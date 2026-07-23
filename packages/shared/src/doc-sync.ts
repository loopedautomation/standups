// The shared document's sync layer: a Yjs text CRDT carried over the
// meeting's existing LiveKit data channel. Every participant — clients and
// the agent bridge — holds a Y.Doc; edits are minimal text splices that
// merge instead of racing, so two people (or a person and an agent) typing
// at once both land. This replaced a whole-document last-writer-wins scheme
// whose accepted cost was dropped keystrokes under concurrency.
//
// Transport: incremental updates broadcast on the `doc` topic as base64
// (see docSyncMessageSchema); durability: the full encoded state is PUT to
// the bridge store on a debounce, where states are merged bytewise
// (Y.mergeUpdates — commutative and idempotent, so any interleaving of
// PUTs converges) and served to late joiners as a snapshot.

import * as Y from "yjs"
import { z } from "zod"

/** Metadata shown in the panel ("Last edited by …"), not sync-critical. */
export type SharedDocView = {
  text: string
  by: string
  byName: string
  at: number
  /** Bumped per edit; > 0 means someone has written. Cosmetic only. */
  rev: number
}

export const emptySharedDocView: SharedDocView = {
  text: "",
  by: "",
  byName: "",
  at: 0,
  rev: 0,
}

/** An incremental update on the `doc` data topic. */
export const docSyncMessageSchema = z.object({
  type: z.literal("doc-sync"),
  /** base64-encoded Yjs update. */
  update: z.string().min(1).max(1_500_000),
})
export type DocSyncMessage = z.infer<typeof docSyncMessageSchema>

/** The PUT body for the durable store: the sender's full encoded state. */
export const docSnapshotPutSchema = z.object({
  update: z.string().min(1).max(2_000_000),
})

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64")
  }
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"))
  }
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function docText(doc: Y.Doc): Y.Text {
  return doc.getText("text")
}

function docMeta(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("meta")
}

export function readSharedDoc(doc: Y.Doc): SharedDocView {
  const meta = docMeta(doc)
  return {
    text: docText(doc).toString(),
    by: (meta.get("by") as string) ?? "",
    byName: (meta.get("byName") as string) ?? "",
    at: (meta.get("at") as number) ?? 0,
    rev: (meta.get("rev") as number) ?? 0,
  }
}

/**
 * Set the document to `next` as a minimal splice — common prefix and suffix
 * preserved — so a concurrent edit elsewhere in the text merges cleanly
 * instead of being overwritten. One transaction: text and authorship move
 * together, and observers fire once.
 */
export function setSharedDocText(
  doc: Y.Doc,
  next: string,
  author: { by: string; byName: string },
  origin?: unknown,
): boolean {
  const ytext = docText(doc)
  const prev = ytext.toString()
  if (prev === next) return false
  let start = 0
  while (
    start < prev.length &&
    start < next.length &&
    prev[start] === next[start]
  ) {
    start++
  }
  let prevEnd = prev.length
  let nextEnd = next.length
  while (
    prevEnd > start &&
    nextEnd > start &&
    prev[prevEnd - 1] === next[nextEnd - 1]
  ) {
    prevEnd--
    nextEnd--
  }
  doc.transact(() => {
    if (prevEnd > start) ytext.delete(start, prevEnd - start)
    if (nextEnd > start) ytext.insert(start, next.slice(start, nextEnd))
    const meta = docMeta(doc)
    meta.set("by", author.by)
    meta.set("byName", author.byName)
    meta.set("at", Date.now())
    meta.set("rev", ((meta.get("rev") as number) ?? 0) + 1)
  }, origin)
  return true
}

/** Apply a base64 update; unparseable payloads are dropped, not thrown. */
export function applyDocUpdateB64(
  doc: Y.Doc,
  b64: string,
  origin?: unknown,
): boolean {
  try {
    Y.applyUpdate(doc, base64ToBytes(b64), origin)
    return true
  } catch {
    return false
  }
}

/** The doc's full state as a base64 update (a late joiner's seed). */
export function encodeDocStateB64(doc: Y.Doc): string {
  return bytesToBase64(Y.encodeStateAsUpdate(doc))
}

/**
 * The incremental update representing everything in `doc` that happened
 * after `sinceStateVector` (from Y.encodeStateVector taken beforehand).
 */
export function encodeDocDiffB64(
  doc: Y.Doc,
  sinceStateVector: Uint8Array,
): string {
  return bytesToBase64(Y.encodeStateAsUpdate(doc, sinceStateVector))
}

export { Y }
