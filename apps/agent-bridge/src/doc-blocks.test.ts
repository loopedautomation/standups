import { describe, expect, it } from "vitest"
import {
  DOC_BLOCK_CLOSE,
  DOC_BLOCK_OPEN,
  DocBlockExtractor,
} from "./doc-blocks.js"

describe("DocBlockExtractor", () => {
  it("passes plain replies through untouched", () => {
    const out = new DocBlockExtractor().feed("Sure, I'll get on that.")
    expect(out.spoken).toBe("Sure, I'll get on that.")
    expect(out.docs).toEqual([])
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
    expect(out.docs).toEqual(["# Agenda\n\n- [ ] ship it"])
    expect(out.spoken).toBe(
      "Done — I've added the action items.\nAnything else?",
    )
  })

  it("tolerates whitespace around the marker lines", () => {
    const out = new DocBlockExtractor().feed(
      `  ${DOC_BLOCK_OPEN}  \ndoc text\n\t${DOC_BLOCK_CLOSE}`,
    )
    expect(out.docs).toEqual(["doc text"])
  })

  it("keeps marker-like text inside the document verbatim", () => {
    const out = new DocBlockExtractor().feed(
      `${DOC_BLOCK_OPEN}\nuse ${DOC_BLOCK_OPEN} markers inline\n${DOC_BLOCK_CLOSE}`,
    )
    expect(out.docs).toEqual([`use ${DOC_BLOCK_OPEN} markers inline`])
  })

  it("joins a block split across assistant frames", () => {
    const extractor = new DocBlockExtractor()
    const first = extractor.feed(`Updating now.\n${DOC_BLOCK_OPEN}\n# Notes`)
    expect(first.spoken).toBe("Updating now.")
    expect(first.docs).toEqual([])
    const second = extractor.feed(`- point one\n${DOC_BLOCK_CLOSE}\nDone.`)
    expect(second.docs).toEqual(["# Notes\n- point one"])
    expect(second.spoken).toBe("Done.")
  })

  it("extracts several blocks and never leaks doc text into speech", () => {
    const extractor = new DocBlockExtractor()
    const out = extractor.feed(
      `${DOC_BLOCK_OPEN}\nfirst\n${DOC_BLOCK_CLOSE}\n${DOC_BLOCK_OPEN}\nsecond\n${DOC_BLOCK_CLOSE}`,
    )
    expect(out.docs).toEqual(["first", "second"])
    expect(out.spoken.trim()).toBe("")
  })

  it("discards a block the turn never closed", () => {
    const extractor = new DocBlockExtractor()
    const out = extractor.feed(`${DOC_BLOCK_OPEN}\nhalf a doc`)
    expect(out.docs).toEqual([])
    expect(out.spoken).toBe("")
  })
})
