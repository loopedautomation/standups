"use client"

import {
  RoomAudioRenderer,
  useConnectionState,
  useTracks,
} from "@livekit/components-react"
import { parseParticipantMeta } from "@meet/shared"
import { useStore } from "@nanostores/react"
import { ConnectionState, Track } from "livekit-client"
import { motion } from "motion/react"
import { useRef } from "react"
import { ControlBar } from "@/components/room/ControlBar"
import { ParticipantTile } from "@/components/room/ParticipantTile"
import { PanelHost } from "@/components/room/panels/PanelHost"
import { RoomDataListener } from "@/components/room/RoomDataListener"
import { ScreenShareTile } from "@/components/room/ScreenShareTile"
import { WhiteboardStage } from "@/components/room/WhiteboardStage"
import { useAgentControlToasts } from "@/hooks/useAgentControlToasts"
import { useAwayOnHidden } from "@/hooks/useAwayOnHidden"
import { useJoinLeaveSounds } from "@/hooks/useJoinLeaveSounds"
import { useKnockAlerts } from "@/hooks/useKnockAlerts"
import {
  readLocalSttPref,
  useLocalTranscription,
} from "@/hooks/useLocalTranscription"
import { useMutedSpeakingToast } from "@/hooks/useMutedSpeakingToast"
import { useScreenShareTakeover } from "@/hooks/useScreenShareTakeover"
import { useScreenShareVisionNotice } from "@/hooks/useScreenShareVisionNotice"
import { $canvasOpen } from "@/stores/canvas"
import { $openPanel } from "@/stores/panels"

export function MeetingView({
  slug,
  shareBase,
  startedAt,
}: {
  slug: string
  shareBase?: string
  startedAt?: number
}) {
  useJoinLeaveSounds()
  useKnockAlerts(slug)
  useAgentControlToasts()
  useAwayOnHidden()
  useLocalTranscription(readLocalSttPref())
  useMutedSpeakingToast()
  useScreenShareVisionNotice()
  const cameraTracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false },
  )
  const screenTracks = useTracks([Track.Source.ScreenShare], {
    onlySubscribed: true,
  })
  // A single share owns the stage: the newest sharer takes over and stops the
  // previous one. While both are briefly live, prefer the one that most
  // recently announced a takeover; fall back to LiveKit's order otherwise.
  const latestSharer = useScreenShareTakeover()
  const focused =
    screenTracks.find((t) => t.participant.identity === latestSharer) ??
    screenTracks[0]

  const localTrack = cameraTracks.find((t) => t.participant.isLocal)
  // Service participants (the transcriber) and knockers still in the waiting
  // room never get a tile.
  const remoteTracks = cameraTracks.filter((t) => {
    if (t.participant.isLocal) return false
    const kind = parseParticipantMeta(t.participant.metadata)?.kind
    return kind !== "service" && kind !== "waiting"
  })
  const alone = remoteTracks.length === 0
  const stageRef = useRef<HTMLDivElement>(null)
  const connectionState = useConnectionState()
  const openPanel = useStore($openPanel)
  const whiteboardOpen = useStore($canvasOpen)

  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <RoomAudioRenderer />
      <RoomDataListener slug={slug} />
      <ControlBar slug={slug} shareBase={shareBase} startedAt={startedAt} />

      {connectionState !== ConnectionState.Connected && (
        <div className="alert alert-warning fixed bottom-6 left-1/2 z-50 w-auto -translate-x-1/2 shadow-lg">
          <span className="loading loading-spinner loading-sm" />
          {connectionState === ConnectionState.Reconnecting ||
          connectionState === ConnectionState.SignalReconnecting
            ? "Connection lost — reconnecting…"
            : "Connecting…"}
        </div>
      )}

      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 flex-col gap-3 p-3 md:flex-row"
      >
        {whiteboardOpen ? (
          <WhiteboardTakeover
            slug={slug}
            tracks={remoteTracks}
            focused={focused}
          />
        ) : focused ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            <div className="min-h-0 min-w-0 flex-1">
              <ScreenShareTile trackRef={focused} />
            </div>
            {/* Participants sit in a horizontal strip below the share,
                centered and sized to match the draggable self-view. */}
            <ParticipantStrip tracks={remoteTracks} />
          </div>
        ) : alone ? (
          // Just you: your own camera fills the stage.
          localTrack && (
            <div className="min-h-0 min-w-0 flex-1">
              <ParticipantTile trackRef={localTrack} />
            </div>
          )
        ) : (
          // Phones in portrait stack tiles vertically; rotating to landscape
          // (or any md+ screen) switches to the computed grid.
          <div
            className="grid min-h-0 min-w-0 flex-1 auto-rows-fr grid-cols-1 gap-3 landscape:[grid-template-columns:var(--cols)] landscape:[grid-template-rows:var(--rows)] md:[grid-template-columns:var(--cols)] md:[grid-template-rows:var(--rows)]"
            style={
              {
                "--cols": `repeat(${gridColumns(remoteTracks.length)}, minmax(0, 1fr))`,
                "--rows": `repeat(${gridRows(remoteTracks.length)}, minmax(0, 1fr))`,
              } as React.CSSProperties
            }
          >
            {remoteTracks.map((trackRef) => (
              <ParticipantTile
                key={trackRef.participant.identity}
                trackRef={trackRef}
              />
            ))}
          </div>
        )}

        {/* Your own video floats bottom-right once others are in the call; drag it
            anywhere. When a side panel is open it sits to the panel's left.
            While a screen share is focused, the bottom edge is taken by the
            participant strip, so it floats top-right instead. */}
        {!alone && localTrack && (
          <motion.div
            drag
            dragConstraints={stageRef}
            dragElastic={0.1}
            // No momentum: a fling can carry the tile past the constraint
            // bounds and leave it stranded half off-screen (worst on touch).
            dragMomentum={false}
            whileDrag={{ scale: 1.04 }}
            // touch-none stops mobile browsers treating the drag as a page
            // scroll/pan, which was fighting the gesture. Rounding + shadow
            // live together here so the shadow follows the rounded corners.
            className={`absolute z-10 w-32 cursor-grab touch-none rounded-box shadow-lg transition-[right] duration-200 active:cursor-grabbing sm:w-56 ${
              focused || whiteboardOpen ? "top-6" : "bottom-6"
            } ${openPanel ? "right-[22.25rem]" : "right-6"}`}
          >
            <ParticipantTile trackRef={localTrack} compact />
          </motion.div>
        )}

        <PanelHost slug={slug} />
      </div>
    </div>
  )
}

