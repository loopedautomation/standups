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
  AGENT_BARGE_IN_ATTRIBUTE,
  AGENT_DEAFENED_ATTRIBUTE,
  AGENT_MUTED_ATTRIBUTE,
  AGENT_POLICY_ATTRIBUTE,
  AGENT_STATE_ATTRIBUTE,
  AGENT_VOICES,
  type AgentActivityEvent,
  type AgentState,
  agentControlSchema,
  applyDocUpdateB64,
  type CanvasDiff,
  type CanvasOp,
  type CanvasPresence,
  type CanvasRecord,
  type ChatMessage,
  canvasDiffSchema,
  chatMessageSchema,
  chunkCanvasChanges,
  DataTopic,
  type DocPresence,
  docCursorColor,
  docSyncMessageSchema,
  encodeDocDiffB64,
  mentionsName,
  mergeCanvasRecord,
  type ParticipantMeta,
  parseParticipantMeta,
  readSharedDoc,
  type SharedDoc,
  setSharedDocText,
  TRANSCRIPTION_TOPIC,
  TYPING_HEARTBEAT_MS,
  Y,
} from "@meet/shared"
import {
  CURSOR_FRAME_MS,
  caretSweep,
  cursorLeg,
  groupForReveal,
  REVEAL_BEAT_MS,
  revealLegMs,
} from "./agent-presence.js"
import { LoopedVoiceAgent, SessionState } from "./agent-session.js"
import { bargeInConfigFromEnv } from "./barge-in.js"
import { collectBrainReply } from "./brain-reply.js"
import {
  CANVAS_PROTOCOL_NOTE,
  CanvasBlockExtractor,
  parseCanvasBlock,
} from "./canvas-blocks.js"
import { buildCanvasRecords } from "./canvas-records.js"
import { controlAllowed } from "./control-auth.js"
import {
  type AgentChatOp,
  CHAT_OPS_PROTOCOL_NOTE,
  ChatOpsBlockExtractor,
  DOC_PROTOCOL_NOTE,
  DocBlockExtractor,
  extractLeaveMarker,
  LEAVE_PROTOCOL_NOTE,
  parseChatOpsBlock,
} from "./doc-blocks.js"
import {
  dynamicAgentsPublicOnly,
  getDynamicAgent,
  publicOnlyLookup,
} from "./dynamic.js"
import { GEMINI_LIVE_DEFAULT_MODEL } from "./gemini-live-session.js"
import { LoopedTtyClient } from "./looped-tty.js"
import { type Brain, LoopedWebhookClient } from "./looped-webhook.js"
import {
  describeRoster,
  fetchCanvas,
  fetchTranscript,
  formatCanvas,
  formatSharedDoc,
  formatTranscript,
  persistSharedDoc,
  postCanvasDiff,
  postDebugEvent,
  pushBounded,
  requestAgentRemoval,
  seedSharedDoc,
  withMeetingContext,
} from "./meeting-context.js"
import { runRealtimeAgent } from "./realtime-agent.js"
import { type AgentEntry, brainToken, loadRegistry } from "./registry.js"
import { attachScreenFrame, ScreenCapture } from "./screen-capture.js"

type DispatchMeta = {
  agentId: string
  // "pipeline" is the OpenAI STT/TTS pipeline; "elevenlabs" the same
  // pipeline speaking through ElevenLabs.
  mode?: "realtime" | "gemini" | "pipeline" | "elevenlabs"
  voice?: string
}

/** How long a zapped agent answers freely before its policy resumes. */
const ZAP_WINDOW_MS = 30_000

/** Barge-in thresholds, shared by the realtime and pipeline paths. */
const bargeIn = bargeInConfigFromEnv()

/** A registry entry plus, for dynamic (URL-invited) agents, its token. */
type ResolvedEntry = AgentEntry & { directToken?: string }

/**
 * Interaction mode is a meeting-level choice, not an agent-level one: any
 * brain can be fronted by either the realtime speech-to-speech layer or the
 * STT/TTS pipeline. The registry's `realtime` block is just the default;
 * a dispatch-time mode override converts in either direction.
 */
