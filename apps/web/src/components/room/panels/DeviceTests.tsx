"use client"

import { useMediaDeviceSelect } from "@livekit/components-react"
import { Mic, Volume2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"

const RECORD_MS = 3000

/**
 * Record three seconds from the selected mic and play it back through the
 * selected speaker — the only honest answer to "how do I sound?".
 */
export function MicTest() {
  const { activeDeviceId: micId } = useMediaDeviceSelect({ kind: "audioinput" })
  const { activeDeviceId: speakerId } = useMediaDeviceSelect({
    kind: "audiooutput",
  })
  const [phase, setPhase] = useState<"idle" | "recording" | "playing">("idle")
  const cleanup = useRef<(() => void) | null>(null)

  useEffect(() => () => cleanup.current?.(), [])

  const run = async () => {
    if (phase !== "idle") return
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: micId ? { exact: micId } : undefined },
      })
    } catch {
      return
    }
    setPhase("recording")
    const recorder = new MediaRecorder(stream)
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => chunks.push(e.data)
    recorder.onstop = () => {
      for (const t of stream.getTracks()) t.stop()
      const url = URL.createObjectURL(new Blob(chunks))
      const audio = new Audio(url)
      // Route playback to the chosen speaker where the browser allows it.
      void (audio as { setSinkId?: (id: string) => Promise<void> })
        .setSinkId?.(speakerId ?? "")
        ?.catch(() => undefined)
      setPhase("playing")
      audio.onended = () => {
        URL.revokeObjectURL(url)
        setPhase("idle")
      }
      void audio.play().catch(() => setPhase("idle"))
      cleanup.current = () => {
        audio.pause()
        URL.revokeObjectURL(url)
      }
    }
    recorder.start()
    const timer = setTimeout(() => recorder.stop(), RECORD_MS)
    cleanup.current = () => {
      clearTimeout(timer)
      if (recorder.state !== "inactive") recorder.stop()
      for (const t of stream.getTracks()) t.stop()
    }
  }

  return (
    <button
      type="button"
      className="btn btn-sm w-full gap-1"
      disabled={phase !== "idle"}
      onClick={() => void run()}
    >
      <Mic className="size-4" />
      {phase === "recording"
        ? "Recording… speak now"
        : phase === "playing"
          ? "Playing back…"
          : "Test mic"}
    </button>
  )
}

/** Play a short chime through the selected output device. */
export function SpeakerTest() {
  const { activeDeviceId: speakerId } = useMediaDeviceSelect({
    kind: "audiooutput",
  })

  const play = async () => {
    try {
      const ctx = new AudioContext()
      // Chrome routes AudioContexts; elsewhere the default output is used.
      await (ctx as unknown as { setSinkId?: (id: string) => Promise<void> })
        .setSinkId?.(speakerId ?? "")
        ?.catch(() => undefined)
      const gain = ctx.createGain()
      gain.gain.value = 0.12
      gain.connect(ctx.destination)
      ;[523.25, 659.25, 783.99].forEach((freq, i) => {
        const osc = ctx.createOscillator()
        osc.type = "sine"
        osc.frequency.value = freq
        const at = ctx.currentTime + i * 0.15
        osc.connect(gain)
        osc.start(at)
        osc.stop(at + 0.13)
      })
      setTimeout(() => void ctx.close().catch(() => undefined), 900)
    } catch {
      // no audio context available — nothing to test with
    }
  }

  return (
    <button
      type="button"
      className="btn btn-sm w-full gap-1"
      onClick={() => void play()}
    >
      <Volume2 className="size-4" />
      Test speaker
    </button>
  )
}
