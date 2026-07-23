import type { Room } from "@livekit/rtc-node"
import {
  applyDocUpdateB64,
  type CanvasDiff,
  type CanvasSnapshot,
  canvasSnapshotSchema,
  emptyCanvasSnapshot,
  encodeDocStateB64,
  parseParticipantMeta,
  type SharedDoc,
  type Y,
} from "@meet/shared"
import { describeCanvas } from "./canvas-records.js"
import type { Brain } from "./looped-webhook.js"

// Meeting context shared with agent brains: who is in the room, and what has
// been said so far. Transcript segments live in the control API process (the
// transcriber posts finals there over localhost), so agent workers — which
// run as separate job processes — can fetch them over HTTP.

const CONTROL_URL = process.env.CONTROL_URL ?? "http://localhost:8090"

export type TranscriptSegment = {
  at: number
  speaker: string
  text: string
}

/** Fire-and-forget: record a finalized utterance for the room. */
export function postTranscriptSegment(
  room: string,
  segment: TranscriptSegment,
): void {
  void fetch(
    `${CONTROL_URL}/internal/rooms/${encodeURIComponent(room)}/transcript`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.BRIDGE_TOKEN ?? ""}`,
      },
      body: JSON.stringify(segment),
    },
  ).catch(() => undefined)
}

/** The meeting transcript so far, oldest first. Empty on any failure. */
export async function fetchTranscript(
  room: string,
): Promise<TranscriptSegment[]> {
  try {
    const res = await fetch(
      `${CONTROL_URL}/internal/rooms/${encodeURIComponent(room)}/transcript`,
      {
        headers: { authorization: `Bearer ${process.env.BRIDGE_TOKEN ?? ""}` },
      },
    )
    if (!res.ok) return []
    const body = (await res.json()) as { segments?: TranscriptSegment[] }
    return body.segments ?? []
  } catch {
    return []
  }
}

/**
 * Fold the store's snapshot of the shared doc into `ydoc`. Idempotent —
 * applying the same state twice is a no-op — so callers refresh freely
 * before reading or writing. Failures leave the doc as it was.
 */
export async function seedSharedDoc(room: string, ydoc: Y.Doc): Promise<void> {
  try {
    const res = await fetch(
      `${CONTROL_URL}/rooms/${encodeURIComponent(room)}/doc`,
      {
        headers: { authorization: `Bearer ${process.env.BRIDGE_TOKEN ?? ""}` },
      },
    )
    if (!res.ok) return
    const body = (await res.json()) as { snapshot?: unknown }
    if (typeof body.snapshot === "string" && body.snapshot) {
      applyDocUpdateB64(ydoc, body.snapshot)
    }
  } catch {
    // reads fall back to whatever the local doc already holds
  }
}

/** Persist the doc's full state to the store (merged there, never clobbered). */
export async function persistSharedDoc(
  room: string,
  ydoc: Y.Doc,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${CONTROL_URL}/rooms/${encodeURIComponent(room)}/doc`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.BRIDGE_TOKEN ?? ""}`,
        },
        body: JSON.stringify({ update: encodeDocStateB64(ydoc) }),
      },
    )
    return res.ok
  } catch {
    return false
  }
}

/** The room's shared whiteboard. Empty on any failure. */
export async function fetchCanvas(room: string): Promise<CanvasSnapshot> {
  try {
    const res = await fetch(
      `${CONTROL_URL}/rooms/${encodeURIComponent(room)}/canvas`,
      {
        headers: { authorization: `Bearer ${process.env.BRIDGE_TOKEN ?? ""}` },
      },
    )
    if (!res.ok) return emptyCanvasSnapshot
    const parsed = canvasSnapshotSchema.safeParse(await res.json())
    return parsed.success ? parsed.data : emptyCanvasSnapshot
  } catch {
    return emptyCanvasSnapshot
  }
}

/** Persists a batch of canvas record changes drawn by the agent. */
export async function postCanvasDiff(
  room: string,
  diff: CanvasDiff,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${CONTROL_URL}/rooms/${encodeURIComponent(room)}/canvas/diff`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.BRIDGE_TOKEN ?? ""}`,
        },
        body: JSON.stringify(diff),
      },
    )
    return res.ok
  } catch {
    return false
  }
}

/** The whiteboard as brain-readable context; "" when nothing is drawn. */
export function formatCanvas(
  snapshot: CanvasSnapshot,
  maxChars = 2000,
): string {
  const description = describeCanvas(snapshot.records, maxChars)
  if (!description) return ""
  return `The meeting's shared whiteboard currently shows:\n${description}`
}

