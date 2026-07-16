"use client"

import { useDataChannel, useParticipants } from "@livekit/components-react"
import {
  type AgentActivityEvent,
  type AgentControl,
  DataTopic,
  parseParticipantMeta,
} from "@meet/shared"
import { useStore } from "@nanostores/react"
import type { Participant } from "livekit-client"
import { Bot, Mic, MicOff, Plus, UserX, Wrench } from "lucide-react"
import { useAgentState } from "@/components/room/AgentBadge"
import { useAgentInvite } from "@/hooks/mutations/useAgentInvite"
import { useAgents } from "@/hooks/queries/useAgents"
import { $agentActivity } from "@/stores/roomData"

export function AgentsPanel({ slug }: { slug: string }) {
  const { data: agents = [], isLoading } = useAgents()
  const participants = useParticipants()
  const invite = useAgentInvite(slug)
  const activity = useStore($agentActivity)

  const { send: sendControl } = useDataChannel(DataTopic.AgentControl)

  const agentParticipants = new Map(
    participants
      .map((p) => [parseParticipantMeta(p.metadata)?.agentId, p] as const)
      .filter(([id]) => id),
  )

  return (
    <div className="flex h-full flex-col">
      <ul className="space-y-2 p-4">
        {isLoading && (
          <li className="text-base-content/50 text-sm">Loading agents…</li>
        )}
        {!isLoading && agents.length === 0 && (
          <li className="text-base-content/50 text-sm">
            No agents registered. Add them to agents.yaml.
          </li>
        )}
        {agents.map((agent) => {
          const participant = agentParticipants.get(agent.id)
          return (
            <li
              key={agent.id}
              className="flex items-center gap-3 rounded-field bg-base-200 p-3"
            >
              <Bot className="size-5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-sm">{agent.name}</p>
                {agent.description && (
                  <p className="truncate text-base-content/60 text-xs">
                    {agent.description}
                  </p>
                )}
              </div>
              {participant ? (
                <InRoomControls
                  agentId={agent.id}
                  participant={participant}
                  onRemove={() =>
                    invite.mutate({ agentId: agent.id, action: "remove" })
                  }
                  sendControl={(control) =>
                    sendControl(
                      new TextEncoder().encode(JSON.stringify(control)),
                      { topic: DataTopic.AgentControl, reliable: true },
                    )
                  }
                />
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={invite.isPending}
                  onClick={() =>
                    invite.mutate({ agentId: agent.id, action: "invite" })
                  }
                >
                  <Plus className="size-4" />
                  Invite
                </button>
              )}
            </li>
          )
        })}
      </ul>

      <div className="border-base-300 border-t px-4 py-2 font-medium text-base-content/60 text-xs uppercase tracking-wide">
        Activity
      </div>
      <ActivityFeed activity={activity} />
    </div>
  )
}

function InRoomControls({
  agentId,
  participant,
  onRemove,
  sendControl,
}: {
  agentId: string
  participant: Participant
  onRemove: () => void
  sendControl: (control: AgentControl) => void
}) {
  const state = useAgentState(participant)
  const muted = state === "muted"

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className={`btn btn-circle btn-sm ${muted ? "btn-warning" : "btn-ghost"}`}
        aria-label={muted ? "Unmute agent" : "Mute agent"}
        onClick={() =>
          sendControl({ type: muted ? "unmute" : "mute", agentId })
        }
      >
        {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-circle btn-sm text-error"
        aria-label="Remove agent from meeting"
        onClick={onRemove}
      >
        <UserX className="size-4" />
      </button>
    </div>
  )
}

function ActivityFeed({ activity }: { activity: AgentActivityEvent[] }) {
  if (activity.length === 0) {
    return (
      <p className="px-4 py-2 text-base-content/50 text-sm">
        Tool calls will appear here while an agent works.
      </p>
    )
  }
  return (
    <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 pb-4">
      {activity
        .filter((e) => e.type === "tool_call" || e.type === "tool_result")
        .map((e) => (
          <li
            key={`${e.type}-${e.at}`}
            className="rounded-field bg-base-200 p-2 font-mono text-xs"
          >
            <span className="flex items-center gap-1 text-primary">
              <Wrench className="size-3" />
              {e.type === "tool_call" ? `→ ${e.name}` : `← ${e.name}`}
              {e.type === "tool_result" && (
                <span className="text-base-content/50">{e.durationMs}ms</span>
              )}
            </span>
            <span className="line-clamp-3 break-all text-base-content/70">
              {e.type === "tool_call" ? e.arguments : e.content}
            </span>
          </li>
        ))}
    </ul>
  )
}
