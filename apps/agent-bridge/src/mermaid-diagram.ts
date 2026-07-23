// Expands a `diagram` canvas op — Mermaid flowchart source — into the
// primitive rect/ellipse/arrow ops the canvas pipeline already knows how to
// build, bind and sync. Models are far better at emitting Mermaid topology
// than at guessing pixel coordinates, so a real layout algorithm (dagre)
// does the positioning instead.
//
// Deliberately a subset: flowchart/graph node-and-edge statements, the
// bread and butter of meeting diagrams. Sequence diagrams, subgraph frames,
// class diagrams and styling directives are out of scope — unknown lines
// are skipped rather than fatal, so a chatty model's `classDef` doesn't
// void its whole diagram.

import dagre from "@dagrejs/dagre"
import type { CanvasColor, CanvasOp } from "@meet/shared"

type ParsedNode = {
  id: string
  label: string
  shape: "rect" | "ellipse"
  color?: CanvasColor
}

/**
 * Representative hex per canvas color (Excalidraw's stroke palette), used
 * to snap a Mermaid `style`/`classDef` fill to the drawing vocabulary.
 * Local copy: canvas-records.ts imports this module, so it can't be the
 * source without a cycle.
 */
const COLOR_HEX: Record<CanvasColor, [number, number, number]> = {
  black: [30, 30, 30],
  grey: [134, 142, 150],
  "light-violet": [177, 151, 252],
  violet: [151, 117, 250],
  blue: [25, 113, 194],
  "light-blue": [116, 192, 252],
  yellow: [240, 140, 0],
  orange: [232, 89, 12],
  green: [47, 158, 68],
  "light-green": [105, 219, 124],
  "light-red": [255, 168, 168],
  red: [224, 49, 49],
  white: [255, 255, 255],
}

const CSS_COLOR_ALIASES: Record<string, CanvasColor> = {
  gray: "grey",
  purple: "violet",
  pink: "light-red",
  lightblue: "light-blue",
  lightgreen: "light-green",
  gold: "yellow",
  cyan: "light-blue",
  teal: "green",
}

/** Snap a Mermaid color value (hex or common name) to the canvas palette. */
export function nearestCanvasColor(value: string): CanvasColor | undefined {
  const raw = value.trim().toLowerCase()
  if (raw in COLOR_HEX) return raw as CanvasColor
  if (raw in CSS_COLOR_ALIASES) return CSS_COLOR_ALIASES[raw]
  const hex = raw.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/)?.[1]
  if (!hex) return undefined
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex
  const r = Number.parseInt(full.slice(0, 2), 16)
  const g = Number.parseInt(full.slice(2, 4), 16)
  const b = Number.parseInt(full.slice(4, 6), 16)
  let best: CanvasColor = "black"
  let bestDist = Number.POSITIVE_INFINITY
  for (const [name, [cr, cg, cb]] of Object.entries(COLOR_HEX)) {
    const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
    if (dist < bestDist) {
      bestDist = dist
      best = name as CanvasColor
    }
  }
  return best
}

type ParsedEdge = {
  from: string
  to: string
  label?: string
}

type ParsedDiagram = {
  direction: "TB" | "LR" | "BT" | "RL"
  nodes: Map<string, ParsedNode>
  edges: ParsedEdge[]
}

