import type { JobContext } from "@livekit/agents"
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  type RemoteTrack,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node"
import {
  type AgentActivityEvent,
  agentControlSchema,
  chatMessageSchema,
  DataTopic,
} from "@meet/shared"
import type { BridgeCallbacks, SessionState } from "./agent-session.js"
import type { TtyServerFrame } from "./looped-tty.js"
import type { Brain } from "./looped-webhook.js"
import { postDebugEvent } from "./meeting-context.js"
import { REALTIME_SAMPLE_RATE, RealtimeSession } from "./realtime-session.js"
import type { AgentEntry } from "./registry.js"
import type { ScreenCapture } from "./screen-capture.js"

/** How long a poked agent stays fully awake before re-gating/muting. */
const POKE_WINDOW_MS = 60_000

/** How much mixed room audio each push into the session carries. */
const MIX_INTERVAL_MS = 50
const SAMPLES_PER_MIX = (REALTIME_SAMPLE_RATE / 1000) * MIX_INTERVAL_MS

const instructions = (entry: AgentEntry, context?: string) =>
  `You are ${entry.name}, an AI agent participating in a live voice meeting ` +
  "with several people. You are a guest, not the host: most of the " +
  "conversation is between the humans and is not for you. Stay silent unless " +
  "you are addressed by name, asked a direct question, or you have something " +
  "genuinely important to contribute — never comment on, summarize, or " +
  "acknowledge what people say to each other. When unsure whether to speak, " +
  "don't; if you have a useful aside or link, post it with " +
  "send_chat_message instead of talking. Keep spoken replies concise and " +
  "conversational — a sentence or two unless asked for more. Answer " +
  "questions yourself whenever you can; reach for the ask_agent tool only " +
  "when you need its tools, its memory, or to take an action. Messages " +
  "prefixed [meeting chat] are the room's text chat: read them for context " +
  "and reply in chat (or aloud only if addressed there)." +
  (entry.turn_policy === "on-mention"
    ? " Note: your audio is gated — you are only given the floor when " +
      "someone addresses you by name or calls on you after you raise your " +
      "hand. Between turns you may be asked silently whether you want the " +
      "floor; answer those checks honestly and sparingly."
    : "") +
  (context ? `\n\n${context}` : "")

/**
 * Runs an agent whose interaction layer is a realtime speech-to-speech model:
 * room audio streams into the session, spoken replies stream back out as the
 * agent's audio track, and anything needing tools or judgment is delegated to
 * the looped agent brain (whose tool activity still feeds the activity panel).
 */
