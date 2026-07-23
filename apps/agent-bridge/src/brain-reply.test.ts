import { describe, expect, it } from "vitest"
import { collectBrainReply } from "./brain-reply.js"
import type { TtyServerFrame } from "./looped-tty.js"

async function* frames(...list: TtyServerFrame[]) {
  for (const frame of list) yield frame
}

describe("collectBrainReply", () => {
  it("accumulates streamed assistant frames", async () => {
    const reply = await collectBrainReply(
      frames(
        { type: "assistant", content: "first" },
        { type: "assistant", content: "second" },
      ),
    )
    expect(reply).toBe("first\nsecond")
  })

  it("takes the result frame's reply when no assistant frames stream", async () => {
    // The bug class this helper exists for: current agent builds send the
    // whole reply only in the closing result frame. Every collector that
    // listened solely for assistant frames heard silence — drawings, doc
    // updates, chat replies and screen descriptions all came back empty.
    const reply = await collectBrainReply(
      frames(
        { type: "step", n: 1 } as TtyServerFrame,
        {
          type: "tool_call",
          name: "read_skill",
          arguments: "{}",
        } as TtyServerFrame,
        {
          type: "result",
          status: "ok",
          reply: "<<<CANVAS\n[]\nCANVAS>>>",
          steps: 2,
        },
      ),
    )
    expect(reply).toBe("<<<CANVAS\n[]\nCANVAS>>>")
  })

  it("prefers the result reply over accumulated assistant frames", async () => {
    const reply = await collectBrainReply(
      frames(
        { type: "assistant", content: "partial thinking-out-loud" },
        { type: "result", status: "ok", reply: "the real answer", steps: 1 },
      ),
    )
    expect(reply).toBe("the real answer")
  })

  it("keeps assistant text when the result carries no reply", async () => {
    const reply = await collectBrainReply(
      frames(
        { type: "assistant", content: "spoken" },
        { type: "result", status: "ok", reply: "", steps: 1 },
      ),
    )
    expect(reply).toBe("spoken")
  })

  it("throws on error frames", async () => {
    await expect(
      collectBrainReply(frames({ type: "error", error: "brain exploded" })),
    ).rejects.toThrow("brain exploded")
  })

  it("hands every frame to onFrame, including handled ones", async () => {
    const seen: string[] = []
    await collectBrainReply(
      frames(
        { type: "tool_call", name: "x", arguments: "{}" } as TtyServerFrame,
        { type: "assistant", content: "hi" },
        { type: "result", status: "ok", reply: "hi", steps: 1 },
      ),
      (frame) => seen.push(frame.type),
    )
    expect(seen).toEqual(["tool_call", "assistant", "result"])
  })

  it("returns empty for a turn with no text at all", async () => {
    expect(await collectBrainReply(frames())).toBe("")
  })
})
