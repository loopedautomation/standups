import { z } from "zod"

/** Data-channel topics used across web and agent-bridge. */
export const DataTopic = {
  AgentActivity: "agent-activity",
  AgentControl: "agent-control",
  Chat: "chat",
} as const

/** LiveKit's built-in transcription text-stream topic. */
export const TRANSCRIPTION_TOPIC = "lk.transcription"

/** Participant attribute key holding an agent's conversational state. */
export const AGENT_STATE_ATTRIBUTE = "agent.state"

/** Participant attribute set to "1" while a human has their hand raised. */
export const HAND_ATTRIBUTE = "hand"

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
  // Poked: temporarily responding to everything, no mention needed.
  "awake",
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
    "poke",
  ]),
  agentId: z.string(),
})
export type AgentControl = z.infer<typeof agentControlSchema>

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
