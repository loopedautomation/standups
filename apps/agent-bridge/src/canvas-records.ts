import type { CanvasColor, CanvasOp, CanvasRecord } from "@meet/shared"

// Translates the agent's drawing vocabulary into plain Excalidraw element
// JSON — no browser, no editor. Elements are built conservatively with every
// field Excalidraw persists; clients additionally pass everything through
// `restoreElements` before mounting, so a field this file gets subtly wrong
// degrades to Excalidraw's default rather than a broken board.

export type BuildResult = {
  changes: CanvasRecord[]
  /** What the voice model hears back, e.g. `Drew: rect "API" (id api).` */
  summary: string
  warnings: string[]
}

type Author = { identity: string; name: string }

type LooseElement = Record<string, unknown>

/**
 * Agent ids are author-chosen short strings ("api", "db") mapped
 * deterministically into element-id space, so repeated references resolve
 * across tool calls and worker restarts with no mapping state.
 */
export function agentShapeId(shortId: string): string {
  return `agent-${shortId.replace(/[^a-zA-Z0-9_-]/g, "_")}`
}

/** Ops may also name full element ids, as `read_canvas` reports them. */
function resolveId(opId: string): string {
  return opId.startsWith("agent-") || opId.length >= 16
    ? opId
    : agentShapeId(opId)
}

function labelId(elementId: string): string {
  return `${elementId}-label`
}

/** Excalidraw's stock stroke palette, keyed by our color vocabulary. */
const STROKE_COLORS: Record<CanvasColor, string> = {
  black: "#1e1e1e",
  grey: "#868e96",
  "light-violet": "#b197fc",
  violet: "#9775fa",
  blue: "#1971c2",
  "light-blue": "#74c0fc",
  yellow: "#f08c00",
  orange: "#e8590c",
  green: "#2f9e44",
  "light-green": "#69db7c",
  "light-red": "#ffa8a8",
  red: "#e03131",
  white: "#ffffff",
}

/** Softer background fills for the same names (sticky notes, filled boxes). */
const BACKGROUND_COLORS: Record<CanvasColor, string> = {
  black: "#343a40",
  grey: "#e9ecef",
  "light-violet": "#d0bfff",
  violet: "#b197fc",
  blue: "#a5d8ff",
  "light-blue": "#d0ebff",
  yellow: "#ffec99",
  orange: "#ffd8a8",
  green: "#b2f2bb",
  "light-green": "#d3f9d8",
  "light-red": "#ffc9c9",
  red: "#ffa8a8",
  white: "#ffffff",
}

const FONT_SIZES = { s: 16, m: 20, l: 28, xl: 36 } as const

function rand(): number {
  return Math.floor(Math.random() * 2 ** 31)
}

/** Every field Excalidraw persists on all element types. */
function baseElement(id: string, at: number): LooseElement {
  return {
    id,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    angle: 0,
    strokeColor: STROKE_COLORS.black,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: rand(),
    version: 1,
    versionNonce: rand(),
    isDeleted: false,
    boundElements: null,
    updated: at,
    link: null,
    locked: false,
  }
}

function liveElement(entry: CanvasRecord | undefined): LooseElement | null {
  const element = entry?.record
  if (!element || element.isDeleted === true) return null
  return element
}

/** Rough text metrics, good enough for labels the editor will re-measure. */
function measure(text: string, fontSize: number) {
  const lines = text.split("\n")
  const longest = Math.max(...lines.map((l) => l.length), 1)
  return {
    width: Math.max(longest * fontSize * 0.6, 10),
    height: lines.length * fontSize * 1.25,
  }
}

type Box = { x: number; y: number; w: number; h: number }

/** Breathing room between auto-placed shapes, matching the tool's advice. */
const PLACE_GAP = 80

/**
 * Enough of `b` is buried under `a` that both stop being readable. Touching
 * or slightly overlapping neighbours are deliberate layout; a shape landing
 * on top of another is the failure mode this guards against.
 */
function overlapsHeavily(a: Box, b: Box): boolean {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (ix <= 0 || iy <= 0) return false
  const smaller = Math.min(a.w * a.h, b.w * b.h)
  return smaller > 0 && (ix * iy) / smaller > 0.4
}

