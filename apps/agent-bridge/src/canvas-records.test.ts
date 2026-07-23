import type { CanvasOp, CanvasRecord } from "@meet/shared"
import { describe, expect, it } from "vitest"
import {
  agentShapeId,
  buildCanvasRecords,
  describeCanvas,
} from "./canvas-records.js"

const author = { identity: "agent-scout", name: "Scout" }

function build(ops: CanvasOp[], existing: CanvasRecord[] = []) {
  return buildCanvasRecords(
    ops,
    new Map(existing.map((r) => [r.id, r])),
    author,
  )
}

function elementOf(changes: CanvasRecord[], id: string) {
  return changes.find((c) => c.id === id)?.record as Record<string, unknown>
}

describe("agentShapeId", () => {
  it("maps short ids into element-id space deterministically", () => {
    expect(agentShapeId("api")).toBe("agent-api")
    expect(agentShapeId("api")).toBe(agentShapeId("api"))
  })

  it("sanitizes whatever the model dreams up", () => {
    expect(agentShapeId("my box!")).toBe("agent-my_box_")
  })
})

describe("buildCanvasRecords", () => {
  it("builds a rectangle with a bound label", () => {
    const { changes, summary, warnings } = build([
      { op: "rect", id: "api", x: 0, y: 0, w: 160, h: 80, label: "API" },
    ])
    expect(warnings).toEqual([])
    // The labeled box is two elements: the rectangle and its bound text.
    expect(changes).toHaveLength(2)
    const rect = elementOf(changes, "agent-api")
    expect(rect.type).toBe("rectangle")
    expect(rect.isDeleted).toBe(false)
    expect(rect.boundElements).toEqual([
      { type: "text", id: "agent-api-label" },
    ])
    const label = elementOf(changes, "agent-api-label")
    expect(label.type).toBe("text")
    expect(label.text).toBe("API")
    expect(label.containerId).toBe("agent-api")
    expect(summary).toContain('rect "API" (id api)')
  })

  it("connects an arrow to shapes created earlier in the same batch", () => {
    const { changes, warnings } = build([
      { op: "rect", id: "api", x: 0, y: 0, w: 160, h: 80 },
      { op: "rect", id: "db", x: 400, y: 0, w: 160, h: 80 },
      { op: "arrow", id: "a1", from: "api", to: "db", label: "queries" },
    ])
    expect(warnings).toEqual([])
    const arrow = elementOf(changes, "agent-a1")
    expect(arrow.type).toBe("arrow")
    // Anchored at the source's center, pointing at the target's center.
    expect(arrow.x).toBe(80)
    expect(arrow.y).toBe(40)
    expect(arrow.startBinding).toMatchObject({ elementId: "agent-api" })
    expect(arrow.endBinding).toMatchObject({ elementId: "agent-db" })
    // Both bound shapes list the arrow, or the editor won't re-route it.
    for (const id of ["agent-api", "agent-db"]) {
      const bindings = elementOf(changes, id).boundElements as {
        id: string
      }[]
      expect(bindings.some((b) => b.id === "agent-a1")).toBe(true)
    }
  })

  it("warns instead of binding when an arrow names a missing shape", () => {
    const { changes, warnings } = build([
      { op: "arrow", id: "a1", from: "ghost", toPoint: { x: 100, y: 0 } },
    ])
    expect(warnings.some((w) => w.includes("ghost"))).toBe(true)
    const arrow = elementOf(changes, "agent-a1")
    expect(arrow.startBinding).toBeNull()
  })

  it("bumps clocks and versions past the record it replaces", () => {
    const first = build([{ op: "rect", id: "api", x: 0, y: 0, w: 100, h: 80 }])
    const second = build(
      [{ op: "move", id: "api", x: 500, y: 300 }],
      first.changes,
    )
    const moved = second.changes.find((c) => c.id === "agent-api")
    expect(moved?.v).toBe(2)
    const element = moved?.record as Record<string, unknown>
    expect(element.x).toBe(500)
    expect(element.version as number).toBeGreaterThan(1)
  })

  it("moves a labeled shape and its label together", () => {
    const first = build([
      { op: "note", id: "n1", x: 10, y: 10, text: "remember" },
    ])
    const labelBefore = elementOf(first.changes, "agent-n1-label")
    const second = build(
      [{ op: "move", id: "n1", x: 210, y: 10 }],
      first.changes,
    )
    const labelAfter = elementOf(second.changes, "agent-n1-label")
    expect((labelAfter.x as number) - (labelBefore.x as number)).toBe(200)
  })

  it("updates a label without touching geometry", () => {
    const first = build([
      { op: "rect", id: "api", x: 10, y: 20, w: 100, h: 80, label: "API" },
    ])
    const second = build(
      [{ op: "update", id: "api", label: "Gateway", color: "blue" }],
      first.changes,
    )
    expect(second.warnings).toEqual([])
    const rect = elementOf(second.changes, "agent-api")
    expect(rect.x).toBe(10)
    expect(rect.strokeColor).toBe("#1971c2")
    const label = elementOf(second.changes, "agent-api-label")
    expect(label.text).toBe("Gateway")
  })

  it("soft-deletes a shape and unbinds arrows pointing at it", () => {
    const first = build([
      { op: "rect", id: "api", x: 0, y: 0, w: 100, h: 80 },
      { op: "rect", id: "db", x: 300, y: 0, w: 100, h: 80 },
      { op: "arrow", id: "a1", from: "api", to: "db" },
    ])
    const second = build([{ op: "delete", id: "api" }], first.changes)
    const deleted = elementOf(second.changes, "agent-api")
    expect(deleted.isDeleted).toBe(true)
    const arrow = elementOf(second.changes, "agent-a1")
    expect(arrow.startBinding).toBeNull()
    expect(arrow.endBinding).toMatchObject({ elementId: "agent-db" })
  })

  it("clears every element and counts only top-level shapes", () => {
    const first = build([
      { op: "rect", id: "api", x: 0, y: 0, w: 100, h: 80, label: "API" },
      { op: "note", id: "n1", x: 200, y: 0, text: "keep in mind" },
    ])
    const second = build([{ op: "clear" }], first.changes)
    expect(
      second.changes.every(
        (c) => (c.record as { isDeleted?: boolean }).isDeleted === true,
      ),
    ).toBe(true)
    expect(second.summary).toContain("cleared the canvas (2 shapes)")
  })

  it("reports freehand, text and note ops in the summary", () => {
    const { changes, warnings, summary } = build([
      { op: "text", id: "t1", x: 0, y: 0, text: "Q3 architecture" },
      { op: "note", id: "n1", x: 0, y: 100, text: "decide by Friday" },
      {
        op: "draw",
        id: "d1",
        points: [
          { x: 10, y: 10 },
          { x: 40, y: 30 },
          { x: 80, y: 15 },
        ],
      },
    ])
    expect(warnings).toEqual([])
    const stroke = elementOf(changes, "agent-d1")
    expect(stroke.type).toBe("freedraw")
    expect(stroke.points).toEqual([
      [0, 0],
      [30, 20],
      [70, 5],
    ])
    expect(summary).toContain("Q3 architecture")
    expect(summary).toContain("freehand line")
    expect(summary).toContain("3 shapes")
  })

  it("keeps valid ops when one in the batch references nothing", () => {
    const { changes, warnings } = build([
      { op: "rect", id: "ok", x: 0, y: 0, w: 50, h: 50 },
      { op: "move", id: "ghost", x: 0, y: 0 },
    ])
    expect(changes).toHaveLength(1)
    expect(warnings).toHaveLength(1)
  })
})

