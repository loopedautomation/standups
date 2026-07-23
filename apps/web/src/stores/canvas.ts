import { type CanvasRecord, mergeCanvasRecord } from "@meet/shared"
import { atom, map } from "nanostores"

/**
 * The meeting's shared whiteboard: Excalidraw elements keyed by id, deleted
 * ones included. Held here rather than in the whiteboard component so agent
 * and peer drawing keeps arriving while the board is closed — opening it
 * later shows the finished diagram, and reopening is instant.
 */
export const $canvasRecords = map<Record<string, CanvasRecord>>({})

/** Whether the local user has the whiteboard on their stage. */
export const $canvasOpen = atom<boolean>(false)

/** Who is drawing right now (an agent), for the "Scout is drawing…" badge. */
export const $agentDrawing = atom<{ name: string; at: number } | null>(null)

/** Content changed while the board was closed — the ControlBar shows a dot. */
export const $canvasUnseen = atom<boolean>(false)

let agentDrawingTimer: ReturnType<typeof setTimeout> | null = null

export function noteAgentDrawing(name: string) {
  $agentDrawing.set({ name, at: Date.now() })
  if (agentDrawingTimer) clearTimeout(agentDrawingTimer)
  agentDrawingTimer = setTimeout(() => $agentDrawing.set(null), 3_000)
}

/**
 * Merges a batch of records into the cache; returns the ones that won —
 * i.e. what actually changed and should be pushed into a mounted editor.
 */
export function applyCanvasChanges(changes: CanvasRecord[]): CanvasRecord[] {
  const winners: CanvasRecord[] = []
  for (const change of changes) {
    const current = $canvasRecords.get()[change.id]
    const next = mergeCanvasRecord(current, change)
    if (next === current) continue
    $canvasRecords.setKey(change.id, next)
    winners.push(next)
  }
  return winners
}

export function resetCanvas() {
  $canvasRecords.set({})
  $canvasOpen.set(false)
  $agentDrawing.set(null)
  $canvasUnseen.set(false)
}

/**
 * Excalidraw bumps `version`/`versionNonce` for bookkeeping it does on its
 * own — most notably assigning a fractional `index` when `restoreElements`
 * mounts an element that arrived without one (everything the agent draws).
 * Treating that churn as a local edit would re-author the element under this
 * client's identity with a bumped LWW clock `v` — and the bridge, whose
 * clock base is the (lagging) snapshot store, then loses every subsequent
 * move/update to a shape nobody actually touched.
 */
const CHURN_FIELDS = new Set(["version", "versionNonce", "updated", "index"])

function contentKey(element: Record<string, unknown>): string {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
    if (value && typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .map((k) => `${k}:${stable((value as Record<string, unknown>)[k])}`)
        .join(",")}}`
    }
    return JSON.stringify(value) ?? "null"
  }
  const keys = Object.keys(element)
    .filter((k) => !CHURN_FIELDS.has(k))
    .sort()
  return keys
    .map((k) => {
      // `restoreElements` normalizes a null binding list to [].
      const value = k === "boundElements" ? (element[k] ?? []) : element[k]
      return `${k}:${stable(value)}`
    })
    .join(";")
}

/** True when two element snapshots differ only by Excalidraw bookkeeping. */
export function isElementChurn(
  cached: Record<string, unknown>,
  scene: Record<string, unknown>,
): boolean {
  return contentKey(cached) === contentKey(scene)
}

/**
 * Fold Excalidraw's bookkeeping (fractional index, restore version bump)
 * into the cached record without advancing its LWW clock or changing its
 * author — nothing changed that peers or the store care about ordering.
 */
export function adoptCanvasRecord(id: string, element: unknown) {
  const current = $canvasRecords.get()[id]
  if (!current) return
  $canvasRecords.setKey(id, {
    ...current,
    record: JSON.parse(JSON.stringify(element)) as Record<string, unknown>,
  })
}
