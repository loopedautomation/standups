"use client"

import { useMediaDeviceSelect } from "@livekit/components-react"
import type { RoomSettings } from "@meet/shared"
import { useStore } from "@nanostores/react"
import { Moon, Sun } from "lucide-react"
import { useState } from "react"
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
      <HostControls slug={slug} />

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
 * The organiser's room-level settings. Only they see this section, and only
 * they can change it — the toggles write to room metadata through a
 * host-key-authenticated route, which is also what the invite endpoints
 * check, so a locked-down room stays locked down against a crafted request
 * and not just a hidden button.
 */
function HostControls({ slug }: { slug: string }) {
  const { isHost, settings } = useAgentPermissions()
  const [saving, setSaving] = useState<keyof RoomSettings | null>(null)

  if (!isHost) return null

  const update = async (key: keyof RoomSettings, value: boolean) => {
    const hostKey = readHostKey(slug)
    if (!hostKey) {
      toast.error("Only the meeting's organiser can change this.")
      return
    }
    setSaving(key)
    try {
      const res = await fetch(`/api/rooms/${slug}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: { [key]: value }, hostKey }),
      })
      if (!res.ok) throw new Error("save failed")
      // No local state to set: the change lands in room metadata and comes
      // back through useRoomInfo, so every participant (including this one)
      // sees the same value from the same source.
    } catch {
      toast.error("Could not save that setting.")
    } finally {
      setSaving(null)
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-base-content/60 text-xs uppercase tracking-wide">
        Everyone in this meeting can
      </h3>
      <label className="flex cursor-pointer items-center justify-between gap-4">
        <span className="flex flex-col">
          <span className="text-sm">Control agents</span>
          <span className="text-base-content/60 text-xs">
            Mute, interrupt, zap and change how agents take turns. Off leaves
            the buttons visible but yours alone.
          </span>
        </span>
        <input
          type="checkbox"
          className="toggle toggle-primary"
          disabled={saving === "participantsCanControlAgents"}
          checked={settings.participantsCanControlAgents}
          onChange={(e) =>
            update("participantsCanControlAgents", e.target.checked)
          }
        />
      </label>
      <label className="flex cursor-pointer items-center justify-between gap-4">
        <span className="flex flex-col">
          <span className="text-sm">Invite agents</span>
          <span className="text-base-content/60 text-xs">
            Bring agents into the meeting, from the registry or by URL.
          </span>
        </span>
        <input
          type="checkbox"
          className="toggle toggle-primary"
          disabled={saving === "participantsCanInviteAgents"}
          checked={settings.participantsCanInviteAgents}
          onChange={(e) =>
            update("participantsCanInviteAgents", e.target.checked)
          }
        />
      </label>
    </section>
  )
}
