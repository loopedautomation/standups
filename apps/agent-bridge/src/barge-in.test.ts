import { describe, expect, it } from "vitest"
import {
  BargeInPolicy,
  bargeInConfigFromEnv,
  defaultBargeInConfig,
  PcmRingBuffer,
} from "./barge-in.js"

const config = { ...defaultBargeInConfig }

/** Speaking since t=0, so `now` doubles as "ms into the agent's reply". */
function speaking(overrides: Partial<typeof config> = {}) {
  const policy = new BargeInPolicy({ ...config, ...overrides })
  policy.agentStartedSpeaking(0)
  return policy
}

describe("bargeInConfigFromEnv", () => {
  it("defaults to enabled with the documented thresholds", () => {
    expect(bargeInConfigFromEnv({})).toEqual(defaultBargeInConfig)
  })

  it("treats off/false/0 as disabled, case-insensitively", () => {
    for (const value of ["off", "OFF", "false", "0", " off "]) {
      expect(bargeInConfigFromEnv({ AGENT_BARGE_IN: value }).enabled).toBe(
        false,
      )
    }
  })

  it("leaves barge-in on for any other value", () => {
    for (const value of ["on", "true", "1", ""]) {
      expect(bargeInConfigFromEnv({ AGENT_BARGE_IN: value }).enabled).toBe(true)
    }
  })

  it("reads numeric overrides", () => {
    expect(
      bargeInConfigFromEnv({
        AGENT_BARGE_IN_MIN_SPEECH_MS: "250",
        AGENT_BARGE_IN_GRACE_MS: "0",
        AGENT_BARGE_IN_COOLDOWN_MS: "800",
        AGENT_BARGE_IN_PREFIX_MS: "2000",
      }),
    ).toMatchObject({
      minSpeechMs: 250,
      graceMs: 0,
      cooldownMs: 800,
      prefixMs: 2000,
    })
  })

  it("falls back when an override is not a usable number", () => {
    for (const value of ["", "abc", "-1", "NaN"]) {
      expect(
        bargeInConfigFromEnv({ AGENT_BARGE_IN_MIN_SPEECH_MS: value })
          .minSpeechMs,
      ).toBe(defaultBargeInConfig.minSpeechMs)
    }
  })
})

describe("BargeInPolicy", () => {
  it("does not interrupt an agent that isn't speaking", () => {
    const policy = new BargeInPolicy(config)
    expect(policy.shouldInterrupt(5000, 5000)).toBe(false)
  })

  it("ignores speech shorter than the sustained threshold", () => {
    const policy = speaking()
    expect(policy.shouldInterrupt(3000, config.minSpeechMs - 1)).toBe(false)
    expect(policy.shouldInterrupt(3000, config.minSpeechMs)).toBe(true)
  })

  it("holds fire during the grace window after speech starts", () => {
    const policy = speaking()
    expect(policy.shouldInterrupt(config.graceMs - 1, 5000)).toBe(false)
    expect(policy.shouldInterrupt(config.graceMs, 5000)).toBe(true)
  })

  it("stops speaking once it has fired, so one cut yields one interrupt", () => {
    const policy = speaking()
    expect(policy.shouldInterrupt(3000, 5000)).toBe(true)
    expect(policy.speaking).toBe(false)
    expect(policy.shouldInterrupt(3001, 5000)).toBe(false)
  })

  it("enforces the cooldown across a new stretch of agent speech", () => {
    const policy = speaking()
    expect(policy.shouldInterrupt(3000, 5000)).toBe(true)

    // The agent starts a fresh reply and is talked over again immediately.
    policy.agentStartedSpeaking(3100)
    const tooSoon = 3100 + config.graceMs
    expect(tooSoon - 3000).toBeLessThan(config.cooldownMs)
    expect(policy.shouldInterrupt(tooSoon, 5000)).toBe(false)

    // Past the cooldown it fires again.
    expect(policy.shouldInterrupt(3000 + config.cooldownMs, 5000)).toBe(true)
  })

  it("restarts the grace window per reply, not per detection", () => {
    const policy = speaking()
    policy.agentStartedSpeaking(500) // still the same reply — ignored
    expect(policy.shouldInterrupt(config.graceMs, 5000)).toBe(true)
  })

  it("never interrupts when disabled", () => {
    const policy = speaking({ enabled: false })
    expect(policy.enabled).toBe(false)
    expect(policy.shouldInterrupt(60_000, 60_000)).toBe(false)
  })
})

describe("PcmRingBuffer", () => {
  it("drains what it was given, oldest first", () => {
    const ring = new PcmRingBuffer(8)
    ring.push(Int16Array.from([1, 2, 3]))
    expect(Array.from(ring.drain())).toEqual([1, 2, 3])
    expect(ring.length).toBe(0)
  })

  it("keeps only the most recent samples once full", () => {
    const ring = new PcmRingBuffer(4)
    ring.push(Int16Array.from([1, 2, 3]))
    ring.push(Int16Array.from([4, 5, 6]))
    expect(Array.from(ring.drain())).toEqual([3, 4, 5, 6])
  })

  it("keeps the tail of a push larger than the ring", () => {
    const ring = new PcmRingBuffer(3)
    ring.push(Int16Array.from([1, 2, 3, 4, 5]))
    expect(Array.from(ring.drain())).toEqual([3, 4, 5])
  })

  it("survives repeated wraparound", () => {
    const ring = new PcmRingBuffer(3)
    for (let i = 1; i <= 10; i++) ring.push(Int16Array.from([i]))
    expect(Array.from(ring.drain())).toEqual([8, 9, 10])
  })

  it("drains empty after a clear", () => {
    const ring = new PcmRingBuffer(4)
    ring.push(Int16Array.from([1, 2]))
    ring.clear()
    expect(Array.from(ring.drain())).toEqual([])
  })

  it("is inert at zero capacity", () => {
    const ring = new PcmRingBuffer(0)
    ring.push(Int16Array.from([1, 2, 3]))
    expect(Array.from(ring.drain())).toEqual([])
  })
})
