import { describe, expect, it } from "vitest"
import {
  type AgentControl,
  agentActivityEventSchema,
  agentControlSchema,
  applyDocUpdateB64,
  type CanvasRecord,
  canvasOpBatchSchema,
  canvasOpSchema,
  chatMessageSchema,
  chatOpSchema,
  chunkCanvasChanges,
  defaultRoomSettings,
  describeAgentControl,
  docSyncMessageSchema,
  encodeDocDiffB64,
  encodeDocStateB64,
  mentionsName,
  mergeCanvasRecord,
  parseRoomSettings,
  readSharedDoc,
  setSharedDocText,
  spokenMentionRegExp,
  Y,
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

describe("shared doc CRDT sync", () => {
  const author = { by: "u1", byName: "Amin" }

  it("round-trips text and metadata through a full-state update", () => {
    const a = new Y.Doc()
    setSharedDocText(a, "# Plan", author)
    const b = new Y.Doc()
    expect(applyDocUpdateB64(b, encodeDocStateB64(a))).toBe(true)
    const view = readSharedDoc(b)
    expect(view.text).toBe("# Plan")
    expect(view.byName).toBe("Amin")
    expect(view.rev).toBeGreaterThan(0)
  })

  it("merges concurrent edits from two peers — nobody's keystroke drops", () => {
    const a = new Y.Doc()
    setSharedDocText(a, "hello world", author)
    const b = new Y.Doc()
    applyDocUpdateB64(b, encodeDocStateB64(a))
    // Divergent edits at opposite ends, made without seeing each other.
    setSharedDocText(a, "HEY hello world", author)
    setSharedDocText(b, "hello world !!!", { by: "u2", byName: "Bea" })
    // Exchange full states both ways.
    applyDocUpdateB64(b, encodeDocStateB64(a))
    applyDocUpdateB64(a, encodeDocStateB64(b))
    expect(readSharedDoc(a).text).toBe("HEY hello world !!!")
    expect(readSharedDoc(b).text).toBe("HEY hello world !!!")
  })

  it("an agent's full-document rewrite merges with a concurrent human edit", () => {
    // The daily case: the agent rewrites a section while a person types in
    // another one. Under LWW one of them vanished; here both land.
    const human = new Y.Doc()
    setSharedDocText(human, "# Plan\n\n## Goals\n\n## Risks\n", author)
    const agent = new Y.Doc()
    applyDocUpdateB64(agent, encodeDocStateB64(human))
    setSharedDocText(
      agent,
      "# Plan\n\n## Goals\n- ship the CRDT\n\n## Risks\n",
      { by: "agent-scout", byName: "Scout" },
    )
    setSharedDocText(human, "# Plan\n\n## Goals\n\n## Risks\n- none!\n", author)
    applyDocUpdateB64(human, encodeDocStateB64(agent))
    applyDocUpdateB64(agent, encodeDocStateB64(human))
    const merged = readSharedDoc(human).text
    expect(merged).toContain("- ship the CRDT")
    expect(merged).toContain("- none!")
    expect(readSharedDoc(agent).text).toBe(merged)
  })

  it("incremental diffs since a state vector carry only the new edit", () => {
    const a = new Y.Doc()
    setSharedDocText(a, "one", author)
    const b = new Y.Doc()
    applyDocUpdateB64(b, encodeDocStateB64(a))
    const since = Y.encodeStateVector(a)
    setSharedDocText(a, "one two", author)
    applyDocUpdateB64(b, encodeDocDiffB64(a, since))
    expect(readSharedDoc(b).text).toBe("one two")
  })

  it("converges regardless of update arrival order", () => {
    const src = new Y.Doc()
    const updates: string[] = []
    src.on("update", (u: Uint8Array) => {
      updates.push(encodeDocStateB64(src))
      void u
    })
    setSharedDocText(src, "a", author)
    setSharedDocText(src, "a b", author)
    setSharedDocText(src, "a b c", author)
    const forward = new Y.Doc()
    for (const u of updates) applyDocUpdateB64(forward, u)
    const backward = new Y.Doc()
    for (const u of [...updates].reverse()) applyDocUpdateB64(backward, u)
    expect(readSharedDoc(forward).text).toBe("a b c")
    expect(readSharedDoc(backward).text).toBe("a b c")
  })

  it("no-op writes report false and bump nothing", () => {
    const a = new Y.Doc()
    setSharedDocText(a, "same", author)
    const rev = readSharedDoc(a).rev
    expect(setSharedDocText(a, "same", author)).toBe(false)
    expect(readSharedDoc(a).rev).toBe(rev)
  })

  it("drops garbage updates instead of throwing", () => {
    const a = new Y.Doc()
    expect(applyDocUpdateB64(a, "!!!not-base64-yjs!!!")).toBe(false)
  })

  it("bounds broadcast payloads via the message schema", () => {
    expect(
      docSyncMessageSchema.safeParse({ type: "doc-sync", update: "" }).success,
    ).toBe(false)
    expect(
      docSyncMessageSchema.safeParse({
        type: "doc-sync",
        update: "x".repeat(1_500_001),
      }).success,
    ).toBe(false)
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

describe("agentActivityEventSchema typing", () => {
  it("accepts a typing event in either direction", () => {
    for (const typing of [true, false]) {
      const parsed = agentActivityEventSchema.safeParse({
        type: "typing",
        agentId: "scout",
        typing,
        at: 1,
      })
      expect(parsed.success).toBe(true)
    }
  })

  it("requires the typing boolean", () => {
    const parsed = agentActivityEventSchema.safeParse({
      type: "typing",
      agentId: "scout",
      at: 1,
    })
    expect(parsed.success).toBe(false)
  })
})

describe("mentionsName", () => {
  it("matches a plain @mention case-insensitively", () => {
    expect(mentionsName("@scout what's the agenda?", "Scout")).toBe(true)
    expect(mentionsName("hey @SCOUT", "Scout")).toBe(true)
  })

  it("does not match a longer word sharing the prefix", () => {
    expect(mentionsName("@Scouting report", "Scout")).toBe(false)
  })

  it("matches multi-word names with flexible spacing", () => {
    expect(mentionsName("@Scout Team ship it", "Scout Team")).toBe(true)
    expect(mentionsName("@scout   team ship it", "Scout Team")).toBe(true)
    expect(mentionsName("@scout ship it", "Scout Team")).toBe(false)
  })

  it("survives regex metacharacters in the name", () => {
    expect(mentionsName("@C++ Helper, review this", "C++ Helper")).toBe(true)
    expect(mentionsName("ping @Agent (dev)", "Agent (dev)")).toBe(true)
    expect(mentionsName("nothing here", "Agent (dev)")).toBe(false)
  })

  it("never matches an empty or whitespace name", () => {
    expect(mentionsName("@ hello", "")).toBe(false)
    expect(mentionsName("@ hello", "   ")).toBe(false)
  })
})

describe("spokenMentionRegExp", () => {
  it("matches the name through possessives and punctuation", () => {
    expect(spokenMentionRegExp("Scout").test("What's Scout's take?")).toBe(true)
    expect(spokenMentionRegExp("Scout").test("scout?")).toBe(true)
  })

  it("matches multi-word names however STT spaces them", () => {
    const re = spokenMentionRegExp("R2-D2")
    expect(re.test("ask r2 d2 about it")).toBe(true)
    expect(re.test("ask r2d2 about it")).toBe(true)
    expect(re.test("ask r2, d2 about it")).toBe(true)
  })

  it("does not throw on regex metacharacters", () => {
    expect(spokenMentionRegExp("C++ (dev)").test("the c++ dev agent")).toBe(
      true,
    )
  })

  it("matches nothing for an all-punctuation name", () => {
    expect(spokenMentionRegExp("++").test("anything at all")).toBe(false)
    expect(spokenMentionRegExp("++").test("")).toBe(false)
  })
})

describe("chatMessageSchema / chatOpSchema", () => {
  it("accepts a plain message, with or without an editedAt", () => {
    const base = {
      id: "m1",
      from: "yashay",
      fromName: "Yashay",
      text: "hi",
      at: 1,
    }
    expect(chatMessageSchema.safeParse(base).success).toBe(true)
    expect(chatMessageSchema.safeParse({ ...base, editedAt: 2 }).success).toBe(
      true,
    )
  })

  it("accepts edit and delete ops", () => {
    expect(
      chatOpSchema.safeParse({ op: "edit", id: "m1", text: "hi!", at: 2 })
        .success,
    ).toBe(true)
    expect(
      chatOpSchema.safeParse({ op: "delete", id: "m1", at: 2 }).success,
    ).toBe(true)
  })

  it("rejects an edit with no text", () => {
    expect(
      chatOpSchema.safeParse({ op: "edit", id: "m1", at: 2 }).success,
    ).toBe(false)
  })

  it("never matches a chat op against the message schema, or vice versa", () => {
    const op = { op: "delete", id: "m1", at: 2 }
    expect(chatMessageSchema.safeParse(op).success).toBe(false)
    const message = { id: "m1", from: "a", fromName: "A", text: "hi", at: 1 }
    expect(chatOpSchema.safeParse(message).success).toBe(false)
  })
})
