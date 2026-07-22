"use client"

import { useMediaDeviceSelect } from "@livekit/components-react"
import {
  type RoomSettings,
  serializeVideoTransform,
  type VideoTransform,
  videoTransformCss,
} from "@meet/shared"
import { useStore } from "@nanostores/react"
import {
  FlipHorizontal2,
  FlipVertical2,
  Lock,
  Moon,
  RotateCw,
  Sun,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "react-toastify"
import { NetworkSection } from "@/components/room/CallHealth"
import { Select } from "@/components/ui/Select"
import { useAgentPermissions } from "@/hooks/useRoomSettings"
import { supportsVoiceIsolation } from "@/hooks/useVoiceIsolation"
import {
  $videoTransform,
  rotatedCw,
  setVideoTransform,
} from "@/stores/videoTransform"
import { cleanDeviceLabel } from "@/lib/deviceLabel"
import { readHostKey } from "@/lib/hostKey"
import { $blur, setBlur } from "@/stores/blur"
import {
  $pauseCameraOnBackground,
  setPauseCameraOnBackground,
} from "@/stores/camera"
import { setDevicePref } from "@/stores/devicePrefs"
import {
  $incomingVideoOff,
  setIncomingVideoOff,
} from "@/stores/incomingVideo"
import { $theme, setTheme } from "@/stores/theme"
import { $voiceIsolation, setVoiceIsolation } from "@/stores/voiceIsolation"

export function SettingsPanel({ slug }: { slug: string }) {
  const theme = useStore($theme)
  const blur = useStore($blur)
  const voiceIsolation = useStore($voiceIsolation)
  const pauseOnBackground = useStore($pauseCameraOnBackground)
  const incomingVideoOff = useStore($incomingVideoOff)

  return (
    <div className="flex flex-col gap-6 p-4">
      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-base-content/60 text-xs uppercase tracking-wide">
          Appearance
        </h3>
        <div className="join w-full">
          <button
            type="button"
            className={`btn join-item flex-1 ${theme === "looped-light" ? "btn-primary" : "btn-neutral"}`}
            onClick={() => setTheme("looped-light")}
          >
            <Sun className="size-4" />
            Light
          </button>
          <button
            type="button"
            className={`btn join-item flex-1 ${theme === "looped-dark" ? "btn-primary" : "btn-neutral"}`}
            onClick={() => setTheme("looped-dark")}
          >
            <Moon className="size-4" />
            Dark
          </button>
        </div>
      </section>

      {/* min-w-0 at every flex level: the selects' longest option would
          otherwise set the section's min-content width and overflow the
          panel sideways. */}
      <section className="flex min-w-0 flex-col gap-3">
        <h3 className="font-medium text-base-content/60 text-xs uppercase tracking-wide">
          Devices
        </h3>
        <DeviceSelect
          kind="audioinput"
          label="Select microphone"
          persistKey="audioDeviceId"
        />
        <MicLevel />
        {supportsVoiceIsolation() && (
          <label className="flex cursor-pointer items-center justify-between gap-4">
            <span className="flex flex-col">
              <span className="text-sm">Enhanced noise removal</span>
              <span className="text-base-content/60 text-xs">
                Isolates your voice and strips out background noise (fans,
                typing, chatter). On by default — turn it off if it clips your
                audio.
              </span>
            </span>
            <input
              type="checkbox"
              className="toggle toggle-primary"
              checked={voiceIsolation}
              onChange={(e) => setVoiceIsolation(e.target.checked)}
            />
          </label>
        )}
        <CameraSetting />
        <label className="flex cursor-pointer items-center justify-between">
          <span className="text-sm">Background blur</span>
          <input
            type="checkbox"
            className="toggle toggle-primary"
            checked={blur}
            onChange={(e) => setBlur(e.target.checked)}
          />
        </label>
        <DeviceSelect
          kind="audiooutput"
          label="Select speaker"
          persistKey="audioOutputDeviceId"
        />
      </section>

      <NetworkSection />

      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-base-content/60 text-xs uppercase tracking-wide">
          Connection
        </h3>
        <label className="flex cursor-pointer items-center justify-between gap-4">
          <span className="flex flex-col">
            <span className="text-sm">Turn off incoming video</span>
            <span className="text-base-content/60 text-xs">
              Stops receiving other people's cameras to save bandwidth on a
              poor connection. Audio and screenshares keep coming through.
            </span>
          </span>
          <input
            type="checkbox"
            className="toggle toggle-primary"
            checked={incomingVideoOff}
            onChange={(e) => setIncomingVideoOff(e.target.checked)}
          />
        </label>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-base-content/60 text-xs uppercase tracking-wide">
          When you switch away
        </h3>
        <label className="flex cursor-pointer items-center justify-between gap-4">
          <span className="flex flex-col">
            <span className="text-sm">Pause my camera</span>
            <span className="text-base-content/60 text-xs">
              Turns your camera off while this tab is in the background, and
              back on when you return. Off by default — your camera keeps
              running.
            </span>
          </span>
          <input
            type="checkbox"
            className="toggle toggle-primary"
            checked={pauseOnBackground}
            onChange={(e) => setPauseCameraOnBackground(e.target.checked)}
          />
        </label>
      </section>

      {/* Everything above is personal — it changes only your own audio, video
          and view. Host-only room controls are cordoned off below, so it's
          clear which settings affect just you and which affect the meeting. */}
      <HostControls slug={slug} />
    </div>
  )
}

/**
 * Live level of the selected mic, shown just above its select so a device
 * change can be judged before the meeting hears it. Audio-only second
 * capture (fine alongside the published track); time-domain RMS at ~30fps.
 */
function MicLevel() {
  const { activeDeviceId: micId } = useMediaDeviceSelect({ kind: "audioinput" })
  const [level, setLevel] = useState(0)

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let audioCtx: AudioContext | null = null
    let raf = 0

    const acquire = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: micId ? { exact: micId } : undefined },
        })
      } catch {
        return // no meter beats an error box here — the select still works
      }
      if (cancelled) {
        for (const t of stream.getTracks()) t.stop()
        return
      }
      audioCtx = new AudioContext()
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 512
      audioCtx.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      const tick = () => {
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (const s of samples) sum += s * s
        // RMS is tiny for speech at normal levels — scale so talking fills
        // most of the bar and clipping pins it.
        setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4))
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    }
    void acquire()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      void audioCtx?.close().catch(() => undefined)
      for (const t of stream?.getTracks() ?? []) t.stop()
    }
  }, [micId])

  return <MicMeter level={level} />
}

