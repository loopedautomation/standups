import { z } from "zod"

/** Data-channel topics used across web and agent-bridge. */
export const DataTopic = {
  AgentActivity: "agent-activity",
  AgentControl: "agent-control",
  Canvas: "canvas",
  CanvasPresence: "canvas-presence",
  Chat: "chat",
  Doc: "doc",
  DocPresence: "doc-presence",
  ScreenShare: "screen-share",
} as const

/** LiveKit's built-in transcription text-stream topic. */
export const TRANSCRIPTION_TOPIC = "lk.transcription"

/** Participant attribute key holding an agent's conversational state. */
export const AGENT_STATE_ATTRIBUTE = "agent.state"

/** Participant attribute set to "1" while a human has their hand raised. */
export const HAND_ATTRIBUTE = "hand"

/**
 * Mute and deafen are independent flags, but `agent.state` can only carry
 * one value (deafened wins) — so the flags are also published individually
 * ("1" or absent) and the controls read these, not the display state.
 */
export const AGENT_MUTED_ATTRIBUTE = "agent.muted"
export const AGENT_DEAFENED_ATTRIBUTE = "agent.deafened"

/** Participant attribute holding an agent's effective turn policy. */
export const AGENT_POLICY_ATTRIBUTE = "agent.policy"

/** "1"/"0": whether talking over this agent cuts it off (barge-in). */
export const AGENT_BARGE_IN_ATTRIBUTE = "agent.bargein"

/**
 * How a participant's camera feed should be displayed, e.g. "90,h" —
 * rotation degrees plus flip flags. Published as an attribute so every
 * client renders the same orientation with plain CSS; the encoded track
 * itself is untouched.
 */
export const VIDEO_TRANSFORM_ATTRIBUTE = "video.transform"

export type VideoTransform = {
  rotation: 0 | 90 | 180 | 270
  flipH: boolean
  flipV: boolean
}

export const defaultVideoTransform: VideoTransform = {
  rotation: 0,
  flipH: false,
  flipV: false,
}

export function serializeVideoTransform(t: VideoTransform): string {
  const parts = [String(t.rotation)]
  if (t.flipH) parts.push("h")
  if (t.flipV) parts.push("v")
  return parts.join(",")
}

export function parseVideoTransform(raw: string | undefined): VideoTransform {
  if (!raw) return defaultVideoTransform
  const parts = raw.split(",")
  const rotation = Number(parts[0])
  return {
    rotation:
      rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0,
    flipH: parts.includes("h"),
    flipV: parts.includes("v"),
  }
}

/**
 * The CSS transform for a feed, composing the published transform with the
 * local self-view mirror (mirror and flipH cancel each other out).
 */
export function videoTransformCss(
  t: VideoTransform,
  mirror = false,
): string | undefined {
  const parts: string[] = []
  if (t.rotation !== 0) parts.push(`rotate(${t.rotation}deg)`)
  if (t.flipH !== mirror) parts.push("scaleX(-1)")
  if (t.flipV) parts.push("scaleY(-1)")
  return parts.length ? parts.join(" ") : undefined
}

/**
 * Participant attribute a client sets (value "active") once its in-browser
 * WASM transcriber is loaded, warmed, and proven real-time. The server
 * transcriber skips mics whose owner advertises this and resumes them the
 * moment the attribute clears — local STT can never block transcription.
 */
export const SELF_TRANSCRIBE_ATTRIBUTE = "stt.local"
export const SELF_TRANSCRIBE_ACTIVE = "active"

/**
 * Streaming ASR models trained on GigaSpeech emit ALL-CAPS text with no
 * punctuation, while finalized utterances are properly cased — so captions
 * visibly "flip" at utterance end. Sentence-case shouty text so interims and
 * finals read alike; anything already mixed-case passes through untouched.
 */
