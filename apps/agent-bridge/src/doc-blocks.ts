import { z } from "zod"

// The pipeline path's write channels. A pipeline brain speaks over the
// TTY protocol — plain text frames, no bridge-side tools — so it can't call
// a doc tool the way realtime models do (realtime-session's
// update_shared_doc). Instead the brain embeds writes in its reply between
// marker lines, and the bridge lifts each block out before the text reaches
// TTS or chat. This file owns the generic extractor and the shared-doc
// protocol; canvas-blocks.ts speaks the same way for the whiteboard.

export const DOC_BLOCK_OPEN = "<<<DOC"
export const DOC_BLOCK_CLOSE = "DOC>>>"

/**
 * How a pipeline brain is told to write the shared document. Joined into
 * the meeting context on the first turn; the markers match the delimiters
 * the realtime path already uses when showing the brain the current doc.
 */
export const DOC_PROTOCOL_NOTE =
  "You can update the meeting's shared markdown document. To do so, include " +
  `the complete updated document between a line containing only ${DOC_BLOCK_OPEN} ` +
  `and a line containing only ${DOC_BLOCK_CLOSE} anywhere in your reply. ` +
  "That block is saved and shown to everyone instead of being spoken, so " +
  "always include the full document text, preserving everything you don't " +
  "mean to change — not just the new parts. Don't wrap the block in code " +
  "fences, and never use those marker lines for anything else. Any text " +
  "outside the block is spoken aloud as usual; keep it brief and don't read " +
  "the document back."

/**
 * Splits a brain's streamed reply into text to speak and marker blocks to
 * act on. Stateful across `feed` calls because a block may open in one
 * assistant frame and close in a later one; a block still open when the turn
 * ends is discarded (a barge-in can cut the brain off mid-block, and acting
 * on the truncated half would do the wrong thing).
 */
export class MarkerBlockExtractor {
  #open: string
  #close: string
  #inBlock = false
  #blockLines: string[] = []

  constructor(open: string, close: string) {
    this.#open = open
    this.#close = close
  }

  feed(content: string): { spoken: string; blocks: string[] } {
    const spokenLines: string[] = []
    const blocks: string[] = []
    for (const line of content.split("\n")) {
      if (!this.#inBlock) {
        if (line.trim() === this.#open) {
          this.#inBlock = true
          this.#blockLines = []
        } else {
          spokenLines.push(line)
        }
      } else if (line.trim() === this.#close) {
        this.#inBlock = false
        blocks.push(this.#blockLines.join("\n"))
        this.#blockLines = []
      } else {
        this.#blockLines.push(line)
      }
    }
    return { spoken: spokenLines.join("\n"), blocks }
  }
}

/** The doc-write channel: marker blocks carrying the full updated document. */
export class DocBlockExtractor extends MarkerBlockExtractor {
  constructor() {
    super(DOC_BLOCK_OPEN, DOC_BLOCK_CLOSE)
  }
}

// ---- agent chat message ops ------------------------------------------------
// The channel a brain uses to edit or delete ITS OWN earlier chat messages
// ("actually, delete that", "fix the typo in your last message"). Same
// marker mechanics as doc/canvas blocks; ops are validated here and the
// worker publishes them as the room's standard chat ops, so the same
// author-only authorization every client enforces applies.

export const CHAT_OPS_BLOCK_OPEN = "<<<CHATOPS"
export const CHAT_OPS_BLOCK_CLOSE = "CHATOPS>>>"

export const CHAT_OPS_PROTOCOL_NOTE =
  "You can edit or delete YOUR OWN earlier chat messages (their ids are " +
  "shown to you with the chat context). To do so, include a JSON array " +
  `between a line containing only ${CHAT_OPS_BLOCK_OPEN} and a line ` +
  `containing only ${CHAT_OPS_BLOCK_CLOSE} in your reply: ` +
  '[{"op":"edit","id":"...","text":"the corrected message"}] or ' +
  '[{"op":"delete","id":"..."}]. Only your own message ids work.'

const chatOpsBatchSchema = z
  .array(
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("edit"),
        id: z.string().min(1).max(64),
        text: z.string().min(1).max(8000),
      }),
      z.object({ op: z.literal("delete"), id: z.string().min(1).max(64) }),
    ]),
  )
  .min(1)
  .max(10)
export type AgentChatOp = z.infer<typeof chatOpsBatchSchema>[number]

export class ChatOpsBlockExtractor extends MarkerBlockExtractor {
  constructor() {
    super(CHAT_OPS_BLOCK_OPEN, CHAT_OPS_BLOCK_CLOSE)
  }
}

export function parseChatOpsBlock(
  block: string,
): { ops: AgentChatOp[] } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(block)
  } catch {
    return { error: "The chat-ops block wasn't valid JSON." }
  }
  const parsed = chatOpsBatchSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      error: `The chat-ops block was invalid (${issue?.path.join(".")}: ${issue?.message}).`,
    }
  }
  return { ops: parsed.data }
}

// ---- leaving the meeting ---------------------------------------------------

/** A line a brain includes to leave the call ("show yourself out"). */
export const LEAVE_MARKER = "<<<LEAVE>>>"

export const LEAVE_PROTOCOL_NOTE =
  "If someone asks you to leave the meeting, say a brief goodbye and " +
  `include a line containing only ${LEAVE_MARKER} in that reply — you'll ` +
  "be disconnected once it's delivered. Never use the marker unasked."

/** Lift the leave marker out of reply text; `leave` says it was present. */
export function extractLeaveMarker(text: string): {
  text: string
  leave: boolean
} {
  const lines = text.split("\n")
  const kept = lines.filter((line) => line.trim() !== LEAVE_MARKER)
  return { text: kept.join("\n"), leave: kept.length !== lines.length }
}
