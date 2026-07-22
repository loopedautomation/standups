"use client"

import { useRoomContext } from "@livekit/components-react"
import {
  chatMessageSchema,
  DataTopic,
  parseParticipantMeta,
} from "@meet/shared"
import { RoomEvent } from "livekit-client"
import { useEffect } from "react"

/** Short synthesized cues — no audio assets, quiet by design. */
function playCue(kind: "join" | "leave" | "chat") {
  try {
    const ctx = new AudioContext()
    const gain = ctx.createGain()
    gain.gain.value = 0.06
    gain.connect(ctx.destination)
    const notes =
      kind === "join"
        ? [523.25, 659.25] // C5 -> E5, rising
        : kind === "leave"
          ? [659.25, 523.25] // falling
          : [880] // single pop
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      osc.type = "sine"
      osc.frequency.value = freq
      const at = ctx.currentTime + i * 0.12
      osc.connect(gain)
      osc.start(at)
      osc.stop(at + 0.1)
    })
    setTimeout(() => void ctx.close().catch(() => undefined), 600)
  } catch {
    // no audio context — silence is fine
  }
}

/** Join/leave chimes and a chat pop, each gated by the sounds preference. */
export function useMeetingSounds(enabled: boolean) {
  const room = useRoomContext()

  useEffect(() => {
    if (!enabled) return
    const onJoin = (p: { metadata?: string }) => {
      // Waiting-room entries chime on admission (they connect again), not
      // while queued.
      if (parseParticipantMeta(p.metadata)?.kind === "waiting") return
      playCue("join")
    }
    const onLeave = (p: { metadata?: string }) => {
      if (parseParticipantMeta(p.metadata)?.kind === "waiting") return
      playCue("leave")
    }
    const onData = (
      payload: Uint8Array,
      _p: unknown,
      _k: unknown,
      topic?: string,
    ) => {
      if (topic !== DataTopic.Chat) return
      try {
        chatMessageSchema.parse(JSON.parse(new TextDecoder().decode(payload)))
        playCue("chat")
      } catch {}
    }
    room.on(RoomEvent.ParticipantConnected, onJoin)
    room.on(RoomEvent.ParticipantDisconnected, onLeave)
    room.on(RoomEvent.DataReceived, onData)
    return () => {
      room.off(RoomEvent.ParticipantConnected, onJoin)
      room.off(RoomEvent.ParticipantDisconnected, onLeave)
      room.off(RoomEvent.DataReceived, onData)
    }
  }, [enabled, room])
}
