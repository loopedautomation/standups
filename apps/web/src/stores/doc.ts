import { emptySharedDoc, mergeSharedDoc, type SharedDoc } from "@meet/shared"
import { atom } from "nanostores"

/**
 * The meeting's shared markdown document.
 *
 * Held here rather than in the panel so edits keep arriving while the panel
 * is closed — the agent drafts during the conversation, and opening the
 * panel afterwards should show the finished plan, not an empty page.
 */
export const $doc = atom<SharedDoc>(emptySharedDoc)

/** True while someone else's edit is being applied, so we don't echo it. */
export const $docSyncing = atom<boolean>(false)

/** Applies an update if it wins the merge; returns whether anything changed. */
export function applyDocUpdate(incoming: SharedDoc): boolean {
  const current = $doc.get()
  const next = mergeSharedDoc(current, incoming)
  if (next === current) return false
  $doc.set(next)
  return true
}

export function resetDoc() {
  $doc.set(emptySharedDoc)
}
