"use client"

import { Mic, MicOff, Video as VideoIcon, VideoOff } from "lucide-react"
import { useRef, useState } from "react"
import { Wordmark } from "@/components/brand/BrandMark"
import { ThemeToggle } from "@/components/brand/ThemeToggle"
import type { JoinPreferences } from "@/components/room/RoomClient"
import { useMediaPreview } from "@/hooks/useMediaPreview"

type LobbyProps = {
  slug: string
  onJoin: (prefs: JoinPreferences) => Promise<void>
  error: string | null
}

export function Lobby({ slug, onJoin, error }: LobbyProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [displayName, setDisplayName] = useState(() => {
    if (typeof window === "undefined") return ""
    try {
      return localStorage.getItem("displayName") ?? ""
    } catch {
      return ""
    }
  })
  const [audioEnabled, setAudioEnabled] = useState(true)
  const [videoEnabled, setVideoEnabled] = useState(true)
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
              className={`btn btn-circle ${audioEnabled ? "btn-neutral" : "btn-error"}`}
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
              className={`btn btn-circle ${videoEnabled ? "btn-neutral" : "btn-error"}`}
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
              <select
                className="select w-full"
                value={audioDeviceId ?? ""}
                onChange={(e) => setAudioDeviceId(e.target.value || undefined)}
              >
                <option value="">Default microphone</option>
                {mics.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || "Microphone"}
                  </option>
                ))}
              </select>
            </label>
          )}

          {cameras.length > 0 && (
            <label className="form-control w-full">
              <span className="label-text pb-1 text-xs">Camera</span>
              <select
                className="select w-full"
                value={videoDeviceId ?? ""}
                onChange={(e) => setVideoDeviceId(e.target.value || undefined)}
              >
                <option value="">Default camera</option>
                {cameras.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || "Camera"}
                  </option>
                ))}
              </select>
            </label>
          )}

          {(mediaError || error) && (
            <p className="text-error text-sm">{mediaError ?? error}</p>
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
