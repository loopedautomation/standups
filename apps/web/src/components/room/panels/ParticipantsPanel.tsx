"use client"

import {
  useIsMuted,
  useLocalParticipant,
  useParticipants,
} from "@livekit/components-react"
import { parseParticipantMeta } from "@meet/shared"
import { useStore } from "@nanostores/react"
import type { Participant } from "livekit-client"
import { Track } from "livekit-client"
import { Bot, Check, MicOff, User, UserX, X } from "lucide-react"
import { useState } from "react"
import { toast } from "react-toastify"
import { $isHost } from "@/stores/host"

export function ParticipantsPanel({ slug }: { slug: string }) {
  const participants = useParticipants()
  const { localParticipant } = useLocalParticipant()
  const [busy, setBusy] = useState<string | null>(null)
  const isHost = useStore($isHost)
  // Removal asks first — the row's X becomes a confirm button.
  const [confirming, setConfirming] = useState<string | null>(null)

  const moderate = async (identity: string, action: "remove" | "mute") => {
    let hostKey: string | null = null
    try {
      hostKey = localStorage.getItem(`hostKey:${slug}`)
    } catch {}
    if (!hostKey) {
      toast.error("Only the meeting's organiser can do that.")
      return
    }
    setBusy(identity)
    try {
      const res = await fetch(`/api/rooms/${slug}/moderate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity, action, hostKey }),
      })
      if (!res.ok) throw new Error(`could not ${action} participant`)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
      setConfirming(null)
    }
  }

  const kind = (metadata?: string) => parseParticipantMeta(metadata)?.kind
  const waiting = participants.filter((p) => kind(p.metadata) === "waiting")
  const inMeeting = participants.filter(
    (p) => kind(p.metadata) === "human" || kind(p.metadata) === "agent",
  )

  const decide = async (identity: string, action: "admit" | "deny") => {
    setBusy(identity)
    try {
      await fetch(`/api/rooms/${slug}/admit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          identity,
          action,
          requesterIdentity: localParticipant.identity,
        }),
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {waiting.length > 0 && (
        <>
          <div className="px-4 py-2 font-medium text-base-content/60 text-xs uppercase tracking-wide">
            Waiting to join
          </div>
          <ul className="space-y-2 px-4 pb-2">
            {waiting.map((p) => (
              <li
                key={p.identity}
                className="flex items-center gap-3 rounded-field bg-warning/10 p-3 ring-1 ring-warning/30"
              >
                <User className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-medium text-sm">
                  {p.name || p.identity}
                </span>
                <button
                  type="button"
                  className="btn btn-success btn-xs"
                  disabled={busy === p.identity}
                  onClick={() => decide(p.identity, "admit")}
                >
                  <Check className="size-3" />
                  Admit
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs text-error"
                  disabled={busy === p.identity}
                  onClick={() => decide(p.identity, "deny")}
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="px-4 py-2 font-medium text-base-content/60 text-xs uppercase tracking-wide">
        In the meeting
      </div>
      <ul className="space-y-1 px-4 pb-4">
        {inMeeting.map((p) => (
          <li
            key={p.identity}
            className="flex items-center gap-2 rounded-field p-2"
          >
            {kind(p.metadata) === "agent" ? (
              <Bot className="size-4 shrink-0 text-primary" />
            ) : (
              <User className="size-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm">
              {p.name || p.identity}
              {p.isLocal && " (you)"}
            </span>
            {isHost && !p.isLocal && (
              <>
                <MuteButton
                  participant={p}
                  disabled={busy === p.identity}
                  onMute={() => moderate(p.identity, "mute")}
                />
                {confirming === p.identity ? (
                  <button
                    type="button"
                    className="btn btn-error btn-xs"
                    disabled={busy === p.identity}
                    onClick={() => moderate(p.identity, "remove")}
                    onBlur={() => setConfirming(null)}
                  >
                    Remove?
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs text-error"
                    aria-label={`Remove ${p.name || p.identity} from the meeting`}
                    title="Remove from the meeting"
                    onClick={() => setConfirming(p.identity)}
                  >
                    <UserX className="size-4" />
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Silence someone's mic. One-way by design: only its owner can turn a mic
 * back on, so the button reads as already-done once they're muted.
 */
function MuteButton({
  participant,
  disabled,
  onMute,
}: {
  participant: Participant
  disabled: boolean
  onMute: () => void
}) {
  const muted = useIsMuted({
    participant,
    source: Track.Source.Microphone,
  })
  if (muted) {
    return (
      <span
        className="px-1 text-base-content/40"
        title="Microphone is off — only they can turn it back on"
      >
        <MicOff className="size-4" />
      </span>
    )
  }
  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs"
      disabled={disabled}
      aria-label={`Mute ${participant.name || participant.identity}`}
      title="Mute — only they can unmute themselves"
      onClick={onMute}
    >
      <MicOff className="size-4" />
    </button>
  )
}