function applyMode(
  entry: ResolvedEntry,
  mode?: DispatchMeta["mode"],
): ResolvedEntry {
  if (mode === "pipeline") {
    // The OpenAI pipeline, explicitly — an agent whose registry pipeline is
    // ElevenLabs still converts, or the mode choice would silently not take.
    const tts =
      entry.tts.provider === "openai"
        ? entry.tts
        : ({
            provider: "openai",
            model: "gpt-4o-mini-tts",
            voice: "alloy",
          } as const)
    return { ...entry, realtime: undefined, tts }
  }
  if (mode === "elevenlabs") {
    const tts =
      entry.tts.provider === "elevenlabs"
        ? entry.tts
        : ({
            provider: "elevenlabs",
            model: process.env.ELEVENLABS_MODEL ?? "eleven_turbo_v2_5",
            // Registry entries pick their own voice id; the override default
            // has to name one, since ElevenLabs has no generic fallback.
            voice: process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM",
          } as const)
    return { ...entry, realtime: undefined, tts }
  }
  if (mode === "realtime" && entry.realtime?.provider !== "openai") {
    const voice = (AGENT_VOICES as readonly string[]).includes(entry.tts.voice)
      ? entry.tts.voice
      : "marin"
    return {
      ...entry,
      realtime: {
        provider: "openai" as const,
        model: process.env.REALTIME_MODEL ?? "gpt-realtime-2.1-mini",
        voice,
      },
    }
  }
  if (mode === "gemini") {
    return {
      ...entry,
      // Gemini Live cannot be gated (it always auto-responds), so choosing
      // it is also choosing an open floor — a gated registry policy would
      // otherwise kill the job at startup.
      turn_policy: "open",
      realtime:
        entry.realtime?.provider === "gemini"
          ? entry.realtime
          : {
              provider: "gemini" as const,
              model:
                process.env.GEMINI_REALTIME_MODEL ?? GEMINI_LIVE_DEFAULT_MODEL,
              voice: "Puck",
            },
    }
  }
  return entry
}

/**
 * Per-invite voice override, applied after the mode is resolved so it lands
 * on whichever layer actually speaks: the realtime model's voice or the
 * pipeline's TTS voice.
 */
function applyVoice(entry: ResolvedEntry, voice?: string): ResolvedEntry {
  if (!voice) return entry
  if (entry.realtime) {
    return { ...entry, realtime: { ...entry.realtime, voice } }
  }
  return { ...entry, tts: { ...entry.tts, voice } }
}

function entryFromMetadata(metadata: string): ResolvedEntry {
  const { agentId, mode, voice } = JSON.parse(metadata) as DispatchMeta
  if (agentId.startsWith("dyn-")) {
    const spec = getDynamicAgent(agentId)
    if (!spec) throw new Error(`unknown dynamic agent: ${agentId}`)
    const dyn = applyMode(
      {
        id: agentId,
        name: spec.name,
        description: spec.description,
        greeting: `Hi, I'm ${spec.name}.`,
        turn_policy: "open",
        brain: { kind: "tty", url: spec.url, token_env: "" },
        realtime: {
          provider: "openai" as const,
          model: process.env.REALTIME_MODEL ?? "gpt-realtime-2.1-mini",
          voice: spec.voice ?? "marin",
        },
        stt: { provider: "openai", model: "gpt-4o-mini-transcribe" },
        tts: { provider: "openai", model: "gpt-4o-mini-tts", voice: "alloy" },
        directToken: spec.token,
      },
      mode,
    )
    return applyVoice(dyn, voice)
  }
  const entry = loadRegistry().find((a) => a.id === agentId)
  if (!entry) throw new Error(`unknown agent: ${agentId}`)
  return applyVoice(applyMode(entry, mode), voice)
}

