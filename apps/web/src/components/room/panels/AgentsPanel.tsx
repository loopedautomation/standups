"use client"

import { useParticipants } from "@livekit/components-react"
import {
  AGENT_VOICES,
  type AgentActivityEvent,
  type AgentInfo,
  GEMINI_VOICES,
  OPENAI_TTS_VOICES,
  parseParticipantMeta,
} from "@meet/shared"
import { useStore } from "@nanostores/react"
import { Bot, ChevronDown, Plus, Wrench } from "lucide-react"
import { useState } from "react"
import { toast } from "react-toastify"
import { AgentControls } from "@/components/room/AgentControls"
import {
  type AgentMode,
  useAgentInvite,
} from "@/hooks/mutations/useAgentInvite"
import { useAgents } from "@/hooks/queries/useAgents"
import { useAgentPermissions } from "@/hooks/useRoomSettings"
import { useSendAgentControl } from "@/hooks/useSendAgentControl"
import { readHostKey } from "@/lib/hostKey"
import { $agentActivity, $agentStats } from "@/stores/roomData"
import { properCase } from "@/lib/casing"
import { Select } from "@/components/ui/Select"
/**
 * The voices offerable for an invite: the namespace follows the effective
 * mode's speaking provider. A realtime override on a pipeline-default agent
 * runs on OpenAI realtime (the worker's conversion), hence AGENT_VOICES.
 * Null means no picker: ElevenLabs voices are account-specific ids.
 */
function voiceOptions(
  agent: AgentInfo,
  mode: AgentMode | "",
): readonly string[] | null {
  if (mode === "gemini") return GEMINI_VOICES
  if (mode === "realtime") return AGENT_VOICES
  if (mode === "elevenlabs") return null
  if (mode === "" && agent.realtimeProvider) {
    return agent.realtimeProvider === "gemini" ? GEMINI_VOICES : AGENT_VOICES
  }
  if (mode === "" && agent.ttsProvider === "elevenlabs") return null
  return OPENAI_TTS_VOICES
}

/** The mode an invite without overrides actually runs: the registry's. */
function defaultMode(agent: AgentInfo): AgentMode {
  if (agent.realtimeProvider === "gemini") return "gemini"
  if (agent.realtimeProvider) return "realtime"
  return agent.ttsProvider === "elevenlabs" ? "elevenlabs" : "pipeline"
}

/**
 * The voice pre-selected for a mode: the registry's own choice when it
 * belongs to that mode's list, else the list's first entry.
 */
function defaultVoice(agent: AgentInfo, mode: AgentMode): string {
  const options = voiceOptions(agent, mode)
  if (!options) return ""
  const registry =
    mode === "realtime" || mode === "gemini"
      ? agent.realtimeVoice
      : agent.ttsVoice
  return registry && options.includes(registry) ? registry : options[0]
}