describe("describeCanvas", () => {
  it("is empty for an empty canvas", () => {
    expect(describeCanvas([])).toBe("")
  })

  it("describes shapes and resolves arrow endpoints to labels", () => {
    const { changes } = build([
      { op: "rect", id: "api", x: 0, y: 0, w: 160, h: 80, label: "API" },
      { op: "rect", id: "db", x: 400, y: 0, w: 160, h: 80, label: "Postgres" },
      { op: "arrow", id: "a1", from: "api", to: "db", label: "queries" },
    ])
    const description = describeCanvas(changes)
    expect(description).toContain('rectangle "API" (id agent-api)')
    expect(description).toContain('arrow API → Postgres "queries"')
    expect(description).toContain("3 shapes total")
  })

  it("ignores deleted elements", () => {
    const first = build([{ op: "rect", id: "api", x: 0, y: 0, w: 10, h: 10 }])
    const second = build([{ op: "delete", id: "api" }], first.changes)
    expect(describeCanvas(second.changes)).toBe("")
  })

  it("stays inside its character budget", () => {
    const ops: CanvasOp[] = Array.from({ length: 40 }, (_, i) => ({
      op: "note",
      id: `n${i}`,
      x: 0,
      y: i * 100,
      text: `a long meandering sticky note number ${i} with plenty of text`,
    }))
    const { changes } = build(ops)
    const description = describeCanvas(changes, 500)
    expect(description.length).toBeLessThan(700)
    expect(description).toContain("…(truncated)")
  })
})
