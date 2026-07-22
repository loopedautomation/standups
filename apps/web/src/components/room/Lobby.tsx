"use client"

import { Mic, MicOff, Video as VideoIcon, VideoOff } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "react-toastify"
import { Wordmark } from "@/components/brand/BrandMark"
import { Select } from "@/components/ui/Select"
import { ThemeToggle } from "@/components/brand/ThemeToggle"
import type { JoinPreferences } from "@/components/room/RoomClient"
import { useMediaPreview } from "@/hooks/useMediaPreview"

function readStoredString(key: string): string {
  if (typeof window === "undefined") return ""
  try {
    return localStorage.getItem(key) ?? ""
  } catch {
    return ""
  }
}

function readStoredToggle(key: string): boolean {
  if (typeof window === "undefined") return true
  try {
    return localStorage.getItem(key) !== "false"
  } catch {
    return true
  }
}

type LobbyProps = {
  slug: string
  onJoin: (prefs: JoinPreferences) => Promise<void>
}

export function Lobby({ slug, onJoin }: LobbyProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [displayName, setDisplayName] = useState("")
  const [audioEnabled, setAudioEnabled] = useState(true)
  const [videoEnabled, setVideoEnabled] = useState(true)
  // Stored prefs are read after mount so SSR and first client render agree.
  const [restored, setRestored] = useState(false)
  useEffect(() => {
    setDisplayName(readStoredString("displayName"))
    setAudioEnabled(readStoredToggle("audioEnabled"))
    setVideoEnabled(readStoredToggle("videoEnabled"))
    setRestored(true)
  }, [])
  useEffect(() => {
    if (!restored) return
    try {
      localStorage.setItem("audioEnabled", String(audioEnabled))
      localStorage.setItem("videoEnabled", String(videoEnabled))
    } catch {}
  }, [restored, audioEnabled, videoEnabled])
  const [audioDeviceId, setAudioDeviceId] = useState<string>()
  const [videoDeviceId, setVideoDeviceId] = useState<string>()
  const [joining, setJoining] = useState(false)

  const { mics, cameras, mediaError, stopStream } = useMediaPreview({
    audioEnabled,
    videoEnabled,
    audioDeviceId,
    videoDeviceId,
    videoRef,
  })

  useEffect(() => {
    if (mediaError) toast.error(mediaError)
  }, [mediaError])

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!displayName.trim()) return
    setJoining(true)
    try {
      localStorage.setItem("displayName", displayName.trim())
    } catch {}
    stopStream()
    await onJoin({
      displayName: displayName.trim(),
      audioEnabled,
      videoEnabled,
      audioDeviceId,
      videoDeviceId,
    })
    setJoining(false)
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col px-6">
      <header className="flex items-center justify-between py-6">
        <Wordmark />
        <ThemeToggle />
      </header>

      <div className="grid flex-1 content-center gap-8 pb-16 lg:grid-cols-2">
        <div className="relative aspect-video overflow-hidden rounded-box bg-base-300">
          {videoEnabled ? (
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="size-full scale-x-[-1] object-cover"
            />
          ) : (
            <div className="flex size-full items-center justify-center text-base-content/50">
              Camera off
            </div>
          )}
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-2">
            <button
              type="button"
              className="btn btn-circle btn-neutral"
              onClick={() => setAudioEnabled((v) => !v)}
              aria-label={
                audioEnabled ? "Mute microphone" : "Unmute microphone"
              }
            >
              {audioEnabled ? (
                <Mic className="size-5" />
              ) : (
                <MicOff className="size-5" />
              )}
            </button>
            <button
              type="button"
              className="btn btn-circle btn-neutral"
              onClick={() => setVideoEnabled((v) => !v)}
              aria-label={videoEnabled ? "Turn camera off" : "Turn camera on"}
            >
              {videoEnabled ? (
                <VideoIcon className="size-5" />
              ) : (
                <VideoOff className="size-5" />
              )}
            </button>
          </div>
        </div>

        <form
          onSubmit={handleJoin}
          className="flex flex-col justify-center gap-4"
        >
          <div>
            <h1 className="font-semibold text-2xl tracking-tight">
              Ready to join?
            </h1>
            <p className="text-base-content/60 text-sm">
              Meeting <span className="font-mono">{slug}</span>
            </p>
          </div>

          <input
            className="input input-lg w-full"
            placeholder="Your name"
            value={displayName}
            maxLength={64}
            onChange={(e) => setDisplayName(e.target.value)}
          />

          {mics.length > 0 && (
            <label className="form-control w-full">
              <span className="label-text pb-1 text-xs">Microphone</span>
              <Select
                size="md"
                value={audioDeviceId ?? ""}
                onChange={(e) => setAudioDeviceId(e.target.value || undefined)}
                placeholder="Default microphone"
                options={mics.map((d) => ({
                  value: d.deviceId,
                  label: d.label || "Microphone",
                }))}
              />
            </label>
          )}

          {cameras.length > 0 && (
            <label className="form-control w-full">
              <span className="label-text pb-1 text-xs">Camera</span>
              <Select
                size="md"
                value={videoDeviceId ?? ""}
                onChange={(e) => setVideoDeviceId(e.target.value || undefined)}
                placeholder="Default camera"
                options={cameras.map((d) => ({
                  value: d.deviceId,
                  label: d.label || "Camera",
                }))}
              />
            </label>
          )}

          <button
            type="submit"
            className="btn btn-primary btn-lg"
            disabled={!displayName.trim() || joining}
          >
            {joining && <span className="loading loading-spinner loading-sm" />}
            Join meeting
          </button>
        </form>
      </div>
    </main>
  )
}
