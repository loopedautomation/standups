import type { ChatMessage } from "@meet/shared"
import { beforeEach, describe, expect, it } from "vitest"
import {
  $chatMessages,
  $typingAgents,
  addChatMessage,
  pruneTypingAgents,
  removeChatMessage,
  setAgentTyping,
  updateChatMessage,
} from "./roomData"

const msg = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  from: "yashay",
  fromName: "Yashay",
  text: "hi",
  at: 1,
  ...overrides,
})

beforeEach(() => {
  $chatMessages.set([])
})

describe("updateChatMessage", () => {
  it("edits the text and stamps editedAt when the author matches", () => {
    addChatMessage(msg())
    updateChatMessage("m1", "yashay", "hi there", 2)
    expect($chatMessages.get()).toEqual([
      msg({ text: "hi there", editedAt: 2 }),
    ])
  })

  it("refuses to edit someone else's message", () => {
    addChatMessage(msg())
    updateChatMessage("m1", "someone-else", "hijacked", 2)
    expect($chatMessages.get()).toEqual([msg()])
  })

  it("is a no-op for a message that no longer exists (e.g. already deleted)", () => {
    updateChatMessage("missing", "yashay", "text", 2)
    expect($chatMessages.get()).toEqual([])
  })

  it("drops a stale edit that arrives behind a newer one", () => {
    addChatMessage(msg())
    updateChatMessage("m1", "yashay", "second edit", 5)
    updateChatMessage("m1", "yashay", "late first edit", 3)
    expect($chatMessages.get()).toEqual([
      msg({ text: "second edit", editedAt: 5 }),
    ])
  })
})

describe("removeChatMessage", () => {
  it("deletes the message when the author matches", () => {
    addChatMessage(msg())
    removeChatMessage("m1", "yashay")
    expect($chatMessages.get()).toEqual([])
  })

  it("refuses to delete someone else's message", () => {
    addChatMessage(msg())
    removeChatMessage("m1", "someone-else")
    expect($chatMessages.get()).toEqual([msg()])
  })

  it("is a no-op for an id that isn't present", () => {
    removeChatMessage("missing", "yashay")
    expect($chatMessages.get()).toEqual([])
  })
})

describe("typing indicators", () => {
  beforeEach(() => {
    $typingAgents.set({})
  })

  it("tracks typers by identity — humans and agents alike", () => {
    setAgentTyping("agent-scout", "Scout", true, Date.now())
    setAgentTyping("user-abc", "Ratul", true, Date.now())
    expect(Object.keys($typingAgents.get()).sort()).toEqual([
      "agent-scout",
      "user-abc",
    ])
  })

  it("clears a typer when their stopped signal arrives", () => {
    setAgentTyping("user-abc", "Ratul", true, Date.now())
    setAgentTyping("user-abc", "Ratul", false, Date.now())
    expect($typingAgents.get()).toEqual({})
  })

  it("a heartbeat refreshes the timestamp, keeping the indicator alive", () => {
    const early = Date.now() - 60_000
    setAgentTyping("user-abc", "Ratul", true, early)
    setAgentTyping("user-abc", "Ratul", true, Date.now())
    pruneTypingAgents(10_000)
    expect($typingAgents.get()["user-abc"]).toBeDefined()
  })

  it("prunes a stuck indicator whose stopped signal was dropped", () => {
    setAgentTyping("user-abc", "Ratul", true, Date.now() - 60_000)
    setAgentTyping("agent-scout", "Scout", true, Date.now())
    pruneTypingAgents(10_000)
    expect(Object.keys($typingAgents.get())).toEqual(["agent-scout"])
  })
})
