import { describe, expect, it } from "vitest"
import {
  type AgentControl,
  agentControlSchema,
  type CanvasRecord,
  canvasOpBatchSchema,
  canvasOpSchema,
  chunkCanvasChanges,
  clampIncomingDocRev,
  defaultRoomSettings,
  describeAgentControl,
  emptySharedDoc,
  MAX_DOC_REV,
  mergeCanvasRecord,
  mergeSharedDoc,
  nextDocRev,
  parseRoomSettings,
  type SharedDoc,
  sharedDocSchema,
} from "./index.js"

describe("agentControlSchema", () => {
  it("accepts a control without actor fields, as older clients send", () => {
    const parsed = agentControlSchema.parse({ type: "mute", agentId: "scout" })
    expect(parsed.byName).toBeUndefined()
  })

  it("carries the actor when stamped", () => {
    const parsed = agentControlSchema.parse({
      type: "interrupt",
      agentId: "scout",
      by: "user-1",
      byName: "Gwinyai",
    })
    expect(parsed.byName).toBe("Gwinyai")
  })

  it("rejects an unknown control type", () => {
    expect(
      agentControlSchema.safeParse({ type: "explode", agentId: "scout" })
        .success,
    ).toBe(false)
  })
})

describe("describeAgentControl", () => {
  const cases: [AgentControl["type"], string][] = [
    ["mute", "muted Scout"],
    ["unmute", "unmuted Scout"],
    ["deafen", "deafened Scout"],
    ["undeafen", "undeafened Scout"],
    ["interrupt", "interrupted Scout"],
    ["call-on", "called on Scout"],
    ["zap", "zapped Scout"],
    ["remove", "removed Scout from the meeting"],
  ]

  it.each(cases)("describes %s", (type, expected) => {
    expect(describeAgentControl({ type, agentId: "scout" }, "Scout")).toBe(
      expected,
    )
  })

  it("names the policy when the turn policy changes", () => {
    expect(
      describeAgentControl(
        { type: "set-turn-policy", agentId: "scout", policy: "raise-hand" },
        "Scout",
      ),
    ).toBe("set Scout's response mode to raise-hand")
  })

  it("stays quiet on a policy change with no policy to report", () => {
    expect(
      describeAgentControl({ type: "set-turn-policy", agentId: "scout" }, "S"),
    ).toBeNull()
  })

  it("names the direction when barge-in is toggled", () => {
    expect(
      describeAgentControl(
        { type: "set-barge-in", agentId: "scout", bargeIn: true },
        "Scout",
      ),
    ).toBe("turned barge-in on for Scout")
    expect(
      describeAgentControl(
        { type: "set-barge-in", agentId: "scout", bargeIn: false },
        "Scout",
      ),
    ).toBe("turned barge-in off for Scout")
  })

  it("stays quiet on a barge-in change with no direction to report", () => {
    expect(
      describeAgentControl({ type: "set-barge-in", agentId: "scout" }, "S"),
    ).toBeNull()
  })

  it("covers every control type, so a new one can't ship unannounced", () => {
    for (const type of agentControlSchema.shape.type.options) {
      const control: AgentControl = {
        type,
        agentId: "scout",
        ...(type === "set-turn-policy" ? { policy: "open" as const } : {}),
        ...(type === "set-barge-in" ? { bargeIn: true } : {}),
      }
      expect(describeAgentControl(control, "Scout")).toBeTruthy()
    }
  })
})

describe("parseRoomSettings", () => {
  it("defaults to open when a room has no metadata", () => {
    expect(parseRoomSettings(undefined)).toEqual(defaultRoomSettings)
    expect(parseRoomSettings("")).toEqual(defaultRoomSettings)
  })

  it("defaults to open for rooms created before settings existed", () => {
    const legacy = JSON.stringify({ hostKey: "k", started: true })
    expect(parseRoomSettings(legacy)).toEqual(defaultRoomSettings)
  })

  it("reads settings the host has saved", () => {
    const raw = JSON.stringify({
      hostKey: "k",
      settings: {
        participantsCanControlAgents: false,
        participantsCanInviteAgents: false,
      },
    })
    expect(parseRoomSettings(raw)).toEqual({
      participantsCanControlAgents: false,
      participantsCanInviteAgents: false,
    })
  })

  it("fills in a setting the host never touched", () => {
    const raw = JSON.stringify({
      settings: { participantsCanInviteAgents: false },
    })
    expect(parseRoomSettings(raw)).toEqual({
      participantsCanControlAgents: true,
      participantsCanInviteAgents: false,
    })
  })

  it("falls back to open rather than throwing on junk", () => {
    expect(parseRoomSettings("not json")).toEqual(defaultRoomSettings)
    expect(
      parseRoomSettings(
        JSON.stringify({ settings: { participantsCanControlAgents: "yes" } }),
      ),
    ).toEqual(defaultRoomSettings)
  })
})