/**
 * Camera picker with a true preview: the select and the tile show a pending
 * choice without touching the published camera — what the meeting sees only
 * changes on Save. (The mic select stays immediate: a mic switch is loud in
 * no one's face, and the meter previews it anyway.)
 */
function CameraSetting() {
  const { devices, activeDeviceId, setActiveMediaDevice } =
    useMediaDeviceSelect({ kind: "videoinput" })
  const applied = useStore($videoTransform)
  // undefined = following the live camera/transform; set = pending choice.
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [pendingT, setPendingT] = useState<VideoTransform | undefined>(
    undefined,
  )
  const shown = pending ?? activeDeviceId
  const shownT = pendingT ?? applied
  const dirty =
    (pending !== undefined && pending !== activeDeviceId) ||
    (pendingT !== undefined &&
      serializeVideoTransform(pendingT) !== serializeVideoTransform(applied))

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-base-content/70 text-sm">Select camera</span>
        <Select
          value={shown}
          onChange={(e) => setPending(e.target.value)}
          options={devices.map((d) => ({
            value: d.deviceId,
            label: cleanDeviceLabel(d.label) || "Camera",
          }))}
        />
      </label>
      <CameraSettingsPreview deviceId={shown} transform={shownT} />
      {/* Orientation stages like the device does: preview-only until Save. */}
      <div className="flex gap-1">
        <button
          type="button"
          className="btn btn-ghost btn-xs flex-1"
          title="Rotate 90° clockwise"
          onClick={() => setPendingT(rotatedCw(shownT))}
        >
          <RotateCw className="size-4" />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-xs flex-1"
          title="Flip horizontally"
          onClick={() => setPendingT({ ...shownT, flipH: !shownT.flipH })}
        >
          <FlipHorizontal2 className="size-4" />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-xs flex-1"
          title="Flip vertically"
          onClick={() => setPendingT({ ...shownT, flipV: !shownT.flipV })}
        >
          <FlipVertical2 className="size-4" />
        </button>
      </div>
      {dirty && (
        <button
          type="button"
          className="btn btn-primary btn-sm w-full"
          onClick={() => {
            if (pending !== undefined) {
              // Pin first so useStickyDevices doesn't fight the switch.
              setDevicePref("videoinput", pending)
              void setActiveMediaDevice(pending)
            }
            if (pendingT !== undefined) setVideoTransform(pendingT)
            setPending(undefined)
            setPendingT(undefined)
          }}
        >
          Apply changes
        </button>
      )}
    </div>
  )
}