/** Shapes a new element must keep clear of: live, top-level, with area. */
function placementObstacles(
  working: ReadonlyMap<string, CanvasRecord>,
  skipId: string,
): Box[] {
  const boxes: Box[] = []
  for (const [id, entry] of working) {
    if (id === skipId) continue
    const element = liveElement(entry)
    if (!element || element.containerId) continue
    const type = element.type as string
    if (type === "arrow" || type === "freedraw") continue
    const { x, y, width, height } = element as Partial<
      Record<"x" | "y" | "width" | "height", number>
    >
    if (typeof x !== "number" || typeof y !== "number") continue
    boxes.push({ x, y, w: width ?? 0, h: height ?? 0 })
  }
  return boxes
}

/**
 * Where a create op actually lands. The caller's coordinates are intent —
 * but voice models repeat themselves, so a shape that would bury an existing
 * one slides right past the blocker, and past the row's edge drops to a
 * fresh row below everything. Omitted coordinates start at the right edge of
 * what's already drawn.
 */
function placeCreate(
  working: ReadonlyMap<string, CanvasRecord>,
  id: string,
  op: { x?: number; y?: number },
  w: number,
  h: number,
): { x: number; y: number; nudged: boolean } {
  const current = liveElement(working.get(id))
  const obstacles = placementObstacles(working, id)
  if (
    (op.x === undefined || op.y === undefined) &&
    typeof current?.x === "number"
  ) {
    // Re-creating an existing shape without coordinates keeps its place.
    return { x: current.x as number, y: current.y as number, nudged: false }
  }
  let x =
    op.x ??
    (obstacles.length
      ? Math.max(...obstacles.map((b) => b.x + b.w)) + PLACE_GAP
      : 0)
  let y =
    op.y ?? (obstacles.length ? Math.min(...obstacles.map((b) => b.y)) : 0)
  // Redrawing a shape at its own spot is idempotent, never a collision.
  if (current && current.x === x && current.y === y) {
    return { x, y, nudged: false }
  }
  const desired = { x, y }
  const rowStart = x
  const rowLimit = x + 1600
  for (let i = 0; i <= obstacles.length; i++) {
    const hit = obstacles.find((b) => overlapsHeavily({ x, y, w, h }, b))
    if (!hit) break
    x = hit.x + hit.w + PLACE_GAP / 2
    if (x + w > rowLimit) {
      // A guaranteed-clear row under everything already drawn.
      x = rowStart
      y = Math.max(...obstacles.map((b) => b.y + b.h)) + PLACE_GAP / 2
      break
    }
  }
  return { x, y, nudged: x !== desired.x || y !== desired.y }
}