/** Accept dispatches with an agent-scoped identity and metadata. */
export async function acceptRequest(request: JobRequest): Promise<void> {
  const entry = entryFromMetadata(request.job.metadata)
  // Carry the description in participant metadata so every client can show
  // what a URL-invited agent is, not just the person who invited it — its
  // name is already the participant name, but description has no other home.
  const meta: ParticipantMeta = {
    kind: "agent",
    agentId: entry.id,
    ...(entry.description ? { description: entry.description } : {}),
  }
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
      // Dynamic (pasted-URL) agents connect through a DNS lookup that
      // refuses private addresses at dial time — the invite-time SSRF check
      // alone is bypassable by a rebinding domain. Registry agents come
      // from the operator's own config and may legitimately be internal.
      ...(entry.id.startsWith("dyn-") && dynamicAgentsPublicOnly()
        ? { lookup: publicOnlyLookup }
        : {}),
    }
    const rawBrain: Brain =
      entry.brain.kind === "tty"
        ? new LoopedTtyClient(brainOpts)
        : new LoopedWebhookClient(brainOpts)

    await ctx.connect()
    const local = ctx.room.localParticipant
    if (!local) throw new Error("no local participant after connect")

    const sessionState = new SessionState()
    sessionState.turnPolicy = entry.turn_policy
    let zapTimer: ReturnType<typeof setTimeout> | null = null

    const setState = (state: AgentState) => {
      local
        .setAttributes({ [AGENT_STATE_ATTRIBUTE]: state })
        .catch(() => undefined)
    }
    // Mute and deafen are independent — publish both flags so the UI's
    // buttons stay truthful when an agent is muted AND deafened (the single
    // state attribute can only show one of them).
    const publishFlags = () => {
      local
        .setAttributes({
          [AGENT_MUTED_ATTRIBUTE]: sessionState.muted ? "1" : "",
          [AGENT_DEAFENED_ATTRIBUTE]: sessionState.deafened ? "1" : "",
        })
        .catch(() => undefined)
    }
    /** Publish the effective turn policy so the host's toggle reflects it. */
    const publishPolicy = () => {
      local
        .setAttributes({ [AGENT_POLICY_ATTRIBUTE]: sessionState.turnPolicy })
        .catch(() => undefined)
    }
    publishPolicy()
    // Barge-in starts at the deployment default; the "set-barge-in" control
    // flips it per meeting (realtime handles its own flips in realtime-agent).
    local
      .setAttributes({
        [AGENT_BARGE_IN_ATTRIBUTE]: bargeIn.enabled ? "1" : "0",
      })
      .catch(() => undefined)
    const publishActivity = (event: AgentActivityEvent) => {
      local
        .publishData(new TextEncoder().encode(JSON.stringify(event)), {
          reliable: true,
          topic: DataTopic.AgentActivity,
        })
        .catch(() => undefined)
    }
    // The agent's own recent chat messages, so the brain can refer back to
    // them — and edit or delete them via chat-ops blocks.
    const recentChat: { id: string; text: string }[] = []
    const publishChat = (text: string) => {
      const message: ChatMessage = {
        id: `${entry.id}-${Date.now()}`,
        from: `agent-${entry.id}`,
        fromName: entry.name,
        text,
        at: Date.now(),
      }
      recentChat.push({ id: message.id, text })
      if (recentChat.length > 8) recentChat.shift()
      local
        .publishData(new TextEncoder().encode(JSON.stringify(message)), {
          reliable: true,
          topic: DataTopic.Chat,
        })
        .catch(() => undefined)
    }

    /**
     * Edit/delete one of the agent's own messages, exactly as a person
     * does: a chat op on the chat topic, authorized on every client by the
     * sender being the message's author. Restricted to ids in recentChat —
     * the brain must not even attempt to touch someone else's message.
     */
    const publishChatOp = (op: AgentChatOp): string => {
      const own = recentChat.find((m) => m.id === op.id)
      if (!own) return `"${op.id}" isn't one of your recent messages.`
      const wire =
        op.op === "edit"
          ? { op: "edit" as const, id: op.id, text: op.text, at: Date.now() }
          : { op: "delete" as const, id: op.id, at: Date.now() }
      if (op.op === "edit") own.text = op.text
      else recentChat.splice(recentChat.indexOf(own), 1)
      local
        .publishData(new TextEncoder().encode(JSON.stringify(wire)), {
          reliable: true,
          topic: DataTopic.Chat,
        })
        .catch(() => undefined)
      return op.op === "edit" ? `edited ${op.id}` : `deleted ${op.id}`
    }

    /** Leave on request: goodbye first, then a clean server-side removal. */
    const leaveMeeting = async () => {
      postDebugEvent(
        roomName,
        `agent:${entry.id}`,
        "info",
        "leaving on request",
      )
      // Let the goodbye reach speakers/chat before the tile drops.
      await sleep(2000)
      await requestAgentRemoval(roomName, entry.id)
    }

    // "typing…" while the agent composes a chat reply. A heartbeat keeps a
    // long deliberation from expiring on the clients (they prune after
    // TYPING_STALE_MS), and a crashed worker's indicator self-clears when the
    // heartbeat stops. Sending is idempotent — repeated true/false is fine.
    let typingHeartbeat: ReturnType<typeof setInterval> | null = null
    const setTyping = (typing: boolean) => {
      const beat = () =>
        publishActivity({
          type: "typing",
          agentId: entry.id,
          typing: true,
          at: Date.now(),
        })
      if (typing) {
        beat()
        if (!typingHeartbeat) {
          typingHeartbeat = setInterval(beat, TYPING_HEARTBEAT_MS)
          typingHeartbeat.unref?.()
        }
      } else {
        if (typingHeartbeat) {
          clearInterval(typingHeartbeat)
          typingHeartbeat = null
        }
        publishActivity({
          type: "typing",
          agentId: entry.id,
          typing: false,
          at: Date.now(),
        })
      }
    }

    // Vision failures used to be invisible (issue #110: "the agent acts as
    // if nothing is shared", with nothing in any log to say why). Every
    // stage change and failure now lands in the worker log and the room's
    // debug feed, where a deployment can actually see it.
    const screen = new ScreenCapture(ctx.room, undefined, {
      log: (level, message) => {
        console.log(`[${entry.id}] screen: ${message}`)
        postDebugEvent(
          roomName,
          `agent:${entry.id}`,
          level,
          `screen: ${message}`,
        )
      },
    })

    // The agent's visible hand. Presence frames are lossy fire-and-forget,
    // and animations queue so overlapping tool calls play out in order
    // rather than teleporting the cursor around.
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms))
    let presenceChain: Promise<void> = Promise.resolve()
    const queuePresence = (run: () => Promise<void>) => {
      presenceChain = presenceChain.then(run).catch(() => undefined)
    }
    const publishLossy = (topic: string, payload: unknown) => {
      local
        .publishData(new TextEncoder().encode(JSON.stringify(payload)), {
          reliable: false,
          topic,
        })
        .catch(() => undefined)
    }
    const agentCursorColor = docCursorColor(`agent-${entry.id}`, -1)

    // The worker's replica of the shared document CRDT: seeded from the
    // store, kept current by every doc-sync broadcast, and the base for the
    // agent's own writes.
    const docYDoc = new Y.Doc()
    // The doc state as of the brain's last read. The brain replies with a
    // COMPLETE document composed from that read — humans may have typed
    // since. Splicing its reply against this frozen base and merging the
    // fork back in turns the staleness into ordinary CRDT concurrency:
    // the human's mid-think edit and the agent's rewrite both land.
    let docReadState: Uint8Array | null = null
    const readDocText = async (): Promise<string> => {
      await seedSharedDoc(roomName, docYDoc)
      docReadState = Y.encodeStateAsUpdate(docYDoc)
      return readSharedDoc(docYDoc).text
    }

    /**
     * Write the shared document and tell the room. Persisting alone isn't
     * enough — anyone with the Doc panel open is watching the data channel,
     * and would keep showing the old text until they reloaded.
     */
    const publishDoc = async (text: string): Promise<string> => {
      await seedSharedDoc(roomName, docYDoc)
      const base = new Y.Doc()
      Y.applyUpdate(base, docReadState ?? Y.encodeStateAsUpdate(docYDoc))
      const before = Y.encodeStateVector(docYDoc)
      const changed = setSharedDocText(base, text, {
        by: `agent-${entry.id}`,
        byName: entry.name,
      })
      Y.applyUpdate(docYDoc, Y.encodeStateAsUpdate(base))
      if (!changed) return "The document already reads exactly like that."
      await persistSharedDoc(roomName, docYDoc)
      local
        .publishData(
          new TextEncoder().encode(
            JSON.stringify({
              type: "doc-sync",
              update: encodeDocDiffB64(docYDoc, before),
            }),
          ),
          {
            reliable: true,
            topic: DataTopic.Doc,
          },
        )
        .catch(() => undefined)
      // The agent's caret sweeps through what it just wrote, then leaves —
      // the update lands instantly; this is how the room sees who did it.
      queuePresence(async () => {
        const caret = (start: number | null, end: number | null) => {
          const presence: DocPresence = {
            by: `agent-${entry.id}`,
            byName: entry.name,
            color: agentCursorColor,
            start,
            end,
            at: Date.now(),
          }
          publishLossy(DataTopic.DocPresence, presence)
        }
        for (const offset of caretSweep(text.length, 14)) {
          caret(offset, offset)
          await sleep(90)
        }
        await sleep(400)
        caret(null, null)
      })
      return "Saved. Everyone can see the updated document."
    }

    // The worker's own view of the whiteboard, seeded at join and kept
    // current from broadcast diffs and the agent's own draws. Exists so
    // pipeline turns can describe the board synchronously (the context
    // injector below can't await a fetch).
    const canvasCache = new Map<string, CanvasRecord>()
    const mergeIntoCanvasCache = (changes: CanvasRecord[]) => {
      for (const change of changes) {
        canvasCache.set(
          change.id,
          mergeCanvasRecord(canvasCache.get(change.id), change),
        )
      }
    }

    /**
     * Draw on the shared whiteboard and tell the room, mirroring publishDoc:
     * persist first (so a client that reacts to the broadcast and refetches
     * sees a store at least as new), then broadcast the same diff message
     * clients exchange among themselves.
     */
    const publishCanvasOps = async (ops: CanvasOp[]): Promise<string> => {
      // Build against the store merged into the live cache, not the store
      // alone: client snapshot PUTs trail their edits by seconds, and an
      // agent drawing from that stale view both misplaces shapes and bases
      // its LWW clocks low enough to revert a move or delete a person made
      // moments ago. The cache has their broadcast diffs the instant they
      // happen.
      const snapshot = await fetchCanvas(roomName)
      mergeIntoCanvasCache(snapshot.records)
      const { changes, summary, warnings } = buildCanvasRecords(
        ops,
        canvasCache,
        { identity: `agent-${entry.id}`, name: entry.name },
      )
      if (changes.length === 0) {
        return `Nothing was drawn. ${warnings.join(" ")}`.trim()
      }
      const diff: CanvasDiff = {
        type: "diff",
        from: `agent-${entry.id}`,
        fromName: entry.name,
        changes,
      }
      if (!(await postCanvasDiff(roomName, diff))) {
        return "The drawing couldn't be saved."
      }
      mergeIntoCanvasCache(changes)
      // The full batch is already durable; the room watches it appear shape
      // by shape, the agent's cursor gliding to each one first. Queued and
      // unawaited so the model keeps talking while its hand draws.
      const broadcast = (batch: typeof changes) => {
        for (const chunk of chunkCanvasChanges(batch)) {
          local
            .publishData(
              new TextEncoder().encode(
                JSON.stringify({ ...diff, changes: chunk }),
              ),
              { reliable: true, topic: DataTopic.Canvas },
            )
            .catch(() => undefined)
        }
      }
      const cursor = (x: number, y: number, gone = false) => {
        const presence: CanvasPresence = {
          type: "cursor",
          from: `agent-${entry.id}`,
          name: entry.name,
          x,
          y,
          at: Date.now(),
          ...(gone ? { gone } : {}),
        }
        publishLossy(DataTopic.CanvasPresence, presence)
      }
      queuePresence(async () => {
        const groups = groupForReveal(changes)
        const legMs = revealLegMs(groups.length)
        const steps = Math.max(2, Math.round(legMs / CURSOR_FRAME_MS))
        let from = groups.find((g) => g.at)?.at ?? null
        for (const group of groups) {
          if (group.at && from) {
            for (const frame of cursorLeg(from, group.at, steps)) {
              cursor(frame.x, frame.y)
              await sleep(CURSOR_FRAME_MS)
            }
            from = group.at
          }
          broadcast(group.changes)
          await sleep(REVEAL_BEAT_MS)
        }
        if (from) cursor(from.x, from.y, true)
      })
      return [summary, ...warnings].join(" ").trim()
    }
    const readCanvas = async (): Promise<string> => {
      mergeIntoCanvasCache((await fetchCanvas(roomName)).records)
      return (
        formatCanvas({ records: [...canvasCache.values()] }) ||
        "The whiteboard is empty."
      )
    }

    // Meeting context: what was said before the agent joined (from the
    // control API's transcript store) plus who's in the room. Wrapping the
    // brain injects it into the first turn on every path — voice, chat
    // mention, or realtime ask_agent delegation.
    const priorTranscript = formatTranscript(await fetchTranscript(roomName))
    await readDocText()
    const priorDoc = formatSharedDoc(readSharedDoc(docYDoc))
    const canvasSnapshot = await fetchCanvas(roomName)
    mergeIntoCanvasCache(canvasSnapshot.records)
    const priorCanvas = formatCanvas(canvasSnapshot)
    const meetingContext = [
      `Participants in the meeting when you joined: ${describeRoster(ctx.room)}.`,
      priorDoc,
      priorCanvas,
      // Say so explicitly: an agent that doesn't know a share exists can't
      // offer to look at it, and one that doesn't know it's blind will
      // happily invent what's on screen.
      screen.enabled && entry.brain.kind === "tty"
        ? "You can see screenshares in this meeting — a current frame is attached whenever someone is sharing."
        : "You cannot see screenshares in this meeting. If someone asks about their screen, say so rather than guessing.",
      priorTranscript
        ? `Transcript of the meeting before you joined:\n${priorTranscript}`
        : "",
      // Realtime brains write the doc and canvas through the voice model's
      // tools instead; telling them about marker blocks would have them wrap
      // ordinary replies in one.
      entry.realtime ? "" : DOC_PROTOCOL_NOTE,
      entry.realtime ? "" : CANVAS_PROTOCOL_NOTE,
      // Realtime agents leave via their leave_meeting tool instead.
      entry.realtime ? "" : LEAVE_PROTOCOL_NOTE,
    ]
      .filter(Boolean)
      .join("\n\n")
    // Chat messages the brain hasn't seen yet; drained into its next turn so
    // pipeline agents follow the room's text chat, not just @mentions.
    const chatSince: string[] = []
    // What the room said and did since the brain last ran — spoken turns,
    // chat, roster changes. Fed by the realtime branch below, so a brain
    // fronted by a speech-to-speech model stays part of the conversation
    // itself rather than seeing only what the voice model forwards. (The
    // pipeline path leaves it empty: its brain hears every turn directly,
    // and the room transcriber's copy would duplicate them.)
    const heardSince: string[] = []
    // Latest shared-doc edit by someone else (pipeline path only): the brain
    // has no read tool, so without this it would rewrite from the stale copy
    // it saw at join time and clobber everything typed since.
    let docSince: SharedDoc | null = null
    // Same for the whiteboard: who last drew since the brain's last turn
    // (pipeline path only), so the fresh board rides into the next turn.
    let canvasSinceBy: string | null = null
    // Outcomes of the brain's own canvas blocks — where shapes landed,
    // auto-placement nudges, validation errors. A marker block can't return
    // a value mid-turn, so results ride into the next one.
    const canvasOutcomes: string[] = []
    const brain = withMeetingContext(rawBrain, meetingContext, () => {
      const parts: string[] = []
      if (docSince) {
        parts.push(
          `[${docSince.byName || docSince.by} updated the shared document. ${formatSharedDoc(docSince)}]`,
        )
        // The brain is about to see this text — writes it makes now are
        // composed against it, so future splices diff from here.
        docReadState = Y.encodeStateAsUpdate(docYDoc)
        docSince = null
      }
      const outcomes = canvasOutcomes.splice(0)
      if (outcomes.length) {
        parts.push(
          `[Whiteboard results from your last turn:]\n${outcomes.join("\n")}`,
        )
      }
      if (canvasSinceBy) {
        parts.push(
          `[${canvasSinceBy} drew on the whiteboard. ${
            formatCanvas({ records: [...canvasCache.values()] }) ||
            "The whiteboard is now empty."
          }]`,
        )
        canvasSinceBy = null
      }
      const heard = heardSince.splice(0)
      if (heard.length) {
        parts.push(
          `[Heard in the meeting since your last turn:]\n${heard.join("\n")}`,
        )
      }
      const lines = chatSince.splice(0)
      if (lines.length) {
        parts.push(`[Meeting chat since your last turn:]\n${lines.join("\n")}`)
      }
      return parts.join("\n\n")
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

    /**
     * A canvas marker block from the brain: validate, draw through the same
     * path the realtime tool uses, and buffer the outcome (positions,
     * auto-placement nudges, validation errors) for the brain's next turn.
     */
    const drawCanvasBlock = async (block: string): Promise<string> => {
      const parsed = parseCanvasBlock(block)
      const outcome =
        "error" in parsed
          ? `${parsed.error} Fix the block and try again.`
          : await publishCanvasOps(parsed.ops)
      pushBounded(canvasOutcomes, outcome)
      return outcome
    }

    /**
     * Chat mentions get a chat reply — text in, text out, straight to the
     * brain; tool activity streams to the activity feed. Shared by both
     * paths: pipeline agents have no other chat channel, and realtime
     * agents route chat here too so the brain's judgment, tools and
     * marker-block powers (doc edits, drawings) answer instead of the
     * voice model. Returns the posted text so the realtime layer can tell
     * its voice model what "it" said in chat.
     */
    const replyInChat = async (
      message: ChatMessage,
    ): Promise<string | null> => {
      // The brain sees its own recent messages by id, so "delete that" and
      // "fix the typo" resolve to concrete chat ops.
      const ownChat = recentChat.length
        ? `\n[Your recent chat messages — ${recentChat
            .map((m) => `(id ${m.id}) "${m.text.slice(0, 80)}"`)
            .join(
              ", ",
            )}]\n[${CHAT_OPS_PROTOCOL_NOTE}]\n[${LEAVE_PROTOCOL_NOTE}]`
        : `\n[${LEAVE_PROTOCOL_NOTE}]`
      const { text: input, images } = await attachScreenFrame(
        screen,
        `${message.fromName} (in the meeting chat — reply concisely, your reply appears in the chat): ${message.text}${ownChat}`,
      )
      setState(sessionState.muted ? "muted" : "thinking")
      setTyping(true)
      try {
        const reply = await collectBrainReply(
          brain.runTurn(input, images),
          (frame) => {
            const at = Date.now()
            if (frame.type === "tool_call") {
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
                content: frame.content.slice(0, 8000),
                durationMs: frame.durationMs,
                at,
              })
            }
          },
        )
        // Chat-asked doc edits and drawings come back as marker blocks too —
        // act on them and keep them out of the chat.
        const { spoken: afterDocs, blocks: docs } =
          new DocBlockExtractor().feed(reply)
        for (const doc of docs) {
          const outcome = await publishDoc(doc)
          publishActivity({
            type: "tool_result",
            agentId: entry.id,
            name: "update_shared_doc",
            content: outcome,
            durationMs: 0,
            at: Date.now(),
          })
        }
        const { spoken: afterCanvas, blocks: drawings } =
          new CanvasBlockExtractor().feed(afterDocs)
        for (const block of drawings) {
          const outcome = await drawCanvasBlock(block)
          publishActivity({
            type: "tool_result",
            agentId: entry.id,
            name: "draw_on_canvas",
            content: outcome,
            durationMs: 0,
            at: Date.now(),
          })
        }
        // Edits/deletes of the agent's own messages ride the same way.
        const { spoken: afterChatOps, blocks: chatOpsBlocks } =
          new ChatOpsBlockExtractor().feed(afterCanvas)
        let opsApplied = 0
        for (const block of chatOpsBlocks) {
          const parsed = parseChatOpsBlock(block)
          const outcomes =
            "error" in parsed
              ? [parsed.error]
              : parsed.ops.map((op) => {
                  const outcome = publishChatOp(op)
                  if (/^(edited|deleted)/.test(outcome)) opsApplied++
                  return outcome
                })
          publishActivity({
            type: "tool_result",
            agentId: entry.id,
            name: "chat_message_ops",
            content: outcomes.join(" "),
            durationMs: 0,
            at: Date.now(),
          })
        }
        const { text: spoken, leave } = extractLeaveMarker(afterChatOps)
        const posted = spoken.trim()
          ? spoken.trim()
          : docs.length
            ? "(I've updated the shared document.)"
            : drawings.length
              ? "(I've drawn on the whiteboard.)"
              : opsApplied || leave
                ? null
                : null
        if (posted) publishChat(posted)
        if (leave) void leaveMeeting()
        return posted
      } catch (err) {
        const busy = err instanceof Error && /in progress/.test(err.message)
        publishChat(
          busy
            ? "(I'm mid-task right now — ask me again in a moment.)"
            : "(Sorry, I couldn't process that.)",
        )
        return null
      } finally {
        setTyping(false)
        setState(sessionState.muted ? "muted" : "listening")
      }
    }

    // Realtime agents: a speech-to-speech model is the interaction layer and
    // the brain handles tool work — no STT/TTS pipeline at all.
    if (entry.realtime) {
      // The brain's ears: every finalized utterance in the room (the room
      // transcriber's segments) lands in the heard buffer, so each brain
      // turn carries the conversation itself, not just the voice model's
      // summary of it.
      ctx.room.registerTextStreamHandler(
        TRANSCRIPTION_TOPIC,
        (reader, info) => {
          void (async () => {
            try {
              if (info.identity === `agent-${entry.id}`) return
              const attrs = reader.info.attributes
              if (attrs?.["lk.transcription_final"] !== "true") return
              const text = (await reader.readAll()).trim()
              if (!text) return
              const speaker = [...ctx.room.remoteParticipants.values()].find(
                (p) => p.identity === info.identity,
              )
              pushBounded(
                heardSince,
                `${speaker?.name || info.identity}: ${text}`,
              )
            } catch {
              // stream aborted mid-read; nothing to record
            }
          })()
        },
      )
      const noteRoster =
        (verb: string) =>
        (p: { identity: string; name?: string; metadata?: string }) => {
          const meta = parseParticipantMeta(p.metadata)
          if (meta?.kind === "service" || meta?.kind === "waiting") return
          pushBounded(
            heardSince,
            `[${p.name || p.identity} ${verb} the meeting]`,
          )
        }
      ctx.room.on("participantConnected", noteRoster("joined"))
      ctx.room.on("participantDisconnected", noteRoster("left"))
      // Chat handling lives with the realtime session: every room chat
      // message is surfaced to the model as context, and it posts replies
      // itself via the send_chat_message tool (see realtime-agent.ts). The
      // heard buffer gets a copy too, so the brain follows the chat as well.
      ctx.room.on("dataReceived", (payload: Uint8Array, sender, _k, topic) => {
        if (topic === DataTopic.Chat) {
          try {
            const message = chatMessageSchema.parse(
              JSON.parse(new TextDecoder().decode(payload)),
            )
            // Attribution from the actual LiveKit sender — the payload's
            // claimed name would let anyone put words in another's mouth
            // inside the model's context.
            if (sender && !sender.identity.startsWith("agent-")) {
              pushBounded(
                heardSince,
                `${sender.name || sender.identity} (in chat): ${message.text}`,
              )
            }
          } catch {}
          return
        }
        if (topic !== DataTopic.AgentControl) return
        // Enforced here, not just in the UI: only an admitted human — and
        // only the host when they've reserved controls — may drive agents.
        if (!controlAllowed(ctx.room, sender)) return
        try {
          const control = agentControlSchema.parse(
            JSON.parse(new TextDecoder().decode(payload)),
          )
          if (control.agentId !== entry.id) return
          if (control.type === "set-turn-policy" && control.policy) {
            sessionState.turnPolicy = control.policy
            publishPolicy()
            return
          }
          if (control.type === "mute") sessionState.muted = true
          else if (control.type === "unmute") sessionState.muted = false
          else if (control.type === "deafen") sessionState.deafened = true
          else if (control.type === "undeafen") sessionState.deafened = false
          // Only these four own the state attribute here; zap, call-on and
          // interrupt are handled in realtime-agent.ts and would otherwise
          // have their state (e.g. "zapped") clobbered by this handler.
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
          publishFlags()
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
        // Half-duplex keeps room audio away from the realtime model while it
        // speaks, so barge-in has to be heard locally. Same prewarmed VAD the
        // pipeline path uses for turn detection.
        vad: ctx.proc.userData.vad as silero.VAD | undefined,
        readDoc: readDocText,
        writeDoc: publishDoc,
        readCanvas,
        drawCanvas: publishCanvasOps,
        context: meetingContext,
        // Chat @mentions go to the brain, not the voice model: the brain's
        // tools, memory, and marker blocks (doc edits, drawings) can answer
        // a chat request; the voice model only gets told what was said.
        onChatMention: replyInChat,
        leaveMeeting,
        onSpoke: (text) =>
          pushBounded(heardSince, `${entry.name} (you, aloud): ${text}`),
      })
      return
    }

    // Seconds, matching how the knob has always been documented and set —
    // the SDK's own field is milliseconds.
    const endpointMinDelayMs =
      Number(process.env.PIPELINE_ENDPOINT_MIN_DELAY ?? 4) * 1000

    const agent = new LoopedVoiceAgent(
      entry,
      brain,
      sessionState,
      {
        publishActivity,
        publishChat,
        setState,
        writeDoc: publishDoc,
        drawCanvas: drawCanvasBlock,
        leave: () => void leaveMeeting(),
      },
      screen,
      { roster: () => describeRoster(ctx.room) },
    )

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      // OpenAI STT finalizes transcripts slowly; with the default endpointing
      // delay turns get committed while their transcript is still empty, so
      // the agent hears nothing (llmNode sees no user input) even though the
      // transcription panel later shows the text.
      // 2s still lost the race in practice (empty-transcript turns → the
      // agent hears nothing at all); 4s is sluggish but reliable. Tunable
      // because it's a latency/reliability trade per deployment.
      turnHandling: {
        endpointing: {
          minDelay: endpointMinDelayMs,
          // maxDelay is the hard stop on a turn, and its default (3s) sits
          // below the delay above — leave it and the turn fires early,
          // making minDelay look like it did nothing.
          maxDelay: Math.max(endpointMinDelayMs + 1000, 3000),
        },
        // Barge-in for the pipeline path. The SDK enables interruptions by
        // default; this pins the same thresholds the realtime path uses, so
        // both modes feel alike and tune from one place.
        interruption: {
          enabled: bargeIn.enabled,
          minDuration: bargeIn.minSpeechMs,
        },
      },
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
        "barge-in": bargeIn.enabled
          ? `vad, ${bargeIn.minSpeechMs}ms sustained`
          : "off (manual interrupt only)",
        vision:
          screen.enabled && entry.brain.kind === "tty"
            ? "screenshare frame attached to every turn"
            : screen.enabled
              ? "off (brain is webhook; images are dropped)"
              : "off (AGENT_SCREEN_VISION)",
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
    // While zapped, "listening" reads as "zapped" so the indicator stays up
    // for the whole window instead of clearing after the first turn.
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (sessionState.muted) return
      const map: Record<string, AgentState> = {
        listening:
          Date.now() < sessionState.zappedUntil ? "zapped" : "listening",
        thinking: "thinking",
        speaking: "speaking",
      }
      const mapped = map[ev.newState]
      if (mapped) setState(mapped)
    })

    // Mute/unmute controls and chat @-mentions arrive over data topics.
    ctx.room.on("dataReceived", (payload: Uint8Array, sender, _k, topic) => {
      if (topic === DataTopic.AgentControl) {
        // Enforced here, not just in the UI: only an admitted human — and
        // only the host when they've reserved controls — may drive agents.
        if (!controlAllowed(ctx.room, sender)) return
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
          } else if (control.type === "set-turn-policy" && control.policy) {
            sessionState.turnPolicy = control.policy
            publishPolicy()
          } else if (
            control.type === "set-barge-in" &&
            control.bargeIn !== undefined
          ) {
            // The SDK reads interruption config live from its options; there
            // is no public setter, so reach through the deprecated alias.
            try {
              ;(
                session.options as unknown as { allowInterruptions?: boolean }
              ).allowInterruptions = control.bargeIn
            } catch {}
            local
              .setAttributes({
                [AGENT_BARGE_IN_ATTRIBUTE]: control.bargeIn ? "1" : "0",
              })
              .catch(() => undefined)
          } else if (control.type === "zap") {
            // Wake the agent: unmuted and answering every turn for the zap
            // window, then back to its usual policy. "zapped" is the visible
            // cue, and a timer clears it so the badge matches the window.
            sessionState.muted = false
            sessionState.zappedUntil = Date.now() + ZAP_WINDOW_MS
            setState("zapped")
            if (zapTimer) clearTimeout(zapTimer)
            zapTimer = setTimeout(() => {
              zapTimer = null
              sessionState.zappedUntil = 0
              if (!sessionState.muted && !sessionState.deafened) {
                setState("listening")
              }
            }, ZAP_WINDOW_MS)
            publishChat(
              "(You zapped me — I'm listening and will chime in for the next 30 seconds.)",
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
          if (["mute", "unmute", "deafen", "undeafen"].includes(control.type)) {
            publishFlags()
          }
        } catch {
          // ignore malformed control messages
        }
      } else if (topic === DataTopic.Chat) {
        try {
          const message = chatMessageSchema.parse(
            JSON.parse(new TextDecoder().decode(payload)),
          )
          // Attribution from the actual LiveKit sender, not payload claims.
          if (!sender || sender.identity.startsWith("agent-")) return
          const senderName = sender.name || sender.identity
          if (!mentionsName(message.text, entry.name)) {
            // Not for us directly — queue as context for the next turn.
            chatSince.push(`${senderName}: ${message.text}`)
            return
          }
          console.log(`[${entry.id}] chat mention from ${senderName}`)
          void replyInChat({ ...message, fromName: senderName })
        } catch {
          // ignore malformed chat messages
        }
      } else if (topic === DataTopic.Doc) {
        // Someone else edited the shared document: fold their CRDT update
        // into the worker's replica. Own writes never arrive here — LiveKit
        // doesn't echo data back to the sender.
        try {
          const msg = docSyncMessageSchema.parse(
            JSON.parse(new TextDecoder().decode(payload)),
          )
          applyDocUpdateB64(docYDoc, msg.update)
          const view = readSharedDoc(docYDoc)
          docSince = {
            ...view,
            byName: sender?.name || sender?.identity || view.byName,
          }
        } catch {
          // ignore malformed doc messages
        }
      } else if (topic === DataTopic.Canvas) {
        // Someone else drew (clients and agents broadcast element diffs).
        // Folded into the worker's cache so the brain's next turn can carry
        // a fresh description of the board.
        try {
          const diff = canvasDiffSchema.parse(
            JSON.parse(new TextDecoder().decode(payload)),
          )
          mergeIntoCanvasCache(diff.changes)
          canvasSinceBy = sender?.name || sender?.identity || diff.fromName
        } catch {
          // ignore malformed canvas messages
        }
      }
    })

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
      if (zapTimer) clearTimeout(zapTimer)
      brain.close()
    })
  },
})
