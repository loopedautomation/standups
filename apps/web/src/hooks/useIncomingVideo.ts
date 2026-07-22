"use client"

import { useRoomContext } from "@livekit/components-react"
import {
  type RemoteTrackPublication,
  RoomEvent,
  Track,
} from "livekit-client"
import { useEffect } from "react"

/**
 * Enforce the "turn off incoming video" preference: unsubscribe every remote
 * camera publication (the server then stops sending that video), including
 * ones published later. Screenshares are left alone. Turning the preference
 * off resubscribes everything.
 */
export function useIncomingVideo(off: boolean) {
  const room = useRoomContext()

  useEffect(() => {
    const apply = (pub: RemoteTrackPublication) => {
      if (pub.kind !== Track.Kind.Video) return
      if (pub.source === Track.Source.ScreenShare) return
      pub.setSubscribed(!off)
    }
    const applyAll = () => {
      for (const participant of room.remoteParticipants.values()) {
        for (const pub of participant.trackPublications.values()) apply(pub)
      }
    }
    applyAll()

    const onPublished = (pub: RemoteTrackPublication) => apply(pub)
    room.on(RoomEvent.TrackPublished, onPublished)
    return () => {
      room.off(RoomEvent.TrackPublished, onPublished)
    }
  }, [room, off])
}
