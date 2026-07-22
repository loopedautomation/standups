import { type JobContext, type VAD, VADEventType } from "@livekit/agents"
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
  AGENT_BARGE_IN_ATTRIBUTE,
  type AgentActivityEvent,
  agentControlSchema,
  chatMessageSchema,
  DataTopic,
} from "@meet/shared"
import type { BridgeCallbacks, SessionState } from "./agent-session.js"
import {
  BargeInPolicy,
  bargeInConfigFromEnv,
  PcmRingBuffer,
} from "./barge-in.js"
import {
  GEMINI_INPUT_SAMPLE_RATE,
  GeminiLiveSession,
} from "./gemini-live-session.js"
import type { TtyServerFrame } from "./looped-tty.js"
import type { Brain } from "./looped-webhook.js"
import { postDebugEvent } from "./meeting-context.js"
import {
  REALTIME_SAMPLE_RATE,
  RealtimeSession,
  type RealtimeSessionOptions,
} from "./realtime-session.js"
import type { AgentEntry } from "./registry.js"
import { attachScreenFrame, type ScreenCapture } from "./screen-capture.js"

/** How long a zapped agent responds freely before re-gating/muting. */
const ZAP_WINDOW_MS = 30_000

/** How much mixed room audio each push into the session carries. */
const MIX_INTERVAL_MS = 50

