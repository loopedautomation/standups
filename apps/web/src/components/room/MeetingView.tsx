"use client"

import {
  RoomAudioRenderer,
  useConnectionState,
  useTracks,
} from "@livekit/components-react"
import { useStore } from "@nanostores/react"
import { ConnectionState, Track } from "livekit-client"
import { motion } from "motion/react"
import { useRef } from "react"
import { ControlBar } from "@/components/room/ControlBar"
import { ParticipantTile } from "@/components/room/ParticipantTile"
import { PanelHost } from "@/components/room/panels/PanelHost"
import { RoomDataListener } from "@/components/room/RoomDataListener"
import { ScreenShareTile } from "@/components/room/ScreenShareTile"
import { $openPanel } from "@/stores/panels"

export function MeetingView({ slug }: { slug: string }) {
  const cameraTracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false },
  )
  const screenTracks = useTracks([Track.Source.ScreenShare], {
    onlySubscribed: true,
  })
  const focused = screenTracks[0]

  const localTrack = cameraTracks.find((t) => t.participant.isLocal)
  const remoteTracks = cameraTracks.filter((t) => !t.participant.isLocal)
  const alone = remoteTracks.length === 0
  const stageRef = useRef<HTMLDivElement>(null)
  const connectionState = useConnectionState()
  const openPanel = useStore($openPanel)

  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <RoomAudioRenderer />
      <RoomDataListener />
      <ControlBar slug={slug} />

      {connectionState !== ConnectionState.Connected && (
        <div className="alert alert-warning fixed top-4 left-1/2 z-50 w-auto -translate-x-1/2 shadow-lg">
          <span className="loading loading-spinner loading-sm" />
          {connectionState === ConnectionState.Reconnecting ||
          connectionState === ConnectionState.SignalReconnecting
            ? "Connection lost — reconnecting…"
            : "Connecting…"}
        </div>
      )}

      <div ref={stageRef} className="relative flex min-h-0 flex-1 gap-3 p-3">
        {focused ? (
          <>
            <div className="min-w-0 flex-1">
              <ScreenShareTile trackRef={focused} />
            </div>
            <div className="flex w-52 shrink-0 flex-col gap-3 overflow-y-auto">
              {remoteTracks.map((trackRef) => (
                <ParticipantTile
                  key={trackRef.participant.identity}
                  trackRef={trackRef}
                  compact
                />
              ))}
            </div>
          </>
        ) : alone ? (
          // Just you: your own camera fills the stage.
          localTrack && (
            <div className="min-h-0 min-w-0 flex-1">
              <ParticipantTile trackRef={localTrack} />
            </div>
          )
        ) : (
          <div
            className="grid min-h-0 min-w-0 flex-1 gap-3"
            style={{
              gridTemplateColumns: `repeat(${gridColumns(remoteTracks.length)}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${gridRows(remoteTracks.length)}, minmax(0, 1fr))`,
            }}
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
            anywhere. When a side panel is open it sits to the panel's left. */}
        {!alone && localTrack && (
          <motion.div
            drag
            dragConstraints={stageRef}
            dragElastic={0.25}
            dragMomentum
            dragTransition={{ bounceStiffness: 400, bounceDamping: 22 }}
            whileDrag={{ scale: 1.04 }}
            className={`absolute bottom-6 z-10 w-48 cursor-grab shadow-lg transition-[right] duration-200 active:cursor-grabbing sm:w-56 ${
              openPanel ? "right-[22.25rem]" : "right-6"
            }`}
          >
            <ParticipantTile trackRef={localTrack} compact />
          </motion.div>
        )}

        <PanelHost slug={slug} />
      </div>
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
