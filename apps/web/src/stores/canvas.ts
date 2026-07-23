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