export function tidyShoutyTranscript(text: string): string {
  const letters = text.replace(/[^a-zA-Z]/g, "")
  if (!letters || letters !== letters.toUpperCase()) return text
  return text
    .toLowerCase()
    .replace(/(^|[.!?]\s+)([a-z])/g, (m, pre, c) => pre + c.toUpperCase())
    .replace(/\bi\b/g, "I")
    .replace(/\bi'/g, "I'")
}

export const agentStateSchema = z.enum([
  "listening",
  "thinking",
  "speaking",
  "muted",
  "deafened",
  // The agent has something to contribute but its turn policy keeps it
  // quiet until a participant calls on it.
  "hand-raised",
  // Zapped: temporarily responding to everything, no mention needed.
  "zapped",
])
export type AgentState = z.infer<typeof agentStateSchema>

export const participantMetaSchema = z.object({
  // "service" participants (e.g. the platform transcriber) are invisible
  // infrastructure: no tile, no chimes, no mention picker entry. "waiting"
  // participants have knocked and sit in the waiting room until admitted.
  kind: z.enum(["human", "agent", "service", "waiting"]),
  agentId: z.string().optional(),
  // An agent's self-reported description, for URL-invited agents that aren't
  // in the registry — the only way the panel can show what they are.
  description: z.string().optional(),
  service: z.string().optional(),
})
export type ParticipantMeta = z.infer<typeof participantMetaSchema>

export function parseParticipantMeta(
  raw: string | undefined,
): ParticipantMeta | null {
  if (!raw) return null
  try {
    return participantMetaSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Voices an agent may speak with (OpenAI realtime model voices). */
export const AGENT_VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "coral",
  "sage",
  "verse",
] as const
export type AgentVoice = (typeof AGENT_VOICES)[number]

/** Prebuilt voices of Google's Gemini Live realtime models. */
export const GEMINI_VOICES = [
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Aoede",
  "Leda",
  "Orus",
  "Zephyr",
] as const

/** Voices of OpenAI's TTS models (the pipeline mode's speech output). */
export const OPENAI_TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
] as const

/**
 * How an agent decides when to speak.
 * - "open": replies whenever it hears a turn.
 * - "on-mention": stays quiet unless addressed by name or called on, and
 *   raises its hand when it has something to contribute.
 */
export const turnPolicySchema = z.enum(["open", "on-mention", "raise-hand"])
export type TurnPolicy = z.infer<typeof turnPolicySchema>

/** True for infrastructure participants that the UI should not render. */
export function isServiceParticipant(metadata: string | undefined): boolean {
  return parseParticipantMeta(metadata)?.kind === "service"
}

/** Control messages published by participants on the `agent-control` topic. */
export const agentControlSchema = z.object({
  type: z.enum([
    "mute",
    "unmute",
    "deafen",
    "undeafen",
    "interrupt",
    // Lets a hand-raised agent take its turn (see the agent turn policy).
    "call-on",
    // Wakes an agent up: it listens and responds freely for a short window,
    // then returns to its usual policy (gated agents re-gate, open agents
    // are muted).
    "zap",
    // Change how the agent takes turns for the rest of the meeting,
    // overriding the registry default. Carries `policy`.
    "set-turn-policy",
    // Allow or forbid barge-in (speech cutting the agent off mid-reply).
    // Carries `bargeIn`.
    "set-barge-in",
    // Not a control the bridge acts on — removal goes through the control
    // API. Broadcast purely so the room can say who did it, like every
    // other agent control.
    "remove",
  ]),
  agentId: z.string(),
  policy: turnPolicySchema.optional(),
  bargeIn: z.boolean().optional(),
  /**
   * Who pressed the button. Optional so older clients still parse, and
   * carried on the message rather than resolved from the sender identity:
   * the receiving side would otherwise have to keep a roster to name
   * someone who may already have left.
   */
  by: z.string().optional(),
  byName: z.string().optional(),
})
export type AgentControl = z.infer<typeof agentControlSchema>

/**
 * What non-hosts are allowed to do with agents. Agent controls are shared
 * ground by default — an agent talking over the room is everyone's problem,
 * and making only the organiser able to mute it is how a meeting derails.
 * A host who wants a tighter room can turn either off.
 */
export const roomSettingsSchema = z.object({
  participantsCanControlAgents: z.boolean().default(true),
  participantsCanInviteAgents: z.boolean().default(true),
})
export type RoomSettings = z.infer<typeof roomSettingsSchema>

export const defaultRoomSettings: RoomSettings = {
  participantsCanControlAgents: true,
  participantsCanInviteAgents: true,
}

/**
 * Room metadata, which is where settings live: unlike a data message it
 * reaches participants who join later, and LiveKit pushes changes to
 * everyone already in the room.
 */
export const roomMetadataSchema = z.object({
  /**
   * Legacy only: rooms created before the host key was removed from
   * metadata may still carry one. Never written any more — room metadata is
   * broadcast to every participant, so a secret must not live in it.
   */
  hostKey: z.string().optional(),
  started: z.boolean().optional(),
  startedAt: z.number().optional(),
  /**
   * The organiser's LiveKit identity, stamped by the host-authenticated
   * settings route so agent workers can enforce host-only controls.
   */
  hostIdentity: z.string().optional(),
  settings: roomSettingsSchema.optional(),
})
export type RoomMetadata = z.infer<typeof roomMetadataSchema>

/** Settings from raw room metadata, falling back to the defaults. */
export function parseRoomSettings(raw: string | undefined): RoomSettings {
  if (!raw) return defaultRoomSettings
  try {
    return roomSettingsSchema.parse(
      roomMetadataSchema.parse(JSON.parse(raw)).settings ?? {},
    )
  } catch {
    return defaultRoomSettings
  }
}

/** How an agent control reads in the room's activity toast. */
export function describeAgentControl(
  control: AgentControl,
  agentName: string,
): string | null {
  switch (control.type) {
    case "mute":
      return `muted ${agentName}`
    case "unmute":
      return `unmuted ${agentName}`
    case "deafen":
      return `deafened ${agentName}`
    case "undeafen":
      return `undeafened ${agentName}`
    case "interrupt":
      return `interrupted ${agentName}`
    case "call-on":
      return `called on ${agentName}`
    case "zap":
      return `zapped ${agentName}`
    case "remove":
      return `removed ${agentName} from the meeting`
    case "set-turn-policy":
      return control.policy
        ? `set ${agentName}'s response mode to ${control.policy}`
        : null
    case "set-barge-in":
      return control.bargeIn === undefined
        ? null
        : `turned barge-in ${control.bargeIn ? "on" : "off"} for ${agentName}`
    default:
      return null
  }
}

/** Events published by the bridge on the `agent-activity` data topic. */
export const agentActivityEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("step"),
    agentId: z.string(),
    n: z.number(),
    at: z.number(),
  }),
  z.object({
    type: z.literal("tool_call"),
    agentId: z.string(),
    name: z.string(),
    arguments: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal("tool_result"),
    agentId: z.string(),
    name: z.string(),
    content: z.string(),
    durationMs: z.number(),
    at: z.number(),
  }),
  z.object({
    type: z.literal("status"),
    agentId: z.string(),
    state: agentStateSchema,
    at: z.number(),
  }),
  // "Stats for nerds": the agent's pipeline configuration plus rolling
  // latency measurements, published by the bridge as they update.
  z.object({
    type: z.literal("stats"),
    agentId: z.string(),
    config: z.record(z.string(), z.string()),
    latencyMs: z.record(z.string(), z.number()),
    at: z.number(),
  }),
])
export type AgentActivityEvent = z.infer<typeof agentActivityEventSchema>
export type AgentStatsEvent = Extract<AgentActivityEvent, { type: "stats" }>

