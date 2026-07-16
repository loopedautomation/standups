"use client"

import { RoomAudioRenderer, useTracks } from "@livekit/components-react"
import { Track } from "livekit-client"
import { motion } from "motion/react"
import { useRef } from "react"
import { ControlBar } from "@/components/room/ControlBar"
import { ParticipantTile } from "@/components/room/ParticipantTile"
import { PanelHost } from "@/components/room/panels/PanelHost"
import { ScreenShareTile } from "@/components/room/ScreenShareTile"

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

  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <RoomAudioRenderer />

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

        {/* Your own video floats bottom-right once others are in the call; drag it anywhere. */}
        {!alone && localTrack && (
          <motion.div
            drag
            dragConstraints={stageRef}
            dragElastic={0.1}
            dragMomentum={false}
            className="absolute right-6 bottom-6 z-10 w-48 cursor-grab shadow-lg active:cursor-grabbing sm:w-56"
          >
            <ParticipantTile trackRef={localTrack} compact />
          </motion.div>
        )}

        <PanelHost slug={slug} />
      </div>

      <ControlBar slug={slug} />
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