export function buildCanvasRecords(
  ops: CanvasOp[],
  existing: ReadonlyMap<string, CanvasRecord>,
  author: Author,
): BuildResult {
  const at = Date.now()
  const warnings: string[] = []
  const actions: string[] = []
  // Later ops see earlier ones — a batch can create two boxes and connect
  // them — so changes accumulate into a working view of the room.
  const working = new Map(existing)
  const changes = new Map<string, CanvasRecord>()

  const put = (id: string, element: LooseElement) => {
    const prior = working.get(id)
    const version =
      typeof element.version === "number"
        ? element.version
        : (prior?.v ?? 0) + 1
    const entry: CanvasRecord = {
      id,
      record: { ...element, version, versionNonce: rand(), updated: at },
      v: (prior?.v ?? 0) + 1,
      at,
      by: author.identity,
    }
    working.set(id, entry)
    changes.set(id, entry)
  }

  /** Mutate a live element, bumping Excalidraw's own version alongside ours. */
  const patch = (id: string, updates: LooseElement) => {
    const element = liveElement(working.get(id))
    if (!element) return false
    put(id, {
      ...element,
      ...updates,
      version: ((element.version as number) ?? 0) + 1,
    })
    return true
  }

  /** A container label: its own text element bound both ways. */
  const putLabel = (
    containerId: string,
    container: LooseElement,
    text: string,
    color: string,
  ) => {
    const id = labelId(containerId)
    const fontSize = 20
    const size = measure(text, fontSize)
    const cw = (container.width as number) ?? 0
    const ch = (container.height as number) ?? 0
    put(id, {
      ...baseElement(id, at),
      type: "text",
      x: (container.x as number) + cw / 2 - size.width / 2,
      y: (container.y as number) + ch / 2 - size.height / 2,
      width: size.width,
      height: size.height,
      strokeColor: color,
      text,
      originalText: text,
      fontSize,
      fontFamily: 5,
      textAlign: "center",
      verticalAlign: "middle",
      containerId,
      autoResize: true,
      lineHeight: 1.25,
    })
    return { type: "text", id }
  }

  const softDelete = (id: string) => patch(id, { isDeleted: true })

  const atSpot = (spot: { x: number; y: number }) =>
    `(${Math.round(spot.x)}, ${Math.round(spot.y)})`
  /** Tell the model its shape landed elsewhere, so its map stays right. */
  const noteNudge = (opId: string, spot: { x: number; y: number }) => {
    warnings.push(
      `"${opId}" would have covered an existing shape, so it was placed at ${atSpot(spot)} instead.`,
    )
  }

  for (const op of ops) {
    switch (op.op) {
      case "rect":
      case "ellipse": {
        const id = resolveId(op.id)
        const color = STROKE_COLORS[op.color ?? "black"]
        const spot = placeCreate(working, id, op, op.w, op.h)
        const element: LooseElement = {
          ...baseElement(id, at),
          type: op.op === "rect" ? "rectangle" : "ellipse",
          x: spot.x,
          y: spot.y,
          width: op.w,
          height: op.h,
          strokeColor: color,
          backgroundColor:
            op.fill && op.fill !== "none"
              ? BACKGROUND_COLORS[op.color ?? "blue"]
              : "transparent",
          fillStyle: op.fill === "semi" ? "hachure" : "solid",
          roundness: op.op === "rect" ? { type: 3 } : null,
        }
        if (op.label) {
          element.boundElements = [
            putLabel(id, element, op.label, STROKE_COLORS.black),
          ]
        }
        put(id, element)
        if (spot.nudged) noteNudge(op.id, spot)
        actions.push(
          `${op.op}${op.label ? ` "${op.label}"` : ""} (id ${op.id}) at ${atSpot(spot)}`,
        )
        break
      }
      case "text": {
        const id = resolveId(op.id)
        const fontSize = FONT_SIZES[op.size ?? "m"]
        const size = measure(op.text, fontSize)
        const spot = placeCreate(working, id, op, size.width, size.height)
        put(id, {
          ...baseElement(id, at),
          type: "text",
          x: spot.x,
          y: spot.y,
          width: size.width,
          height: size.height,
          strokeColor: STROKE_COLORS[op.color ?? "black"],
          text: op.text,
          originalText: op.text,
          fontSize,
          fontFamily: 5,
          textAlign: "left",
          verticalAlign: "top",
          containerId: null,
          autoResize: true,
          lineHeight: 1.25,
        })
        if (spot.nudged) noteNudge(op.id, spot)
        actions.push(
          `text "${truncate(op.text, 30)}" (id ${op.id}) at ${atSpot(spot)}`,
        )
        break
      }
      case "note": {
        const id = resolveId(op.id)
        const size = measure(op.text, 20)
        const w = Math.max(size.width + 40, 180)
        const h = Math.max(size.height + 40, 100)
        const spot = placeCreate(working, id, op, w, h)
        const element: LooseElement = {
          ...baseElement(id, at),
          type: "rectangle",
          x: spot.x,
          y: spot.y,
          width: w,
          height: h,
          strokeColor: STROKE_COLORS.black,
          backgroundColor: BACKGROUND_COLORS[op.color ?? "yellow"],
          fillStyle: "solid",
          roundness: { type: 3 },
        }
        element.boundElements = [
          putLabel(id, element, op.text, STROKE_COLORS.black),
        ]
        put(id, element)
        if (spot.nudged) noteNudge(op.id, spot)
        actions.push(
          `note "${truncate(op.text, 30)}" (id ${op.id}) at ${atSpot(spot)}`,
        )
        break
      }
      case "draw": {
        const id = resolveId(op.id)
        const origin = op.points[0]
        const points = op.points.map((p) => [p.x - origin.x, p.y - origin.y])
        const xs = points.map((p) => p[0])
        const ys = points.map((p) => p[1])
        put(id, {
          ...baseElement(id, at),
          type: "freedraw",
          x: origin.x,
          y: origin.y,
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
          strokeColor: STROKE_COLORS[op.color ?? "black"],
          points,
          pressures: [],
          simulatePressure: true,
          lastCommittedPoint: points[points.length - 1],
        })
        actions.push(`freehand line (id ${op.id})`)
        break
      }
      case "arrow": {
        const id = resolveId(op.id)
        const fromId = op.from ? resolveId(op.from) : null
        const toId = op.to ? resolveId(op.to) : null
        const fromShape = fromId ? liveElement(working.get(fromId)) : null
        const toShape = toId ? liveElement(working.get(toId)) : null
        if (fromId && !fromShape) {
          warnings.push(`arrow "${op.id}": no shape with id ${op.from}.`)
        }
        if (toId && !toShape) {
          warnings.push(`arrow "${op.id}": no shape with id ${op.to}.`)
        }
        const center = (el: LooseElement) => ({
          x: (el.x as number) + (el.width as number) / 2,
          y: (el.y as number) + (el.height as number) / 2,
        })
        const start = fromShape
          ? center(fromShape)
          : (op.fromPoint ?? { x: 0, y: 0 })
        const end = toShape
          ? center(toShape)
          : (op.toPoint ?? { x: start.x + 100, y: start.y })
        const element: LooseElement = {
          ...baseElement(id, at),
          type: "arrow",
          x: start.x,
          y: start.y,
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
          strokeColor: STROKE_COLORS[op.color ?? "black"],
          points: [
            [0, 0],
            [end.x - start.x, end.y - start.y],
          ],
          lastCommittedPoint: null,
          startBinding: fromShape
            ? { elementId: fromId, focus: 0, gap: 4 }
            : null,
          endBinding: toShape ? { elementId: toId, focus: 0, gap: 4 } : null,
          startArrowhead: null,
          endArrowhead: "arrow",
          elbowed: false,
        }
        const bound: { type: string; id: string }[] = []
        if (op.label) {
          bound.push(putLabel(id, element, op.label, STROKE_COLORS.black))
        }
        element.boundElements = bound.length ? bound : null
        put(id, element)
        // Bindings are bookkept on both ends: the bound shapes must list the
        // arrow, or Excalidraw won't re-route it when they move.
        for (const target of [fromShape && fromId, toShape && toId]) {
          if (!target) continue
          const shape = liveElement(working.get(target))
          if (!shape) continue
          const bindings = Array.isArray(shape.boundElements)
            ? (shape.boundElements as { type: string; id: string }[])
            : []
          if (!bindings.some((b) => b.id === id)) {
            patch(target, {
              boundElements: [...bindings, { type: "arrow", id }],
            })
          }
        }
        actions.push(
          `arrow ${op.from ?? "free"}→${op.to ?? "free"}${
            op.label ? ` "${op.label}"` : ""
          } (id ${op.id})`,
        )
        break
      }
      case "move": {
        const id = resolveId(op.id)
        const element = liveElement(working.get(id))
        if (!element) {
          warnings.push(`move: no shape with id ${op.id}.`)
          break
        }
        const dx = op.x - (element.x as number)
        const dy = op.y - (element.y as number)
        patch(id, { x: op.x, y: op.y })
        // The bound label keeps its own coordinates, so it rides along.
        const label = liveElement(working.get(labelId(id)))
        if (label) {
          patch(labelId(id), {
            x: (label.x as number) + dx,
            y: (label.y as number) + dy,
          })
        }
        actions.push(`moved ${op.id} to ${atSpot(op)}`)
        break
      }
      case "update": {
        const id = resolveId(op.id)
        const element = liveElement(working.get(id))
        if (!element) {
          warnings.push(`update: no shape with id ${op.id}.`)
          break
        }
        const updates: LooseElement = {}
        if (op.color) {
          updates.strokeColor = STROKE_COLORS[op.color]
          if (element.backgroundColor !== "transparent") {
            updates.backgroundColor = BACKGROUND_COLORS[op.color]
          }
        }
        if (op.w !== undefined) updates.width = op.w
        if (op.h !== undefined) updates.height = op.h
        const text = op.label ?? op.text
        if (text !== undefined) {
          if (element.type === "text") {
            updates.text = text
            updates.originalText = text
          } else {
            const label = liveElement(working.get(labelId(id)))
            if (label) {
              patch(labelId(id), { text, originalText: text })
            } else {
              const bindings = Array.isArray(element.boundElements)
                ? (element.boundElements as { type: string; id: string }[])
                : []
              updates.boundElements = [
                ...bindings,
                putLabel(id, element, text, STROKE_COLORS.black),
              ]
            }
          }
        }
        patch(id, updates)
        actions.push(`updated ${op.id}`)
        break
      }
      case "delete": {
        const id = resolveId(op.id)
        const element = liveElement(working.get(id))
        if (!element) {
          warnings.push(`delete: no shape with id ${op.id}.`)
          break
        }
        softDelete(id)
        softDelete(labelId(id))
        // Arrows pointing at a deleted shape keep their last geometry but
        // drop the binding, so they stop tracking a ghost.
        for (const [otherId, entry] of working) {
          const other = liveElement(entry)
          if (!other || other.type !== "arrow") continue
          const start = other.startBinding as { elementId?: string } | null
          const end = other.endBinding as { elementId?: string } | null
          if (start?.elementId === id || end?.elementId === id) {
            patch(otherId, {
              startBinding: start?.elementId === id ? null : other.startBinding,
              endBinding: end?.elementId === id ? null : other.endBinding,
            })
          }
        }
        actions.push(`deleted ${op.id}`)
        break
      }
      case "clear": {
        let cleared = 0
        for (const [id, entry] of working) {
          const element = liveElement(entry)
          if (!element) continue
          softDelete(id)
          if (!(element.containerId as string | null)) cleared++
        }
        actions.push(`cleared the canvas (${cleared} shapes)`)
        break
      }
    }
  }

  const liveShapes = [...working.values()].filter((entry) => {
    const element = liveElement(entry)
    return element && !(element.containerId as string | null)
  }).length
  const summary = actions.length
    ? `Drew: ${actions.join(", ")}. The canvas now has ${liveShapes} shape${
        liveShapes === 1 ? "" : "s"
      }.`
    : ""

  return { changes: [...changes.values()], summary, warnings }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * The whiteboard as text — what `read_canvas` returns and what pipeline
 * brains get as context. Shapes read top-to-bottom, left-to-right; arrows
 * name what they connect so the description reads as a diagram.
 */
export function describeCanvas(
  records: Iterable<CanvasRecord>,
  maxChars = 4000,
): string {
  const elements = new Map<string, LooseElement>()
  for (const entry of records) {
    const element = liveElement(entry)
    if (element) elements.set(entry.id, element)
  }
  if (elements.size === 0) return ""

  const labelOf = (id: string): string => {
    const element = elements.get(id)
    if (!element) return ""
    if (element.type === "text") return (element.text as string) ?? ""
    const bindings = Array.isArray(element.boundElements)
      ? (element.boundElements as { type: string; id: string }[])
      : []
    const textBinding = bindings.find((b) => b.type === "text")
    const label = textBinding ? elements.get(textBinding.id) : undefined
    return (label?.text as string) ?? ""
  }
  const nameOf = (id: string): string => {
    const element = elements.get(id)
    if (!element) return id
    return labelOf(id) || `${element.type} ${id}`
  }

  const standalone = [...elements.entries()].filter(
    ([, el]) => !(el.containerId as string | null),
  )
  const arrows = standalone.filter(([, el]) => el.type === "arrow")
  const others = standalone
    .filter(([, el]) => el.type !== "arrow")
    .sort(([, a], [, b]) => {
      const ay = a.y as number
      const by = b.y as number
      return ay === by ? (a.x as number) - (b.x as number) : ay - by
    })

  const lines: string[] = []
  for (const [id, element] of others) {
    const text = labelOf(id)
    const size = ` ${Math.round(element.width as number)}x${Math.round(
      element.height as number,
    )}`
    lines.push(
      `- ${element.type}${text ? ` "${truncate(text, 60)}"` : ""} (id ${id}) at (${Math.round(
        element.x as number,
      )}, ${Math.round(element.y as number)})${size}`,
    )
  }
  for (const [id, element] of arrows) {
    const start = element.startBinding as { elementId?: string } | null
    const end = element.endBinding as { elementId?: string } | null
    const text = labelOf(id)
    lines.push(
      `- arrow ${start?.elementId ? nameOf(start.elementId) : "free"} → ${
        end?.elementId ? nameOf(end.elementId) : "free"
      }${text ? ` "${text}"` : ""} (id ${id})`,
    )
  }

  let out = lines.join("\n")
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars)}\n…(truncated)`
  }
  const xs = others.map(([, el]) => el.x as number)
  const ys = others.map(([, el]) => el.y as number)
  const extent = xs.length
    ? ` spanning roughly (${Math.round(Math.min(...xs))}, ${Math.round(
        Math.min(...ys),
      )}) to (${Math.round(Math.max(...xs))}, ${Math.round(Math.max(...ys))})`
    : ""
  const count = others.length + arrows.length
  return `${out}\n${count} shape${count === 1 ? "" : "s"} total${extent}.`
}
