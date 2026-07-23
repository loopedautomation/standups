import {
  applyDocUpdateB64,
  emptySharedDoc,
  encodeDocDiffB64,
  encodeDocStateB64,
  readSharedDoc,
  type SharedDoc,
  setSharedDocText,
  Y,
} from "@meet/shared"
import { atom } from "nanostores"

/**
 * The shared document, synced as a Yjs text CRDT (see shared/doc-sync.ts).
 * This module owns the page's replica; `$doc` is its read-side projection
 * for React — text plus "last edited by" metadata.
 */
export const $doc = atom<SharedDoc>(emptySharedDoc)

let ydoc = attach(new Y.Doc())

function attach(doc: Y.Doc): Y.Doc {
  doc.on("update", () => $doc.set(readSharedDoc(doc)))
  return doc
}

/** Fold in a remote update (broadcast or snapshot). False if unparseable. */
export function applyRemoteDocUpdate(b64: string): boolean {
  return applyDocUpdateB64(ydoc, b64, "remote")
}

/**
 * Apply a local edit as a minimal splice; returns the incremental update to
 * broadcast, or null when nothing changed.
 */
export function setLocalDocText(
  text: string,
  author: { by: string; byName: string },
): string | null {
  const before = Y.encodeStateVector(ydoc)
  if (!setSharedDocText(ydoc, text, author, "local")) return null
  return encodeDocDiffB64(ydoc, before)
}

/** The full state, for the debounced durable PUT to the bridge store. */
export function encodeDocState(): string {
  return encodeDocStateB64(ydoc)
}

export function resetDoc() {
  ydoc.destroy()
  ydoc = attach(new Y.Doc())
  $doc.set(emptySharedDoc)
}