const instructions = (
  entry: AgentEntry,
  canSeeScreens: boolean,
  context?: string,
) =>
  `You are ${entry.name}, an AI agent participating in a live voice meeting ` +
  "with several people. You are a guest, not the host: most of the " +
  "conversation is between the humans and is not for you. Stay silent unless " +
  "you are addressed by name, asked a direct question, or you have something " +
  "genuinely important to contribute — never comment on, summarize, or " +
  "acknowledge what people say to each other. When unsure whether to speak, " +
  "don't; if you have a useful aside or link, post it with " +
  "send_chat_message instead of talking. Keep spoken replies concise and " +
  "conversational — a sentence or two unless asked for more. Answer " +
  "questions yourself whenever you can; reach for the do_task tool only " +
  "when you need your tools, your memory, or to take an action. A task is " +
  "you doing the work — speak about it in the first person ('I'll look " +
  "that up', 'I've filed it'), never as asking or waiting on another " +
  "agent, and never mention runs, tasks, tools or delegation out loud. If " +
  "a task continues in the background, you'll get a [task finished] note " +
  "with the outcome; until it arrives, don't guess at results, and use " +
  "cancel_task if someone tells you to stop. Messages " +
  "prefixed [meeting chat] are the room's text chat: read them for context " +
  "and reply in chat (or aloud only if addressed there)." +
  " The meeting has a shared markdown document everyone can see and edit. " +
  "When someone asks you to write something up, capture a decision, or draft " +
  "a plan, read it and write it back with your changes folded in — never " +
  "just your own addition, or you'll delete their work. Say briefly what you " +
  "changed rather than reading the document out loud." +
  " Your audio may be gated by the meeting's host: while it is, you are " +
  "only given the floor when someone addresses you by name or calls on you " +
  "after you raise your hand, and between turns you may be asked silently " +
  "whether you want the floor — answer those checks honestly and sparingly." +
  (canSeeScreens
    ? " You cannot see the meeting: you hear it. If someone shares their " +
      "screen and asks about it — what's on it, what an error says, what " +
      "they're pointing at — call look_at_screen and answer from what it " +
      "returns. Never describe or guess at anything on a screen you " +
      "haven't just looked at, and look again rather than trusting an " +
      "earlier look, since the screen changes as they work."
    : " You cannot see anything: not the participants, not their screens. " +
      "If someone asks about a shared screen, say plainly that you can't " +
      "see it and ask them to describe it — never guess.") +
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
  /**
   * Prewarmed silero VAD, used to hear a human talking over the agent. The
   * model's own server-side VAD can't do this job here: half-duplex withholds
   * room audio while the agent speaks, so the interruption never reaches it.
   * Without a VAD, barge-in is simply unavailable and the manual interrupt
   * control remains the only recourse.
   */
  vad?: VAD
  /** Read/write the meeting's shared markdown document. */
  readDoc?: () => Promise<string>
  writeDoc?: (text: string) => Promise<string>
  /** Meeting context (roster, prior transcript) folded into instructions. */
  context?: string
}): Promise<void> {
  const { ctx, entry, realtime, brain, state, callbacks, screen, vad } = opts
  const { readDoc, writeDoc } = opts
  const local = ctx.room.localParticipant
  if (!local) throw new Error("no local participant")
  const provider = realtime.provider
  const apiKey =
    provider === "gemini"
      ? (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)
      : process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      provider === "gemini"
        ? "GEMINI_API_KEY (or GOOGLE_API_KEY) is required for Gemini realtime agents"
        : "OPENAI_API_KEY is required for realtime agents",
    )
  }
  // Gemini Live always auto-responds to a completed turn — there is no
  // create_response switch — so the deterministic gate behind on-mention and
  // raise-hand cannot exist. Failing loudly beats an agent that talks when
  // it was configured not to.
  if (provider === "gemini" && entry.turn_policy !== "open") {
    throw new Error(
      `agent "${entry.id}": turn_policy "${entry.turn_policy}" requires the ` +
        "openai realtime provider; Gemini Live cannot be gated",
    )
  }
  // Room audio in at the provider's rate; both providers speak 24 kHz out.
  const inputRate =
    provider === "gemini" ? GEMINI_INPUT_SAMPLE_RATE : REALTIME_SAMPLE_RATE
  const samplesPerMix = (inputRate / 1000) * MIX_INTERVAL_MS

  // Barge-in: the room mix keeps feeding a local VAD while the agent talks,
  // so a human speaking over it can cut it off. The model can't do this for
  // us — see the half-duplex note in the pump further down. No VAD (nothing
  // prewarmed it) means no barge-in; the manual control still works.
  const bargeIn = bargeInConfigFromEnv()
  if (bargeIn.enabled && !vad) {
    console.warn(`[${entry.id}] barge-in disabled: no VAD available`)
  }

  // Vision needs both halves: a deployment that permits it, and a brain that
  // can actually receive an image. Webhook brains drop images silently, so
  // an agent on one is better told it has no eyes than left to guess.
  const canSeeScreens = screen.enabled && entry.brain.kind === "tty"

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
      "speech-to-speech": `${provider}/${realtime.model}`,
      voice: realtime.voice,
      brain: "looped-af (tty, via do_task)",
      "turn detection":
        entry.turn_policy === "open"
          ? "server vad"
          : entry.turn_policy === "raise-hand"
            ? "server vad, gated (raises hand; speaks on mention/call-on)"
            : "server vad, gated (speaks on mention/call-on)",
      "turn policy": entry.turn_policy,
      "echo control": "half-duplex",
      "barge-in":
        bargeIn.enabled && vad
          ? `silero vad, ${bargeIn.minSpeechMs}ms sustained`
          : "off (manual interrupt only)",
      vision: canSeeScreens
        ? "screenshare frames on demand (look_at_screen)"
        : screen.enabled
          ? "off (brain is webhook; images are dropped)"
          : "off (AGENT_SCREEN_VISION)",
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
  let workInFlight = 0
  const delegate = async (request: string): Promise<string> => {
    const startedAt = Date.now()
    workInFlight++
    callbacks.setState("thinking")
    const { text: input, images } = await attachScreenFrame(screen, request)
    try {
      let reply = ""
      // The brain's tool activity streams to the room's activity feed, but
      // the realtime model only hears the final reply — so it can't speak to
      // what was actually done ("I filed issue #42"). Digest the tool calls
      // and hand them back with the reply.
      const actions: string[] = []
      let pendingCall: string | null = null
      for await (const frame of brain.runTurn(input, images)) {
        publishBrainActivity(entry.id, frame, callbacks)
        if (frame.type === "assistant") {
          reply += (reply ? "\n" : "") + frame.content
        } else if (frame.type === "tool_call") {
          pendingCall = `${frame.name}(${frame.arguments.slice(0, 120)})`
        } else if (frame.type === "tool_result") {
          if (actions.length < 12) {
            const result = frame.content.replace(/\s+/g, " ").slice(0, 150)
            actions.push(`${pendingCall ?? frame.name} -> ${result}`)
          }
          pendingCall = null
        } else if (frame.type === "error") {
          throw new Error(frame.error)
        }
      }
      const digest = actions.length
        ? `\n\n[For your own awareness — the tool actions behind this answer, so you can speak to them naturally and accurately:\n${actions.join("\n")}]`
        : ""
      return (reply || "(the task produced no summary)") + digest
    } finally {
      workInFlight--
      stats.latencyMs["brain delegation"] = Date.now() - startedAt
      publishStats()
      callbacks.setState(state.muted ? "muted" : "listening")
    }
  }

  /**
   * Answer "what's on my screen?" — the question that used to get a
   * confident guess. The realtime model can't see, so the frame goes to the
   * brain (which can) and its description comes back as the tool's result.
   */
  const describeScreen = async (): Promise<string> => {
    const { text, images } = await attachScreenFrame(
      screen,
      "Describe what is currently on the shared screen, in a couple of " +
        "sentences someone could act on. Lead with whatever they are most " +
        "likely asking about — an error, a diff, a chart, the active window.",
    )
    if (!images) return "Nobody is sharing their screen at the moment."
    let description = ""
    for await (const frame of brain.runTurn(text, images)) {
      publishBrainActivity(entry.id, frame, callbacks)
      if (frame.type === "assistant") {
        description += (description ? "\n" : "") + frame.content
      } else if (frame.type === "error") {
        throw new Error(frame.error)
      }
    }
    return description || "You couldn't make out what's on the screen."
  }

  // captureFrame is async and chunks internally — concurrent calls interleave
  // their chunks and play back as scrambled speech. Serialize all writes, and
  // use a generation counter so frames queued behind an interrupt are dropped
  // instead of resuming the cancelled reply.
  let writeChain: Promise<void> = Promise.resolve()
  let generation = 0
  // Guards delayed idle transitions: bumped whenever speech (re)starts so a
  // stale playout-drain can't overwrite a newer "speaking" state.
  let idleGen = 0
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
  // The gate follows the session's turn policy, which the meeting's host can
  // flip mid-call; `gate` below is installed once and consults it each turn.
  const gated = () => state.turnPolicy !== "open"
  let handRaised = false
  let zapTimer: ReturnType<typeof setTimeout> | null = null
  let zappedUntil = 0
  /** What "at rest" looks like right now: zapped during a zap window. */
  const idleState = () =>
    state.muted ? "muted" : Date.now() < zappedUntil ? "zapped" : "listening"

  const sessionOpts: RealtimeSessionOptions = {
    model: realtime.model,
    voice: realtime.voice,
    apiKey,
    instructions: instructions(entry, canSeeScreens, opts.context),
    delegate,
    cancelWork: () => {
      if (workInFlight === 0 || !brain.abortTurn) return false
      brain.abortTurn()
      return true
    },
    sendChat: callbacks.publishChat,
    readDoc,
    writeDoc,
    // Offered only when a look could actually succeed. A webhook brain
    // drops images on the floor, so an agent on one must not be told it
    // can see — it would answer confidently about a screen it never saw.
    lookAtScreen: canSeeScreens
      ? async () => {
          if (!screen.active) {
            return "Nobody is sharing their screen at the moment."
          }
          callbacks.setState("thinking")
          try {
            return await describeScreen()
          } finally {
            callbacks.setState(state.muted ? "muted" : "listening")
          }
        }
      : undefined,
    gate: {
      // Substring, not word-boundary: STT often renders the name with
      // possessives or punctuation attached ("Scout's", "scout?").
      mention: new RegExp(entry.name.replace(/[^a-z0-9]/gi, ""), "i"),
      // Under raise-hand, a mention only raises the hand; the floor is
      // granted exclusively by call-on.
      mentionSpeaks: () => state.turnPolicy !== "raise-hand",
      onHandRaise: () => {
        // Strict on-mention keeps the hand down — silence is the point.
        if (state.turnPolicy !== "raise-hand") return
        handRaised = true
        if (!state.muted) callbacks.setState("hand-raised")
      },
      // Every decision lands in the room's debug log so a too-quiet agent
      // can be diagnosed: was the turn even transcribed, and what did the
      // transcript say?
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
    },
    onAudio: (pcm) => {
      if (state.muted) return
      enqueueAudio(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2))
    },
    onInterrupt: () => {
      generation++
      source.clearQueue()
    },
    onSpeaking: () => {
      idleGen++
      handRaised = false
      if (!state.muted) callbacks.setState("speaking")
    },
    onIdle: () => {
      // onIdle fires when the model finishes *generating* — long before the
      // buffered audio finishes *playing*. Hold the "speaking" state until
      // playout drains, or the badge flashes for a second on a 20s answer
      // and the interrupt affordance never has time to exist.
      const gen = ++idleGen
      void source
        .waitForPlayout()
        .catch(() => undefined)
        .then(() => {
          if (gen !== idleGen) return
          if (handRaised && !state.muted) return
          callbacks.setState(idleState())
        })
    },
    onError: (msg) => {
      console.error(`[${entry.id}] realtime: ${msg}`)
      if (ctx.room.name) {
        postDebugEvent(ctx.room.name, `agent:${entry.id}`, "error", msg)
      }
    },
  }
  const session =
    provider === "gemini"
      ? // Gemini can't honor the gate (see the policy check above), and its
        // constructor rejects one on principle — hand it gate-free options.
        new GeminiLiveSession({ ...sessionOpts, gate: undefined })
      : new RealtimeSession(sessionOpts)
  await session.open()
  if (!session.live) throw new Error("realtime session failed to open")
  // The gate is always installed; an "open" policy simply leaves it lifted,
  // so the host can switch policies mid-call without reopening the session.
  session.setGateOpen(!gated())

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
      sampleRate: inputRate,
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

  const bargeInPolicy = new BargeInPolicy(bargeIn)
  const bargeInStream = bargeIn.enabled && vad ? vad.stream() : null
  const prefix = new PcmRingBuffer(
    bargeInStream ? (inputRate * bargeIn.prefixMs) / 1000 : 0,
  )
  let wasAudible = false

  const pump = setInterval(() => {
    if (!session.live || fifos.size === 0) return
    // Mix first, unconditionally: even in the half-duplex window below, this
    // audio still has a job to do — it's what the barge-in VAD listens to.
    const mixed = new Int16Array(samplesPerMix)
    let any = false
    for (const fifo of fifos.values()) {
      const n = Math.min(fifo.length, samplesPerMix)
      if (n === 0) continue
      any = true
      for (let i = 0; i < n; i++) {
        const sum = mixed[i] + (fifo[i] ?? 0)
        mixed[i] = Math.max(-32768, Math.min(32767, sum))
      }
      fifo.splice(0, n)
    }

    // Half-duplex: while the agent is audible, room audio is withheld from
    // the model rather than fed in. Participants on open speakers echo the
    // agent's own voice into their mics, and the model ends up in a
    // conversation with itself. Generation finishes well before playback
    // does (deltas stream faster than realtime), so the gate stays shut
    // until the speaker queue has actually drained.
    if (session.responding || source.queuedDuration > 0.05) {
      wasAudible = true
      bargeInPolicy.agentStartedSpeaking(Date.now())
      if (any && bargeInStream) {
        // Withheld from the model, but not from the interrupt detector —
        // and kept briefly, so a cut can replay what triggered it.
        prefix.push(mixed)
        bargeInStream.pushFrame(
          new AudioFrame(mixed, inputRate, 1, samplesPerMix),
        )
      }
      return
    }

    if (wasAudible) {
      // Leaving the half-duplex window breaks the audio the VAD was hearing.
      // Flush, or the next reply inherits a half-finished speech segment and
      // barge-in fires on the seam.
      wasAudible = false
      bargeInPolicy.agentStoppedSpeaking()
      bargeInStream?.flush()
      prefix.clear()
    }
    if (!any) return
    session.appendAudio(new Uint8Array(mixed.buffer, 0, samplesPerMix * 2))
  }, MIX_INTERVAL_MS)

  // Hard-stop whatever is playing: cancel the model's response, drop frames
  // queued behind the cut, and silence the speaker queue immediately. Used by
  // tap-to-interrupt and by mute.
  const hardCut = () => {
    generation++
    session.cancelResponse()
    source.clearQueue()
  }

  // Barge-in detector: sustained human speech during the agent's turn cuts it
  // off the way it would cut off a person. `speechDuration` is what makes it
  // sustained — a single loud frame is a cough, half a second is a sentence
  // starting. The policy owns the grace window and cooldown.
  if (bargeInStream) {
    void (async () => {
      for await (const event of bargeInStream) {
        if (event.type !== VADEventType.INFERENCE_DONE || !event.speaking) {
          continue
        }
        if (!bargeInPolicy.shouldInterrupt(Date.now(), event.speechDuration)) {
          continue
        }
        hardCut()
        // Replay the speech that triggered the cut. Half-duplex withheld it
        // from the model, so without this the interruption's opening words
        // ("no, wait — I meant Tuesday") are simply lost.
        const pending = prefix.drain()
        if (pending.length > 0) {
          session.appendAudio(new Uint8Array(pending.buffer))
        }
        callbacks.setState(idleState())
        if (ctx.room.name) {
          postDebugEvent(
            ctx.room.name,
            `agent:${entry.id}`,
            "info",
            `barge-in: cut off after ${Math.round(event.speechDuration)}ms of speech`,
          )
        }
      }
    })()
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
      } else if (
        control.type === "set-barge-in" &&
        control.bargeIn !== undefined
      ) {
        bargeInPolicy.setEnabled(control.bargeIn)
        local
          .setAttributes({
            [AGENT_BARGE_IN_ATTRIBUTE]: control.bargeIn ? "1" : "0",
          })
          .catch(() => undefined)
        stats.config["barge-in"] =
          control.bargeIn && vad
            ? `silero vad, ${bargeIn.minSpeechMs}ms sustained`
            : "off (manual interrupt only)"
        publishStats()
      } else if (control.type === "set-turn-policy" && control.policy) {
        // The host changed how this agent takes turns; apply it immediately
        // (the worker owns state.turnPolicy and the published attribute).
        handRaised = false
        session.setGateOpen(control.policy === "open")
        callbacks.setState(idleState())
        stats.config["turn detection"] =
          control.policy === "open"
            ? "server vad"
            : control.policy === "raise-hand"
              ? "server vad, gated (raises hand; speaks on mention/call-on)"
              : "server vad, gated (speaks on mention/call-on)"
        stats.config["turn policy"] = control.policy
        publishStats()
      } else if (control.type === "call-on") {
        handRaised = false
        session.callOn()
      } else if (control.type === "zap") {
        // Wake the agent: gate lifted (or unmuted) for the zap window, then
        // to normal. A fresh zap extends the window. The "zapped" state is
        // the visible indicator that the zap took.
        handRaised = false
        state.muted = false
        zappedUntil = Date.now() + ZAP_WINDOW_MS
        session.setGateOpen(true)
        callbacks.setState("zapped")
        if (zapTimer) clearTimeout(zapTimer)
        zapTimer = setTimeout(() => {
          zapTimer = null
          zappedUntil = 0
          if (gated()) {
            session.setGateOpen(false)
          } else {
            // Open-policy agents have no gate to fall back to — mute them.
            state.muted = true
            hardCut()
            callbacks.setState("muted")
            return
          }
          callbacks.setState(state.muted ? "muted" : "listening")
        }, ZAP_WINDOW_MS)
        session.say("Acknowledge in a few words that you're now listening in.")
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
    if (zapTimer) clearTimeout(zapTimer)
    bargeInStream?.close()
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
      content: frame.content.slice(0, 8000),
      durationMs: frame.durationMs,
      at,
    }
  }
  if (event) callbacks.publishActivity(event)
}
