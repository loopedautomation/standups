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
import type { AgentActivityEvent } from "@meet/shared"
import type { BridgeCallbacks, SessionState } from "./agent-session.js"
import type { Brain } from "./looped-webhook.js"
import type { AgentEntry } from "./registry.js"
import { REALTIME_SAMPLE_RATE, RealtimeSession } from "./realtime-session.js"
import type { ScreenCapture } from "./screen-capture.js"
import type { TtyServerFrame } from "./looped-tty.js"

/** How much mixed room audio each push into the session carries. */
const MIX_INTERVAL_MS = 50
const SAMPLES_PER_MIX = (REALTIME_SAMPLE_RATE / 1000) * MIX_INTERVAL_MS

const instructions = (entry: AgentEntry) =>
  `You are ${entry.name}, an AI agent participating in a live voice meeting ` +
  "with several people. Keep spoken replies concise and conversational — a " +
  "sentence or two unless asked for more. Answer questions yourself whenever " +
  "you can; reach for the ask_agent tool only when you need its tools, its " +
  "memory, or to take an action."

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

  // ---- delegate: realtime model -> looped agent brain ---------------------
  const delegate = async (request: string): Promise<string> => {
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
      callbacks.setState(state.muted ? "muted" : "listening")
    }
  }

  const session = new RealtimeSession({
    model: realtime.model,
    voice: realtime.voice,
    apiKey,
    instructions: instructions(entry),
    delegate,
    onAudio: (pcm) => {
      if (state.muted) return
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)
      void source.captureFrame(
        new AudioFrame(samples, REALTIME_SAMPLE_RATE, 1, samples.length),
      )
    },
    onInterrupt: () => source.clearQueue(),
    onSpeaking: () => {
      if (!state.muted) callbacks.setState("speaking")
    },
    onIdle: () => callbacks.setState(state.muted ? "muted" : "listening"),
    onError: (msg) => console.error(`[${entry.id}] realtime: ${msg}`),
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
    if (track.kind === TrackKind.KIND_AUDIO) consume(track, participant.identity)
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
    // (Trade-off: barge-in by voice is disabled while the agent talks.)
    if (session.responding) {
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
    session.appendAudio(
      new Uint8Array(mixed.buffer, 0, SAMPLES_PER_MIX * 2),
    )
  }, MIX_INTERVAL_MS)

  ctx.addShutdownCallback(async () => {
    clearInterval(pump)
    session.close()
  })

  if (entry.greeting) session.say(entry.greeting)
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
