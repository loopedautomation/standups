"use client"

import {
  useConnectionQualityIndicator,
  useLocalParticipant,
  useMediaDeviceSelect,
  useParticipantAttributes,
  useParticipants,
  useRoomContext,
} from "@livekit/components-react"
import {
  HAND_ATTRIBUTE,
  parseParticipantMeta,
  serializeVideoTransform,
  VIDEO_TRANSFORM_ATTRIBUTE,
} from "@meet/shared"
import { useStore } from "@nanostores/react"
import { ConnectionQuality, type LocalParticipant } from "livekit-client"
import {
  Bot,
  Check,
  ChevronDown,
  FileText,
  Hand,
  Link as LinkIcon,
  LogOut,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PenLine,
  ScrollText,
  Settings,
  Users,
  Video,
  VideoOff,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "react-toastify"
import { Modal } from "@/components/ui/Modal"
import { useCameraEffect } from "@/hooks/useCameraEffect"
import { useIncomingVideo } from "@/hooks/useIncomingVideo"
import { useMeetingSounds } from "@/hooks/useMeetingSounds"
import { usePushToTalk } from "@/hooks/usePushToTalk"
import { useStickyDevices } from "@/hooks/useStickyDevices"
import { useVoiceIsolation } from "@/hooks/useVoiceIsolation"
import { cleanDeviceLabel } from "@/lib/deviceLabel"
import { $cameraEffect } from "@/stores/cameraEffect"
import { $agentDrawing, $canvasOpen, $canvasUnseen } from "@/stores/canvas"
import { type DeviceKind, setDevicePref } from "@/stores/devicePrefs"
import { $incomingVideoOff, setIncomingVideoOff } from "@/stores/incomingVideo"
import { $openPanel, togglePanel } from "@/stores/panels"
import {
  $autoDataSaver,
  $meetingSounds,
  $pushToTalk,
} from "@/stores/preferences"
import { $videoTransform } from "@/stores/videoTransform"
import { $voiceIsolation } from "@/stores/voiceIsolation"

export function ControlBar({
  slug,
  shareBase,
  startedAt,
}: {
  slug: string
  shareBase?: string
  startedAt?: number
}) {
  const room = useRoomContext()
  const {
    isMicrophoneEnabled,
    isCameraEnabled,
    isScreenShareEnabled,
    localParticipant,
  } = useLocalParticipant()
  const [copied, setCopied] = useState(false)
  // Guard the destructive leave action behind a confirm — a stray click on the
  // red button shouldn't drop you out of the call and back through the lobby.
  const [confirmLeave, setConfirmLeave] = useState(false)
  const openPanel = useStore($openPanel)
  const whiteboardOpen = useStore($canvasOpen)
  const canvasUnseen = useStore($canvasUnseen)
  const agentDrawing = useStore($agentDrawing)
  const participants = useParticipants()
  const waitingCount = participants.filter(
    (p) => parseParticipantMeta(p.metadata)?.kind === "waiting",
  ).length

  const cameraEffect = useStore($cameraEffect)
  useCameraEffect(cameraEffect)

  const voiceIsolation = useStore($voiceIsolation)
  useVoiceIsolation(voiceIsolation)

  const incomingVideoOff = useStore($incomingVideoOff)
  useIncomingVideo(incomingVideoOff)

  usePushToTalk(useStore($pushToTalk))
  useMeetingSounds(useStore($meetingSounds))
  const autoDataSaver = useStore($autoDataSaver)

  // Keep the chosen mic/camera pinned against OS auto-switching on hot-plug.
  useStickyDevices()

  // Publish the camera orientation so every client renders this feed the
  // same way — the track itself is untouched, viewers apply CSS.
  const videoTransform = useStore($videoTransform)
  useEffect(() => {
    localParticipant
      ?.setAttributes({
        [VIDEO_TRANSFORM_ATTRIBUTE]: serializeVideoTransform(videoTransform),
      })
      .catch(() => undefined)
  }, [videoTransform, localParticipant])

  const { handRaised, toggleHand } = useRaiseHand(localParticipant)

  // Warn once per dip when this participant's own connection degrades.
  const { quality } = useConnectionQualityIndicator({
    participant: localParticipant,
  })
  const lastQuality = useRef(quality)
  useEffect(() => {
    if (
      quality !== lastQuality.current &&
      (quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost)
    ) {
      // Auto data-saver: a degrading link sheds incoming video by itself.
      if (autoDataSaver && !$incomingVideoOff.get()) {
        setIncomingVideoOff(true)
        toast.info(
          "Connection is unstable — incoming video turned off to save bandwidth (Settings > Connection to undo).",
        )
      } else {
        toast.warning("Your connection is unstable — call quality may suffer.")
      }
    }
    lastQuality.current = quality
  }, [quality, autoDataSaver])

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

  const toggleMic = () =>
    toggle(
      () => localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled),
      "microphone",
      { key: "audioEnabled", value: !isMicrophoneEnabled },
    )
  const toggleCamera = () =>
    toggle(
      () => localParticipant.setCameraEnabled(!isCameraEnabled),
      "camera",
      { key: "videoEnabled", value: !isCameraEnabled },
    )

  // Keyboard shortcuts (Meet's conventions): ⌘/Ctrl+D mic, ⌘/Ctrl+E camera.
  const shortcutRefs = useRef({ toggleMic, toggleCamera })
  shortcutRefs.current = { toggleMic, toggleCamera }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return
      }
      if (e.key === "d") {
        e.preventDefault()
        shortcutRefs.current.toggleMic()
      } else if (e.key === "e") {
        e.preventDefault()
        shortcutRefs.current.toggleCamera()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

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
        <div className="tooltip tooltip-bottom" data-tip="Copy meeting link">
          <button
            type="button"
            className="btn btn-ghost btn-sm font-mono"
            onClick={copyLink}
          >
            {copied ? (
              <Check className="size-4 text-success" />
            ) : (
              <LinkIcon className="size-4" />
            )}
            {copied ? "Copied" : slug}
          </button>
        </div>
        {startedAt ? <CallTimer startedAt={startedAt} /> : null}
      </div>

      <div className="flex items-center gap-2">
        <div className="join">
          <div
            className="tooltip tooltip-bottom"
            data-tip={
              isMicrophoneEnabled
                ? "Mute microphone ⌘D"
                : "Unmute microphone ⌘D"
            }
          >
            <button
              type="button"
              className="btn btn-circle join-item btn-neutral"
              onClick={toggleMic}
              aria-label="Toggle microphone"
            >
              {isMicrophoneEnabled ? (
                <Mic className="size-5" />
              ) : (
                <MicOff className="size-5" />
              )}
            </button>
          </div>
          {/* Noise removal and blur live in Settings — these menus are for
              picking devices only. */}
          <DeviceMenu kind="audioinput" />
        </div>
        <div className="join">
          <div
            className="tooltip tooltip-bottom"
            data-tip={
              isCameraEnabled ? "Turn off camera ⌘E" : "Turn on camera ⌘E"
            }
          >
            <button
              type="button"
              className="btn btn-circle join-item btn-neutral"
              onClick={toggleCamera}
              aria-label="Toggle camera"
            >
              {isCameraEnabled ? (
                <Video className="size-5" />
              ) : (
                <VideoOff className="size-5" />
              )}
            </button>
          </div>
          <DeviceMenu kind="videoinput" />
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
                  localParticipant.setScreenShareEnabled(
                    !isScreenShareEnabled,
                    // Exclude this tab from the picker: sharing the meeting's own
                    // tab points the capture back at itself and spirals into a
                    // hall-of-mirrors feedback loop (see #23).
                    { selfBrowserSurface: "exclude" },
                  ),
                "screen share",
              )
            }
            aria-label="Toggle screen share"
          >
            <MonitorUp className="size-5" />
          </button>
        </div>
        <div
          className="tooltip tooltip-bottom"
          data-tip={handRaised ? "Lower hand" : "Raise hand"}
        >
          <button
            type="button"
            className={`btn btn-circle ${handRaised ? "btn-warning" : "btn-neutral"}`}
            onClick={toggleHand}
            aria-label={handRaised ? "Lower hand" : "Raise hand"}
          >
            <Hand className="size-5" />
          </button>
        </div>
        <div className="tooltip tooltip-bottom" data-tip="Leave meeting">
          <button
            type="button"
            className="btn btn-circle btn-error"
            onClick={() => setConfirmLeave(true)}
            aria-label="Leave meeting"
          >
            <LogOut className="size-5" />
          </button>
        </div>
      </div>

      <Modal isOpen={confirmLeave} onClose={() => setConfirmLeave(false)}>
        <h3 className="font-semibold text-lg">Leave this meeting?</h3>
        <p className="py-2 text-base-content/70 text-sm">
          You'll be disconnected from the call and will need to rejoin to come
          back.
        </p>
        <div className="modal-action">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setConfirmLeave(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-error btn-brutalist"
            onClick={() => {
              setConfirmLeave(false)
              void room.disconnect()
            }}
          >
            <LogOut className="size-4" />
            Leave
          </button>
        </div>
      </Modal>

      <div className="flex items-center gap-1">
        {/* Agents first — it's the most frequently used panel. */}
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
        <div className="tooltip tooltip-bottom" data-tip="Chat">
          <button
            type="button"
            className={`btn btn-circle ${openPanel === "chat" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => togglePanel("chat")}
            aria-label="Chat"
          >
            <MessageSquare className="size-5" />
          </button>
        </div>
        <div className="tooltip tooltip-bottom" data-tip="Doc">
          <button
            type="button"
            className={`btn btn-circle ${openPanel === "doc" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => togglePanel("doc")}
            aria-label="Doc"
          >
            <FileText className="size-5" />
          </button>
        </div>
        <div
          className="tooltip tooltip-bottom"
          data-tip={
            agentDrawing && !whiteboardOpen
              ? `${agentDrawing.name} is drawing…`
              : "Whiteboard"
          }
        >
          <button
            type="button"
            className={`btn btn-circle indicator ${whiteboardOpen ? "btn-primary" : "btn-ghost"}`}
            onClick={() => {
              const opening = !$canvasOpen.get()
              $canvasOpen.set(opening)
              if (opening) $canvasUnseen.set(false)
            }}
            aria-label={
              agentDrawing && !whiteboardOpen
                ? `Whiteboard — ${agentDrawing.name} is drawing`
                : "Whiteboard"
            }
          >
            {/* Someone drawing right now outranks the passive unseen dot:
                a live ping says "open me and watch", the dot only says
                "something changed while you were away". */}
            {agentDrawing && !whiteboardOpen ? (
              <span className="indicator-item flex size-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
              </span>
            ) : (
              canvasUnseen &&
              !whiteboardOpen && (
                <span className="badge indicator-item badge-primary badge-xs" />
              )
            )}
            <PenLine className="size-5" />
          </button>
        </div>
        <div className="tooltip tooltip-bottom" data-tip="Settings">
          <button
            type="button"
            className={`btn btn-circle ${openPanel === "settings" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => togglePanel("settings")}
            aria-label="Settings"
          >
            <Settings className="size-5" />
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Raise/lower hand via a LiveKit participant attribute. Keeps an optimistic
 * local state so the button flips on click instead of waiting for the attribute
 * to round-trip, reverts (and surfaces a toast) if the write is rejected, and
 * clears the override once the server echoes the change back.
 */
function useRaiseHand(localParticipant: LocalParticipant) {
  const { attributes } = useParticipantAttributes({
    participant: localParticipant,
  })
  const attrHandRaised = attributes?.[HAND_ATTRIBUTE] === "1"
  const [optimisticHand, setOptimisticHand] = useState<boolean | null>(null)
  const handRaised = optimisticHand ?? attrHandRaised
  useEffect(() => {
    if (optimisticHand !== null && attrHandRaised === optimisticHand) {
      setOptimisticHand(null)
    }
  }, [attrHandRaised, optimisticHand])
  const toggleHand = () => {
    const next = !handRaised
    setOptimisticHand(next)
    localParticipant
      .setAttributes({ [HAND_ATTRIBUTE]: next ? "1" : "" })
      .catch((err: unknown) => {
        // Roll the button back and tell the user, rather than silently no-op.
        setOptimisticHand(null)
        const detail = err instanceof Error ? err.message : "unknown error"
        toast.error(`Could not ${next ? "raise" : "lower"} hand: ${detail}`)
      })
  }
  return { handRaised, toggleHand }
}

/** Elapsed time since the room was created — shared anchor for everyone. */
function CallTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const total = Math.max(0, Math.floor((now - startedAt) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    <span className="font-mono text-base-content/60 text-sm tabular-nums">
      {h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`}
    </span>
  )
}

