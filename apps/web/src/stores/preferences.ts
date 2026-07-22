import { atom, type WritableAtom } from "nanostores"

/**
 * Small persisted user preferences (the "elite behaviors" batch). Each is a
 * localStorage-backed boolean/string atom; effects that act on them mount in
 * ControlBar (always rendered inside the room).
 */

function persistedBool(key: string, fallback: boolean) {
  const initial =
    typeof window === "undefined"
      ? fallback
      : (() => {
          try {
            const raw = localStorage.getItem(key)
            return raw === null ? fallback : raw === "true"
          } catch {
            return fallback
          }
        })()
  const store = atom<boolean>(initial)
  const set = (value: boolean) => {
    store.set(value)
    try {
      localStorage.setItem(key, String(value))
    } catch {}
  }
  return [store, set] as const
}

function persistedString<T extends string>(key: string, fallback: T) {
  const initial =
    typeof window === "undefined"
      ? fallback
      : (() => {
          try {
            return (localStorage.getItem(key) as T) ?? fallback
          } catch {
            return fallback
          }
        })()
  const store = atom<T>(initial) as WritableAtom<T>
  const set = (value: T) => {
    store.set(value)
    try {
      localStorage.setItem(key, value)
    } catch {}
  }
  return [store, set] as const
}

// ---- audio -----------------------------------------------------------------

/** Browser auto gain control; podcasters with real interfaces turn it off. */
export const [$autoGain, setAutoGain] = persistedBool("autoGainControl", true)

/** Hold Space while muted to talk; release re-mutes. */
export const [$pushToTalk, setPushToTalk] = persistedBool("pushToTalk", false)

// ---- video -----------------------------------------------------------------

export type SendQuality = "auto" | "1080p" | "720p" | "360p" | "180p"

/** Cap on the outgoing camera resolution — the data-saver for uplink. */
export const [$sendQuality, setSendQuality] = persistedString<SendQuality>(
  "sendQuality",
  "auto",
)

/**
 * "auto" asks for the camera's maximum (up to 4K) — the constraints are
 * ideal, not exact, so a lesser camera simply delivers its best.
 */
export const AUTO_MAX_RESOLUTION = { width: 3840, height: 2160 }

export const SEND_QUALITY_RESOLUTION: Record<
  Exclude<SendQuality, "auto">,
  { width: number; height: number }
> = {
  "1080p": { width: 1920, height: 1080 },
  "720p": { width: 1280, height: 720 },
  "360p": { width: 640, height: 360 },
  "180p": { width: 320, height: 180 },
}

/** Whether your own self-view is mirrored (everyone else is unaffected). */
export const [$mirrorSelf, setMirrorSelf] = persistedBool("mirrorSelf", true)

// ---- meeting ---------------------------------------------------------------

/** Join every meeting muted / camera off, regardless of last call's state. */
export const [$joinMuted, setJoinMuted] = persistedBool("joinMuted", false)
export const [$joinCameraOff, setJoinCameraOff] = persistedBool(
  "joinCameraOff",
  false,
)

/** Join/leave chimes and the chat pop. */
export const [$meetingSounds, setMeetingSounds] = persistedBool(
  "meetingSounds",
  true,
)

/** Poor connection flips "turn off incoming video" on automatically. */
export const [$autoDataSaver, setAutoDataSaver] = persistedBool(
  "autoDataSaver",
  false,
)
