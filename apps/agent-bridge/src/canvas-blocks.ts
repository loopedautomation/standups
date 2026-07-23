import { type CanvasOp, canvasOpBatchSchema } from "@meet/shared"
import { MarkerBlockExtractor } from "./doc-blocks.js"

// The pipeline path's whiteboard channel, the doc-blocks pattern applied to
// drawing: the brain embeds a JSON array of canvas ops between marker lines,
// the bridge lifts the block out of the spoken reply, validates it against
// the shared op schema, and runs it through the same publish path the
// realtime draw_on_canvas tool uses. Knowledge about drawing *well* lives in
// the whiteboard skill (skills/whiteboard.md); this note only makes the
// capability and wire format known to brains that don't carry the skill.

export const CANVAS_BLOCK_OPEN = "<<<CANVAS"
export const CANVAS_BLOCK_CLOSE = "CANVAS>>>"

/**
 * How a pipeline brain is told it can draw. Joined into the meeting context
 * on the first turn, next to DOC_PROTOCOL_NOTE. Deliberately compact: the
 * full vocabulary with examples is skill material, and agents that carry the
 * whiteboard skill are told to read it.
 */
export const CANVAS_PROTOCOL_NOTE =
  "You can draw on the meeting's shared whiteboard, which everyone sees " +
  `live. To do so, include a JSON array of drawing operations between a line ` +
  `containing only ${CANVAS_BLOCK_OPEN} and a line containing only ` +
  `${CANVAS_BLOCK_CLOSE} anywhere in your reply. Operations (applied in ` +
  'order): {"op":"rect"|"ellipse","id","x","y","w","h","label?","color?",' +
  '"fill?":"none"|"semi"|"solid"}, {"op":"text","id","x","y","text",' +
  '"size?":"s"|"m"|"l"|"xl"}, {"op":"note","id","x","y","text","color?"}, ' +
  '{"op":"arrow","id","from?","to?","label?"} (from/to are shape ids), ' +
  '{"op":"move","id","x","y"}, {"op":"update","id","label?","text?",' +
  '"color?","w?","h?"}, {"op":"delete","id"}, {"op":"clear"}. Coordinates ' +
  "are page pixels on roughly a 1600x1000 area, y growing downward from " +
  "the top-left origin — align related shapes by arithmetic (bars on a " +
  "shared baseline end at the same y+h). Omit x/y on creates to " +
  "auto-place clear of existing shapes. Give every shape a short memorable " +
  "id so you can connect, move or update it later. If you have a whiteboard " +
  "skill, read it before drawing. The block is drawn, not spoken; any text " +
  "outside it is spoken as usual — never mention coordinates or ids aloud."

/** The whiteboard channel's extractor: same mechanics, its own markers. */
export class CanvasBlockExtractor extends MarkerBlockExtractor {
  constructor() {
    super(CANVAS_BLOCK_OPEN, CANVAS_BLOCK_CLOSE)
  }
}

/**
 * A lifted canvas block, parsed and validated. Errors come back as prose
 * because their audience is the brain (via the activity feed and next-turn
 * context), which can rephrase its batch and try again.
 */
export function parseCanvasBlock(
  block: string,
): { ops: CanvasOp[] } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(block)
  } catch {
    return { error: "The canvas block wasn't valid JSON." }
  }
  const parsed = canvasOpBatchSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      error: `The canvas block was invalid (${issue?.path.join(".")}: ${issue?.message}).`,
    }
  }
  return { ops: parsed.data }
}
