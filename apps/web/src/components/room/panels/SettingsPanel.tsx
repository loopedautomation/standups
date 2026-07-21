"use client"

import { useMediaDeviceSelect } from "@livekit/components-react"
import type { RoomSettings } from "@meet/shared"
import { useStore } from "@nanostores/react"
import { Lock, Moon, Sun } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "react-toastify"
import { useAgentPermissions } from "@/hooks/useRoomSettings"
import { supportsVoiceIsolation } from "@/hooks/useVoiceIsolation"
import { readHostKey } from "@/lib/hostKey"
import { $blur, setBlur } from "@/stores/blur"
import {
  $pauseCameraOnBackground,
  setPauseCameraOnBackground,
} from "@/stores/camera"
import { $theme, setTheme } from "@/stores/theme"
import { $voiceIsolation, setVoiceIsolation } from "@/stores/voiceIsolation"

export function SettingsPanel({ slug }: { slug: string }) {
  const theme = useStore($theme)
  const blur = useStore($blur)
  const voiceIsolation = useStore($voiceIsolation)
  const pauseOnBackground = useStore($pauseCameraOnBackground)

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

      <section className="flex flex-col gap-3">
        <h3 className="font-medium text-base-content/60 text-xs uppercase tracking-wide">
          Devices
        </h3>
        <DeviceSelect
          kind="audioinput"
          label="Microphone"
          persistKey="audioDeviceId"
        />
        <DeviceSelect
          kind="videoinput"
          label="Camera"
          persistKey="videoDeviceId"
        />
        <DeviceSelect
          kind="audiooutput"
          label="Speaker"
          persistKey="audioOutputDeviceId"
        />
      </section>

      {supportsVoiceIsolation() && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium text-base-content/60 text-xs uppercase tracking-wide">
            Audio
          </h3>
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
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-base-content/60 text-xs uppercase tracking-wide">
          Camera effects
        </h3>
        <label className="flex cursor-pointer items-center justify-between">
          <span className="text-sm">Background blur</span>
          <input
            type="checkbox"
            className="toggle toggle-primary"
            checked={blur}
            onChange={(e) => setBlur(e.target.checked)}
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

      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-base-content/60 text-xs uppercase tracking-wide">
          Keyboard shortcuts
        </h3>
        <ul className="flex flex-col gap-1 text-sm">
          <li className="flex items-center justify-between">
            <span>Toggle microphone</span>
            <kbd className="kbd kbd-sm">⌘ D</kbd>
          </li>
          <li className="flex items-center justify-between">
            <span>Toggle camera</span>
            <kbd className="kbd kbd-sm">⌘ E</kbd>
          </li>
        </ul>
      </section>

      {/* Everything above is personal — it changes only your own audio, video
          and view. Host-only room controls are cordoned off below, so it's
          clear which settings affect just you and which affect the meeting. */}
      <HostControls slug={slug} />
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
      {/* Device labels are long ("Studio Display Microphone (…)") — keep the
          select at the panel width and truncate rather than overflow. */}
      <select
        className="select select-sm w-full max-w-full truncate"
        value={activeDeviceId}
        onChange={(e) => {
          void setActiveMediaDevice(e.target.value)
          try {
            localStorage.setItem(persistKey, e.target.value)
          } catch {}
        }}
      >
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || label}
          </option>
        ))}
      </select>
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