/**
 * The whiteboard owning the stage the way a share does. A share starting
 * doesn't force the board closed (the agent may be mid-diagram) — its tile
 * in the strip is the way back.
 */
function WhiteboardTakeover({
  slug,
  tracks,
  focused,
}: {
  slug: string
  tracks: ReturnType<typeof useTracks>
  focused?: React.ComponentProps<typeof ScreenShareTile>["trackRef"]
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <div className="min-h-0 min-w-0 flex-1">
        <WhiteboardStage slug={slug} />
      </div>
      <ParticipantStrip tracks={tracks}>
        {focused && (
          <button
            type="button"
            className="w-32 shrink-0 cursor-pointer sm:w-56"
            onClick={() => $canvasOpen.set(false)}
            title="Back to the screen share"
          >
            <ScreenShareTile trackRef={focused} />
          </button>
        )}
      </ParticipantStrip>
    </div>
  )
}

/** The compact tile row under a stage takeover (share or whiteboard). */
function ParticipantStrip({
  tracks,
  children,
}: {
  tracks: ReturnType<typeof useTracks>
  children?: React.ReactNode
}) {
  return (
    <div className="flex shrink-0 flex-row flex-wrap justify-center gap-3 overflow-x-auto">
      {children}
      {tracks.map((trackRef) => (
        <div
          key={trackRef.participant.identity}
          className="w-32 shrink-0 sm:w-56"
        >
          <ParticipantTile trackRef={trackRef} compact />
        </div>
      ))}
    </div>
  )
}

function gridColumns(count: number): number {
  if (count <= 1) return 1
  if (count <= 4) return 2
  if (count <= 9) return 3
  return 4
}

function gridRows(count: number): number {
  return Math.max(1, Math.ceil(count / gridColumns(count)))
}
