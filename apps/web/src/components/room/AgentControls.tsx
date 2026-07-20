"use client"

import {
  useDataChannel,
  useParticipantAttributes,
} from "@livekit/components-react"
import {
  AGENT_POLICY_ATTRIBUTE,
  type AgentControl,
  DataTopic,
  type TurnPolicy,
} from "@meet/shared"
import type { Participant } from "livekit-client"
import { Ear, EarOff, Hand, Mic, MicOff, UserX, Zap } from "lucide-react"
import { useParams } from "next/navigation"
import { useState } from "react"
import { useAgentState } from "@/components/room/AgentBadge"
import { useAgentInvite } from "@/hooks/mutations/useAgentInvite"

/**
 * The host's per-agent controls, shared between the Agents panel (horizontal,
 * with a caption line for tips) and the agent's video tile (vertical overlay,
 * native title tooltips).
 */
export function AgentControls({
  agentId,
  participant,
  onRemove,
  sendControl,
  vertical,
  withCaption,
}: {
  agentId: string
  participant: Participant
  onRemove: () => void
  sendControl: (control: AgentControl) => void
  vertical?: boolean
  withCaption?: boolean
}) {
  const state = useAgentState(participant)
  const { attributes } = useParticipantAttributes({ participant })
  const policy = (attributes?.[AGENT_POLICY_ATTRIBUTE] ?? "open") as TurnPolicy
  const deafened = state === "deafened"
  const muted = state === "muted"
  const zapped = state === "zapped"
  const gated = policy === "on-mention"

  const zapTip = zapped
    ? "Zapped — responding freely for 30 seconds"
    : "Zap: responds to everything for 30 seconds"
  const muteTip = muted
    ? "Unmute — let the agent speak aloud"
    : "Mute — the agent replies in chat instead"
  const deafenTip = deafened
    ? "Undeafen — let the agent hear the meeting"
    : "Deafen — the agent stops hearing the meeting"

  // Tooltips clip against scroll containers, and no bubble direction fits
  // every button in a 22rem panel — so the panel renders tips as a caption
  // line instead (hover or keyboard focus). Tiles use native titles.
  const [tip, setTip] = useState<string | null>(null)

  return (
    <div>
      <div
        className={`flex gap-1 ${vertical ? "flex-col" : "items-center"}`}
        onMouseLeave={() => setTip(null)}
      >
        <ControlButton
          onTip={withCaption ? setTip : undefined}
          tip={
            gated
              ? "Hand-raising on — speaks only when addressed or called on"
              : "Hand-raising off — speaks whenever it has something to say"
          }
          active={gated}
          onClick={() =>
            sendControl({
              type: "set-turn-policy",
              agentId,
              policy: gated ? "open" : "on-mention",
            })
          }
        >
          <Hand className="size-4" />
        </ControlButton>
        <ControlButton
          onTip={withCaption ? setTip : undefined}
          tip={zapTip}
          active={zapped}
          onClick={() => sendControl({ type: "zap", agentId })}
        >
          <Zap className="size-4" />
        </ControlButton>
        <ControlButton
          onTip={withCaption ? setTip : undefined}
          tip={muteTip}
          alert={muted}
          onClick={() =>
            sendControl({ type: muted ? "unmute" : "mute", agentId })
          }
        >
          {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
        </ControlButton>
        <ControlButton
          onTip={withCaption ? setTip : undefined}
          tip={deafenTip}
          alert={deafened}
          onClick={() =>
            sendControl({ type: deafened ? "undeafen" : "deafen", agentId })
          }
        >
          {deafened ? (
            <EarOff className="size-4" />
          ) : (
            <Ear className="size-4" />
          )}
        </ControlButton>
        <ControlButton
          onTip={withCaption ? setTip : undefined}
          tip="Remove the agent from the meeting"
          danger
          onClick={onRemove}
        >
          <UserX className="size-4" />
        </ControlButton>
      </div>
      {withCaption && (
        <p className="min-h-4 pt-1 text-[11px] text-base-content/50 leading-tight">
          {tip}
        </p>
      )}
    </div>
  )
}

/** Self-contained vertical overlay for the agent's video tile (host only). */
export function AgentTileControls({
  agentId,
  participant,
}: {
  agentId: string
  participant: Participant
}) {
  const { slug } = useParams<{ slug: string }>()
  const invite = useAgentInvite(slug)
  const { send } = useDataChannel(DataTopic.AgentControl)

  return (
    <div className="absolute top-1/2 right-2 z-10 -translate-y-1/2 rounded-field bg-base-100/70 p-1 backdrop-blur">
      <AgentControls
        agentId={agentId}
        participant={participant}
        vertical
        onRemove={() => invite.mutate({ agentId, action: "remove" })}
        sendControl={(control) =>
          send(new TextEncoder().encode(JSON.stringify(control)), {
            topic: DataTopic.AgentControl,
            reliable: true,
          })
        }
      />
    </div>
  )
}

/**
 * An agent control: icon button whose colour marks deviation from default —
 * accent for modes turned on, red for capabilities taken away, neutral
 * otherwise. Danger stays quiet until you're on it.
 */
function ControlButton({
  tip,
  active,
  alert,
  danger,
  onClick,
  onTip,
  children,
}: {
  tip: string
  /** A behavioural mode the host switched on (hand-raising, zap). */
  active?: boolean
  /** A capability the host took away (muted, deafened). */
  alert?: boolean
  /** Destructive action (remove). */
  danger?: boolean
  onClick: () => void
  /** Caption-line reporting; when absent the native title carries the tip. */
  onTip?: (tip: string | null) => void
  children: React.ReactNode
}) {
  const tone = danger
    ? "btn-ghost text-error"
    : alert
      ? "btn-error"
      : active
        ? "btn-primary"
        : "btn-ghost"
  return (
    <button
      type="button"
      aria-label={tip}
      title={onTip ? undefined : tip}
      className={`btn btn-circle btn-sm ${tone}`}
      onClick={onClick}
      onMouseEnter={() => onTip?.(tip)}
      onFocus={() => onTip?.(tip)}
      onBlur={() => onTip?.(null)}
    >
      {children}
    </button>
  )
}
