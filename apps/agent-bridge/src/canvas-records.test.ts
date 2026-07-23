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

  it("expands a diagram op into laid-out shapes and bound arrows", () => {
    const { changes, summary, warnings } = build([
      {
        op: "diagram",
        id: "arch",
        mermaid: "flowchart TD\n web[Web] --> api[API]\n api --> db[DB]",
      },
    ])
    expect(warnings).toEqual([])
    expect(summary).toContain("laid out diagram arch (3 nodes)")
    const web = elementOf(changes, "agent-arch_web")
    const api = elementOf(changes, "agent-arch_api")
    expect(web).toBeDefined()
    expect(api).toBeDefined()
    // dagre put the second rank strictly below the first.
    expect(api.y as number).toBeGreaterThan(web.y as number)
    const arrows = changes.filter((c) => c.record.type === "arrow")
    expect(arrows).toHaveLength(2)
  })

  it("redraws an edited diagram in place instead of duplicating it", () => {
    const first = build([
      {
        op: "diagram",
        id: "arch",
        mermaid: "flowchart TD\n web[Web] --> api[API]",
      },
      // A bystander shape to the right, so free-space placement would move.
      { op: "rect", id: "note", x: 900, y: 0, w: 120, h: 60, label: "Note" },
    ])
    const webBefore = elementOf(first.changes, "agent-arch_web")
    const second = build(
      [
        {
          op: "diagram",
          id: "arch",
          mermaid: "flowchart TD\n web[Web] --> api[API]\n api --> db[DB]",
        },
      ],
      first.changes,
    )
    const webAfter = elementOf(second.changes, "agent-arch_web")
    // Same node id, same spot — the diagram grew in place.
    expect(webAfter.x).toBe(webBefore.x)
    expect(webAfter.y).toBe(webBefore.y)
    expect(elementOf(second.changes, "agent-arch_db")).toBeDefined()
  })

  it("warns instead of failing on unparseable diagram source", () => {
    const { changes, warnings } = build([
      { op: "diagram", id: "bad", mermaid: "sequenceDiagram\nA->>B: hi" },
    ])
    expect(changes).toHaveLength(0)
    expect(warnings[0]).toContain("bad")
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

  it("reports where each shape landed so the model can lay out the next", () => {
    const { summary } = build([
      { op: "rect", id: "api", x: 120, y: 60, w: 160, h: 80, label: "API" },
    ])
    expect(summary).toContain('rect "API" (id api) at (120, 60)')
  })

  it("nudges a create that would bury an existing shape", () => {
    const first = build([
      { op: "rect", id: "api", x: 100, y: 100, w: 160, h: 80 },
    ])
    const second = build(
      [{ op: "rect", id: "db", x: 100, y: 100, w: 160, h: 80 }],
      first.changes,
    )
    const db = elementOf(second.changes, "agent-db")
    // Slid clear of the blocker rather than stacking on top of it.
    expect(db.x as number).toBeGreaterThanOrEqual(100 + 160)
    expect(second.warnings.some((w) => w.includes("placed at"))).toBe(true)
    expect(second.summary).toContain(`at (${db.x}, ${db.y})`)
  })

  it("cascades placement inside one batch of identical coordinates", () => {
    const { changes, warnings } = build([
      { op: "rect", id: "a", x: 0, y: 0, w: 160, h: 80 },
      { op: "rect", id: "b", x: 0, y: 0, w: 160, h: 80 },
      { op: "rect", id: "c", x: 0, y: 0, w: 160, h: 80 },
    ])
    const spots = ["agent-a", "agent-b", "agent-c"].map((id) => {
      const el = elementOf(changes, id)
      return `${el.x},${el.y}`
    })
    expect(new Set(spots).size).toBe(3)
    expect(warnings).toHaveLength(2)
  })

  it("auto-places a create with omitted coordinates beside the content", () => {
    const first = build([{ op: "rect", id: "api", x: 0, y: 40, w: 160, h: 80 }])
    const second = build(
      [{ op: "rect", id: "db", w: 160, h: 80 }],
      first.changes,
    )
    const db = elementOf(second.changes, "agent-db")
    expect(db.x as number).toBeGreaterThanOrEqual(160)
    expect(db.y).toBe(40)
    expect(second.warnings).toEqual([])
  })

  it("keeps a re-created shape in place when coordinates are omitted", () => {
    const first = build([
      { op: "rect", id: "api", x: 300, y: 200, w: 160, h: 80 },
    ])
    const second = build(
      [{ op: "rect", id: "api", w: 200, h: 100, label: "API v2" }],
      first.changes,
    )
    const rect = elementOf(second.changes, "agent-api")
    expect(rect.x).toBe(300)
    expect(rect.y).toBe(200)
  })

  it("never nudges a shape redrawn at its own position", () => {
    const first = build([
      { op: "rect", id: "api", x: 100, y: 100, w: 160, h: 80 },
    ])
    const second = build(
      [{ op: "rect", id: "api", x: 100, y: 100, w: 160, h: 80, color: "red" }],
      first.changes,
    )
    const rect = elementOf(second.changes, "agent-api")
    expect(rect.x).toBe(100)
    expect(second.warnings).toEqual([])
  })

  it("wraps to a fresh row when the current row is full", () => {
    const first = build([{ op: "rect", id: "a", x: 0, y: 0, w: 1500, h: 80 }])
    const second = build(
      [{ op: "rect", id: "b", x: 0, y: 0, w: 1500, h: 80 }],
      first.changes,
    )
    const b = elementOf(second.changes, "agent-b")
    expect(b.y as number).toBeGreaterThanOrEqual(80)
    expect(b.x).toBe(0)
  })

  it("leaves a shape drawn inside a larger frame where it was put", () => {
    // A bar chart: bars sit inside the plot frame on purpose. Nudging them
    // out is what scattered chart pieces away from their axes.
    const first = build([
      { op: "rect", id: "frame", x: 0, y: 0, w: 600, h: 300 },
    ])
    const second = build(
      [{ op: "rect", id: "bar1", x: 60, y: 120, w: 60, h: 160, fill: "solid" }],
      first.changes,
    )
    const bar = elementOf(second.changes, "agent-bar1")
    expect(bar.x).toBe(60)
    expect(bar.y).toBe(120)
    expect(second.warnings).toEqual([])
  })

  it("leaves deliberate near-neighbours alone", () => {
    const first = build([{ op: "rect", id: "a", x: 0, y: 0, w: 160, h: 80 }])
    // 20px of overlap is a styling choice, not a burial.
    const second = build(
      [{ op: "rect", id: "b", x: 140, y: 0, w: 160, h: 80 }],
      first.changes,
    )
    const b = elementOf(second.changes, "agent-b")
    expect(b.x).toBe(140)
    expect(second.warnings).toEqual([])
  })

  it("reports the destination of a move", () => {
    const first = build([{ op: "rect", id: "api", x: 0, y: 0, w: 100, h: 80 }])
    const second = build(
      [{ op: "move", id: "api", x: 500, y: 300 }],
      first.changes,
    )
    expect(second.summary).toContain("moved api to (500, 300)")
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
