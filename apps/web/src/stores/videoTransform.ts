import {
  defaultVideoTransform,
  parseVideoTransform,
  serializeVideoTransform,
  type VideoTransform,
} from "@meet/shared"
import { atom } from "nanostores"

const KEY = "videoTransform"

function initial(): VideoTransform {
  try {
    return parseVideoTransform(localStorage.getItem(KEY) ?? undefined)
  } catch {
    return defaultVideoTransform
  }
}

/** How the local camera feed is oriented; published to the room. */
export const $videoTransform = atom<VideoTransform>(
  typeof window === "undefined" ? defaultVideoTransform : initial(),
)

function set(t: VideoTransform) {
  $videoTransform.set(t)
  try {
    localStorage.setItem(KEY, serializeVideoTransform(t))
  } catch {}
}

/** Quarter turn clockwise; four presses come back around. */
export function rotateCamera() {
  const t = $videoTransform.get()
  set({ ...t, rotation: ((t.rotation + 90) % 360) as VideoTransform["rotation"] })
}

export function flipCameraH() {
  const t = $videoTransform.get()
  set({ ...t, flipH: !t.flipH })
}

export function flipCameraV() {
  const t = $videoTransform.get()
  set({ ...t, flipV: !t.flipV })
}