/** Messages on the `chat` data topic. */
export const chatMessageSchema = z.object({
  id: z.string().max(64),
  from: z.string().max(128),
  fromName: z.string().max(128),
  text: z.string().max(8000),
  at: z.number(),
})
export type ChatMessage = z.infer<typeof chatMessageSchema>

/**
 * The meeting's shared markdown document, on the `doc` topic.
 *
 * Whole-document updates rather than character operations: this is a plan
 * being written during a call, where the agent drafts and people edit
 * between turns, not a Google Doc with six simultaneous typists. `rev`
 * orders edits so a straggling broadcast can't resurrect stale text.
 */
/**
 * Ceiling on a document revision. Bounded so a malicious MAX_SAFE_INTEGER
 * `rev` can't freeze everyone's edits: without a cap, one huge revision
 * would make every legitimate `+1` increment overflow schema validation
 * forever. No real meeting doc approaches a billion edits.
 */
export const MAX_DOC_REV = 1_000_000_000

/** Next revision after `current`, clamped so it can never exceed the cap. */
export function nextDocRev(current: number): number {
  return Math.min(current + 1, MAX_DOC_REV)
}

/** An incoming rev clamped to at most one past what we already hold. */
export function clampIncomingDocRev(
  incomingRev: number,
  currentRev: number,
): number {
  return Math.min(incomingRev, nextDocRev(currentRev))
}

