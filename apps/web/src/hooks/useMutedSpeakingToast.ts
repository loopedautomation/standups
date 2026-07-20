"use client"

import { useLocalParticipant } from "@livekit/components-react"
import { Track } from "livekit-client"
import { useEffect } from "react"
import { toast } from "react-toastify"

/** Sustained speech above this RMS while muted triggers the reminder. */
const RMS_THRESHOLD = 0.04
const SUSTAIN_MS = 350
const COOLDOWN_MS = 15_000
const POLL_MS = 100
/** Speech dips below the threshold between words; only this much continuous
 * quiet counts as actually having stopped talking. */
const HANGOVER_MS = 500

/**
 * "You're muted" reminder: while the mic is muted, watch the local audio
 * level (never published anywhere) and toast when the user talks anyway.
 * Uses the existing mic track when LiveKit kept it alive, otherwise opens
 * its own capture for the duration of the mute.
 */
export function useMutedSpeakingToast() {
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant()

  useEffect(() => {
    if (typeof window === "undefined" || isMicrophoneEnabled) return
    let cancelled = false
    let audioCtx: AudioContext | null = null
    let ownStream: MediaStream | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    void (async () => {
      try {
        const pub = localParticipant.getTrackPublication(
          Track.Source.Microphone,
        )
        const existing = pub?.track?.mediaStreamTrack
        // Muting the mic in LiveKit disables its MediaStreamTrack rather than
        // stopping it: the track stays "live" but delivers pure silence, so the
        // analyser would never see speech. Only reuse a track that is still
        // enabled; otherwise open our own capture for the duration of the mute.
        let track =
          existing && existing.readyState === "live" && existing.enabled
            ? existing
            : null
        if (!track) {
          ownStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          })
          track = ownStream.getAudioTracks()[0] ?? null
        }
        if (!track || cancelled) return

        audioCtx = new AudioContext()
        if (audioCtx.state === "suspended") await audioCtx.resume()
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 512
        audioCtx
          .createMediaStreamSource(new MediaStream([track]))
          .connect(analyser)
        const buf = new Float32Array(analyser.fftSize)

        let loudSince = 0
        let lastLoud = 0
        let lastToast = 0
        const tick = () => {
          if (cancelled) return
          analyser.getFloatTimeDomainData(buf)
          let sum = 0
          for (const s of buf) sum += s * s
          const rms = Math.sqrt(sum / buf.length)
          const now = Date.now()
          if (rms > RMS_THRESHOLD) {
            if (!loudSince) loudSince = now
            lastLoud = now
          } else if (loudSince && now - lastLoud > HANGOVER_MS) {
            // Quiet long enough to count as done talking, not a word gap.
            loudSince = 0
          }
          if (
            loudSince &&
            now - loudSince > SUSTAIN_MS &&
            now - lastToast > COOLDOWN_MS
          ) {
            toast.info("You're muted — unmute to be heard")
            lastToast = now
            loudSince = 0
          }
          timer = setTimeout(tick, POLL_MS)
        }
        tick()
      } catch {
        // no mic permission or capture failed — no reminder, nothing broken
      }
    })()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      void audioCtx?.close().catch(() => {})
      for (const t of ownStream?.getTracks() ?? []) t.stop()
    }
  }, [isMicrophoneEnabled, localParticipant])
}