/**
 * Chevron dropdown next to a media toggle listing input devices; switching
 * takes effect live and is remembered for the next lobby visit. Extra menu
 * items (e.g. background blur) render below the device list.
 */
function DeviceMenu({
  kind,
  children,
}: {
  kind: DeviceKind
  children?: React.ReactNode
}) {
  const { devices, activeDeviceId, setActiveMediaDevice } =
    useMediaDeviceSelect({ kind })
  // Camera menus preview: the tile at the top shows the hovered device (or
  // the current one), so a switch can be judged before it's clicked. Open
  // state is tracked so the preview camera runs only while the menu shows.
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)

  return (
    <div
      className="dropdown dropdown-bottom"
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false)
          setHovered(null)
        }
      }}
    >
      <button
        type="button"
        tabIndex={0}
        className="btn btn-circle join-item btn-neutral w-6"
        aria-label={`Select ${kind === "audioinput" ? "microphone" : "camera"}`}
      >
        <ChevronDown className="size-3" />
      </button>
      {/* Wide enough that device names read in full — the trigger button can
          truncate, the options themselves shouldn't. Long outliers wrap. */}
      <ul className="menu dropdown-content z-30 mt-1 w-80 max-w-[90vw] rounded-box bg-base-100 p-2 shadow-lg ring-1 ring-base-300">
        {kind === "videoinput" && open && (
          <li className="pointer-events-none mb-2">
            <CameraPreview deviceId={hovered ?? activeDeviceId} />
          </li>
        )}
        {devices.map((d) => (
          <li key={d.deviceId}>
            <button
              type="button"
              // DaisyUI v5 highlights the active menu row with `menu-active`
              // (renamed from `active` in v4).
              className={d.deviceId === activeDeviceId ? "menu-active" : ""}
              onMouseEnter={() =>
                kind === "videoinput" && setHovered(d.deviceId)
              }
              onMouseLeave={() => setHovered(null)}
              onClick={() => {
                // Pin before switching so useStickyDevices sees the new choice
                // when LiveKit emits ActiveDeviceChanged and doesn't fight it.
                setDevicePref(kind, d.deviceId)
                void setActiveMediaDevice(d.deviceId)
              }}
            >
              <span className="min-w-0 break-words">
                {cleanDeviceLabel(d.label) ||
                  (kind === "audioinput" ? "Microphone" : "Camera")}
              </span>
              {d.deviceId === activeDeviceId && (
                <Check className="size-4 shrink-0 text-success" />
              )}
            </button>
          </li>
        ))}
        {children}
      </ul>
    </div>
  )
}

/**
 * The camera the pointer is over, live. A fresh capture per device — the
 * stream restarts on hover moves, which beats holding every camera open.
 */
function CameraPreview({ deviceId }: { deviceId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    setFailed(false)
    void navigator.mediaDevices
      .getUserMedia({
        video: { deviceId: deviceId ? { exact: deviceId } : undefined },
      })
      .then((s) => {
        if (cancelled) {
          for (const t of s.getTracks()) t.stop()
          return
        }
        stream = s
        if (videoRef.current) videoRef.current.srcObject = s
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      for (const t of stream?.getTracks() ?? []) t.stop()
    }
  }, [deviceId])

  if (failed) {
    return (
      <span className="block rounded-field bg-base-300 p-2 text-center text-xs">
        Preview unavailable
      </span>
    )
  }
  return (
    // biome-ignore lint/a11y/useMediaCaption: local camera preview
    <video
      ref={videoRef}
      autoPlay
      muted
      playsInline
      className="aspect-video w-full scale-x-[-1] rounded-field bg-base-300 object-cover p-0"
    />
  )
}