function doc(overrides: Partial<SharedDoc>): SharedDoc {
  return { ...emptySharedDoc, by: "a", byName: "A", ...overrides }
}

describe("sharedDocSchema", () => {
  it("accepts a document update", () => {
    expect(
      sharedDocSchema.parse({
        text: "# Plan",
        rev: 3,
        by: "u1",
        byName: "Amin",
        at: 1000,
      }).rev,
    ).toBe(3)
  })

  it("rejects a negative or fractional revision", () => {
    for (const rev of [-1, 1.5]) {
      expect(sharedDocSchema.safeParse({ ...doc({}), rev }).success).toBe(false)
    }
  })

  it("rejects a revision above the cap (the doc-freeze attack)", () => {
    expect(
      sharedDocSchema.safeParse({ ...doc({}), rev: MAX_DOC_REV + 1 }).success,
    ).toBe(false)
    expect(
      sharedDocSchema.safeParse({ ...doc({}), rev: Number.MAX_SAFE_INTEGER })
        .success,
    ).toBe(false)
  })

  it("bounds oversized attribution fields", () => {
    const big = "x".repeat(200)
    expect(sharedDocSchema.safeParse({ ...doc({}), by: big }).success).toBe(
      false,
    )
    expect(sharedDocSchema.safeParse({ ...doc({}), byName: big }).success).toBe(
      false,
    )
  })
})

describe("doc revision clamping (freeze defense)", () => {
  it("increments normally below the cap", () => {
    expect(nextDocRev(0)).toBe(1)
    expect(nextDocRev(41)).toBe(42)
  })

  it("never exceeds the cap, so validation can't overflow", () => {
    expect(nextDocRev(MAX_DOC_REV)).toBe(MAX_DOC_REV)
    expect(nextDocRev(MAX_DOC_REV - 1)).toBe(MAX_DOC_REV)
    // The clamped rev always passes the schema — the freeze can't happen.
    expect(
      sharedDocSchema.safeParse({ ...doc({}), rev: nextDocRev(MAX_DOC_REV) })
        .success,
    ).toBe(true)
  })

  it("clamps a malicious incoming rev to at most one past what we hold", () => {
    // Attacker PUTs rev at the ceiling while the stored doc is at 3.
    expect(clampIncomingDocRev(MAX_DOC_REV, 3)).toBe(4)
    // A normal +1 edit is untouched.
    expect(clampIncomingDocRev(4, 3)).toBe(4)
    // A stale/lower rev is left as-is (mergeSharedDoc discards it).
    expect(clampIncomingDocRev(2, 3)).toBe(2)
  })
})

describe("mergeSharedDoc", () => {
  it("takes the newer revision", () => {
    const current = doc({ text: "old", rev: 1 })
    const incoming = doc({ text: "new", rev: 2 })
    expect(mergeSharedDoc(current, incoming).text).toBe("new")
  })

  it("ignores a stale broadcast that arrives late", () => {
    // The case this exists for: a slow peer's older edit landing after a
    // newer one would otherwise wipe out the newer text.
    const current = doc({ text: "new", rev: 5 })
    const incoming = doc({ text: "stale", rev: 4 })
    expect(mergeSharedDoc(current, incoming).text).toBe("new")
  })

  it("breaks a revision tie on timestamp", () => {
    const current = doc({ text: "first", rev: 2, at: 100 })
    const incoming = doc({ text: "second", rev: 2, at: 200 })
    expect(mergeSharedDoc(current, incoming).text).toBe("second")
  })

  it("breaks a full tie the same way on every peer", () => {
    const mine = doc({ text: "mine", rev: 2, at: 100, by: "aaa" })
    const theirs = doc({ text: "theirs", rev: 2, at: 100, by: "zzz" })
    // Both sides must land on the same text, whichever way round they see
    // the pair — otherwise the room silently diverges.
    expect(mergeSharedDoc(mine, theirs).text).toBe("theirs")
    expect(mergeSharedDoc(theirs, mine).text).toBe("theirs")
  })

  it("converges regardless of the order updates arrive in", () => {
    const updates = [
      doc({ text: "a", rev: 1, at: 10, by: "u1" }),
      doc({ text: "b", rev: 2, at: 20, by: "u2" }),
      doc({ text: "c", rev: 2, at: 20, by: "u3" }),
      doc({ text: "d", rev: 3, at: 30, by: "u1" }),
    ]
    const fold = (order: SharedDoc[]) =>
      order.reduce(mergeSharedDoc, emptySharedDoc).text
    expect(fold(updates)).toBe("d")
    expect(fold([...updates].reverse())).toBe("d")
    expect(fold([updates[2], updates[0], updates[3], updates[1]])).toBe("d")
  })

  it("accepts the first real edit over an empty document", () => {
    const incoming = doc({ text: "# Plan", rev: 1, at: 5 })
    expect(mergeSharedDoc(emptySharedDoc, incoming).text).toBe("# Plan")
  })
})

