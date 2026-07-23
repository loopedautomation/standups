import type { CanvasRecord } from "@meet/shared"
import { describe, expect, it } from "vitest"
import {
  caretSweep,
  cursorLeg,
  groupForReveal,
  revealLegMs,
} from "./agent-presence.js"

function rec(
  id: string,
  element: Record<string, unknown> | null,
): CanvasRecord {
  return { id, record: element, v: 1, at: 0, by: "agent-scout" }
}

describe("groupForReveal", () => {
  it("gives each drawn element its own beat, centered on it", () => {
    const groups = groupForReveal([
      rec("a", { type: "rectangle", x: 0, y: 0, width: 100, height: 50 }),
      rec("b", { type: "ellipse", x: 200, y: 0, width: 100, height: 50 }),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].at).toEqual({ x: 50, y: 25 })
    expect(groups[1].at).toEqual({ x: 250, y: 25 })
  })

  it("keeps a bound label with its container, never on its own beat", () => {
    const groups = groupForReveal([
      rec("box", {
        type: "rectangle",
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        boundElements: [{ type: "text", id: "box-label" }],
      }),
      rec("box-label", {
        type: "text",
        x: 20,
        y: 15,
        containerId: "box",
      }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].changes.map((c) => c.id)).toEqual(["box", "box-label"])
  })

  it("rides deletions and bookkeeping along with the first beat", () => {
    const groups = groupForReveal([
      rec("gone", { type: "rectangle", isDeleted: true }),
      rec("new", { type: "rectangle", x: 0, y: 0, width: 10, height: 10 }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].changes.map((c) => c.id)).toEqual(["gone", "new"])
  })

  it("still produces one silent group when nothing new is drawn", () => {
    const groups = groupForReveal([
      rec("gone", { type: "rectangle", isDeleted: true }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].at).toBeNull()
    expect(groups[0].changes.map((c) => c.id)).toEqual(["gone"])
  })
})

describe("cursorLeg", () => {
  it("ends exactly at the destination and never repeats the start", () => {
    const frames = cursorLeg({ x: 0, y: 0 }, { x: 100, y: 200 }, 8)
    expect(frames).toHaveLength(8)
    expect(frames[0]).not.toEqual({ x: 0, y: 0 })
    expect(frames[7]).toEqual({ x: 100, y: 200 })
  })

  it("moves monotonically toward the destination", () => {
    const frames = cursorLeg({ x: 0, y: 0 }, { x: 100, y: 0 }, 6)
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].x).toBeGreaterThan(frames[i - 1].x)
    }
  })
})

describe("caretSweep", () => {
  it("sweeps monotonically and lands exactly on the end", () => {
    const offsets = caretSweep(1000, 12)
    expect(offsets).toHaveLength(12)
    expect(offsets[11]).toBe(1000)
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1])
    }
  })
})

describe("revealLegMs", () => {
  it("slows down for small diagrams and speeds up for big ones", () => {
    expect(revealLegMs(2)).toBe(450)
    expect(revealLegMs(30)).toBe(150)
    expect(revealLegMs(15)).toBe(300)
  })
})
