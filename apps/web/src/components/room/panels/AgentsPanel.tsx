"use client"

import { useDataChannel, useParticipants } from "@livekit/components-react"
import {
  AGENT_VOICES,
  type AgentActivityEvent,
  DataTopic,
  parseParticipantMeta,
} from "@meet/shared"
import { useStore } from "@nanostores/react"
import { Bot, Plus, Wrench } from "lucide-react"
import { useState } from "react"
import { toast } from "react-toastify"
import { AgentControls } from "@/components/room/AgentControls"
import {
  type AgentMode,
  useAgentInvite,
} from "@/hooks/mutations/useAgentInvite"
import { useAgents } from "@/hooks/queries/useAgents"
import { $isHost } from "@/stores/host"
import { $agentActivity, $agentStats } from "@/stores/roomData"

export function AgentsPanel({ slug }: { slug: string }) {
  const { data: agents = [], isLoading } = useAgents()
  const participants = useParticipants()
  const invite = useAgentInvite(slug)
  const activity = useStore($agentActivity)
  // Agents belong to whoever organises the meeting; everyone else sees who
  // is in the room and what they're doing, but no controls.
  const isHost = useStore($isHost)

  const { send: sendControl } = useDataChannel(DataTopic.AgentControl)
  // Per-agent interaction-mode choice ("" = the agent's registry default).
  // Meeting-level, not agent-level: any brain can front realtime or pipeline.
  const [modes, setModes] = useState<Record<string, AgentMode | "">>({})

  const agentParticipants = new Map(
    participants
      .map((p) => [parseParticipantMeta(p.metadata)?.agentId, p] as const)
      .filter(([id]) => id),
  )

  // One mutation serves every row, so isPending alone would disable all the
  // Invite buttons at once — scope it to the agent actually being invited.
  const isInviting = (agentId: string) =>
    invite.isPending && invite.variables?.agentId === agentId

  return (
    <div className="flex h-full flex-col">
      <ul className="space-y-2 p-4">
        {isLoading && (
          <li className="text-base-content/50 text-sm">Loading agents…</li>
        )}
        {!isLoading && agents.length === 0 && (
          <li className="text-base-content/50 text-sm">
            No agents registered. Add them to agent-registry.yaml.
          </li>
        )}
        {agents.map((agent) => {
          const participant = agentParticipants.get(agent.id)
          return (
            <li
              key={agent.id}
              className="flex flex-col gap-2 rounded-field bg-base-200 p-3"
            >
              <div className="flex items-center gap-3">
                <Bot className="size-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm">{agent.name}</p>
                  {agent.description && (
                    <p className="text-base-content/60 text-xs">
                      {agent.description}
                    </p>
                  )}
                </div>
              </div>
              {participant ? (
                isHost ? (
                  <AgentControls
                    withCaption
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
                  <span className="badge badge-ghost badge-sm">in call</span>
                )
              ) : isHost ? (
                <div className="join w-full">
                  <select
                    className="select select-sm join-item min-w-0 flex-1 border border-base-300 text-xs"
                    value={modes[agent.id] ?? ""}
                    onChange={(e) =>
                      setModes((m) => ({
                        ...m,
                        [agent.id]: e.target.value as AgentMode | "",
                      }))
                    }
                    aria-label="Interaction mode"
                  >
                    <option value="">Default</option>
                    <option value="realtime">Realtime</option>
                    <option value="pipeline">STT + TTS</option>
                  </select>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm join-item"
                    disabled={isInviting(agent.id)}
                    onClick={() =>
                      invite.mutate({
                        agentId: agent.id,
                        action: "invite",
                        mode: modes[agent.id] || undefined,
                      })
                    }
                  >
                    {isInviting(agent.id) ? (
                      <span className="loading loading-spinner loading-xs" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    Invite
                  </button>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>

      {!isHost && (
        <p className="px-4 pb-2 text-base-content/50 text-xs">
          The meeting's organiser manages agents.
        </p>
      )}

      {isHost && <InviteByUrl slug={slug} />}

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
        placeholder="your-agent.lpd.sh"
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
        className="select select-sm w-full border border-base-300"
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
