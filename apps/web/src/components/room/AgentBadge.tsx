"use client"

import { useParticipantAttributes } from "@livekit/components-react"
import {
  AGENT_STATE_ATTRIBUTE,
  type AgentState,
  agentStateSchema,
} from "@meet/shared"
import type { Participant } from "livekit-client"
import { Bot, EarOff, Hand, MicOff, Zap } from "lucide-react"

const stateLabel: Record<AgentState, string> = {
  listening: "listening",
  thinking: "thinking…",
  speaking: "speaking",
  muted: "muted",
  deafened: "deafened",
  "hand-raised": "hand raised",
  awake: "awake",
}

export function useAgentState(participant: Participant): AgentState {
  const { attributes } = useParticipantAttributes({ participant })
  const parsed = agentStateSchema.safeParse(attributes?.[AGENT_STATE_ATTRIBUTE])
  return parsed.success ? parsed.data : "listening"
}

export function AgentBadge({ participant }: { participant: Participant }) {
  const state = useAgentState(participant)

  return (
    <span
      className={`badge badge-sm gap-1 ${
        state === "muted" ||
        state === "deafened" ||
        state === "hand-raised" ||
        state === "awake"
          ? "badge-warning"
          : "badge-primary"
      }`}
    >
      {state === "muted" ? (
        <MicOff className="size-3" />
      ) : state === "deafened" ? (
        <EarOff className="size-3" />
      ) : state === "hand-raised" ? (
        <Hand className="size-3" />
      ) : state === "awake" ? (
        <Zap className="size-3" />
      ) : (
        <Bot className="size-3" />
      )}
      {stateLabel[state]}
      {state === "thinking" && (
        <span className="loading loading-dots loading-xs" />
      )}
    </span>
  )
}
