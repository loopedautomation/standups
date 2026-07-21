import { describe, expect, it } from "vitest"
import {
  type AgentControl,
  agentControlSchema,
  defaultRoomSettings,
  describeAgentControl,
  emptySharedDoc,
  mergeSharedDoc,
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

  it("covers every control type, so a new one can't ship unannounced", () => {
    for (const type of agentControlSchema.shape.type.options) {
      const control: AgentControl = {
        type,
        agentId: "scout",
        ...(type === "set-turn-policy" ? { policy: "open" as const } : {}),
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
