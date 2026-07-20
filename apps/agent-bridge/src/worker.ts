import {
  defineAgent,
  type JobContext,
  type JobProcess,
  type JobRequest,
  voice,
} from "@livekit/agents"
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs"
import * as openai from "@livekit/agents-plugin-openai"
import * as silero from "@livekit/agents-plugin-silero"
import {
  AGENT_STATE_ATTRIBUTE,
  type AgentActivityEvent,
  type AgentState,
  agentControlSchema,
  type ChatMessage,
  chatMessageSchema,
  DataTopic,
  type ParticipantMeta,
} from "@meet/shared"
import { LoopedVoiceAgent, SessionState } from "./agent-session.js"
import { getDynamicAgent } from "./dynamic.js"
import { LoopedTtyClient } from "./looped-tty.js"
import { type Brain, LoopedWebhookClient } from "./looped-webhook.js"
import {
  describeRoster,
  fetchTranscript,
  formatTranscript,
  postDebugEvent,
  withMeetingContext,
} from "./meeting-context.js"
import { runRealtimeAgent } from "./realtime-agent.js"
import { type AgentEntry, brainToken, loadRegistry } from "./registry.js"
import { ScreenCapture } from "./screen-capture.js"

type DispatchMeta = { agentId: string }

/** How long a poked agent answers freely before its policy resumes. */
const POKE_WINDOW_MS = 60_000

/** A registry entry plus, for dynamic (URL-invited) agents, its token. */
type ResolvedEntry = AgentEntry & { directToken?: string }

function entryFromMetadata(metadata: string): ResolvedEntry {
  const { agentId } = JSON.parse(metadata) as DispatchMeta
  if (agentId.startsWith("dyn-")) {
    const spec = getDynamicAgent(agentId)
    if (!spec) throw new Error(`unknown dynamic agent: ${agentId}`)
    return {
      id: agentId,
      name: spec.name,
      greeting: `Hi, I'm ${spec.name}.`,
      turn_policy: "open",
      brain: { kind: "tty", url: spec.url, token_env: "" },
      realtime: {
        model: process.env.REALTIME_MODEL ?? "gpt-realtime-2.1",
        voice: spec.voice ?? "marin",
      },
      stt: { provider: "openai", model: "gpt-4o-mini-transcribe" },
      tts: { provider: "openai", model: "gpt-4o-mini-tts", voice: "alloy" },
      directToken: spec.token,
    }
  }
  const entry = loadRegistry().find((a) => a.id === agentId)
  if (!entry) throw new Error(`unknown agent: ${agentId}`)
  return entry
}

