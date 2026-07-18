"use client"

import {
  useLocalParticipant,
  useParticipants,
  useRoomContext,
} from "@livekit/components-react"
import { parseParticipantMeta } from "@meet/shared"
import { useStore } from "@nanostores/react"
import {
  Bot,
  Check,
  Link as LinkIcon,
  LogOut,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  ScrollText,
  Users,
  Video,
  VideoOff,
} from "lucide-react"
import { useState } from "react"
import { toast } from "react-toastify"
import { $openPanel, togglePanel } from "@/stores/panels"

export function ControlBar({
  slug,
  shareBase,
}: {
  slug: string
  shareBase?: string
}) {
  const room = useRoomContext()
  const {
    isMicrophoneEnabled,
    isCameraEnabled,
    isScreenShareEnabled,
    localParticipant,
  } = useLocalParticipant()
  const [copied, setCopied] = useState(false)
  const openPanel = useStore($openPanel)
  const participants = useParticipants()
  const waitingCount = participants.filter(
    (p) => parseParticipantMeta(p.metadata)?.kind === "waiting",
  ).length

  const toggle = (
    action: () => Promise<unknown>,
    what: string,
    persist?: { key: string; value: boolean },
  ) => {
    if (persist) {
      try {
        localStorage.setItem(persist.key, String(persist.value))
      } catch {}
    }
    action().catch((err: unknown) => {
      const detail =
        err instanceof Error && err.name === "NotAllowedError"
          ? "browser permission denied"
          : err instanceof Error
            ? err.message
            : "unknown error"
      toast.error(`Could not toggle ${what}: ${detail}`)
    })
  }

  const copyLink = async () => {
    // Prefer the short-link format when the deployment configures one.
    await navigator.clipboard.writeText(
      shareBase ? `${shareBase}/${slug}` : window.location.href,
    )
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex items-center justify-between gap-2 border-base-300 border-b bg-base-100 px-4 py-3">
      <div className="hidden items-center gap-2 sm:flex">
        <span className="font-mono text-base-content/60 text-sm">{slug}</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={copyLink}
        >
          {copied ? (
            <Check className="size-4 text-success" />
          ) : (
            <LinkIcon className="size-4" />
          )}
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <div
          className="tooltip tooltip-bottom"
          data-tip={
            isMicrophoneEnabled ? "Mute microphone" : "Unmute microphone"
          }
        >
          <button
            type="button"
            className={`btn btn-circle ${isMicrophoneEnabled ? "btn-neutral" : "btn-soft"}`}
            onClick={() =>
              toggle(
                () =>
                  localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled),
                "microphone",
                { key: "audioEnabled", value: !isMicrophoneEnabled },
              )
            }
            aria-label="Toggle microphone"
          >
            {isMicrophoneEnabled ? (
              <Mic className="size-5" />
            ) : (
              <MicOff className="size-5" />
            )}
          </button>
        </div>
        <div
          className="tooltip tooltip-bottom"
          data-tip={isCameraEnabled ? "Turn off camera" : "Turn on camera"}
        >
          <button
            type="button"
            className={`btn btn-circle ${isCameraEnabled ? "btn-neutral" : "btn-soft"}`}
            onClick={() =>
              toggle(
                () => localParticipant.setCameraEnabled(!isCameraEnabled),
                "camera",
                { key: "videoEnabled", value: !isCameraEnabled },
              )
            }
            aria-label="Toggle camera"
          >
            {isCameraEnabled ? (
              <Video className="size-5" />
            ) : (
              <VideoOff className="size-5" />
            )}
          </button>
        </div>
        <div
          className="tooltip tooltip-bottom"
          data-tip={isScreenShareEnabled ? "Stop sharing" : "Share screen"}
        >
          <button
            type="button"
            className={`btn btn-circle ${isScreenShareEnabled ? "btn-primary" : "btn-neutral"}`}
            onClick={() =>
              toggle(
                () =>
                  localParticipant.setScreenShareEnabled(!isScreenShareEnabled),
                "screen share",
              )
            }
            aria-label="Toggle screen share"
          >
            <MonitorUp className="size-5" />
          </button>
        </div>
        <div className="tooltip tooltip-bottom" data-tip="Leave meeting">
          <button
            type="button"
            className="btn btn-circle btn-error"
            onClick={() => room.disconnect()}
            aria-label="Leave meeting"
          >
            <LogOut className="size-5" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <div className="tooltip tooltip-bottom" data-tip="Participants">
          <button
            type="button"
            className={`btn btn-circle indicator ${openPanel === "participants" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => togglePanel("participants")}
            aria-label="Participants"
          >
            {waitingCount > 0 && (
              <span className="badge indicator-item badge-warning badge-xs">
                {waitingCount}
              </span>
            )}
            <Users className="size-5" />
          </button>
        </div>
        <div className="tooltip tooltip-bottom" data-tip="Agents">
          <button
            type="button"
            className={`btn btn-circle ${openPanel === "agents" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => togglePanel("agents")}
            aria-label="Agents"
          >
            <Bot className="size-5" />
          </button>
        </div>
        <div className="tooltip tooltip-bottom" data-tip="Transcript">
          <button
            type="button"
            className={`btn btn-circle ${openPanel === "transcript" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => togglePanel("transcript")}
            aria-label="Transcript"
          >
            <ScrollText className="size-5" />
          </button>
        </div>
        <div className="tooltip tooltip-left" data-tip="Chat">
          <button
            type="button"
            className={`btn btn-circle ${openPanel === "chat" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => togglePanel("chat")}
            aria-label="Chat"
          >
            <MessageSquare className="size-5" />
          </button>
        </div>
      </div>
    </div>
  )
}
