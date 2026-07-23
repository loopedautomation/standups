import type { CanvasRecord } from "@meet/shared"
import { beforeEach, describe, expect, it } from "vitest"
import {
  $canvasRecords,
  adoptCanvasRecord,
  applyCanvasChanges,
  isElementChurn,
  resetCanvas,
} from "./canvas"

// A record as the agent bridge builds it: no fractional index yet — the
// client's Excalidraw assigns one on mount, bumping version/versionNonce.
function agentRecord(overrides: Partial<CanvasRecord> = {}): CanvasRecord {
  return {
    id: "agent-api",
    record: {
      id: "agent-api",
      type: "rectangle",
      x: 100,
      y: 100,
      width: 160,
      height: 80,
      version: 1,
      versionNonce: 111,
      updated: 1000,
      isDeleted: false,
      boundElements: null,
    },
    v: 1,
    at: 1000,
    by: "agent-scout",
    ...overrides,
  }
}

/** The same element after Excalidraw restored it and assigned an index. */
function restoredElement(record: Record<string, unknown>) {
  return {
    ...record,
    version: (record.version as number) + 1,
    versionNonce: 999,
    updated: 2000,
    index: "a0",
    boundElements: [],
  }
}

beforeEach(() => resetCanvas())

describe("isElementChurn", () => {
  it("treats restore bookkeeping as churn, not an edit", () => {
    const cached = agentRecord().record as Record<string, unknown>
    expect(isElementChurn(cached, restoredElement(cached))).toBe(true)
  })

  it("sees through key ordering differences", () => {
    const cached = agentRecord().record as Record<string, unknown>
    const reordered = Object.fromEntries(Object.entries(cached).reverse())
    expect(isElementChurn(cached, reordered)).toBe(true)
  })

  it("is not fooled by a real move riding the version bump", () => {
    const cached = agentRecord().record as Record<string, unknown>
    const moved = { ...restoredElement(cached), x: 500 }
    expect(isElementChurn(cached, moved)).toBe(false)
  })

  it("is not fooled by nested changes like arrow bindings", () => {
    const cached = {
      ...(agentRecord().record as Record<string, unknown>),
      boundElements: [{ type: "arrow", id: "agent-a1" }],
    }
    const rebound = {
      ...restoredElement(cached),
      boundElements: [{ type: "arrow", id: "agent-a2" }],
    }
    expect(isElementChurn(cached, rebound)).toBe(false)
  })
})

describe("adoptCanvasRecord", () => {
  it("folds Excalidraw bookkeeping in without touching the LWW clock", () => {
    const entry = agentRecord()
    applyCanvasChanges([entry])
    const scene = restoredElement(entry.record as Record<string, unknown>)

    adoptCanvasRecord(entry.id, scene)

    const adopted = $canvasRecords.get()[entry.id]
    expect(adopted.v).toBe(1)
    expect(adopted.by).toBe("agent-scout")
    expect(adopted.record?.index).toBe("a0")
    expect(adopted.record?.version).toBe(2)
  })

  it("keeps the agent's next move winning the merge after adoption", () => {
    const entry = agentRecord()
    applyCanvasChanges([entry])
    adoptCanvasRecord(
      entry.id,
      restoredElement(entry.record as Record<string, unknown>),
    )

    // The bridge builds the move off the snapshot store (still at v=1).
    const move = agentRecord({
      v: 2,
      at: 3000,
      record: { ...(entry.record as Record<string, unknown>), x: 500 },
    })
    const won = applyCanvasChanges([move])

    expect(won).toHaveLength(1)
    expect($canvasRecords.get()[entry.id].record?.x).toBe(500)
  })

  it("ignores ids that are not cached", () => {
    adoptCanvasRecord("ghost", { id: "ghost" })
    expect($canvasRecords.get().ghost).toBeUndefined()
  })
})
