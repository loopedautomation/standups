import { describe, expect, it } from "vitest"
import {
  ChatOpsBlockExtractor,
  DOC_BLOCK_CLOSE,
  DOC_BLOCK_OPEN,
  DocBlockExtractor,
  extractLeaveMarker,
  parseChatOpsBlock,
} from "./doc-blocks.js"

describe("DocBlockExtractor", () => {
  it("passes plain replies through untouched", () => {
    const out = new DocBlockExtractor().feed("Sure, I'll get on that.")
    expect(out.spoken).toBe("Sure, I'll get on that.")
    expect(out.blocks).toEqual([])
  })

  it("lifts a doc block out of a reply", () => {
    const out = new DocBlockExtractor().feed(
      [
        "Done — I've added the action items.",
        DOC_BLOCK_OPEN,
        "# Agenda",
        "",
        "- [ ] ship it",
        DOC_BLOCK_CLOSE,
        "Anything else?",
      ].join("\n"),
    )
    expect(out.blocks).toEqual(["# Agenda\n\n- [ ] ship it"])
    expect(out.spoken).toBe(
      "Done — I've added the action items.\nAnything else?",
    )
  })

  it("tolerates whitespace around the marker lines", () => {
    const out = new DocBlockExtractor().feed(
      `  ${DOC_BLOCK_OPEN}  \ndoc text\n\t${DOC_BLOCK_CLOSE}`,
    )
    expect(out.blocks).toEqual(["doc text"])
  })

  it("keeps marker-like text inside the document verbatim", () => {
    const out = new DocBlockExtractor().feed(
      `${DOC_BLOCK_OPEN}\nuse ${DOC_BLOCK_OPEN} markers inline\n${DOC_BLOCK_CLOSE}`,
    )
    expect(out.blocks).toEqual([`use ${DOC_BLOCK_OPEN} markers inline`])
  })

  it("joins a block split across assistant frames", () => {
    const extractor = new DocBlockExtractor()
    const first = extractor.feed(`Updating now.\n${DOC_BLOCK_OPEN}\n# Notes`)
    expect(first.spoken).toBe("Updating now.")
    expect(first.blocks).toEqual([])
    const second = extractor.feed(`- point one\n${DOC_BLOCK_CLOSE}\nDone.`)
    expect(second.blocks).toEqual(["# Notes\n- point one"])
    expect(second.spoken).toBe("Done.")
  })

  it("extracts several blocks and never leaks doc text into speech", () => {
    const extractor = new DocBlockExtractor()
    const out = extractor.feed(
      `${DOC_BLOCK_OPEN}\nfirst\n${DOC_BLOCK_CLOSE}\n${DOC_BLOCK_OPEN}\nsecond\n${DOC_BLOCK_CLOSE}`,
    )
    expect(out.blocks).toEqual(["first", "second"])
    expect(out.spoken.trim()).toBe("")
  })

  it("discards a block the turn never closed", () => {
    const extractor = new DocBlockExtractor()
    const out = extractor.feed(`${DOC_BLOCK_OPEN}\nhalf a doc`)
    expect(out.blocks).toEqual([])
    expect(out.spoken).toBe("")
  })
})

describe("chat ops blocks", () => {
  it("parses a valid edit/delete batch", () => {
    const parsed = parseChatOpsBlock(
      '[{"op":"edit","id":"echo-1","text":"fixed"},{"op":"delete","id":"echo-2"}]',
    )
    expect("ops" in parsed && parsed.ops).toHaveLength(2)
  })

  it("returns prose errors for junk, not exceptions", () => {
    expect(parseChatOpsBlock("not json")).toHaveProperty("error")
    expect(
      parseChatOpsBlock('[{"op":"edit","id":"x"}]'), // edit without text
    ).toHaveProperty("error")
    expect(parseChatOpsBlock("[]")).toHaveProperty("error")
  })

  it("extracts blocks from a reply via the marker extractor", () => {
    const out = new ChatOpsBlockExtractor().feed(
      `Deleting that.\n<<<CHATOPS\n[{"op":"delete","id":"a"}]\nCHATOPS>>>`,
    )
    expect(out.blocks).toHaveLength(1)
    expect(out.spoken.trim()).toBe("Deleting that.")
  })
})

describe("leave marker", () => {
  it("lifts the marker and reports it", () => {
    const { text, leave } = extractLeaveMarker("Goodbye everyone!\n<<<LEAVE>>>")
    expect(leave).toBe(true)
    expect(text).toBe("Goodbye everyone!")
  })

  it("is inert when absent or embedded mid-line", () => {
    expect(extractLeaveMarker("just talking").leave).toBe(false)
    expect(extractLeaveMarker("about <<<LEAVE>>> markers").leave).toBe(false)
  })
})
