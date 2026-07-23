import type { CanvasRecord } from "@meet/shared"

// The agent's visible hand: keyframe generators for the cursor that glides
// across the whiteboard as shapes appear, and the caret that sweeps through
// the doc after a write. Pure functions here; the worker drives them with
// timers and publishes each frame as presence.

export type CursorPoint = { x: number; y: number }

/**
 * One reveal beat: the cursor travels to `at`, then these changes appear.
 * Bookkeeping changes with no stage presence of their own (arrow-binding
 * patches, deletions) ride along with the first beat.
 */
export type RevealGroup = { at: CursorPoint | null; changes: CanvasRecord[] }

function centerOf(element: Record<string, unknown>): CursorPoint | null {
  const { x, y, width, height } = element as {
    x?: number
    y?: number
    width?: number
    height?: number
  }
  if (typeof x !== "number" || typeof y !== "number") return null
  return { x: x + (width ?? 0) / 2, y: y + (height ?? 0) / 2 }
}

/**
 * Splits a built batch into cursor beats: one per drawn element, with its
 * bound label riding along so a note never appears before its text.
 */
export function groupForReveal(changes: CanvasRecord[]): RevealGroup[] {
  const byId = new Map(changes.map((c) => [c.id, c]))
  const groups: RevealGroup[] = []
  const claimed = new Set<string>()
  const leftovers: CanvasRecord[] = []

  for (const change of changes) {
    if (claimed.has(change.id)) continue
    const element = change.record
    if (!element || element.isDeleted === true) {
      leftovers.push(change)
      continue
    }
    // Labels surface with their container, not on their own beat.
    const containerId = element.containerId as string | null | undefined
    if (containerId && byId.has(containerId)) continue
    const at = centerOf(element)
    if (!at) {
      leftovers.push(change)
      continue
    }
    const group: RevealGroup = { at, changes: [change] }
    claimed.add(change.id)
    const bindings = Array.isArray(element.boundElements)
      ? (element.boundElements as { type: string; id: string }[])
      : []
    for (const binding of bindings) {
      const label = byId.get(binding.id)
      if (label && !claimed.has(label.id)) {
        group.changes.push(label)
        claimed.add(label.id)
      }
    }
    groups.push(group)
  }

  // Anything left (deletes, binding patches on pre-existing shapes) lands
  // with the first beat so state converges even when nothing new is drawn.
  const remaining = leftovers.filter((c) => !claimed.has(c.id))
  if (remaining.length > 0) {
    if (groups.length > 0) {
      groups[0].changes.unshift(...remaining)
    } else {
      groups.push({ at: null, changes: remaining })
    }
  }
  return groups
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
}

/**
 * Intermediate cursor positions between two points, eased so the cursor
 * accelerates away and settles in — endpoints excluded/included so chaining
 * legs never repeats a frame.
 */
export function cursorLeg(
  from: CursorPoint,
  to: CursorPoint,
  steps: number,
): CursorPoint[] {
  const frames: CursorPoint[] = []
  for (let i = 1; i <= steps; i++) {
    const t = easeInOutQuad(i / steps)
    frames.push({
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
    })
  }
  return frames
}

/**
 * Caret offsets sweeping a document top to bottom, eased to linger toward
 * the end, always finishing exactly at `length`.
 */
export function caretSweep(length: number, steps: number): number[] {
  const offsets: number[] = []
  for (let i = 1; i <= steps; i++) {
    offsets.push(Math.round(easeInOutQuad(i / steps) * length))
  }
  offsets[offsets.length - 1] = length
  return offsets
}

/** Per-beat travel time: brisk for big diagrams, deliberate for small ones. */
export function revealLegMs(groupCount: number, budgetMs = 4_500): number {
  return Math.min(450, Math.max(150, budgetMs / Math.max(groupCount, 1)))
}

export const CURSOR_FRAME_MS = 50

/** The pause after a shape lands, so each one registers before the next. */
export const REVEAL_BEAT_MS = 120
