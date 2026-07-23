---
name: whiteboard
description: Draw clear, legible diagrams on the meeting's shared whiteboard with canvas op blocks.
---

# Drawing on the meeting whiteboard

Meetings you join through Looped Meet have a shared whiteboard everyone sees
live. You draw by including a JSON array of operations between two marker
lines anywhere in your reply:

```
<<<CANVAS
[
  { "op": "rect", "id": "api", "x": 0, "y": 0, "w": 160, "h": 80, "label": "API" },
  { "op": "rect", "id": "db", "x": 400, "y": 0, "w": 160, "h": 80, "label": "Postgres" },
  { "op": "arrow", "id": "a1", "from": "api", "to": "db", "label": "queries" }
]
CANVAS>>>
```

The block is drawn, never spoken; text outside it is spoken aloud as usual.
Each marker must sit on its own line, exactly as written, with no code
fences around the block. Never say coordinates, ids, or JSON out loud —
say what the diagram shows ("here's the API talking to Postgres"), not how
you drew it.

## Operations

Applied in order within a block. Every op except `clear` names a shape by
`id` — pick short memorable ids (`api`, `db`, `step1`) so you can connect,
move, update, or delete shapes in later turns.

| Op | Fields | Notes |
| --- | --- | --- |
| `rect`, `ellipse` | `id, x, y, w, h, label?, color?, fill?` | `fill`: `none` (default), `semi`, `solid` |
| `text` | `id, x, y, text, size?, color?` | `size`: `s`, `m`, `l` (heading), `xl` (title) |
| `note` | `id, x, y, text, color?` | a sticky note; sizes itself to the text |
| `arrow` | `id, from?, to?, fromPoint?, toPoint?, label?, color?` | `from`/`to` are shape ids — bound arrows re-route when shapes move; prefer them over free points |
| `draw` | `id, points, color?` | freehand polyline, `points: [{x, y}, …]` |
| `move` | `id, x, y` | reposition a shape (its label rides along) |
| `update` | `id, label?, text?, color?, w?, h?` | restyle or relabel in place |
| `delete` | `id` | arrows pointing at it stay but unbind |
| `clear` | — | wipes the board; only when asked |
| `diagram` | `id, mermaid, x?, y?` | a whole Mermaid `flowchart`/`graph` laid out automatically — **prefer this for any boxes-and-arrows structure**; node ids become `<id>.<node>` for later `move`/`update`/`arrow` ops. Mermaid `style <node> fill:<color>` / `classDef` / `:::class` colors are honored (snapped to the palette below). **Editing:** re-send the same diagram `id` with the edited Mermaid and it updates in place — the way to add, remove, recolor or relabel parts of an existing diagram |

Colors: `black` (default), `grey`, `blue`, `light-blue`, `violet`,
`light-violet`, `green`, `light-green`, `yellow`, `orange`, `red`,
`light-red`, `white`.

## Layout that stays legible

- Coordinates are page pixels on roughly a **1600x1000** area, origin
  top-left — **`y` grows downward**. Lay diagrams out left-to-right or
  top-down starting near (0,0).
- Boxes around **160x80**, with **~80px gaps**. Never place two shapes at
  the same spot.
- For charts and aligned layouts, compute positions with arithmetic, never
  by eye: bars on a shared baseline all end at the same `y + h`, so a
  taller bar starts at a **smaller** `y`; draw the axes from that same
  baseline. A shape placed inside a larger frame (a plot area, a region
  box) is deliberate nesting and stays where you put it.
- **Omit `x`/`y` on a create to auto-place it** clear of existing shapes.
  A create that would land on an existing shape's footprint is auto-nudged
  to free space — the result tells you where it actually landed.
- Track your own layout: you placed the shapes, so you know where they are.
  Results and board updates arrive in your context with exact positions —
  trust those over memory.

## Working incrementally

Build complex diagrams across several replies while you talk: draw a part,
say what it is, draw the next. Reuse an id to replace that shape; use
`move`/`update` to rearrange rather than redrawing everything. When the
meeting asks for changes ("make the cache red", "move that box down"),
prefer the smallest op that does it.

## What you see back

- The whiteboard's contents (every shape with id, position, and size) are
  described to you when you join, and again whenever someone else draws.
- Results of your own blocks — where each shape landed, auto-placement
  nudges, validation errors — arrive at the start of your next turn as
  `[Whiteboard results from your last turn:]`. If a block is reported
  invalid, fix the JSON and send it again; nothing from a bad block is
  drawn.
- A block that fails to close (you were interrupted mid-reply) is
  discarded, so re-send the whole block if your drawing never appeared.

## When to draw

Draw when structure beats speech: architectures, flows, timelines,
comparisons, quick brainstorm stickies. Don't duplicate the shared document
— prose and lists belong there; boxes and arrows belong here.
