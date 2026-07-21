"use client"

import {
  isTrackReference,
  type TrackReferenceOrPlaceholder,
  useConnectionQualityIndicator,
  useIsMuted,
  useIsSpeaking,
  useParticipantAttributes,
  VideoTrack,
} from "@livekit/components-react"
import { HAND_ATTRIBUTE, parseParticipantMeta } from "@meet/shared"
import { ConnectionQuality, Track } from "livekit-client"
import { Hand, MicOff } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { AgentBadge, useAgentState } from "@/components/room/AgentBadge"
import { AgentTileControls } from "@/components/room/AgentControls"
import { useAgentPermissions } from "@/hooks/useRoomSettings"
import { useSendAgentControl } from "@/hooks/useSendAgentControl"

type ParticipantTileProps = {
  trackRef: TrackReferenceOrPlaceholder
  compact?: boolean
}

export function ParticipantTile({ trackRef, compact }: ParticipantTileProps) {
  const { participant } = trackRef
  const speaking = useIsSpeaking(participant)
  const micMuted = useIsMuted({
    participant,
    source: Track.Source.Microphone,
  })
  const meta = parseParticipantMeta(participant.metadata)
  const isAgent = meta?.kind === "agent"
  // Narrowed through a const so the click handlers below see a string, not
  // string | undefined.
  const agentId = meta?.agentId
  const { quality } = useConnectionQualityIndicator({ participant })
  const { attributes } = useParticipantAttributes({ participant })
  const isAway = attributes?.away === "1"
  const handUp = attributes?.[HAND_ATTRIBUTE] === "1"
  const agentState = useAgentState(participant)
  const sendControl = useSendAgentControl()
  const { canControl } = useAgentPermissions()
  const name = participant.name || participant.identity
  const hasVideo = isTrackReference(trackRef) && !trackRef.publication.isMuted
  // A phone in portrait publishes a taller-than-wide track; cropping it into
  // a landscape card cuts heads off. Measure the actual video element (the
  // publication's static dimensions are unreliable, and the element fires
  // `resize` when the phone rotates mid-call) and adapt the card (compact)
  // or letterbox within the grid cell.
  const videoRef = useRef<HTMLVideoElement>(null)
  const [portrait, setPortrait] = useState(false)
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const update = () => {
      if (el.videoWidth && el.videoHeight) {
        setPortrait(el.videoHeight > el.videoWidth)
      }
    }
    update()
    el.addEventListener("resize", update)
    el.addEventListener("loadedmetadata", update)
    return () => {
      el.removeEventListener("resize", update)
      el.removeEventListener("loadedmetadata", update)
    }
  }, [hasVideo])

  return (
    <div
      className={`relative overflow-hidden rounded-box transition-shadow ${
        participant.isLocal
          ? "bg-[color-mix(in_oklch,var(--color-primary)_20%,var(--color-base-300))] ring-1 ring-primary/40"
          : "bg-base-300"
      } ${speaking ? "ring-2 ring-primary" : ""} ${
        handUp ? "outline-2 outline-success outline-offset-2" : ""
      } ${
        compact
          ? `${portrait ? "aspect-[9/16]" : "aspect-video"} shrink-0`
          : "size-full min-h-0"
      }`}
    >
      {hasVideo ? (
        <VideoTrack
          ref={videoRef}
          trackRef={trackRef}
          className={`size-full ${portrait && !compact ? "object-contain" : "object-cover"} ${
            participant.isLocal ? "scale-x-[-1]" : ""
          }`}
        />
      ) : (
        <div className="flex size-full items-center justify-center">
          <div
            className={`flex items-center justify-center rounded-full font-medium ${
              participant.isLocal
                ? "bg-secondary text-secondary-content"
                : "bg-primary text-primary-content"
            } ${compact ? "size-10 text-base" : "size-16 text-2xl"}`}
          >
            {name.charAt(0).toUpperCase()}
          </div>
        </div>
      )}

      {/* Call on: lets a hand-raised (on-mention policy) agent take a turn. */}
      {isAgent && agentId && agentState === "hand-raised" && canControl && (
        <button
          type="button"
          className="btn btn-primary btn-xs absolute top-2 right-2 z-10 gap-1"
          onClick={() => sendControl({ type: "call-on", agentId }, name)}
        >
          <Hand className="size-3" />
          Call on
        </button>
      )}

      {/* Tap to interrupt: cuts the agent off mid-sentence. */}
      {isAgent && agentId && agentState === "speaking" && canControl && (
        <button
          type="button"
          className="btn btn-warning btn-xs absolute top-2 right-2 z-10 gap-1"
          onClick={() => sendControl({ type: "interrupt", agentId }, name)}
        >
          <Hand className="size-3" />
          Interrupt
        </button>
      )}

      {/* Full agent controls, stacked along the tile's right edge — everyone
          sees them; they're inert for non-hosts if the host reserved them.
          Hidden on compact tiles: no room, and the panel covers it. */}
      {isAgent && agentId && !compact && (
        <AgentTileControls agentId={agentId} participant={participant} />
      )}

      {handUp && (
        <span className="badge badge-soft badge-success badge-sm absolute top-2 left-2 z-10 gap-1">
          <Hand className="size-3" />
          Hand raised
        </span>
      )}

      <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
        <span className="badge badge-neutral badge-sm gap-1 bg-base-100/80 text-base-content backdrop-blur">
          {micMuted && <MicOff className="size-3 text-error" />}
          {participant.isLocal ? `${name} (you)` : name}
          {isAway && <span className="text-base-content/60">· away</span>}
        </span>
        <QualityBars quality={quality} />
        {isAgent && meta?.agentId && <AgentBadge participant={participant} />}
      </div>
    </div>
  )
}

/** Three signal bars colored by LiveKit's per-participant connection quality. */
function QualityBars({ quality }: { quality: ConnectionQuality }) {
  if (quality === ConnectionQuality.Unknown) return null
  const level =
    quality === ConnectionQuality.Excellent
      ? 3
      : quality === ConnectionQuality.Good
        ? 2
        : quality === ConnectionQuality.Poor
          ? 1
          : 0
  const color =
    level >= 3 ? "bg-success" : level === 2 ? "bg-warning" : "bg-error"
  return (
    <span
      className="flex items-end gap-px rounded-sm bg-base-100/80 p-1 backdrop-blur"
      title={`Connection: ${quality}`}
    >
      {[1, 2, 3].map((bar) => (
        <span
          key={bar}
          className={`w-0.5 rounded-sm ${bar <= Math.max(level, 1) && level > 0 ? color : "bg-base-content/20"}`}
          style={{ height: `${3 + bar * 2}px` }}
        />
      ))}
    </span>
  )
}
