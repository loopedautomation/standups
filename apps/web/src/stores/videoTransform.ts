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

/** Commit a transform (Settings stages changes locally until Save). */
export function setVideoTransform(t: VideoTransform) {
  set(t)
}

/** Quarter turn clockwise; four presses come back around. */
export function rotatedCw(t: VideoTransform): VideoTransform {
  return {
    ...t,
    rotation: ((t.rotation + 90) % 360) as VideoTransform["rotation"],
  }
}