export const sharedDocSchema = z.object({
  // Char cap well above the store's byte cap — the store enforces bytes;
  // this stops a pathological payload before it's even merged.
  text: z.string().max(300_000),
  /**
   * Increments on every accepted edit; the primary ordering. Bounded by
   * MAX_DOC_REV so a malicious revision can't freeze everyone's updates.
   */
  rev: z.number().int().min(0).max(MAX_DOC_REV),
  /** Who last wrote, so the panel can say "Scout is drafting". */
  by: z.string().max(128),
  byName: z.string().max(128),
  at: z.number(),
})
export type SharedDoc = z.infer<typeof sharedDocSchema>

export const emptySharedDoc: SharedDoc = {
  text: "",
  rev: 0,
  by: "",
  byName: "",
  at: 0,
}

/**
 * Picks the winner between what we hold and what just arrived.
 *
 * Every peer runs this on the same pair and must reach the same answer, or
 * the room's copies diverge silently — which is why the tie-breaks go all
 * the way down to comparing identities rather than stopping at "whatever
 * arrived last". Two people editing the same instant means one of them
 * loses their keystroke; that's the accepted cost of not shipping a CRDT.
 */
export function mergeSharedDoc(
  current: SharedDoc,
  incoming: SharedDoc,
): SharedDoc {
  if (incoming.rev !== current.rev) {
    return incoming.rev > current.rev ? incoming : current
  }
  if (incoming.at !== current.at) {
    return incoming.at > current.at ? incoming : current
  }
  // Same revision, same millisecond: fall back to a stable comparison so
  // every participant converges on one text instead of on their own.
  return incoming.by > current.by ? incoming : current
}

/**
 * Where someone's cursor sits in the shared document right now.
 *
 * Ephemeral by design: sent lossy on the `doc-presence` topic, never
 * persisted, and pruned by receivers when it goes quiet. `start`/`end` are
 * offsets into the sender's copy of the doc text (equal for a bare caret);
 * both null means the person left the editor.
 */
export const docPresenceSchema = z.object({
  by: z.string().max(128),
  byName: z.string().max(128),
  /** The sender picks its own color so every peer renders the same one. */
  color: z.string().max(32),
  start: z.number().int().min(0).nullable(),
  end: z.number().int().min(0).nullable(),
  at: z.number(),
})
export type DocPresence = z.infer<typeof docPresenceSchema>

/** The first ten people get predefined, well-separated cursor colors. */
export const DOC_CURSOR_COLORS = [
  "#2563eb", // blue
  "#dc2626", // red
  "#16a34a", // green
  "#9333ea", // purple
  "#ea580c", // orange
  "#0891b2", // cyan
  "#db2777", // pink
  "#ca8a04", // yellow
  "#4f46e5", // indigo
  "#0d9488", // teal
] as const

/**
 * Cursor color for a participant: palette by join order for the first ten,
 * then a hue derived from the identity so late joiners still get a stable
 * color without any coordination.
 */
export function docCursorColor(identity: string, joinIndex: number): string {
  if (joinIndex >= 0 && joinIndex < DOC_CURSOR_COLORS.length) {
    return DOC_CURSOR_COLORS[joinIndex]
  }
  let hash = 0
  for (let i = 0; i < identity.length; i++) {
    hash = (hash * 31 + identity.charCodeAt(i)) | 0
  }
  return `hsl(${((hash % 360) + 360) % 360} 70% 45%)`
}

/**
 * The meeting's shared whiteboard, on the `canvas` topic.
 *
 * Where the shared doc is one LWW value, the canvas is a map of them: each
 * Excalidraw element syncs independently with its own clock, so two people
 * drawing different shapes never conflict, and the worst concurrent case —
 * both editing the same shape — costs one edit, the same accepted trade as
 * `mergeSharedDoc`. The element itself is carried opaquely; only the clock
 * is meeting-protocol. Deletions ride Excalidraw's own `isDeleted` flag,
 * which must outlive the delete broadcast so a straggling edit of a deleted
 * shape loses to the deletion instead of resurrecting it.
 */
export const canvasRecordSchema = z.object({
  /** The Excalidraw element id. */
  id: z.string(),
  /** The Excalidraw element JSON (null kept for wire compatibility). */
  record: z.record(z.string(), z.unknown()).nullable(),
  /** Bumped by the writer on every edit; the primary ordering. */
  v: z.number().int().min(0),
  at: z.number(),
  by: z.string(),
})
export type CanvasRecord = z.infer<typeof canvasRecordSchema>