/** The shared document as brain-readable context, bounded like the transcript. */
export function formatSharedDoc(doc: SharedDoc, maxChars = 6000): string {
  if (!doc.text.trim()) return ""
  const text =
    doc.text.length > maxChars
      ? `${doc.text.slice(0, maxChars)}\n…(truncated)`
      : doc.text
  return `The meeting's shared document, which everyone can see and edit:\n\n${text}`
}

/** Render a transcript as brain-readable context, bounded by character count. */
export function formatTranscript(
  segments: TranscriptSegment[],
  maxChars = 6000,
): string {
  const lines: string[] = []
  let total = 0
  // Walk backwards so the budget keeps the most recent discussion.
  for (let i = segments.length - 1; i >= 0; i--) {
    const line = `${segments[i].speaker}: ${segments[i].text}`
    total += line.length + 1
    if (total > maxChars) break
    lines.unshift(line)
  }
  return lines.join("\n")
}

/**
 * Append a line to a bounded context buffer, dropping the oldest lines once
 * the buffer exceeds its character budget. Keeps at least the newest line so
 * a single oversized entry can't empty the buffer.
 */
export function pushBounded(
  lines: string[],
  line: string,
  maxChars = 4000,
): void {
  lines.push(line)
  let total = lines.reduce((sum, l) => sum + l.length + 1, 0)
  while (total > maxChars && lines.length > 1) {
    total -= (lines[0]?.length ?? 0) + 1
    lines.shift()
  }
}

/**
 * Injects meeting context (roster, prior transcript) into the brain's first
 * turn, whichever path triggers it — a voice turn, a chat mention, or a
 * realtime model's do_task delegation. Brains are stateful conversations,
 * so once is enough.
 */
export function withMeetingContext(
  brain: Brain,
  context: string,
  /** Drained on each turn — e.g. chat messages since the brain last ran. */
  pending?: () => string,
): Brain {
  let sent = false
  return {
    runTurn(input, images) {
      const extra = pending?.()
      if (extra) input = `${extra}\n${input}`
      if (!sent && context) {
        sent = true
        input = `[Meeting context]\n${context}\n\n${input}`
      }
      return brain.runTurn(input, images)
    },
    abortTurn: brain.abortTurn?.bind(brain),
    close: () => brain.close(),
  }
}

// ---- debug events ----------------------------------------------------------
// Workers report lifecycle and error events to a per-room ring buffer on the
// control API, so an observer (a person, or Claude debugging a deployment)
// can read what the bridge did without shelling into the box for logs.

export type DebugEvent = {
  at: number
  /** Which component emitted it, e.g. "agent:scout", "transcriber". */
  source: string
  level: "info" | "error"
  message: string
}

/** Fire-and-forget: record a bridge event for the room's debug log. */
export function postDebugEvent(
  room: string,
  source: string,
  level: DebugEvent["level"],
  message: string,
): void {
  void fetch(
    `${CONTROL_URL}/internal/rooms/${encodeURIComponent(room)}/debug`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.BRIDGE_TOKEN ?? ""}`,
      },
      body: JSON.stringify({ at: Date.now(), source, level, message }),
    },
  ).catch(() => undefined)
}

/** One line per visible participant: name plus whether human or agent. */
export function describeRoster(room: Room): string {
  const entries: string[] = []
  const local = room.localParticipant
  if (local) entries.push(`${local.name || local.identity} (you, AI agent)`)
  for (const p of room.remoteParticipants.values()) {
    const meta = parseParticipantMeta(p.metadata)
    if (meta?.kind === "service" || meta?.kind === "waiting") continue
    const label = meta?.kind === "agent" ? "AI agent" : "human"
    entries.push(`${p.name || p.identity} (${label})`)
  }
  return entries.join(", ")
}