export function AgentsPanel({ slug }: { slug: string }) {
  const { data: agents = [], isLoading } = useAgents()
  const participants = useParticipants()
  const invite = useAgentInvite(slug)
  const activity = useStore($agentActivity)
  // Agents are the room's, not the organiser's — everyone gets the controls
  // unless the host has reserved them.
  const { canControl, canInvite } = useAgentPermissions()
  const sendControl = useSendAgentControl()
  // Per-agent interaction-mode choice ("" = the agent's registry default).
  // Meeting-level, not agent-level: any brain can front realtime or pipeline.
  const [modes, setModes] = useState<Record<string, AgentMode | "">>({})
  // Per-agent voice override ("" = the agent's default). The valid list
  // depends on the effective mode and provider, so a mode change resets it.
  const [voices, setVoices] = useState<Record<string, string>>({})
  // Accordion: one card open at a time; collapsed rows are just icon + name.
  const [expanded, setExpanded] = useState<string | null>(null)
  // Recently invited URL agents, remembered per browser. Lifted out of the
  // invite form so they can render as cards in the list alongside registry
  // agents rather than as a cramped strip of buttons.
  const [recent, setRecent] = useState<RecentAgent[]>(readRecentAgents)
  // The URL currently being (re-)invited, for the spinner. One invite runs at
  // a time, so a single value covers both the form and the recent cards.
  const [invitingUrl, setInvitingUrl] = useState<string | null>(null)

  const agentParticipants = new Map(
    participants
      .map((p) => [parseParticipantMeta(p.metadata)?.agentId, p] as const)
      .filter(([id]) => id),
  )

  // One mutation serves every row, so isPending alone would disable all the
  // Invite buttons at once — scope it to the agent actually being invited.
  const isInviting = (agentId: string) =>
    invite.isPending && invite.variables?.agentId === agentId

  // URL-invited agents aren't in the registry, but they're in the room —
  // give them a row too, or they'd have a tile but no panel presence.
  const registryIds = new Set(agents.map((a) => a.id))
  const dynamicAgents = [...agentParticipants.entries()]
    .filter(([id]) => id && !registryIds.has(id))
    .map(
      ([id, p]): AgentInfo => ({
        id: id as string,
        name: p.name || (id as string),
        // The agent's own description, from its hello frame; fall back for
        // agents on an older framework that don't report one.
        description:
          parseParticipantMeta(p.metadata)?.description ?? "Invited by URL",
      }),
    )
  const allAgents = [...agents, ...dynamicAgents]

  // A recently invited agent that's back in the room already shows as an
  // in-call card above; drop it from "Recently invited" so it isn't listed
  // twice. Name is the only thing a stored invite and a live participant share.
  const inRoomNames = new Set(
    [...agentParticipants.values()].map((p) => (p.name || "").toLowerCase()),
  )
  const recentlyInvited = recent.filter(
    (a) => !inRoomNames.has(a.name.toLowerCase()),
  )

  const inviteByUrl = async (spec: {
    url: string
    token: string
    mode?: AgentMode
    voice?: string
  }): Promise<boolean> => {
    setInvitingUrl(spec.url)
    try {
      const hostKey = readHostKey(slug)
      const res = await fetch(`/api/rooms/${slug}/agents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(hostKey ? { "x-host-key": hostKey } : {}),
        },
        body: JSON.stringify(spec),
      })
      const data = (await res.json()) as { error?: string; name?: string }
      if (!res.ok) throw new Error(data.error ?? "invite failed")
      setRecent(
        rememberAgent({
          url: spec.url,
          token: spec.token,
          name: data.name || spec.url,
          voice: spec.voice,
          at: Date.now(),
        }),
      )
      return true
    } catch (err) {
      toast.error((err as Error).message)
      return false
    } finally {
      setInvitingUrl(null)
    }
  }

  // The registry-empty hint is only true when there's genuinely nothing to
  // show — recently invited agents count as something.
  const nothingToShow =
    !isLoading && allAgents.length === 0 && recentlyInvited.length === 0

  return (
    // Two scroll regions: the agent list (with invite + stats) takes the
    // flexible space; the activity feed keeps a bounded strip at the bottom.
    // Without this the h-full column inside the panel's own scroll container
    // pinned to viewport height and neither section scrolled properly.
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="space-y-2 p-4">
          {isLoading && (
            <li className="text-base-content/50 text-sm">Loading agents…</li>
          )}
          {nothingToShow && (
            <li className="text-base-content/50 text-sm">
              No agents registered. Add them to agent-registry.yaml.
            </li>
          )}
          {allAgents.map((agent) => {
            const participant = agentParticipants.get(agent.id)
            const open = expanded === agent.id
            return (
              <AgentCard
                key={agent.id}
                name={agent.name}
                description={agent.description}
                inCall={!!participant}
                open={open}
                onToggle={() => setExpanded(open ? null : agent.id)}
              >
                {participant ? (
                  <AgentControls
                    withCaption
                    agentId={agent.id}
                    participant={participant}
                    disabled={!canControl}
                    onRemove={() =>
                      invite.mutate(
                        { agentId: agent.id, action: "remove" },
                        // Announced only once it actually happened — a
                        // removal the server refused must not be reported
                        // to the room as done.
                        {
                          onSuccess: () =>
                            sendControl(
                              { type: "remove", agentId: agent.id },
                              agent.name,
                            ),
                        },
                      )
                    }
                    sendControl={(control) => sendControl(control, agent.name)}
                  />
                ) : canInvite ? (
                  (() => {
                    // No blank placeholders: the selects rest on the agent's
                    // registry defaults, so what's displayed is what joins.
                    const mode = (modes[agent.id] ??
                      defaultMode(agent)) as AgentMode
                    const options = voiceOptions(agent, mode)
                    const voice = voices[agent.id] || defaultVoice(agent, mode)
                    return (
                      <div className="space-y-1.5">
                        <div className="space-y-1.5">
                          <Select
                            size="xs"
                            value={mode}
                            onChange={(e) => {
                              const next = e.target.value as AgentMode
                              setModes((m) => ({ ...m, [agent.id]: next }))
                              // Voice names don't carry across providers —
                              // back to the new mode's default.
                              setVoices((v) => ({
                                ...v,
                                [agent.id]: defaultVoice(agent, next),
                              }))
                            }}
                            aria-label="Interaction mode"
                            options={[
                              { value: "gemini", label: "Gemini Live" },
                              { value: "pipeline", label: "OpenAI STT" },
                              { value: "elevenlabs", label: "ElevenLabs STT" },
                              { value: "realtime", label: "GPT Realtime mini" },
                              {
                                value: "gpt-live",
                                label: "GPT Live-1 (soon)",
                                disabled: true,
                              },
                            ]}
                          />
                          {/* ElevenLabs voices are account-specific ids, not
                              an enumerable list — the registry's choice
                              stands. */}
                          {options && (
                            <Select
                              size="xs"
                              value={voice}
                              onChange={(e) =>
                                setVoices((v) => ({
                                  ...v,
                                  [agent.id]: e.target.value,
                                }))
                              }
                              aria-label="Voice"
                              options={options.map((v) => ({
                                value: v,
                                label: properCase(v),
                              }))}
                            />
                          )}
                        </div>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm w-full"
                          disabled={isInviting(agent.id)}
                          onClick={() =>
                            invite.mutate({
                              agentId: agent.id,
                              action: "invite",
                              mode,
                              voice: voice || undefined,
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
                    )
                  })()
                ) : null}
              </AgentCard>
            )
          })}
        </ul>

        {/* Recently invited URL agents render as the same cards as the
            registry, just grouped and with a re-invite action. */}
        {canInvite && recentlyInvited.length > 0 && (
          <div className="px-4 pb-2">
            <p className="pb-2 font-medium text-base-content/60 text-xs uppercase tracking-wide">
              Recently invited
            </p>
            <ul className="space-y-2">
              {recentlyInvited.map((a) => {
                const open = expanded === `recent:${a.url}`
                return (
                  <AgentCard
                    key={a.url}
                    name={a.name}
                    description={a.url}
                    inCall={false}
                    open={open}
                    onToggle={() =>
                      setExpanded(open ? null : `recent:${a.url}`)
                    }
                  >
                    <div className="flex gap-1">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm flex-1 gap-1"
                        disabled={invitingUrl !== null}
                        onClick={() =>
                          inviteByUrl({
                            url: a.url,
                            token: a.token,
                            voice: a.voice,
                          })
                        }
                      >
                        {invitingUrl === a.url ? (
                          <span className="loading loading-spinner loading-xs" />
                        ) : (
                          <Plus className="size-4" />
                        )}
                        Invite
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setRecent(forgetAgent(a.url))}
                      >
                        Forget
                      </button>
                    </div>
                  </AgentCard>
                )
              })}
            </ul>
          </div>
        )}

        {!canInvite && (
          <p className="px-4 pb-2 text-base-content/50 text-xs">
            The meeting's organiser has reserved inviting agents.
          </p>
        )}

        {canInvite && (
          <InviteByUrl inviteByUrl={inviteByUrl} invitingUrl={invitingUrl} />
        )}

        <StatsForNerds agents={agents} />
      </div>

      <div className="shrink-0 border-base-300 border-t px-4 py-2 font-medium text-base-content/60 text-xs uppercase tracking-wide">
        Activity
      </div>
      <ActivityFeed activity={activity} />
    </div>
  )
}

/**
 * One agent in the list: a collapsed icon-and-name row that expands to show
 * its controls (in call) or an invite action (not). Shared by registry,
 * in-room URL, and recently invited agents so all three read identically.
 */
function AgentCard({
  name,
  description,
  inCall,
  open,
  onToggle,
  children,
}: {
  name: string
  description?: string
  inCall: boolean
  open: boolean
  onToggle: () => void
  children?: React.ReactNode
}) {
  return (
    <li className="flex flex-col gap-2 rounded-field bg-base-200 p-3">
      <button
        type="button"
        className="flex w-full items-center gap-3 text-left"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Bot className="size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sm">{name}</p>
          {open && description && (
            <p className="break-words text-base-content/60 text-xs">
              {description}
            </p>
          )}
        </div>
        {inCall && (
          <span className="badge badge-ghost badge-sm shrink-0">in call</span>
        )}
        <ChevronDown
          className={`size-4 shrink-0 text-base-content/40 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && children}
    </li>
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

/**
 * Successful URL invites, remembered per browser so kicking an agent doesn't
 * mean retyping its URL and token next time. Token included deliberately —
 * it's the inviter's own credential on their own device (same trust level as
 * the stored rejoin token).
 */
type RecentAgent = {
  url: string
  token: string
  name: string
  voice?: string
  at: number
}
const RECENT_AGENTS_KEY = "recentAgents"
const MAX_RECENT_AGENTS = 5

function readRecentAgents(): RecentAgent[] {
  if (typeof window === "undefined") return []
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_AGENTS_KEY) ?? "[]")
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function rememberAgent(entry: RecentAgent): RecentAgent[] {
  const list = [
    entry,
    ...readRecentAgents().filter((a) => a.url !== entry.url),
  ].slice(0, MAX_RECENT_AGENTS)
  try {
    localStorage.setItem(RECENT_AGENTS_KEY, JSON.stringify(list))
  } catch {}
  return list
}

function forgetAgent(url: string): RecentAgent[] {
  const list = readRecentAgents().filter((a) => a.url !== url)
  try {
    localStorage.setItem(RECENT_AGENTS_KEY, JSON.stringify(list))
  } catch {}
  return list
}

/** The voice list for a chosen mode (URL agents have no registry defaults). */
function urlVoiceOptions(mode: AgentMode): readonly string[] | null {
  if (mode === "gemini") return GEMINI_VOICES
  if (mode === "realtime") return AGENT_VOICES
  if (mode === "elevenlabs") return null
  return OPENAI_TTS_VOICES
}

/** Bring any looped agent into the call by its TTY URL — no registration. */
function InviteByUrl({
  inviteByUrl,
  invitingUrl,
}: {
  inviteByUrl: (spec: {
    url: string
    token: string
    mode?: AgentMode
    voice?: string
  }) => Promise<boolean>
  invitingUrl: string | null
}) {
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [mode, setMode] = useState<AgentMode>("realtime")
  const [voice, setVoice] = useState<string>(AGENT_VOICES[0])
  const busy = invitingUrl !== null
  const voices = urlVoiceOptions(mode)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim()) return
    if (
      await inviteByUrl({
        url: url.trim(),
        token: token.trim(),
        mode,
        voice: voices ? voice : undefined,
      })
    ) {
      setUrl("")
      setToken("")
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
      <Select
        size="sm"
        value={mode}
        onChange={(e) => {
          const next = e.target.value as AgentMode
          setMode(next)
          // Voice names don't carry across providers.
          setVoice(urlVoiceOptions(next)?.[0] ?? "")
        }}
        aria-label="Communication method"
        options={[
          { value: "realtime", label: "GPT Realtime mini" },
          { value: "gemini", label: "Gemini Live" },
          { value: "pipeline", label: "OpenAI STT" },
          { value: "elevenlabs", label: "ElevenLabs STT" },
        ]}
      />
      {voices && (
        <Select
          size="sm"
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          aria-label="Agent voice"
          options={voices.map((v) => ({
            value: v,
            label: `Voice: ${properCase(v)}`,
          }))}
        />
      )}
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
    <ul className="max-h-56 shrink-0 space-y-1 overflow-y-auto px-4 pb-4">
      {activity
        .filter((e) => e.type === "tool_call" || e.type === "tool_result")
        // Newest at the top — the live call is what you came to watch.
        .reverse()
        .map((e) => (
          <ActivityItem key={`${e.type}-${e.at}`} event={e} />
        ))}
    </ul>
  )
}

function ActivityItem({
  event: e,
}: {
  event: Extract<AgentActivityEvent, { type: "tool_call" | "tool_result" }>
}) {
  const [open, setOpen] = useState(false)
  return (
    <li className="rounded-field bg-base-200 font-mono text-xs">
      <button
        type="button"
        className="w-full cursor-pointer p-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-1 text-primary">
          <Wrench className="size-3" />
          {e.type === "tool_call" ? `→ ${e.name}` : `← ${e.name}`}
          {e.type === "tool_result" && (
            <span className="text-base-content/50">{e.durationMs}ms</span>
          )}
        </span>
        <span
          className={`break-all text-base-content/70 ${
            open ? "block whitespace-pre-wrap" : "line-clamp-3"
          }`}
        >
          {e.type === "tool_call" ? e.arguments : e.content}
        </span>
      </button>
    </li>
  )
}
