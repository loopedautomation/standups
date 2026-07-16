"use client"

import { useLocalParticipant, useRoomContext } from "@livekit/components-react"
import { useStore } from "@nanostores/react"
import {
  Bot,
  Check,
  Link as LinkIcon,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  ScrollText,
  Video,
  VideoOff,
} from "lucide-react"
import { useState } from "react"
import { $openPanel, togglePanel } from "@/stores/panels"

export function ControlBar({ slug }: { slug: string }) {
  const room = useRoomContext()
  const {
    isMicrophoneEnabled,
    isCameraEnabled,
    isScreenShareEnabled,
    localParticipant,
  } = useLocalParticipant()
  const [copied, setCopied] = useState(false)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const openPanel = useStore($openPanel)

  const toggle = (action: () => Promise<unknown>, what: string) => {
    setMediaError(null)
    action().catch((err: unknown) => {
      const detail =
        err instanceof Error && err.name === "NotAllowedError"
          ? "browser permission denied"
          : err instanceof Error
            ? err.message
            : "unknown error"
      setMediaError(`Could not toggle ${what}: ${detail}`)
    })
  }

  const copyLink = async () => {
    await navigator.clipboard.writeText(window.location.href)
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
        <button
          type="button"
          className={`btn btn-circle ${isMicrophoneEnabled ? "btn-neutral" : "btn-error"}`}
          onClick={() =>
            toggle(
              () => localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled),
              "microphone",
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
        <button
          type="button"
          className={`btn btn-circle ${isCameraEnabled ? "btn-neutral" : "btn-error"}`}
          onClick={() =>
            toggle(
              () => localParticipant.setCameraEnabled(!isCameraEnabled),
              "camera",
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
        <button
          type="button"
          className="btn btn-circle btn-error"
          onClick={() => room.disconnect()}
          aria-label="Leave meeting"
        >
          <PhoneOff className="size-5" />
        </button>
        {mediaError && (
          <span className="max-w-64 truncate text-error text-xs">
            {mediaError}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          className={`btn btn-circle ${openPanel === "agents" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => togglePanel("agents")}
          aria-label="Agents"
        >
          <Bot className="size-5" />
        </button>
        <button
          type="button"
          className={`btn btn-circle ${openPanel === "transcript" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => togglePanel("transcript")}
          aria-label="Transcript"
        >
          <ScrollText className="size-5" />
        </button>
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
  )
}