/** Mirrored preview of one camera device, honoring rotation/flip. */
function CameraSettingsPreview({
  deviceId,
  transform,
}: {
  deviceId: string
  transform: VideoTransform
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const camId = deviceId
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    setError(false)
    void navigator.mediaDevices
      .getUserMedia({
        video: { deviceId: camId ? { exact: camId } : undefined },
      })
      .then((s) => {
        if (cancelled) {
          for (const t of s.getTracks()) t.stop()
          return
        }
        stream = s
        if (videoRef.current) videoRef.current.srcObject = s
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
      for (const t of stream?.getTracks() ?? []) t.stop()
    }
  }, [camId])

  if (error) {
    return (
      <p className="text-error text-xs">Couldn't open the camera to preview.</p>
    )
  }
  return (
    // Fixed frame: the video transforms *inside* this box and the overflow
    // clips, so a quarter-turned preview can't sprawl over the panel.
    <div className="aspect-video w-full overflow-hidden rounded-field bg-base-300">
      {/* biome-ignore lint/a11y/useMediaCaption: local camera preview */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="size-full object-cover"
        // Quarter turns scale up to keep covering the 16:9 frame.
        style={{
          transform: [
            videoTransformCss(transform, true),
            transform.rotation % 180 !== 0 ? "scale(1.78)" : undefined,
          ]
            .filter(Boolean)
            .join(" "),
        }}
      />
    </div>
  )
}

const METER_SEGMENTS = 32
/** How many top-end segments render in the darker purple when lit. */
const METER_PEAK_SEGMENTS = 7

/**
 * Segmented level meter: thin vertical bars lighting up left to right —
 * light purple through the body, dark purple at the loud end.
 */
function MicMeter({ level }: { level: number }) {
  return (
    <div className="flex w-full items-center gap-[3px]">
      {Array.from({ length: METER_SEGMENTS }, (_, i) => {
        const lit = level >= (i + 1) / METER_SEGMENTS
        const peak = i >= METER_SEGMENTS - METER_PEAK_SEGMENTS
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-size meter
            key={i}
            className={`h-4 min-w-0 flex-1 rounded-[1px] transition-colors duration-75 ${
              lit ? (peak ? "bg-primary" : "bg-secondary") : "bg-base-300"
            }`}
          />
        )
      })}
    </div>
  )
}