function rec(overrides: Partial<CanvasRecord>): CanvasRecord {
  return {
    id: "shape:s1",
    record: { typeName: "shape" },
    v: 1,
    at: 100,
    by: "a",
    ...overrides,
  }
}

describe("mergeCanvasRecord", () => {
  it("accepts anything over an absent record", () => {
    const incoming = rec({ v: 1 })
    expect(mergeCanvasRecord(undefined, incoming)).toBe(incoming)
  })

  it("takes the higher version", () => {
    const current = rec({ v: 1, record: { w: 1 } })
    const incoming = rec({ v: 2, record: { w: 2 } })
    expect(mergeCanvasRecord(current, incoming).record).toEqual({ w: 2 })
  })

  it("ignores a stale broadcast that arrives late", () => {
    const current = rec({ v: 5 })
    const incoming = rec({ v: 4, record: { w: 9 } })
    expect(mergeCanvasRecord(current, incoming)).toBe(current)
  })

  it("lets a tombstone beat an older edit and lose to a newer one", () => {
    const edit = rec({ v: 2 })
    const tombstone = rec({ v: 3, record: null })
    // Delete wins over the edit it followed…
    expect(mergeCanvasRecord(edit, tombstone).record).toBeNull()
    // …and a deliberate redraw at a higher version resurrects the shape.
    const redraw = rec({ v: 4, record: { w: 3 } })
    expect(mergeCanvasRecord(tombstone, redraw).record).toEqual({ w: 3 })
  })

  it("breaks a full tie the same way on every peer", () => {
    const mine = rec({ v: 2, at: 100, by: "aaa", record: { w: 1 } })
    const theirs = rec({ v: 2, at: 100, by: "zzz", record: { w: 2 } })
    expect(mergeCanvasRecord(mine, theirs)).toBe(theirs)
    expect(mergeCanvasRecord(theirs, mine)).toBe(theirs)
  })
})

describe("chunkCanvasChanges", () => {
  it("keeps a small batch in one message", () => {
    const changes = [rec({ id: "shape:a" }), rec({ id: "shape:b" })]
    expect(chunkCanvasChanges(changes)).toEqual([changes])
  })

  it("splits when a chunk would exceed the byte budget", () => {
    const fat = rec({ record: { d: "x".repeat(600) } })
    const changes = Array.from({ length: 10 }, (_, i) =>
      rec({ ...fat, id: `shape:s${i}` }),
    )
    const chunks = chunkCanvasChanges(changes, 2000)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.flat()).toEqual(changes)
    for (const chunk of chunks.slice(0, -1)) {
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(2400)
    }
  })

  it("still ships a record too big for any chunk, alone", () => {
    const huge = rec({ record: { d: "x".repeat(5000) } })
    expect(
      chunkCanvasChanges([rec({}), huge, rec({ id: "shape:z" })], 2000),
    ).toHaveLength(3)
  })
})

describe("canvasOpSchema", () => {
  it("accepts the primitives an agent draws with", () => {
    const ops = [
      { op: "rect", id: "api", x: 0, y: 0, w: 160, h: 80, label: "API" },
      { op: "arrow", id: "a1", from: "api", to: "db", label: "queries" },
      {
        op: "draw",
        id: "d1",
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 5 },
        ],
      },
      { op: "note", id: "n1", x: 300, y: 0, text: "TODO", color: "yellow" },
      { op: "clear" },
    ]
    expect(canvasOpBatchSchema.safeParse(ops).success).toBe(true)
  })

  it("rejects a shape with no id, zero size, or an unknown color", () => {
    for (const bad of [
      { op: "rect", id: "", x: 0, y: 0, w: 10, h: 10 },
      { op: "rect", id: "a", x: 0, y: 0, w: 0, h: 10 },
      { op: "text", id: "t", x: 0, y: 0, text: "hi", color: "mauve" },
      { op: "draw", id: "d", points: [{ x: 0, y: 0 }] },
    ]) {
      expect(canvasOpSchema.safeParse(bad).success).toBe(false)
    }
  })

  it("caps a batch at 50 ops", () => {
    const ops = Array.from({ length: 51 }, () => ({ op: "clear" }))
    expect(canvasOpBatchSchema.safeParse(ops).success).toBe(false)
  })
})
