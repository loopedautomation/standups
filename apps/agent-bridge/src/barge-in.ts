/**
 * Barge-in: a human talking over a speaking agent should cut it off, the way
 * it would cut off a person. The realtime path can't lean on the model's own
 * server-side VAD for this — while the agent speaks, room audio is withheld
 * from the session (see the half-duplex note in `realtime-agent.ts`), so the
 * model never hears the interruption and never fires `speech_started`.
 *
 * So the bridge detects it locally: silero VAD runs over the room mix even
 * while the agent talks, and this module decides whether what it heard is a
 * real interruption or something to ignore.
 */

/** Tuning for local barge-in detection. */
export type BargeInConfig = {
  /** Off means the agent can only be interrupted by the manual control. */
  enabled: boolean
  /**
   * Sustained speech required before it counts. Coughs, "mm-hmm" and a chair
   * scraping shouldn't kill a considered answer; a sentence should.
   */
  minSpeechMs: number
  /**
   * Quiet window after the agent starts speaking. The human's own last words
   * are often still draining out of the mix when the reply begins, and an
   * agent cut off in its first syllable reads as broken rather than polite.
   */
  graceMs: number
  /** Floor between successive cuts, so one noisy room can't machine-gun them. */
  cooldownMs: number
  /**
   * How much of the interrupting speech to replay into the session once the
   * agent has been cut off. Withheld audio is dropped, so without this the
   * model never hears the first words of "actually, stop — I meant Tuesday".
   */
  prefixMs: number
}

export const defaultBargeInConfig: BargeInConfig = {
  enabled: true,
  minSpeechMs: 400,
  graceMs: 1000,
  cooldownMs: 1500,
  prefixMs: 1500,
}

function num(raw: string | undefined, fallback: number): number {
  // `FOO=` reads as unset, not as zero — Number("") is 0, which would
  // silently disable a threshold the operator only meant to leave alone.
  const trimmed = raw?.trim()
  if (!trimmed) return fallback
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * Reads the `AGENT_BARGE_IN*` env vars. Barge-in is on by default; the
 * escape hatch matters for rooms on open speakers, where participants' mics
 * re-capture the agent's own voice. Browsers cancel most of that echo, but
 * a deployment that hears the agent interrupting itself wants
 * `AGENT_BARGE_IN=off` rather than a rebuild.
 */
export function bargeInConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BargeInConfig {
  const flag = env.AGENT_BARGE_IN?.trim().toLowerCase()
  return {
    enabled: flag !== "off" && flag !== "false" && flag !== "0",
    minSpeechMs: num(env.AGENT_BARGE_IN_MIN_SPEECH_MS, 400),
    graceMs: num(env.AGENT_BARGE_IN_GRACE_MS, 1000),
    cooldownMs: num(env.AGENT_BARGE_IN_COOLDOWN_MS, 1500),
    prefixMs: num(env.AGENT_BARGE_IN_PREFIX_MS, 1500),
  }
}

/**
 * Tracks when the agent is audible and rules on whether detected speech
 * should cut it off. Kept free of LiveKit and VAD types so the policy is
 * testable on its own — the caller supplies the clock and the speech
 * duration that VAD measured.
 */
export class BargeInPolicy {
  #config: BargeInConfig
  #speakingSince: number | null = null
  #lastCutAt = Number.NEGATIVE_INFINITY

  constructor(config: BargeInConfig = defaultBargeInConfig) {
    this.#config = config
  }

  get enabled(): boolean {
    return this.#config.enabled
  }

  /** Meeting-time switch (the "set-barge-in" control); thresholds stay. */
  setEnabled(on: boolean): void {
    this.#config = { ...this.#config, enabled: on }
  }

  /** True while the agent is audible — the only window a cut can happen in. */
  get speaking(): boolean {
    return this.#speakingSince !== null
  }

  /** Idempotent: re-reporting an ongoing speech doesn't restart the grace. */
  agentStartedSpeaking(now: number): void {
    if (this.#speakingSince === null) this.#speakingSince = now
  }

  agentStoppedSpeaking(): void {
    this.#speakingSince = null
  }

  /**
   * Rules on a stretch of speech VAD has been hearing for `speechMs`.
   * Returns true exactly once per cut: the caller is expected to act on it,
   * so the cooldown starts here.
   */
  shouldInterrupt(now: number, speechMs: number): boolean {
    const { enabled, minSpeechMs, graceMs, cooldownMs } = this.#config
    if (!enabled) return false
    const since = this.#speakingSince
    if (since === null) return false
    if (speechMs < minSpeechMs) return false
    if (now - since < graceMs) return false
    if (now - this.#lastCutAt < cooldownMs) return false
    this.#lastCutAt = now
    this.#speakingSince = null
    return true
  }
}

/**
 * Fixed-capacity PCM ring holding the most recent samples. Feeds the
 * interrupting speech back to the model after a cut — see `prefixMs`.
 */
export class PcmRingBuffer {
  readonly #capacity: number
  readonly #buffer: Int16Array
  #length = 0
  #start = 0

  constructor(capacitySamples: number) {
    this.#capacity = Math.max(0, Math.floor(capacitySamples))
    this.#buffer = new Int16Array(this.#capacity)
  }

  get length(): number {
    return this.#length
  }

  push(samples: Int16Array): void {
    if (this.#capacity === 0) return
    // A push larger than the ring can only leave its own tail behind.
    if (samples.length >= this.#capacity) {
      this.#buffer.set(samples.subarray(samples.length - this.#capacity))
      this.#start = 0
      this.#length = this.#capacity
      return
    }
    for (const sample of samples) {
      this.#buffer[(this.#start + this.#length) % this.#capacity] = sample
      if (this.#length < this.#capacity) this.#length++
      else this.#start = (this.#start + 1) % this.#capacity
    }
  }

  /** Returns the buffered samples oldest-first and empties the ring. */
  drain(): Int16Array {
    const out = new Int16Array(this.#length)
    for (let i = 0; i < this.#length; i++) {
      out[i] = this.#buffer[(this.#start + i) % this.#capacity] as number
    }
    this.clear()
    return out
  }

  clear(): void {
    this.#length = 0
    this.#start = 0
  }
}