/** Accept dispatches with an agent-scoped identity and metadata. */
export async function acceptRequest(request: JobRequest): Promise<void> {
  const entry = entryFromMetadata(request.job.metadata)
  const meta: ParticipantMeta = { kind: "agent", agentId: entry.id }
  await request.accept(entry.name, `agent-${entry.id}`, JSON.stringify(meta), {
    [AGENT_STATE_ATTRIBUTE]: "listening" satisfies AgentState,
  })
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load()
  },
  entry: async (ctx: JobContext) => {
    const entry = entryFromMetadata(ctx.job.metadata)
    const roomName = ctx.job.room?.name ?? "room"

    const brainOpts = {
      url: entry.brain.url,
      token: entry.directToken ?? brainToken(entry),
      conversationId: `${roomName}-${entry.id}`,
    }
    const rawBrain: Brain =
      entry.brain.kind === "tty"
        ? new LoopedTtyClient(brainOpts)
        : new LoopedWebhookClient(brainOpts)

    await ctx.connect()
    const local = ctx.room.localParticipant
    if (!local) throw new Error("no local participant after connect")

    const sessionState = new SessionState()
    let pokeTimer: ReturnType<typeof setTimeout> | null = null

    const setState = (state: AgentState) => {
      local
        .setAttributes({ [AGENT_STATE_ATTRIBUTE]: state })
        .catch(() => undefined)
    }
    const publishActivity = (event: AgentActivityEvent) => {
      local
        .publishData(new TextEncoder().encode(JSON.stringify(event)), {
          reliable: true,
          topic: DataTopic.AgentActivity,
        })
        .catch(() => undefined)
    }
    const publishChat = (text: string) => {
      const message: ChatMessage = {
        id: `${entry.id}-${Date.now()}`,
        from: `agent-${entry.id}`,
        fromName: entry.name,
        text,
        at: Date.now(),
      }
      local
        .publishData(new TextEncoder().encode(JSON.stringify(message)), {
          reliable: true,
          topic: DataTopic.Chat,
        })
        .catch(() => undefined)
    }

    const screen = new ScreenCapture(ctx.room)

    // Meeting context: what was said before the agent joined (from the
    // control API's transcript store) plus who's in the room. Wrapping the
    // brain injects it into the first turn on every path — voice, chat
    // mention, or realtime ask_agent delegation.
    const priorTranscript = formatTranscript(await fetchTranscript(roomName))
    const meetingContext = [
      `Participants in the meeting when you joined: ${describeRoster(ctx.room)}.`,
      priorTranscript
        ? `Transcript of the meeting before you joined:\n${priorTranscript}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n")
    // Chat messages the brain hasn't seen yet; drained into its next turn so
    // pipeline agents follow the room's text chat, not just @mentions.
    const chatSince: string[] = []
    const brain = withMeetingContext(rawBrain, meetingContext, () => {
      const lines = chatSince.splice(0)
      return lines.length
        ? `[Meeting chat since your last turn:]\n${lines.join("\n")}`
        : ""
    })

    postDebugEvent(
      roomName,
      `agent:${entry.id}`,
      "info",
      `joined (${entry.realtime ? "realtime" : "pipeline"}, brain: ${entry.brain.url})`,
    )
    ctx.addShutdownCallback(async () => {
      postDebugEvent(roomName, `agent:${entry.id}`, "info", "left the room")
    })

    // Realtime agents: a speech-to-speech model is the interaction layer and
    // the brain handles tool work — no STT/TTS pipeline at all.
    if (entry.realtime) {
      // Chat handling lives with the realtime session: every room chat
      // message is surfaced to the model as context, and it posts replies
      // itself via the send_chat_message tool (see realtime-agent.ts).
      ctx.room.on("dataReceived", (payload: Uint8Array, _p, _k, topic) => {
        if (topic !== DataTopic.AgentControl) return
        try {
          const control = agentControlSchema.parse(
            JSON.parse(new TextDecoder().decode(payload)),
          )
          if (control.agentId !== entry.id) return
          if (control.type === "mute") sessionState.muted = true
          else if (control.type === "unmute") sessionState.muted = false
          else if (control.type === "deafen") sessionState.deafened = true
          else if (control.type === "undeafen") sessionState.deafened = false
          // Only these four own the state attribute here; poke, call-on and
          // interrupt are handled in realtime-agent.ts and would otherwise
          // have their state (e.g. "awake") clobbered by this handler.
          else return
          // The state attribute must reflect deafened too, or the UI's
          // deafen button never flips and appears broken.
          setState(
            sessionState.deafened
              ? "deafened"
              : sessionState.muted
                ? "muted"
                : "listening",
          )
        } catch {}
      })
      await runRealtimeAgent({
        ctx,
        entry,
        realtime: entry.realtime,
        brain,
        state: sessionState,
        callbacks: { publishActivity, publishChat, setState },
        screen,
        context: meetingContext,
      })
      return
    }

    const agent = new LoopedVoiceAgent(
      entry,
      brain,
      sessionState,
      { publishActivity, publishChat, setState },
      screen,
      { roster: () => describeRoster(ctx.room) },
    )

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      // OpenAI STT finalizes transcripts slowly; with the default endpointing
      // delay turns get committed while their transcript is still empty, so
      // the agent hears nothing (llmNode sees no user input) even though the
      // transcription panel later shows the text.
      turnHandling: { endpointing: { minDelay: 2 } },
      stt: new openai.STT({ model: entry.stt.model }),
      tts:
        entry.tts.provider === "elevenlabs"
          ? new elevenlabs.TTS({
              model: entry.tts.model,
              voiceId: entry.tts.voice,
            })
          : new openai.TTS({
              model: entry.tts.model,
              voice: entry.tts.voice as openai.TTSVoices,
            }),
    })

    // Stats for nerds: pipeline configuration + rolling latency, published
    // to the room so the Agents panel can render a benchmark card.
    const stats = {
      config: {
        mode: "pipeline",
        vad: "silero",
        "speech-to-text": `openai/${entry.stt.model}`,
        brain: "looped-af (tty)",
        "text-to-speech": `${entry.tts.provider}/${entry.tts.model}`,
        voice: entry.tts.voice,
        "turn detection": "vad",
        "noise suppression": "room transcriber (gtcrn)",
      } as Record<string, string>,
      latencyMs: {} as Record<string, number>,
    }
    const publishStats = () =>
      publishActivity({
        type: "stats",
        agentId: entry.id,
        config: stats.config,
        latencyMs: stats.latencyMs,
        at: Date.now(),
      })
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const m = ev.metrics as { type: string } & Record<string, unknown>
      const num = (v: unknown) => Math.round(Number(v))
      if (m.type === "stt_metrics" && Number(m.durationMs) > 0) {
        stats.latencyMs["speech-to-text"] = num(m.durationMs)
      } else if (m.type === "eou_metrics") {
        stats.latencyMs["end of turn"] = num(m.endOfUtteranceDelayMs)
      } else if (m.type === "llm_metrics") {
        stats.latencyMs["brain (first token)"] = num(m.ttftMs)
      } else if (m.type === "tts_metrics") {
        stats.latencyMs["text-to-speech (first byte)"] = num(m.ttfbMs)
      } else {
        return
      }
      const parts = [
        "end of turn",
        "brain (first token)",
        "text-to-speech (first byte)",
      ]
      if (parts.every((k) => k in stats.latencyMs)) {
        stats.latencyMs.overall = parts.reduce(
          (sum, k) => sum + stats.latencyMs[k],
          0,
        )
      }
      publishStats()
    })
    publishStats()

    // Mirror the pipeline's state onto a participant attribute for the UI.
    // While poked, "listening" reads as "awake" so the indicator stays up
    // for the whole window instead of clearing after the first turn.
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (sessionState.muted) return
      const map: Record<string, AgentState> = {
        listening: Date.now() < sessionState.pokedUntil ? "awake" : "listening",
        thinking: "thinking",
        speaking: "speaking",
      }
      const mapped = map[ev.newState]
      if (mapped) setState(mapped)
    })

    // Mute/unmute controls and chat @-mentions arrive over data topics.
    ctx.room.on("dataReceived", (payload: Uint8Array, _p, _k, topic) => {
      if (topic === DataTopic.AgentControl) {
        try {
          const control = agentControlSchema.parse(
            JSON.parse(new TextDecoder().decode(payload)),
          )
          if (control.agentId !== entry.id) return
          if (control.type === "interrupt") {
            session.interrupt()
          } else if (control.type === "call-on") {
            // Someone called on a hand-raised agent: answer the last thing
            // heard. generateReply re-runs llmNode over the accumulated chat
            // context with the pending flag letting the turn through.
            sessionState.callOnPending = true
            try {
              session.generateReply()
            } catch {
              sessionState.callOnPending = false
            }
          } else if (control.type === "poke") {
            // Wake the agent: unmuted and answering every turn for a minute,
            // then back to its usual policy. "awake" is the visible cue, and
            // a timer clears it so the badge matches the actual window.
            sessionState.muted = false
            sessionState.pokedUntil = Date.now() + POKE_WINDOW_MS
            setState("awake")
            if (pokeTimer) clearTimeout(pokeTimer)
            pokeTimer = setTimeout(() => {
              pokeTimer = null
              sessionState.pokedUntil = 0
              if (!sessionState.muted && !sessionState.deafened) {
                setState("listening")
              }
            }, POKE_WINDOW_MS)
            publishChat(
              "(You poked me — I'm listening and will chime in for the next minute.)",
            )
          } else if (control.type === "mute" && !sessionState.muted) {
            sessionState.muted = true
            sessionState.notifiedMuted = false
            session.interrupt()
            setState("muted")
          } else if (control.type === "unmute" && sessionState.muted) {
            sessionState.muted = false
            setState("listening")
          } else if (control.type === "deafen" && !sessionState.deafened) {
            sessionState.deafened = true
            session.input.setAudioEnabled(false)
            setState("deafened")
            publishChat(
              "(I've been deafened — I can no longer hear the meeting. You can still reach me with @mentions here.)",
            )
          } else if (control.type === "undeafen" && sessionState.deafened) {
            sessionState.deafened = false
            session.input.setAudioEnabled(true)
            sessionState.notifyUndeafened = true
            setState(sessionState.muted ? "muted" : "listening")
          }
        } catch {
          // ignore malformed control messages
        }
      } else if (topic === DataTopic.Chat) {
        try {
          const message = chatMessageSchema.parse(
            JSON.parse(new TextDecoder().decode(payload)),
          )
          if (message.from.startsWith("agent-")) return
          const mention = new RegExp(`@${entry.name}\\b`, "i")
          if (!mention.test(message.text)) {
            // Not for us directly — queue as context for the next turn.
            chatSince.push(`${message.fromName}: ${message.text}`)
            return
          }
          console.log(`[${entry.id}] chat mention from ${message.fromName}`)
          void replyInChat(message)
        } catch {
          // ignore malformed chat messages
        }
      }
    })

    // Chat mentions get a chat reply — text in, text out; tool activity
    // still streams to the activity feed.
    const replyInChat = async (message: ChatMessage) => {
      let input = `${message.fromName} (in the meeting chat — reply concisely, your reply appears in the chat): ${message.text}`
      const capture = screen.active
        ? await screen.latestJpeg().catch(() => null)
        : null
      const images = capture
        ? [{ mediaType: capture.mediaType, data: capture.data }]
        : undefined
      if (capture) {
        input = `[A current frame of ${capture.sharerName}'s shared screen is attached.]\n${input}`
      }
      setState(sessionState.muted ? "muted" : "thinking")
      try {
        let reply = ""
        for await (const frame of brain.runTurn(input, images)) {
          const at = Date.now()
          if (frame.type === "assistant") {
            reply += (reply ? "\n" : "") + frame.content
          } else if (frame.type === "tool_call") {
            publishActivity({
              type: "tool_call",
              agentId: entry.id,
              name: frame.name,
              arguments: frame.arguments,
              at,
            })
          } else if (frame.type === "tool_result") {
            publishActivity({
              type: "tool_result",
              agentId: entry.id,
              name: frame.name,
              content: frame.content.slice(0, 2000),
              durationMs: frame.durationMs,
              at,
            })
          } else if (frame.type === "error") {
            throw new Error(frame.error)
          }
        }
        if (reply) publishChat(reply)
      } catch (err) {
        const busy = err instanceof Error && /in progress/.test(err.message)
        publishChat(
          busy
            ? "(I'm mid-task right now — ask me again in a moment.)"
            : "(Sorry, I couldn't process that.)",
        )
      } finally {
        setState(sessionState.muted ? "muted" : "listening")
      }
    }

    await session.start({
      agent,
      room: ctx.room,
      // Stay in the room when the inviting participant refreshes/leaves;
      // the agent is removed explicitly or when the room empties out.
      inputOptions: { closeOnDisconnect: false },
    })

    if (entry.greeting) {
      session.say(entry.greeting)
    }

    ctx.addShutdownCallback(async () => {
      if (pokeTimer) clearTimeout(pokeTimer)
      brain.close()
    })
  },
})
