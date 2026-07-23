// The pipeline path's doc-write channel. A pipeline brain speaks over the
// TTY protocol — plain text frames, no bridge-side tools — so it can't call
// a doc tool the way realtime models do (realtime-session's
// update_shared_doc). Instead the brain embeds the updated document in its
// reply between marker lines, and the bridge lifts the block out before the
// text reaches TTS or chat, persisting it like any other doc write.

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
 * Splits a brain's streamed reply into text to speak and documents to save.
 * Stateful across `feed` calls because a block may open in one assistant
 * frame and close in a later one; a block still open when the turn ends is
 * discarded (a barge-in can cut the brain off mid-document, and saving the
 * truncated half would clobber the real doc).
 */
export class DocBlockExtractor {
  #inBlock = false
  #docLines: string[] = []

  feed(content: string): { spoken: string; docs: string[] } {
    const spokenLines: string[] = []
    const docs: string[] = []
    for (const line of content.split("\n")) {
      if (!this.#inBlock) {
        if (line.trim() === DOC_BLOCK_OPEN) {
          this.#inBlock = true
          this.#docLines = []
        } else {
          spokenLines.push(line)
        }
      } else if (line.trim() === DOC_BLOCK_CLOSE) {
        this.#inBlock = false
        docs.push(this.#docLines.join("\n"))
        this.#docLines = []
      } else {
        this.#docLines.push(line)
      }
    }
    return { spoken: spokenLines.join("\n"), docs }
  }
}