function DeviceSelect({
  kind,
  label,
  persistKey,
}: {
  kind: "audioinput" | "videoinput" | "audiooutput"
  label: string
  persistKey: string
}) {
  const { devices, activeDeviceId, setActiveMediaDevice } =
    useMediaDeviceSelect({ kind })

  if (devices.length === 0) return null

  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-base-content/70 text-sm">{label}</span>
      {/* Device labels are long ("Studio Display Microphone (…)") — the
          shared Select truncates them at the panel width. */}
      <Select
        value={activeDeviceId}
        onChange={(e) => {
          const id = e.target.value
          if (kind === "audiooutput") {
            // Speaker choice isn't governed by the sticky-device guard.
            try {
              localStorage.setItem(persistKey, id)
            } catch {}
          } else {
            // Keep the shared pin in sync (and persisted) so useStickyDevices
            // honours this change instead of re-asserting the old device.
            setDevicePref(kind, id)
          }
          void setActiveMediaDevice(id)
        }}
        options={devices.map((d) => ({
          value: d.deviceId,
          label: cleanDeviceLabel(d.label) || label,
        }))}
      />
    </label>
  )
}

/**
 * The organiser's room-level controls, governing what everyone else may do
 * with the meeting's agents. Only the host sees this, and only the host can
 * change it — the toggles write to room metadata through a host-key-
 * authenticated route, which is also what the invite endpoints check, so a
 * locked-down room stays locked down against a crafted request and not just
 * a hidden button.
 */
function HostControls({ slug }: { slug: string }) {
  const { isHost, settings } = useAgentPermissions()
  // Host in the UI is a claim; the key is the evidence the settings route
  // demands. Without it this section can't do anything, so don't show a
  // section whose toggles would only ever error.
  const [hostKey] = useState(() => readHostKey(slug))
  // The saved value lives in room metadata and arrives asynchronously via
  // useRoomInfo. A checkbox bound straight to it snaps back to the old value
  // on click and stays there until the round-trip lands — which reads as a
  // dead toggle. So reflect the intended value immediately and let metadata
  // reconcile it.
  const [pending, setPending] = useState<Partial<RoomSettings>>({})

  // Drop an optimistic value once the room's own metadata confirms it, so the
  // two can't drift and a later real change still shows through.
  useEffect(() => {
    setPending((prev) => {
      const next = { ...prev }
      let changed = false
      for (const key of Object.keys(next) as (keyof RoomSettings)[]) {
        if (settings[key] === next[key]) {
          delete next[key]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [settings])

  if (!isHost || !hostKey) return null

  const effective = { ...settings, ...pending }

  const update = async (key: keyof RoomSettings, value: boolean) => {
    setPending((prev) => ({ ...prev, [key]: value }))
    try {
      const res = await fetch(`/api/rooms/${slug}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: { [key]: value }, hostKey }),
      })
      if (!res.ok) throw new Error("save failed")
    } catch {
      // Roll the optimistic value back to whatever the room still says.
      setPending((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      toast.error("Could not save that setting.")
    }
  }

  return (
    <section className="flex flex-col gap-2 border-base-300 border-t pt-5">
      <h3 className="flex items-center gap-1.5 font-medium text-base-content/60 text-xs uppercase tracking-wide">
        <Lock className="size-3" />
        Host controls
      </h3>
      <p className="text-base-content/50 text-xs">
        Only you can see and change these. They apply to everyone else in the
        meeting — you always keep full control of the agents yourself.
      </p>
      <label className="flex cursor-pointer items-center justify-between gap-4">
        <span className="flex flex-col">
          <span className="text-sm">Others can control agents</span>
          <span className="text-base-content/60 text-xs">
            Mute, interrupt, zap and change how agents take turns. Off leaves
            the buttons visible to others but inert.
          </span>
        </span>
        <input
          type="checkbox"
          className="toggle toggle-primary"
          checked={effective.participantsCanControlAgents}
          onChange={(e) =>
            update("participantsCanControlAgents", e.target.checked)
          }
        />
      </label>
      <label className="flex cursor-pointer items-center justify-between gap-4">
        <span className="flex flex-col">
          <span className="text-sm">Others can invite agents</span>
          <span className="text-base-content/60 text-xs">
            Bring agents into the meeting, from the registry or by URL.
          </span>
        </span>
        <input
          type="checkbox"
          className="toggle toggle-primary"
          checked={effective.participantsCanInviteAgents}
          onChange={(e) =>
            update("participantsCanInviteAgents", e.target.checked)
          }
        />
      </label>
    </section>
  )
}
