import { z } from "zod"

/** Data-channel topics used across web and agent-bridge. */
export const DataTopic = {
  AgentActivity: "agent-activity",
  AgentControl: "agent-control",
  Chat: "chat",
  Doc: "doc",
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

/** Voices an agent may speak with (realtime model voices). */
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
    // Not a control the bridge acts on — removal goes through the control
    // API. Broadcast purely so the room can say who did it, like every
    // other agent control.
    "remove",
  ]),
  agentId: z.string(),
  policy: turnPolicySchema.optional(),
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
  hostKey: z.string().optional(),
  started: z.boolean().optional(),
  startedAt: z.number().optional(),
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
  id: z.string(),
  from: z.string(),
  fromName: z.string(),
  text: z.string(),
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
export const sharedDocSchema = z.object({
  text: z.string(),
  /** Increments on every accepted edit; the primary ordering. */
  rev: z.number().int().min(0),
  /** Who last wrote, so the panel can say "Scout is drafting". */
  by: z.string(),
  byName: z.string(),
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
})
export type AgentInfo = z.infer<typeof agentInfoSchema>