/** Per-record winner pick; same convergence contract as `mergeSharedDoc`. */
export function mergeCanvasRecord(
  current: CanvasRecord | undefined,
  incoming: CanvasRecord,
): CanvasRecord {
  if (!current) return incoming
  if (incoming.v !== current.v) {
    return incoming.v > current.v ? incoming : current
  }
  if (incoming.at !== current.at) {
    return incoming.at > current.at ? incoming : current
  }
  return incoming.by > current.by ? incoming : current
}

/** A batch of record puts/tombstones on the reliable `canvas` topic. */
export const canvasDiffSchema = z.object({
  type: z.literal("diff"),
  from: z.string(),
  fromName: z.string(),
  changes: z.array(canvasRecordSchema).min(1),
})
export type CanvasDiff = z.infer<typeof canvasDiffSchema>

/**
 * The GET/PUT envelope for the bridge's canvas store. Version skew is
 * Excalidraw's problem — clients pass fetched elements through
 * `restoreElements`, so no schema descriptor rides along.
 */
export const canvasSnapshotSchema = z.object({
  records: z.array(canvasRecordSchema),
})
export type CanvasSnapshot = z.infer<typeof canvasSnapshotSchema>

export const emptyCanvasSnapshot: CanvasSnapshot = {
  records: [],
}

/** Page-space cursor on the lossy `canvas-presence` topic. */
export const canvasPresenceSchema = z.object({
  type: z.literal("cursor"),
  from: z.string(),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  at: z.number(),
  /**
   * The sender's cursor is leaving the board (an agent finished drawing).
   * Without this, a finished cursor lingers until the staleness prune.
   */
  gone: z.boolean().optional(),
})
export type CanvasPresence = z.infer<typeof canvasPresenceSchema>

// Cursor colors come from the doc's palette (`docCursorColor`) so one person
// is one color everywhere — the whiteboard adds only its own timings.
export const CANVAS_PRESENCE_THROTTLE_MS = 100
export const CANVAS_PRESENCE_HEARTBEAT_MS = 3_000
export const CANVAS_PRESENCE_STALE_MS = 8_000

/** Snapshot cap. Freehand strokes are fat; the doc's 256KB would pinch. */
export const MAX_CANVAS_BYTES = 1024 * 1024

/**
 * LiveKit reliable data messages cap out around 15KiB; diffs are chunked
 * under that. A record too big even alone still ships (the transport
 * fragments lossily rather than us silently dropping content) — callers
 * should downsample oversized freehand strokes before publishing instead.
 */
export const MAX_CANVAS_MESSAGE_BYTES = 14_000