/** `a[Text]`, `a(Text)`, `a((Text))`, `a([Text])`, `a[(Text)]`, `a{Text}`. */
const NODE_RE =
  /^([A-Za-z0-9_.-]+)\s*(?:(\(\(|\(\[|\[\(|\{\{|\[|\(|\{)\s*"?([^"\]})]*?)"?\s*(?:\)\)|\]\)|\)\]|\}\}|\]|\)|\}))?$/

/** Arrow/link connectors between nodes, label captured where the syntax has one. */
const CONNECTOR_RE =
  /(?:--\s*([^-<>|]+?)\s*-->|-->\s*\|([^|]*)\||---\s*\|([^|]*)\||-\.->|==>|-->|---)/g

function cleanLabel(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim()
}

function nodeShape(bracket: string | undefined): "rect" | "ellipse" {
  return bracket === "(" ||
    bracket === "((" ||
    bracket === "([" ||
    bracket === "[("
    ? "ellipse"
    : "rect"
}

/** Parse a node reference, registering it (or enriching it) as a side effect. */
function takeNode(
  token: string,
  nodes: Map<string, ParsedNode>,
  onClass?: (id: string, className: string) => void,
): string | null {
  // Inline class syntax: `a[Label]:::className`.
  let className: string | undefined
  const stripped = token.trim().replace(/:::([A-Za-z0-9_-]+)$/, (_, name) => {
    className = name
    return ""
  })
  const match = stripped.trim().match(NODE_RE)
  if (!match) return null
  const [, id, bracket, rawLabel] = match
  const existing = nodes.get(id)
  const label = rawLabel !== undefined ? cleanLabel(rawLabel) : undefined
  if (!existing) {
    nodes.set(id, {
      id,
      label: label ?? id,
      shape: nodeShape(bracket),
    })
  } else if (label !== undefined) {
    existing.label = label
    if (bracket) existing.shape = nodeShape(bracket)
  }
  if (className) onClass?.(id, className)
  return id
}

export function parseMermaidFlowchart(source: string): ParsedDiagram | null {
  // Tolerate a fenced block — models add them out of habit.
  const text = source
    .replace(/^\s*```(?:mermaid)?\s*/i, "")
    .replace(/```\s*$/, "")
  const lines = text
    .split(/[\n;]/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("%%"))
  if (lines.length === 0) return null

  let direction: ParsedDiagram["direction"] = "TB"
  const header = lines[0].match(/^(?:flowchart|graph)\s*(TD|TB|BT|LR|RL)?/i)
  if (!header) return null
  if (header[1]) {
    const dir = header[1].toUpperCase()
    direction = dir === "TD" ? "TB" : (dir as ParsedDiagram["direction"])
  }

  const nodes = new Map<string, ParsedNode>()
  const edges: ParsedEdge[] = []
  const classColors = new Map<string, CanvasColor>()
  const pendingClassUses: { ids: string[]; className: string }[] = []
  const fillOf = (styles: string): CanvasColor | undefined => {
    const value = styles.match(/(?:fill|stroke)\s*:\s*([^,;\s]+)/i)?.[1]
    return value ? nearestCanvasColor(value) : undefined
  }
  for (const line of lines.slice(1)) {
    // Color directives are honored (fill snapped to the canvas palette);
    // remaining structure/styling directives are skipped, never fatal.
    const styleDirective = line.match(/^style\s+([A-Za-z0-9_.-]+)\s+(.+)$/i)
    if (styleDirective) {
      const color = fillOf(styleDirective[2])
      const node = nodes.get(styleDirective[1])
      if (color && node) node.color = color
      continue
    }
    const classDef = line.match(/^classDef\s+([A-Za-z0-9_-]+)\s+(.+)$/i)
    if (classDef) {
      const color = fillOf(classDef[2])
      if (color) classColors.set(classDef[1], color)
      continue
    }
    const classUse = line.match(
      /^class\s+([A-Za-z0-9_.,\s-]+)\s+([A-Za-z0-9_-]+)$/i,
    )
    if (classUse) {
      pendingClassUses.push({
        ids: classUse[1].split(",").map((s) => s.trim()),
        className: classUse[2],
      })
      continue
    }
    if (/^(subgraph\b|end$|linkStyle\b|click\b|direction\b)/i.test(line)) {
      continue
    }
    // A chain like `a --> b -->|label| c`: node tokens sit between
    // connector matches, each connector optionally carrying the label of
    // the edge it forms with the next node.
    CONNECTOR_RE.lastIndex = 0
    let cursor = 0
    let prev: string | null = null
    let pendingLabel: string | undefined
    let sawConnector = false
    const onClass = (id: string, className: string) =>
      pendingClassUses.push({ ids: [id], className })
    const link = (token: string) => {
      const id = takeNode(token, nodes, onClass)
      if (id === null) return
      if (prev !== null) {
        edges.push({ from: prev, to: id, label: pendingLabel })
      }
      prev = id
    }
    let match = CONNECTOR_RE.exec(line)
    while (match) {
      sawConnector = true
      link(line.slice(cursor, match.index).trim())
      const label = (match[1] ?? match[2] ?? match[3])?.trim()
      pendingLabel = label ? cleanLabel(label) : undefined
      cursor = match.index + match[0].length
      match = CONNECTOR_RE.exec(line)
    }
    if (!sawConnector) {
      takeNode(line, nodes, onClass)
      continue
    }
    link(line.slice(cursor).trim())
  }

  // Applied after the walk: classDef may appear before or after its uses.
  for (const use of pendingClassUses) {
    const color = classColors.get(use.className)
    if (!color) continue
    for (const id of use.ids) {
      const node = nodes.get(id)
      if (node) node.color = color
    }
  }

  if (nodes.size === 0) return null
  return { direction, nodes, edges }
}

/** Rough node box sized to its label; dagre spaces boxes, we size them. */
function nodeSize(label: string): { width: number; height: number } {
  const lines = label.split("\n")
  const longest = Math.max(...lines.map((l) => l.length), 1)
  return {
    width: Math.min(Math.max(longest * 11 + 48, 120), 360),
    height: Math.max(lines.length * 28 + 32, 64),
  }
}

/**
 * Expand a diagram op into primitive canvas ops with concrete positions,
 * relative to (0,0); the caller decides where the block lands as a whole.
 * Returns null when the source isn't parseable as a flowchart.
 */
export function expandDiagram(
  diagramId: string,
  mermaid: string,
): CanvasOp[] | null {
  const parsed = parseMermaidFlowchart(mermaid)
  if (!parsed) return null

  const graph = new dagre.graphlib.Graph()
  graph.setGraph({
    rankdir: parsed.direction,
    nodesep: 60,
    ranksep: 80,
    marginx: 0,
    marginy: 0,
  })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const node of parsed.nodes.values()) {
    graph.setNode(node.id, nodeSize(node.label))
  }
  for (const edge of parsed.edges) {
    if (parsed.nodes.has(edge.from) && parsed.nodes.has(edge.to)) {
      graph.setEdge(edge.from, edge.to)
    }
  }
  dagre.layout(graph)

  const ops: CanvasOp[] = []
  // dagre positions node centers; the canvas wants top-left corners, and
  // the whole block normalized to start at (0,0).
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  for (const node of parsed.nodes.values()) {
    const placed = graph.node(node.id)
    minX = Math.min(minX, placed.x - placed.width / 2)
    minY = Math.min(minY, placed.y - placed.height / 2)
  }
  // Edge routing can swing outside the node bounding box (a cycle's back
  // edge bends around the rank row) — include it, so nothing lands at
  // negative coordinates relative to the block's placement spot.
  for (const e of graph.edges()) {
    for (const p of graph.edge(e)?.points ?? []) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
    }
  }
  for (const node of parsed.nodes.values()) {
    const placed = graph.node(node.id)
    ops.push({
      op: node.shape,
      id: `${diagramId}.${node.id}`,
      x: placed.x - placed.width / 2 - minX,
      y: placed.y - placed.height / 2 - minY,
      w: placed.width,
      h: placed.height,
      label: node.label,
      color: node.color,
      fill: node.color ? "semi" : undefined,
    })
  }
  for (const edge of parsed.edges) {
    if (!parsed.nodes.has(edge.from) || !parsed.nodes.has(edge.to)) continue
    // Dagre routes every edge (around ranks for back-edges in a cycle);
    // carry the interior waypoints so a long return arrow bends around the
    // diagram instead of cutting straight through the boxes it passes.
    const layout = graph.edge(edge.from, edge.to) as
      | { points?: { x: number; y: number }[] }
      | undefined
    const via = (layout?.points ?? []).slice(1, -1).map((p) => ({
      x: Math.round(p.x - minX),
      y: Math.round(p.y - minY),
    }))
    ops.push({
      op: "arrow",
      id: `${diagramId}.${edge.from}->${edge.to}`,
      from: `${diagramId}.${edge.from}`,
      to: `${diagramId}.${edge.to}`,
      via: via.length ? via.slice(0, 16) : undefined,
      label: edge.label,
    })
  }
  return ops
}
