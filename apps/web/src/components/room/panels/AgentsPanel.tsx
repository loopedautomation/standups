"use client"

import { useDataChannel, useParticipants } from "@livekit/components-react"
import {
  AGENT_VOICES,
  type AgentActivityEvent,
  type AgentControl,
  DataTopic,
  parseParticipantMeta,
} from "@meet/shared"
import { useStore } from "@nanostores/react"
import type { Participant } from "livekit-client"
import {
  Bot,
  Ear,
  EarOff,
  Mic,
  MicOff,
  Plus,
  UserX,
  Wrench,
} from "lucide-react"
import { useState } from "react"
import { toast } from "react-toastify"
import { useAgentState } from "@/components/room/AgentBadge"
import { useAgentInvite } from "@/hooks/mutations/useAgentInvite"
import { useAgents } from "@/hooks/queries/useAgents"
import { $agentActivity, $agentStats } from "@/stores/roomData"

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

      <InviteByUrl slug={slug} />

      <StatsForNerds agents={agents} />

      <div className="border-base-300 border-t px-4 py-2 font-medium text-base-content/60 text-xs uppercase tracking-wide">
        Activity
      </div>
      <ActivityFeed activity={activity} />
    </div>
  )
}

/** Per-agent pipeline configuration + live latency, LiveKit-benchmark style. */
function StatsForNerds({ agents }: { agents: { id: string; name: string }[] }) {
  const stats = useStore($agentStats)
  const entries = agents.filter((a) => stats[a.id])
  if (entries.length === 0) return null

  return (
    <details className="border-base-300 border-t">
      <summary className="cursor-pointer px-4 py-2 font-medium text-base-content/60 text-xs uppercase tracking-wide">
        Stats for nerds
      </summary>
      <div className="space-y-3 px-4 pb-3">
        {entries.map((agent) => {
          const s = stats[agent.id]
          return (
            <div key={agent.id} className="rounded-field bg-base-200 p-3">
              <p className="mb-1 font-medium text-sm">{agent.name}</p>
              <table className="w-full text-xs">
                <tbody>
                  {Object.entries(s.config).map(([k, v]) => (
                    <tr key={k}>
                      <td className="py-0.5 pr-2 text-base-content/60">{k}</td>
                      <td className="break-all font-mono">{v}</td>
                    </tr>
                  ))}
                  {Object.entries(s.latencyMs).map(([k, v]) => (
                    <tr key={k}>
                      <td className="py-0.5 pr-2 text-base-content/60">
                        {k} latency
                      </td>
                      <td
                        className={`font-mono ${k === "overall" ? "font-semibold" : ""}`}
                      >
                        {v}ms
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        })}
      </div>
    </details>
  )
}

/** Bring any looped agent into the call by its TTY URL — no registration. */
function InviteByUrl({ slug }: { slug: string }) {
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [voice, setVoice] = useState<string>(AGENT_VOICES[0])
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim()) return
    setBusy(true)
    try {
      const res = await fetch(`/api/rooms/${slug}/agents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim(), token: token.trim(), voice }),
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(data.error ?? "invite failed")
      setUrl("")
      setToken("")
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 border-base-300 border-t p-4">
      <p className="font-medium text-base-content/60 text-xs uppercase tracking-wide">
        Invite by URL
      </p>
      <input
        className="input input-sm w-full"
        placeholder="wss://my-agent.example.com/tty"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <input
        className="input input-sm w-full"
        placeholder="Access token"
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      <select
        className="select select-sm w-full"
        value={voice}
        onChange={(e) => setVoice(e.target.value)}
        aria-label="Agent voice"
      >
        {AGENT_VOICES.map((v) => (
          <option key={v} value={v}>
            Voice: {v}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="btn btn-primary btn-sm w-full"
        disabled={busy || !url.trim()}
      >
        {busy && <span className="loading loading-spinner loading-xs" />}
        Invite agent
      </button>
    </form>
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
  const deafened = state === "deafened"
  const muted = state === "muted"

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className={`btn btn-circle btn-sm ${muted ? "btn-warning" : "btn-ghost"}`}
        aria-label={
          muted ? "Unmute agent (can speak)" : "Mute agent (replies in chat)"
        }
        onClick={() =>
          sendControl({ type: muted ? "unmute" : "mute", agentId })
        }
      >
        {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      </button>
      <button
        type="button"
        className={`btn btn-circle btn-sm ${deafened ? "btn-warning" : "btn-ghost"}`}
        aria-label={
          deafened
            ? "Undeafen agent (resume listening)"
            : "Deafen agent (stops hearing)"
        }
        onClick={() =>
          sendControl({ type: deafened ? "undeafen" : "deafen", agentId })
        }
      >
        {deafened ? <EarOff className="size-4" /> : <Ear className="size-4" />}
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
