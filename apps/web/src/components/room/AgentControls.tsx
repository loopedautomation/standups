"use client"

import { useParticipantAttributes } from "@livekit/components-react"
import {
  AGENT_BARGE_IN_ATTRIBUTE,
  AGENT_DEAFENED_ATTRIBUTE,
  AGENT_MUTED_ATTRIBUTE,
  AGENT_POLICY_ATTRIBUTE,
  type AgentControl,
  type TurnPolicy,
} from "@meet/shared"
import type { Participant } from "livekit-client"
import {
  AtSign,
  CircleStop,
  Ear,
  EarOff,
  Hand,
  Megaphone,
  Mic,
  MicOff,
  Scissors,
  UserX,
  Zap,
} from "lucide-react"
import { useParams } from "next/navigation"
import { useState } from "react"
import { useAgentState } from "@/components/room/AgentBadge"
import { useAgentInvite } from "@/hooks/mutations/useAgentInvite"
import { useAgentPermissions } from "@/hooks/useRoomSettings"
import { useSendAgentControl } from "@/hooks/useSendAgentControl"

/**
 * Per-agent controls, shared between the Agents panel (horizontal, with a
 * caption line for tips) and the agent's video tile (vertical overlay,
 * native title tooltips).
 *
 * Everyone sees them: an agent talking over the room is the room's problem,
 * not just the organiser's. A host who wants a tighter meeting can turn off
 * `participantsCanControlAgents`, and the buttons stay visible but inert —
 * showing what exists and who may use it beats hiding it and leaving people
 * to wonder why the agent won't stop.
 */
export function AgentControls({
  agentId,
  participant,
  onRemove,
  sendControl,
  vertical,
  withCaption,
  disabled,
}: {
  agentId: string
  participant: Participant
  onRemove: () => void
  sendControl: (control: AgentControl) => void
  vertical?: boolean
  withCaption?: boolean
  /** Visible but not pressable — the host reserved agent controls. */
  disabled?: boolean
}) {
  const state = useAgentState(participant)
  const { attributes } = useParticipantAttributes({ participant })
  const policy = (attributes?.[AGENT_POLICY_ATTRIBUTE] ?? "open") as TurnPolicy
  // The dedicated flags are authoritative — mute and deafen are independent
  // and can both be on, which the single state value can't express. State is
  // the fallback for agents on an older bridge.
  const deafened =
    attributes?.[AGENT_DEAFENED_ATTRIBUTE] === "1" || state === "deafened"
  const muted = attributes?.[AGENT_MUTED_ATTRIBUTE] === "1" || state === "muted"
  const zapped = state === "zapped"
  // Absent attribute (older bridge) reads as on — that's the deployment
  // default, and a toggle that lies about its state is worse than none.
  const bargeInOn = attributes?.[AGENT_BARGE_IN_ATTRIBUTE] !== "0"
  // Hand button cycles through the three turn policies.
  const nextPolicy: Record<TurnPolicy, TurnPolicy> = {
    open: "on-mention",
    "on-mention": "raise-hand",
    "raise-hand": "open",
  }
  const policyTip: Record<TurnPolicy, string> = {
    open: "Open — speaks whenever it has something to say",
    "on-mention": "On mention — speaks only when addressed or called on",
    "raise-hand":
      "Raise hand — waits to be called on, raising a hand when it has something",
  }

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
          disabled={disabled}
          onTip={withCaption ? setTip : undefined}
          tip={policyTip[policy]}
          active={policy !== "open"}
          onClick={() =>
            sendControl({
              type: "set-turn-policy",
              agentId,
              policy: nextPolicy[policy],
            })
          }
        >
          {policy === "raise-hand" ? (
            <Hand className="size-4" />
          ) : policy === "on-mention" ? (
            <AtSign className="size-4" />
          ) : (
            <Megaphone className="size-4" />
          )}
        </ControlButton>
        <ControlButton
          disabled={disabled}
          onTip={withCaption ? setTip : undefined}
          tip={zapTip}
          active={zapped}
          onClick={() => sendControl({ type: "zap", agentId })}
        >
          <Zap className="size-4" />
        </ControlButton>
        <ControlButton
          disabled={disabled}
          onTip={withCaption ? setTip : undefined}
          tip={
            bargeInOn
              ? "Barge-in on — talking over the agent cuts it off"
              : "Barge-in off — the agent finishes what it's saying"
          }
          active={!bargeInOn}
          onClick={() =>
            sendControl({ type: "set-barge-in", agentId, bargeIn: !bargeInOn })
          }
        >
          <Scissors className="size-4" />
        </ControlButton>
        <ControlButton
          disabled={disabled}
          onTip={withCaption ? setTip : undefined}
          tip={
            state === "speaking"
              ? "Interrupt — cut the agent off mid-sentence"
              : "Interrupt (the agent isn't speaking right now)"
          }
          active={state === "speaking"}
          onClick={() => sendControl({ type: "interrupt", agentId })}
        >
          <CircleStop className="size-4" />
        </ControlButton>
        <ControlButton
          disabled={disabled}
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
          disabled={disabled}
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
          disabled={disabled}
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

/** Self-contained vertical overlay for the agent's video tile. */
export function AgentTileControls({
  agentId,
  participant,
}: {
  agentId: string
  participant: Participant
}) {
  const { slug } = useParams<{ slug: string }>()
  const invite = useAgentInvite(slug)
  const sendControl = useSendAgentControl()
  const { canControl } = useAgentPermissions()
  const agentName = participant.name || participant.identity

  return (
    <div className="absolute top-1/2 right-2 z-10 -translate-y-1/2 rounded-field bg-base-100/70 p-1 backdrop-blur">
      <AgentControls
        agentId={agentId}
        participant={participant}
        vertical
        disabled={!canControl}
        onRemove={() =>
          invite.mutate(
            { agentId, action: "remove" },
            // Removal goes through the control API, so it has no data
            // message of its own — announce it once it lands, or the agent
            // just vanishes and nobody knows who did it.
            {
              onSuccess: () =>
                sendControl({ type: "remove", agentId }, agentName),
            },
          )
        }
        sendControl={(control) => sendControl(control, agentName)}
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
  disabled,
  onClick,
  onTip,
  children,
}: {
  tip: string
  /** Shown, but reserved for the host. */
  disabled?: boolean
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
  // A disabled button still reports the agent's state (muted, hand-raised);
  // the tip explains why it can't be pressed rather than leaving a dead
  // control to be discovered by clicking it.
  const label = disabled ? `${tip} (the meeting's organiser only)` : tip
  return (
    <button
      type="button"
      aria-label={label}
      title={onTip ? undefined : label}
      disabled={disabled}
      className={`btn btn-circle btn-sm ${tone} ${disabled ? "!bg-transparent cursor-not-allowed opacity-40" : ""}`}
      onClick={onClick}
      onMouseEnter={() => onTip?.(label)}
      onFocus={() => onTip?.(label)}
      onBlur={() => onTip?.(null)}
    >
      {children}
    </button>
  )
}
