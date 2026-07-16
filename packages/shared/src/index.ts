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

export const agentStateSchema = z.enum([
  "listening",
  "thinking",
  "speaking",
  "muted",
])
export type AgentState = z.infer<typeof agentStateSchema>

export const participantMetaSchema = z.object({
  kind: z.enum(["human", "agent"]),
  agentId: z.string().optional(),
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

/** Control messages published by participants on the `agent-control` topic. */
export const agentControlSchema = z.object({
  type: z.enum(["mute", "unmute"]),
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
])
export type AgentActivityEvent = z.infer<typeof agentActivityEventSchema>

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
})
export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>

export const tokenRequestSchema = z.object({
  displayName: z.string().min(1).max(64),
})
export type TokenRequest = z.infer<typeof tokenRequestSchema>

export const tokenResponseSchema = z.object({
  token: z.string(),
  serverUrl: z.string(),
  identity: z.string(),
  /** How many participants were already in the room before this join. */
  participantCount: z.number().int().min(0).default(0),
})
export type TokenResponse = z.infer<typeof tokenResponseSchema>

export const agentInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  avatar: z.string().optional(),
})
export type AgentInfo = z.infer<typeof agentInfoSchema>
