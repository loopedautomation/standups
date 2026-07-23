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
  type CanvasOp,
  type ChatMessage,
  chatMessageSchema,
  DataTopic,
  mentionsName,
  spokenMentionRegExp,
} from "@meet/shared"
import type { BridgeCallbacks, SessionState } from "./agent-session.js"
import {
  BargeInPolicy,
  bargeInConfigFromEnv,
  PcmRingBuffer,
} from "./barge-in.js"
import { collectBrainReply } from "./brain-reply.js"
import {
  CANVAS_PROTOCOL_NOTE,
  CanvasBlockExtractor,
  parseCanvasBlock,
} from "./canvas-blocks.js"
import { controlAllowed } from "./control-auth.js"
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
  "with several people. You are the agent's voice, not its mind: your " +
  "knowledge, memory, tools and permissions live behind the do_task tool, " +
  "and every answer of substance comes from there. Never answer from what " +
  "you happen to know — anything factual, anything about systems, data, " +
  "people, documents or past conversations, any opinion on the work, and " +
  "any action goes through do_task, even when you feel sure of the answer. " +
  "You handle only the conversational surface yourself: greetings, brief " +
  "acknowledgments, a clarifying question when a request is ambiguous, and " +
  "faithfully relaying results without adding facts of your own. If a task " +
  "fails or your tools are unreachable, say so plainly rather than " +
  "improvising an answer. A task is you doing the work — speak about it in " +
  "the first person ('I'll look that up', 'I've filed it'), never as " +
  "asking or waiting on another agent, and never mention runs, tasks, " +
  "tools or delegation out loud. If a task continues in the background, " +
  "you'll get a [task finished] note with the outcome; until it arrives, " +
  "don't guess at results, and use cancel_task if someone tells you to " +
  "stop. You are a guest, not the host: most of the conversation is " +
  "between the humans and is not for you. Stay silent unless you are " +
  "addressed by name, asked a direct question, or you have something " +
  "genuinely important to contribute — never comment on, summarize, or " +
  "acknowledge what people say to each other. When unsure whether to " +
  "speak, don't; if you have a useful aside or link, post it with " +
  "send_chat_message instead of talking. Keep spoken replies concise and " +
  "conversational — a sentence or two unless asked for more. Messages " +
  "prefixed [meeting chat] are the room's text chat: read them for context " +
  "and reply in chat (or aloud only if addressed there)." +
  " The meeting has a shared markdown document everyone can see and edit. " +
  "When someone asks you to write something up, capture a decision, or " +
  "draft a plan, use update_shared_doc and describe the change in full — " +
  "the document is rewritten for you with everyone's work preserved. Say " +
  "briefly what changed rather than reading the document out loud." +
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
  /** Read/draw on the meeting's shared whiteboard. */
  readCanvas?: () => Promise<string>
  drawCanvas?: (ops: CanvasOp[]) => Promise<string>
  /**
   * Answer a chat @mention through the brain (text in, chat reply out,
   * marker blocks acted on). Resolves with the posted text, so the voice
   * model can be told what "it" said in chat.
   */
  onChatMention?: (
    message: ChatMessage & { fromName: string },
  ) => Promise<string | null>
  /** Leave the meeting on request (asked aloud or in chat). */
  leaveMeeting?: () => Promise<void>
  /** Meeting context (roster, prior transcript) folded into instructions. */
  context?: string
  /** Fed what the agent said aloud, for the brain's record of the meeting. */
  onSpoke?: (text: string) => void
}): Promise<void> {
  const { ctx, entry, realtime, brain, state, callbacks, screen, vad } = opts
  const { readDoc, writeDoc, readCanvas, drawCanvas } = opts
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
      brain: `looped-af (${entry.brain.kind}, relay — all substance via do_task)`,
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
  /** Room debug log, tagged with this agent: which layer acted, and when. */
  const debug = (level: "info" | "error", message: string) => {
    if (ctx.room.name) {
      postDebugEvent(ctx.room.name, `agent:${entry.id}`, level, message)
    }
  }
  let workInFlight = 0
  // The model occasionally fires the same do_task twice for one utterance;
  // the second identical ask gets told to wait rather than a second brain
  // run — which could execute real-world actions twice.
  const inFlight = new Set<string>()
  const requestKey = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()
  const delegate = async (request: string): Promise<string> => {
    const key = requestKey(request)
    if (inFlight.has(key)) {
      debug(
        "info",
        `task deduped (already in flight): "${request.slice(0, 200)}"`,
      )
      return (
        "You are already working on exactly that — wait for its outcome " +
        "instead of starting it again."
      )
    }
    inFlight.add(key)
    const startedAt = Date.now()
    workInFlight++
    callbacks.setState("thinking")
    debug("info", `task started: "${request.slice(0, 200)}"`)
    try {
      const { text: input, images } = await attachScreenFrame(screen, request)
      // The brain's tool activity streams to the room's activity feed, but
      // the realtime model only hears the final reply — so it can't speak to
      // what was actually done ("I filed issue #42"). Digest the tool calls
      // and hand them back with the reply.
      const actions: string[] = []
      let pendingCall: string | null = null
      const reply = await collectBrainReply(
        brain.runTurn(input, images),
        (frame) => {
          publishBrainActivity(entry.id, frame, callbacks)
          if (frame.type === "tool_call") {
            pendingCall = `${frame.name}(${frame.arguments.slice(0, 120)})`
          } else if (frame.type === "tool_result") {
            if (actions.length < 12) {
              const result = frame.content.replace(/\s+/g, " ").slice(0, 150)
              actions.push(`${pendingCall ?? frame.name} -> ${result}`)
            }
            pendingCall = null
          }
        },
      )
      const digest = actions.length
        ? `\n\n[For your own awareness — the tool actions behind this answer, so you can speak to them naturally and accurately:\n${actions.join("\n")}]`
        : ""
      debug("info", `task done in ${Date.now() - startedAt}ms`)
      return (reply || "(the task produced no summary)") + digest
    } catch (err) {
      debug("error", `task failed: ${(err as Error).message}`)
      throw err
    } finally {
      inFlight.delete(key)
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
    const description = await collectBrainReply(
      brain.runTurn(text, images),
      (frame) => publishBrainActivity(entry.id, frame, callbacks),
    )
    return description || "You couldn't make out what's on the screen."
  }

  /**
   * Update the shared doc on instruction: the brain composes the new
   * document (with the current text in front of it) and the bridge persists
   * it. The voice model never authors persistent content, so doc writes get
   * the brain's judgment, memory and audit trail like everything else.
   */
  /**
   * Draw on the whiteboard on instruction: the brain composes the actual
   * shapes — as canvas marker blocks, its native drawing vocabulary — and
   * the bridge applies them. Mirrors updateDoc: the voice model describes
   * intent, never authors coordinates. This is what makes drawing work on
   * conversational realtime models (Gemini native audio especially), which
   * cannot hold a spatial map while talking.
   */
  const drawOnCanvas =
    readCanvas && drawCanvas
      ? async (instruction: string): Promise<string> => {
          callbacks.setState("thinking")
          debug("info", `drawing started: "${instruction.slice(0, 200)}"`)
          workInFlight++
          try {
            const board = await readCanvas()
            const prompt =
              "The meeting's shared whiteboard needs drawing. " +
              `Instruction from the meeting: ${instruction}\n\n` +
              `Current whiteboard: ${board}\n\n` +
              `${CANVAS_PROTOCOL_NOTE}\n\n` +
              "Reply with the canvas block(s) and nothing else — no " +
              "prose outside the markers."
            const reply = await collectBrainReply(
              brain.runTurn(prompt),
              (frame) => publishBrainActivity(entry.id, frame, callbacks),
            )
            const { blocks } = new CanvasBlockExtractor().feed(reply)
            if (blocks.length === 0) {
              debug("error", "drawing produced no canvas block")
              return "Nothing was drawn — the drawing task produced no shapes."
            }
            const outcomes: string[] = []
            for (const block of blocks) {
              const parsed = parseCanvasBlock(block)
              if ("error" in parsed) {
                outcomes.push(parsed.error)
                continue
              }
              outcomes.push(await drawCanvas(parsed.ops))
            }
            debug("info", "drawing applied")
            return outcomes.join(" ")
          } catch (err) {
            debug("error", `drawing failed: ${(err as Error).message}`)
            throw err
          } finally {
            workInFlight--
            callbacks.setState(state.muted ? "muted" : "listening")
          }
        }
      : undefined

  const updateDoc =
    readDoc && writeDoc
      ? async (instruction: string): Promise<string> => {
          callbacks.setState("thinking")
          debug("info", `doc update started: "${instruction.slice(0, 200)}"`)
          workInFlight++
          try {
            const current = await readDoc()
            const prompt =
              "The meeting's shared markdown document needs updating. " +
              `Instruction from the meeting: ${instruction}\n\n` +
              (current.trim()
                ? `Current document:\n<<<DOC\n${current}\nDOC>>>\n\n`
                : "The document is currently empty.\n\n") +
              "Reply with the complete updated document in markdown and " +
              "nothing else — no preamble, no commentary, no code fences. " +
              "Preserve everything already in the document unless the " +
              "instruction says to change it."
            const updated = await collectBrainReply(
              brain.runTurn(prompt),
              (frame) => publishBrainActivity(entry.id, frame, callbacks),
            )
            const text = stripFence(updated)
            if (!text.trim()) {
              debug("error", "doc update produced no text; nothing written")
              return "The update produced no document; nothing was changed."
            }
            const outcome = await writeDoc(text)
            debug("info", "doc update saved")
            return outcome
          } catch (err) {
            debug("error", `doc update failed: ${(err as Error).message}`)
            throw err
          } finally {
            workInFlight--
            callbacks.setState(state.muted ? "muted" : "listening")
          }
        }
      : undefined

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
    updateDoc,
    readCanvas,
    drawCanvas: drawOnCanvas,
    leaveMeeting: opts.leaveMeeting
      ? () => void opts.leaveMeeting?.()
      : undefined,
    onAgentSpoke: opts.onSpoke,
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
      // Loose matching: STT renders the name with possessives,
      // punctuation or spacing of its own ("Scout's", "scout?", "r2 d2").
      mention: spokenMentionRegExp(entry.name),
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
        debug("info", `gate ${decision}: "${transcript.slice(0, 200)}"`)
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
      debug("error", msg)
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
        debug(
          "info",
          `barge-in: cut off after ${Math.round(event.speechDuration)}ms of speech`,
        )
      }
    })()
  }

  ctx.room.on("dataReceived", (payload, sender, _k, topic) => {
    if (topic === DataTopic.Chat) {
      // Surface the room's text chat to the model as passive context; the
      // instructions tell it to reply in chat (or ignore it) rather than
      // narrate. Its own messages are excluded.
      try {
        const message = chatMessageSchema.parse(
          JSON.parse(new TextDecoder().decode(payload)),
        )
        // Attribution from the actual LiveKit sender — a crafted payload
        // must not put words in someone else's mouth in the model's context.
        if (!sender || sender.identity === `agent-${entry.id}`) return
        const line = `[meeting chat] ${sender.name || sender.identity}: ${message.text}`
        // An @mention is a question to THIS agent — passive context isn't
        // enough, it has to actually answer in the chat (#112). Other
        // agents' mentions of us don't qualify; agent-to-agent chat loops
        // would spiral.
        if (
          !sender.identity.startsWith("agent-") &&
          mentionsName(message.text, entry.name)
        ) {
          if (opts.onChatMention) {
            // The brain answers chat, not the voice model — it has the
            // tools, memory and marker-block powers (doc edits, drawings)
            // a chat request may need. The session still hears both sides
            // as passive context so the spoken conversation stays coherent.
            debug("info", "chat mention: replying via brain")
            session.notifyChat(line)
            void opts
              .onChatMention({
                ...message,
                fromName: sender.name || sender.identity,
              })
              .then((posted) => {
                if (posted) {
                  session.notifyChat(
                    `[meeting chat] ${entry.name} (you) replied: ${posted}`,
                  )
                }
              })
              .catch(() => undefined)
          } else {
            debug("info", `chat mention: replying in chat`)
            session.promptChatReply(line)
          }
        } else {
          session.notifyChat(line)
        }
      } catch {}
      return
    }
    if (topic !== DataTopic.AgentControl) return
    // Enforced here, not just in the UI: only an admitted human — and only
    // the host when they've reserved controls — may drive agents.
    if (!controlAllowed(ctx.room, sender)) return
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

/** Unwrap a reply the brain fenced anyway, despite being asked not to. */
function stripFence(text: string): string {
  const match = /^```[a-z]*\n([\s\S]*?)\n?```$/.exec(text.trim())
  return match?.[1] ?? text.trim()
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
