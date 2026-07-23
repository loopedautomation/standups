import { describe, expect, it } from "vitest"
import {
  CANVAS_BLOCK_CLOSE,
  CANVAS_BLOCK_OPEN,
  CANVAS_PROTOCOL_NOTE,
  CanvasBlockExtractor,
  parseCanvasBlock,
} from "./canvas-blocks.js"

describe("CanvasBlockExtractor", () => {
  it("lifts a canvas block out of a spoken reply", () => {
    const out = new CanvasBlockExtractor().feed(
      [
        "Let me sketch that.",
        CANVAS_BLOCK_OPEN,
        '[{"op":"rect","id":"api","x":0,"y":0,"w":160,"h":80}]',
        CANVAS_BLOCK_CLOSE,
        "There you go.",
      ].join("\n"),
    )
    expect(out.blocks).toEqual([
      '[{"op":"rect","id":"api","x":0,"y":0,"w":160,"h":80}]',
    ])
    expect(out.spoken).toBe("Let me sketch that.\nThere you go.")
  })

  it("joins a block split across assistant frames", () => {
    const extractor = new CanvasBlockExtractor()
    const first = extractor.feed(`Drawing.\n${CANVAS_BLOCK_OPEN}\n[`)
    expect(first.spoken).toBe("Drawing.")
    expect(first.blocks).toEqual([])
    const second = extractor.feed(
      `{"op":"note","id":"n1","text":"hi"}]\n${CANVAS_BLOCK_CLOSE}`,
    )
    expect(second.blocks).toEqual(['[\n{"op":"note","id":"n1","text":"hi"}]'])
  })

  it("leaves doc markers alone", () => {
    const out = new CanvasBlockExtractor().feed("<<<DOC\n# notes\nDOC>>>")
    expect(out.blocks).toEqual([])
    expect(out.spoken).toBe("<<<DOC\n# notes\nDOC>>>")
  })
})

describe("parseCanvasBlock", () => {
  it("parses and validates a batch of ops", () => {
    const result = parseCanvasBlock(
      JSON.stringify([
        { op: "rect", id: "api", x: 0, y: 0, w: 160, h: 80, label: "API" },
        { op: "arrow", id: "a1", from: "api", to: "db" },
      ]),
    )
    expect("ops" in result && result.ops).toHaveLength(2)
  })

  it("accepts creates without coordinates (auto-placed downstream)", () => {
    const result = parseCanvasBlock(
      JSON.stringify([{ op: "note", id: "n1", text: "remember this" }]),
    )
    expect("ops" in result).toBe(true)
  })

  it("reports invalid JSON as prose, not an exception", () => {
    const result = parseCanvasBlock("draw a box please")
    expect("error" in result && result.error).toMatch(/JSON/)
  })

  it("reports schema violations with the offending path", () => {
    const result = parseCanvasBlock(
      JSON.stringify([{ op: "rect", id: "api", w: -5, h: 80 }]),
    )
    expect("error" in result && result.error).toContain("w")
  })

  it("rejects an empty batch", () => {
    expect("error" in parseCanvasBlock("[]")).toBe(true)
  })
})

describe("CANVAS_PROTOCOL_NOTE", () => {
  it("teaches the exact markers the extractor looks for", () => {
    expect(CANVAS_PROTOCOL_NOTE).toContain(CANVAS_BLOCK_OPEN)
    expect(CANVAS_PROTOCOL_NOTE).toContain(CANVAS_BLOCK_CLOSE)
  })
})
