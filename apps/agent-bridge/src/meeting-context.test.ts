import { describe, expect, it } from "vitest"
import type { TtyServerFrame } from "./looped-tty.js"
import type { Brain } from "./looped-webhook.js"
import { pushBounded, withMeetingContext } from "./meeting-context.js"

/** A brain that records the exact inputs it was given. */
function recordingBrain(seen: string[]): Brain {
  return {
    async *runTurn(input: string): AsyncGenerator<TtyServerFrame> {
      seen.push(input)
      yield { type: "result", status: "ok", reply: "ok", steps: 1 }
    },
    close: () => {},
  }
}

describe("pushBounded", () => {
  it("drops the oldest lines once over the character budget", () => {
    const lines: string[] = []
    pushBounded(lines, "a".repeat(30), 64)
    pushBounded(lines, "b".repeat(30), 64)
    pushBounded(lines, "c".repeat(30), 64)
    expect(lines).toEqual(["b".repeat(30), "c".repeat(30)])
  })

  it("keeps a single line even when it alone exceeds the budget", () => {
    const lines: string[] = []
    pushBounded(lines, "x".repeat(100), 10)
    expect(lines).toEqual(["x".repeat(100)])
  })
})

describe("withMeetingContext", () => {
  it("injects context on the first turn only", async () => {
    const seen: string[] = []
    const brain = withMeetingContext(recordingBrain(seen), "CONTEXT")
    for await (const _ of brain.runTurn("turn one")) {
      // drain
    }
    for await (const _ of brain.runTurn("turn two")) {
      // drain
    }
    expect(seen[0]).toBe("[Meeting context]\nCONTEXT\n\nturn one")
    expect(seen[1]).toBe("turn two")
  })

  it("drains pending lines into each turn", async () => {
    const seen: string[] = []
    const pending: string[] = []
    const brain = withMeetingContext(recordingBrain(seen), "", () =>
      pending.splice(0).join("\n"),
    )
    pending.push("[Heard in the meeting since your last turn:]", "Alice: hi")
    for await (const _ of brain.runTurn("first")) {
      // drain
    }
    for await (const _ of brain.runTurn("second")) {
      // drain
    }
    expect(seen[0]).toBe(
      "[Heard in the meeting since your last turn:]\nAlice: hi\nfirst",
    )
    // The buffer was drained by the first turn; nothing is repeated.
    expect(seen[1]).toBe("second")
  })
})