export function chunkCanvasChanges(
  changes: CanvasRecord[],
  maxBytes = MAX_CANVAS_MESSAGE_BYTES,
): CanvasRecord[][] {
  const chunks: CanvasRecord[][] = []
  let chunk: CanvasRecord[] = []
  let size = 0
  for (const change of changes) {
    const bytes = JSON.stringify(change).length
    if (chunk.length > 0 && size + bytes > maxBytes) {
      chunks.push(chunk)
      chunk = []
      size = 0
    }
    chunk.push(change)
    size += bytes
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

/**
 * The drawing vocabulary agents use — deliberately simpler than raw canvas
 * elements (page-pixel coords, short author-chosen ids, arrows that connect
 * shapes by id). The bridge translates ops into Excalidraw elements.
 * Shared so a future brain-facing control endpoint speaks the same language.
 */
const canvasPointSchema = z.object({ x: z.number(), y: z.number() })

export const canvasColorSchema = z.enum([
  "black",
  "grey",
  "light-violet",
  "violet",
  "blue",
  "light-blue",
  "yellow",
  "orange",
  "green",
  "light-green",
  "light-red",
  "red",
  "white",
])
export type CanvasColor = z.infer<typeof canvasColorSchema>

export const canvasOpSchema = z.discriminatedUnion("op", [
  // Create ops may omit x/y: the bridge auto-places the shape in free space
  // next to existing content, which beats a voice model guessing (and
  // repeating) coordinates.
  z.object({
    op: z.literal("rect"),
    id: z.string().min(1),
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().positive(),
    h: z.number().positive(),
    label: z.string().optional(),
    color: canvasColorSchema.optional(),
    fill: z.enum(["none", "semi", "solid"]).optional(),
  }),
  z.object({
    op: z.literal("ellipse"),
    id: z.string().min(1),
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().positive(),
    h: z.number().positive(),
    label: z.string().optional(),
    color: canvasColorSchema.optional(),
    fill: z.enum(["none", "semi", "solid"]).optional(),
  }),
  z.object({
    op: z.literal("text"),
    id: z.string().min(1),
    x: z.number().optional(),
    y: z.number().optional(),
    text: z.string().min(1),
    size: z.enum(["s", "m", "l", "xl"]).optional(),
    color: canvasColorSchema.optional(),
  }),
  z.object({
    op: z.literal("note"),
    id: z.string().min(1),
    x: z.number().optional(),
    y: z.number().optional(),
    text: z.string().min(1),
    color: canvasColorSchema.optional(),
  }),
  z.object({
    op: z.literal("arrow"),
    id: z.string().min(1),
    /** Shape ids to attach the ends to; free points as the alternative. */
    from: z.string().optional(),
    to: z.string().optional(),
    fromPoint: canvasPointSchema.optional(),
    toPoint: canvasPointSchema.optional(),
    label: z.string().optional(),
    color: canvasColorSchema.optional(),
  }),
  z.object({
    op: z.literal("draw"),
    id: z.string().min(1),
    points: z.array(canvasPointSchema).min(2),
    color: canvasColorSchema.optional(),
  }),
  z.object({
    op: z.literal("move"),
    id: z.string().min(1),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    op: z.literal("update"),
    id: z.string().min(1),
    label: z.string().optional(),
    text: z.string().optional(),
    color: canvasColorSchema.optional(),
    w: z.number().positive().optional(),
    h: z.number().positive().optional(),
  }),
  z.object({
    op: z.literal("delete"),
    id: z.string().min(1),
  }),
  z.object({
    op: z.literal("clear"),
  }),
])
export type CanvasOp = z.infer<typeof canvasOpSchema>

export const canvasOpBatchSchema = z.array(canvasOpSchema).min(1).max(50)

/**
 * Only one screen share owns the stage. Starting a share broadcasts a
 * "takeover" on the `screen-share` topic; whoever else was sharing stops,
 * and viewers prefer the newest sharer. `at` breaks ties so the older share
 * yields to the newer one, never the reverse.
 */
export const screenShareControlSchema = z.object({
  type: z.literal("takeover"),
  from: z.string(),
  at: z.number(),
})
export type ScreenShareControl = z.infer<typeof screenShareControlSchema>

/** API DTOs. */
export const createRoomResponseSchema = z.object({
  slug: z.string(),
  url: z.string(),
  /**
   * Proof of being the meeting's creator. The creator's browser stores it
   * and presents it with the token request: the meeting only starts once
   * they arrive — everyone earlier sees "hasn't started yet".
   */
  hostKey: z.string().optional(),
})
export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>

export const tokenRequestSchema = z.object({
  displayName: z.string().min(1).max(64),
  /**
   * A previously issued token for this room, proving prior admission — a
   * page refresh re-enters directly instead of knocking again.
   */
  rejoinToken: z.string().optional(),
  /** The creator's key from room creation — starts the meeting on arrival. */
  hostKey: z.string().optional(),
})
export type TokenRequest = z.infer<typeof tokenRequestSchema>

export const tokenResponseSchema = z.object({
  token: z.string(),
  serverUrl: z.string(),
  identity: z.string(),
  /** How many participants were already in the room before this join. */
  participantCount: z.number().int().min(0).default(0),
  /** True when the joiner enters the waiting room pending admission. */
  waiting: z.boolean().default(false),
  /** True for the meeting's organiser — gates the agent settings UI. */
  isHost: z.boolean().default(false),
  /** Epoch ms when the room was created — anchors the call duration timer. */
  roomStartedAt: z.number().default(0),
})
export type TokenResponse = z.infer<typeof tokenResponseSchema>

export const agentInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  avatar: z.string().optional(),
  // Which voice namespace applies per interaction mode: realtime voices are
  // the provider's, pipeline voices are the TTS provider's. Absent
  // realtimeProvider means the agent defaults to pipeline mode.
  realtimeProvider: z.enum(["openai", "gemini"]).optional(),
  ttsProvider: z.enum(["openai", "elevenlabs"]).optional(),
  // Registry-configured voices, so the invite UI can pre-select the real
  // default instead of an arbitrary first list item.
  realtimeVoice: z.string().optional(),
  ttsVoice: z.string().optional(),
})
export type AgentInfo = z.infer<typeof agentInfoSchema>
