import type { TtyServerFrame } from "./looped-tty.js"

/**
 * Drain a brain turn and return its final text. One authoritative place
 * for the protocol subtlety that once silently emptied every delegation:
 * some agent builds stream `assistant` frames as they go, others send the
 * whole reply only in the closing `result` frame — the result's reply,
 * when present, wins. `error` frames throw. Every other frame (steps,
 * tool calls/results) is the caller's business via `onFrame`, which sees
 * ALL frames including the ones handled here.
 */
export async function collectBrainReply(
  frames: AsyncIterable<TtyServerFrame>,
  onFrame?: (frame: TtyServerFrame) => void,
): Promise<string> {
  let reply = ""
  for await (const frame of frames) {
    onFrame?.(frame)
    if (frame.type === "assistant") {
      reply += (reply ? "\n" : "") + frame.content
    } else if (frame.type === "result" && frame.reply) {
      reply = frame.reply
    } else if (frame.type === "error") {
      throw new Error(frame.error)
    }
  }
  return reply
}
