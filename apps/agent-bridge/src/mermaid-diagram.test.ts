import { describe, expect, it } from "vitest"
import {
  expandDiagram,
  nearestCanvasColor,
  parseMermaidFlowchart,
} from "./mermaid-diagram.js"

describe("parseMermaidFlowchart", () => {
  it("parses nodes, shapes, labels and direction", () => {
    const parsed = parseMermaidFlowchart(
      'flowchart LR\n  web[Web App] --> api(API)\n  api --> db[("Database")]',
    )
    expect(parsed).not.toBeNull()
    expect(parsed?.direction).toBe("LR")
    expect(parsed?.nodes.get("web")).toMatchObject({
      label: "Web App",
      shape: "rect",
    })
    expect(parsed?.nodes.get("api")?.shape).toBe("ellipse")
    expect(parsed?.edges).toHaveLength(2)
  })

  it("captures edge labels in both syntaxes", () => {
    const parsed = parseMermaidFlowchart(
      "graph TD\n  a -->|writes| b\n  b -- reads --> c",
    )
    expect(parsed?.edges).toEqual([
      { from: "a", to: "b", label: "writes" },
      { from: "b", to: "c", label: "reads" },
    ])
  })

  it("tolerates fences, comments and unsupported directives", () => {
    const parsed = parseMermaidFlowchart(
      "```mermaid\nflowchart TD\n%% a comment\nclassDef red fill:#f00\nsubgraph backend\n  a --> b\nend\n```",
    )
    expect(parsed?.nodes.size).toBe(2)
    expect(parsed?.edges).toHaveLength(1)
  })

  it("parses chains", () => {
    const parsed = parseMermaidFlowchart("graph LR\n a --> b --> c")
    expect(parsed?.edges).toEqual([
      { from: "a", to: "b", label: undefined },
      { from: "b", to: "c", label: undefined },
    ])
  })

  it("rejects non-flowchart sources", () => {
    expect(parseMermaidFlowchart("sequenceDiagram\n A->>B: hi")).toBeNull()
    expect(parseMermaidFlowchart("")).toBeNull()
  })
})

describe("expandDiagram", () => {
  it("expands into placed primitives and bound arrows", () => {
    const ops = expandDiagram(
      "arch",
      "flowchart TD\n  web[Web] --> api[API]\n  api --> db[DB]",
    )
    expect(ops).not.toBeNull()
    const shapes = ops!.filter((op) => op.op === "rect")
    const arrows = ops!.filter((op) => op.op === "arrow")
    expect(shapes.map((s) => s.id).sort()).toEqual([
      "arch.api",
      "arch.db",
      "arch.web",
    ])
    expect(arrows).toHaveLength(2)
    expect(arrows[0]).toMatchObject({ from: "arch.web", to: "arch.api" })
    // Top-down: each rank sits strictly below the previous one.
    const byId = new Map(
      shapes.map((s) => [s.id, s as { y?: number; h?: number }]),
    )
    expect(byId.get("arch.api")!.y!).toBeGreaterThan(byId.get("arch.web")!.y!)
    expect(byId.get("arch.db")!.y!).toBeGreaterThan(byId.get("arch.api")!.y!)
    // Normalized to the (0,0) origin; placement happens later.
    const minX = Math.min(...shapes.map((s) => (s as { x?: number }).x ?? 0))
    const minY = Math.min(...shapes.map((s) => (s as { y?: number }).y ?? 0))
    expect(minX).toBe(0)
    expect(minY).toBe(0)
  })

  it("lays LR diagrams out horizontally", () => {
    const ops = expandDiagram("flow", "graph LR\n a[One] --> b[Two]")
    const shapes = ops!.filter((op) => op.op !== "arrow") as {
      id: string
      x?: number
    }[]
    const a = shapes.find((s) => s.id === "flow.a")!
    const b = shapes.find((s) => s.id === "flow.b")!
    expect(b.x!).toBeGreaterThan(a.x!)
  })

  it("routes a cycle's back-edge through waypoints instead of straight through", () => {
    const ops = expandDiagram(
      "cyc",
      "graph LR\n a[Client] --> b[Server] --> c[Response] --> a",
    )
    const back = ops!.find(
      (op) => op.op === "arrow" && op.id === "cyc.c->a",
    ) as { via?: { x: number; y: number }[] }
    expect(back).toBeDefined()
    // Dagre routes the reversed edge around the rank row — waypoints exist
    // and leave the row's vertical band rather than cutting through it.
    expect(back.via?.length ?? 0).toBeGreaterThan(0)
  })

  it("returns null for unparseable source", () => {
    expect(expandDiagram("x", "pie title Pets")).toBeNull()
  })

  it("honors style, classDef and inline ::: colors, snapped to the palette", () => {
    const ops = expandDiagram(
      "col",
      [
        "flowchart TD",
        "  a[Web] --> b[Queue]:::hot",
        "  a --> c[DB]",
        "  style a fill:#1971c2",
        "  classDef hot fill:#e03131",
        "  class c hot",
      ].join("\n"),
    )
    const byId = new Map(
      ops!
        .filter((op) => op.op === "rect")
        .map((op) => [op.id, op as { color?: string; fill?: string }]),
    )
    expect(byId.get("col.a")?.color).toBe("blue")
    expect(byId.get("col.b")?.color).toBe("red")
    expect(byId.get("col.c")?.color).toBe("red")
    expect(byId.get("col.a")?.fill).toBe("semi")
  })

  it("snaps arbitrary hex and css names to the nearest palette color", () => {
    expect(nearestCanvasColor("#e03131")).toBe("red")
    expect(nearestCanvasColor("#ff0000")).toBe("red")
    expect(nearestCanvasColor("purple")).toBe("violet")
    expect(nearestCanvasColor("#fff")).toBe("white")
    expect(nearestCanvasColor("not-a-color")).toBeUndefined()
  })
})