export async function runRealtimeAgent(opts: {
  ctx: JobContext
  entry: AgentEntry
  realtime: NonNullable<AgentEntry["realtime"]>
  brain: Brain
  state: SessionState
  callbacks: BridgeCallbacks
  screen: ScreenCapture
  /** Meeting context (roster, prior transcript) folded into instructions. */
  context?: string
}): Promise<void> {
  const { ctx, entry, realtime, brain, state, callbacks, screen } = opts
  const local = ctx.room.localParticipant
  if (!local) throw new Error("no local participant")
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for realtime agents")

  // ---- outbound audio: session -> room ------------------------------------
  const source = new AudioSource(REALTIME_SAMPLE_RATE, 1)
  const track = LocalAudioTrack.createAudioTrack(`${entry.id}-voice`, source)
  const publishOpts = new TrackPublishOptions()
  publishOpts.source = TrackSource.SOURCE_MICROPHONE
  await local.publishTrack(track, publishOpts)

  // Stats for nerds: realtime config + brain delegation latency.
  const stats = {
    config: {
      mode: "realtime",
      "speech-to-speech": `openai/${realtime.model}`,
      voice: realtime.voice,
      brain: "looped-af (tty, via ask_agent)",
      "turn detection":
        entry.turn_policy === "on-mention"
          ? "server vad, gated (speaks on mention/call-on)"
          : "server vad",
      "echo control": "half-duplex",
      "noise suppression": "room transcriber (gtcrn)",
    } as Record<string, string>,
    latencyMs: {} as Record<string, number>,
  }
  const publishStats = () =>
    callbacks.publishActivity({
      type: "stats",
      agentId: entry.id,
      config: stats.config,
      latencyMs: stats.latencyMs,
      at: Date.now(),
    })

  // ---- delegate: realtime model -> looped agent brain ---------------------
  const delegate = async (request: string): Promise<string> => {
    const startedAt = Date.now()
    callbacks.setState("thinking")
    let input = request
    const capture = screen.active
      ? await screen.latestJpeg().catch(() => null)
      : null
    const images = capture
      ? [{ mediaType: capture.mediaType, data: capture.data }]
      : undefined
    if (capture) {
      input = `[A current frame of ${capture.sharerName}'s shared screen is attached.]\n${input}`
    }
    try {
      let reply = ""
      for await (const frame of brain.runTurn(input, images)) {
        publishBrainActivity(entry.id, frame, callbacks)
        if (frame.type === "assistant") {
          reply += (reply ? "\n" : "") + frame.content
        } else if (frame.type === "error") {
          throw new Error(frame.error)
        }
      }
      return reply || "(the agent had nothing to add)"
    } finally {
      stats.latencyMs["brain delegation"] = Date.now() - startedAt
      publishStats()
      callbacks.setState(state.muted ? "muted" : "listening")
    }
  }

  // captureFrame is async and chunks internally — concurrent calls interleave
  // their chunks and play back as scrambled speech. Serialize all writes, and
  // use a generation counter so frames queued behind an interrupt are dropped
  // instead of resuming the cancelled reply.
  let writeChain: Promise<void> = Promise.resolve()
  let generation = 0
  const enqueueAudio = (samples: Int16Array) => {
    const gen = generation
    writeChain = writeChain
      .then(() => {
        if (gen !== generation) return
        return source.captureFrame(
          new AudioFrame(samples, REALTIME_SAMPLE_RATE, 1, samples.length),
        )
      })
      .catch(() => undefined)
  }

  // Deterministic turn gate (turn_policy: on-mention): the model can only
  // make sound when we create a response — on a name mention or a call-on.
  // handRaised keeps the badge up until a human acts (idle events after the
  // silent deliberation must not clear it).
  const gated = entry.turn_policy === "on-mention"
  let handRaised = false
  let pokeTimer: ReturnType<typeof setTimeout> | null = null
  let pokedUntil = 0
  /** What "at rest" looks like right now: awake during a poke window. */
  const idleState = () =>
    state.muted ? "muted" : Date.now() < pokedUntil ? "awake" : "listening"

  const session = new RealtimeSession({
    model: realtime.model,
    voice: realtime.voice,
    apiKey,
    instructions: instructions(entry, opts.context),
    delegate,
    sendChat: callbacks.publishChat,
    gate: gated
      ? {
          // Substring, not word-boundary: STT often renders the name with
          // possessives or punctuation attached ("Scout's", "scout?").
          mention: new RegExp(entry.name.replace(/[^a-z0-9]/gi, ""), "i"),
          onHandRaise: () => {
            handRaised = true
            if (!state.muted) callbacks.setState("hand-raised")
          },
          // Every decision lands in the room's debug log so a too-quiet
          // agent can be diagnosed: was the turn even transcribed, and what
          // did the transcript say?
          onDecision: (transcript, decision) => {
            if (ctx.room.name) {
              postDebugEvent(
                ctx.room.name,
                `agent:${entry.id}`,
                "info",
                `gate ${decision}: "${transcript.slice(0, 200)}"`,
              )
            }
          },
        }
      : undefined,
    onAudio: (pcm) => {
      if (state.muted) return
      enqueueAudio(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2))
    },
    onInterrupt: () => {
      generation++
      source.clearQueue()
    },
    onSpeaking: () => {
      handRaised = false
      if (!state.muted) callbacks.setState("speaking")
    },
    onIdle: () => {
      if (handRaised && !state.muted) return
      callbacks.setState(idleState())
    },
    onError: (msg) => {
      console.error(`[${entry.id}] realtime: ${msg}`)
      if (ctx.room.name) {
        postDebugEvent(ctx.room.name, `agent:${entry.id}`, "error", msg)
      }
    },
  })
  await session.open()
  if (!session.live) throw new Error("realtime session failed to open")

  // ---- inbound audio: room -> session, mixing all human mics --------------
  // Each subscribed mic gets its own resampled-to-24k stream feeding a FIFO;
  // a fixed-interval pump sums whatever every FIFO has and appends one mixed
  // buffer, so overlapping speakers stay intelligible to the model.
  const fifos = new Map<string, number[]>()

  const consume = (track: RemoteTrack, identity: string) => {
    if (identity.startsWith("agent-")) return
    const fifo: number[] = []
    fifos.set(track.sid ?? identity, fifo)
    const stream = new AudioStream(track, {
      sampleRate: REALTIME_SAMPLE_RATE,
      numChannels: 1,
    })
    void (async () => {
      const reader = stream.getReader()
      try {
        while (true) {
          const { value: frame, done } = await reader.read()
          if (done) break
          if (state.deafened) continue
          for (const s of frame.data) fifo.push(s)
        }
      } catch {
        // track ended
      } finally {
        fifos.delete(track.sid ?? identity)
      }
    })()
  }

  ctx.room.on("trackSubscribed", (track, _pub, participant) => {
    if (track.kind === TrackKind.KIND_AUDIO)
      consume(track, participant.identity)
  })
  for (const participant of ctx.room.remoteParticipants.values()) {
    for (const pub of participant.trackPublications.values()) {
      const t = pub.track
      if (t && t.kind === TrackKind.KIND_AUDIO) consume(t, participant.identity)
    }
  }

  const pump = setInterval(() => {
    if (!session.live || fifos.size === 0) return
    // Half-duplex: while the model is speaking, drop room audio instead of
    // feeding it in. Participants on open speakers echo the agent's own voice
    // into their mics, and the model ends up in a conversation with itself.
    // Generation finishes well before playback does (deltas stream faster
    // than realtime), so the gate stays closed until the speaker queue has
    // actually drained. (Trade-off: no voice barge-in while the agent talks.)
    if (session.responding || source.queuedDuration > 0.05) {
      for (const fifo of fifos.values()) fifo.length = 0
      return
    }
    const mixed = new Int16Array(SAMPLES_PER_MIX)
    let any = false
    for (const fifo of fifos.values()) {
      const n = Math.min(fifo.length, SAMPLES_PER_MIX)
      if (n === 0) continue
      any = true
      for (let i = 0; i < n; i++) {
        const sum = mixed[i] + (fifo[i] ?? 0)
        mixed[i] = Math.max(-32768, Math.min(32767, sum))
      }
      fifo.splice(0, n)
    }
    if (!any) return
    session.appendAudio(new Uint8Array(mixed.buffer, 0, SAMPLES_PER_MIX * 2))
  }, MIX_INTERVAL_MS)

  // Hard-stop whatever is playing: cancel the model's response, drop frames
  // queued behind the cut, and silence the speaker queue immediately. Used by
  // tap-to-interrupt and by mute.
  const hardCut = () => {
    generation++
    session.cancelResponse()
    source.clearQueue()
  }

  ctx.room.on("dataReceived", (payload, _p, _k, topic) => {
    if (topic === DataTopic.Chat) {
      // Surface the room's text chat to the model as passive context; the
      // instructions tell it to reply in chat (or ignore it) rather than
      // narrate. Its own messages are excluded.
      try {
        const message = chatMessageSchema.parse(
          JSON.parse(new TextDecoder().decode(payload)),
        )
        if (message.from === `agent-${entry.id}`) return
        session.notifyChat(
          `[meeting chat] ${message.fromName}: ${message.text}`,
        )
      } catch {}
      return
    }
    if (topic !== DataTopic.AgentControl) return
    try {
      const control = agentControlSchema.parse(
        JSON.parse(new TextDecoder().decode(payload)),
      )
      if (control.agentId !== entry.id) return
      if (control.type === "interrupt") {
        hardCut()
        callbacks.setState(idleState())
      } else if (control.type === "call-on") {
        handRaised = false
        session.callOn()
      } else if (control.type === "poke") {
        // Wake the agent: gate lifted (or unmuted) for a minute, then back
        // to normal. A fresh poke extends the window. The "awake" state is
        // the visible indicator that the poke took.
        handRaised = false
        state.muted = false
        pokedUntil = Date.now() + POKE_WINDOW_MS
        session.setGateOpen(true)
        callbacks.setState("awake")
        if (pokeTimer) clearTimeout(pokeTimer)
        pokeTimer = setTimeout(() => {
          pokeTimer = null
          pokedUntil = 0
          if (gated) {
            session.setGateOpen(false)
          } else {
            // Open-policy agents have no gate to fall back to — mute them.
            state.muted = true
            hardCut()
            callbacks.setState("muted")
            return
          }
          callbacks.setState(state.muted ? "muted" : "listening")
        }, POKE_WINDOW_MS)
        session.say(
          "Acknowledge in a few words that you're now listening in for a bit.",
        )
      } else if (control.type === "mute") {
        // The worker's control handler flips the muted flag; this one makes
        // mute take effect audibly by cutting playback mid-word.
        state.muted = true
        hardCut()
        callbacks.setState("muted")
      }
    } catch {}
  })

  ctx.addShutdownCallback(async () => {
    clearInterval(pump)
    if (pokeTimer) clearTimeout(pokeTimer)
    session.close()
  })

  if (entry.greeting) session.say(entry.greeting)
  publishStats()
}

function publishBrainActivity(
  agentId: string,
  frame: TtyServerFrame,
  callbacks: BridgeCallbacks,
) {
  const at = Date.now()
  let event: AgentActivityEvent | null = null
  if (frame.type === "step") {
    event = { type: "step", agentId, n: frame.n, at }
  } else if (frame.type === "tool_call") {
    event = {
      type: "tool_call",
      agentId,
      name: frame.name,
      arguments: frame.arguments,
      at,
    }
  } else if (frame.type === "tool_result") {
    event = {
      type: "tool_result",
      agentId,
      name: frame.name,
      content: frame.content.slice(0, 2000),
      durationMs: frame.durationMs,
      at,
    }
  }
  if (event) callbacks.publishActivity(event)
}
