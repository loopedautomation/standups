import type { LocalAudioTrack, LocalVideoTrack, Room } from "livekit-client"
import { Track } from "livekit-client"
import {
  AUTO_MAX_RESOLUTION,
  SEND_QUALITY_RESOLUTION,
  type SendQuality,
} from "@/stores/preferences"

/**
 * Mid-call re-capture with new constraints. RoomClient seeds the same
 * preferences into the capture defaults, so these only matter for changes
 * made while the track is live.
 */

export async function applyAutoGain(room: Room, on: boolean): Promise<void> {
  const track = room.localParticipant.getTrackPublication(
    Track.Source.Microphone,
  )?.track as LocalAudioTrack | undefined
  await track?.restartTrack({
    autoGainControl: on,
    echoCancellation: true,
    noiseSuppression: true,
  })
}

export async function applySendQuality(
  room: Room,
  quality: SendQuality,
): Promise<void> {
  const track = room.localParticipant.getTrackPublication(Track.Source.Camera)
    ?.track as LocalVideoTrack | undefined
  if (!track) return
  await track.restartTrack({
    resolution:
      quality === "auto"
        ? AUTO_MAX_RESOLUTION
        : SEND_QUALITY_RESOLUTION[quality],
  })
}
