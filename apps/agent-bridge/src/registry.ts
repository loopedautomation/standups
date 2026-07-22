import { readFileSync } from "node:fs"
import { parse } from "yaml"
import { z } from "zod"

const brainSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tty"),
    url: z.string(),
    token_env: z.string(),
  }),
  z.object({
    kind: z.literal("webhook"),
    url: z.string(),
    token_env: z.string(),
  }),
])

const agentEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  description: z.string().optional(),
  avatar: z.string().optional(),
  greeting: z.string().optional(),
  brain: brainSchema,
  // "open": the agent replies whenever it hears a turn (default).
  // "on-mention": the agent only speaks when addressed by name; otherwise it
  // raises its hand and waits for someone to call on it. For realtime
  // agents this is a hard gate — auto-response is off and audio can only be
  // triggered by a name mention or a call-on.
  // "open": speaks whenever it has something to say. "on-mention": speaks
  // only when addressed by name or called on, silent otherwise.
  // "raise-hand": like on-mention, but raises a hand when it has something,
  // so a host can call on it.
  turn_policy: z.enum(["open", "on-mention", "raise-hand"]).default("open"),
  // When present, the agent runs on a realtime speech-to-speech model (the
  // interaction layer) that delegates tool work to the brain — no STT/TTS
  // pipeline. stt/tts below are ignored for realtime agents.
  // provider "gemini" runs on Google's Live API (needs GEMINI_API_KEY or
  // GOOGLE_API_KEY, and a Gemini voice name like Puck or Kore). Gemini has
  // no deterministic turn gate, so it only supports turn_policy "open".
  realtime: z
    .object({
      provider: z.enum(["openai", "gemini"]).default("openai"),
      model: z.string().optional(),
      voice: z.string().optional(),
    })
    .transform((rt) => ({
      provider: rt.provider,
      // Model and voice namespaces differ per provider, so their defaults
      // have to resolve after the provider is known.
      model:
        rt.model ??
        (rt.provider === "gemini"
          ? "gemini-2.5-flash-native-audio-preview-12-2025"
          : "gpt-realtime-mini"),
      voice: rt.voice ?? (rt.provider === "gemini" ? "Puck" : "marin"),
    }))
    .optional(),
  stt: z
    .object({
      provider: z.enum(["openai"]).default("openai"),
      model: z.string().default("gpt-4o-mini-transcribe"),
    })
    .default({ provider: "openai", model: "gpt-4o-mini-transcribe" }),
  tts: z
    .object({
      // For elevenlabs, `voice` is the ElevenLabs voice id and `model` an
      // ElevenLabs model (e.g. eleven_turbo_v2_5). Needs ELEVENLABS_API_KEY.
      provider: z.enum(["openai", "elevenlabs"]).default("openai"),
      model: z.string().default("gpt-4o-mini-tts"),
      voice: z.string().default("alloy"),
    })
    .default({ provider: "openai", model: "gpt-4o-mini-tts", voice: "alloy" }),
})

const registrySchema = z.object({
  agents: z.array(agentEntrySchema),
})

export type AgentEntry = z.infer<typeof agentEntrySchema>

export function loadRegistry(
  path = process.env.AGENTS_CONFIG ?? "agent-registry.yaml",
): AgentEntry[] {
  const raw = parse(readFileSync(path, "utf8"))
  return registrySchema.parse(raw).agents
}

export function brainToken(entry: AgentEntry): string {
  const token = process.env[entry.brain.token_env]
  if (!token) {
    throw new Error(
      `Agent "${entry.id}": env var ${entry.brain.token_env} is not set`,
    )
  }
  return token
}
