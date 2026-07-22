import { serve } from "@hono/node-server"
import { AgentServer, initializeLogger, ServerOptions } from "@livekit/agents"
import {
  AGENT_VOICES,
  type AgentVoice,
  GEMINI_VOICES,
  OPENAI_TTS_VOICES,
  emptySharedDoc,
  mergeSharedDoc,
  type SharedDoc,
  sharedDocSchema,
} from "@meet/shared"
import { Hono } from "hono"
import { AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk"
import {
  type DynamicAgentSpec,
  normalizeAgentUrl,
  probeAgent,
  registerDynamicAgent,
} from "./dynamic.js"
import { loadRegistry } from "./registry.js"
import { acceptTranscriberRequest } from "./transcriber-worker.js"
import { acceptRequest } from "./worker.js"

const PORT = Number(process.env.PORT ?? 8090)
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN
const LIVEKIT_URL = process.env.LIVEKIT_URL ?? "ws://localhost:7880"
const httpUrl = LIVEKIT_URL.replace(/^ws/, "http")

if (!BRIDGE_TOKEN) {
  console.error("BRIDGE_TOKEN is required")
  process.exit(1)
}

initializeLogger({ pretty: false, level: process.env.LOG_LEVEL ?? "info" })

const dispatch = new AgentDispatchClient(httpUrl)
const rooms = new RoomServiceClient(httpUrl)

const app = new Hono()

app.get("/health", (c) => c.json({ ok: true }))

app.use("*", async (c, next) => {
  if (c.req.path === "/health") return next()
  const auth = c.req.header("authorization")
  if (auth !== `Bearer ${BRIDGE_TOKEN}`) {
    return c.json({ error: "unauthorized" }, 401)
  }
  return next()
})

app.get("/agents", (c) => {
  const agents = loadRegistry().map(
    ({ id, name, description, avatar, realtime, tts }) => ({
      id,
      name,
      description,
      avatar,
      // Enough config for the invite UI to offer the right voice list per
      // interaction mode, without shipping the whole registry entry.
      realtimeProvider: realtime?.provider,
      ttsProvider: tts.provider,
    }),
  )
  return c.json({ agents })
})

app.post("/rooms/:room/agents/:id", async (c) => {
  const { room, id } = c.req.param()
  const entry = loadRegistry().find((a) => a.id === id)
  if (!entry) return c.json({ error: "unknown agent" }, 404)
  // Optional per-invite overrides (interaction mode and voice); the worker
  // applies them when resolving the dispatch.
  const body = (await c.req.json().catch(() => ({}))) as {
    mode?: string
    voice?: string
  }
  if (
    body.mode &&
    body.mode !== "realtime" &&
    body.mode !== "gemini" &&
    body.mode !== "pipeline"
  ) {
    return c.json({ error: "unknown mode" }, 400)
  }
  // Gemini Live cannot be gated; refused here so the invite fails visibly
  // instead of the dispatched job dying where no one sees it.
  if (body.mode === "gemini" && entry.turn_policy !== "open") {
    return c.json(
      { error: "this agent's turn policy needs the openai realtime provider" },
      400,
    )
  }
  // Which list applies depends on the resolved mode and provider, so the
  // check here is membership in any namespace — the UI offers the right one.
  if (
    body.voice &&
    !(
      (AGENT_VOICES as readonly string[]).includes(body.voice) ||
      (GEMINI_VOICES as readonly string[]).includes(body.voice) ||
      (OPENAI_TTS_VOICES as readonly string[]).includes(body.voice)
    )
  ) {
    return c.json({ error: "unknown voice" }, 400)
  }

  const participants = await rooms.listParticipants(room).catch(() => [])
  if (participants.some((p) => p.identity === `agent-${id}`)) {
    return c.json({ ok: true, already: true })
  }

  await dispatch.createDispatch(room, "looped-bridge", {
    metadata: JSON.stringify({
      agentId: id,
      mode: body.mode,
      voice: body.voice,
    }),
  })
  return c.json({ ok: true })
})

// Ad-hoc invite: paste any looped agent's TTY URL (+ token) and it joins the
// room — no agent-registry.yaml registration. The spec lives in the bridge's memory
// for the room's lifetime; dispatch metadata carries only the generated id.
app.post("/rooms/:room/agents", async (c) => {
  const { room } = c.req.param()
  let body: { url?: string; token?: string; name?: string; voice?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "invalid body" }, 400)
  }
  if (!body.url) return c.json({ error: "url required" }, 400)
  if (body.voice && !AGENT_VOICES.includes(body.voice as AgentVoice)) {
    return c.json({ error: "unknown voice" }, 400)
  }
  const url = normalizeAgentUrl(body.url)
  if (!url) return c.json({ error: "invalid url" }, 400)

  const probe = await probeAgent(url, body.token ?? "")
  if ("error" in probe) return c.json({ error: probe.error }, 422)

  const spec: DynamicAgentSpec = {
    url,
    token: body.token ?? "",
    // The agent names itself in its hello frame; a pasted name still wins if
    // one is given, but the UI no longer asks for one.
    name: body.name?.trim() || probe.name,
    ...(probe.description ? { description: probe.description } : {}),
    voice: body.voice,
  }
  const id = registerDynamicAgent(spec)
  await dispatch.createDispatch(room, "looped-bridge", {
    metadata: JSON.stringify({ agentId: id }),
  })
  return c.json({
    ok: true,
    id,
    name: spec.name,
    description: spec.description,
  })
})

// ---- transcript store ------------------------------------------------------
// Every room's finalized utterances, posted by the transcriber worker and
// read back by agent workers on join so agents get meeting context. Memory
// only: capped per room and dropped once a room has been quiet for a day.
type TranscriptSegment = { at: number; speaker: string; text: string }
const MAX_SEGMENTS_PER_ROOM = 2000
const TRANSCRIPT_TTL_MS = 24 * 60 * 60 * 1000
const transcripts = new Map<
  string,
  { updatedAt: number; segments: TranscriptSegment[] }
>()

setInterval(
  () => {
    const cutoff = Date.now() - TRANSCRIPT_TTL_MS
    for (const [room, entry] of transcripts) {
      if (entry.updatedAt < cutoff) transcripts.delete(room)
    }
  },
  60 * 60 * 1000,
).unref()

app.post("/internal/rooms/:room/transcript", async (c) => {
  const { room } = c.req.param()
  let segment: TranscriptSegment
  try {
    const body = (await c.req.json()) as Partial<TranscriptSegment>
    if (typeof body.speaker !== "string" || typeof body.text !== "string") {
      return c.json({ error: "invalid segment" }, 400)
    }
    segment = {
      at: body.at ?? Date.now(),
      speaker: body.speaker,
      text: body.text,
    }
  } catch {
    return c.json({ error: "invalid body" }, 400)
  }
  let entry = transcripts.get(room)
  if (!entry) {
    entry = { updatedAt: 0, segments: [] }
    transcripts.set(room, entry)
  }
  entry.updatedAt = Date.now()
  entry.segments.push(segment)
  if (entry.segments.length > MAX_SEGMENTS_PER_ROOM) {
    entry.segments.splice(0, entry.segments.length - MAX_SEGMENTS_PER_ROOM)
  }
  return c.json({ ok: true })
})

app.get("/internal/rooms/:room/transcript", (c) => {
  const { room } = c.req.param()
  return c.json({ segments: transcripts.get(room)?.segments ?? [] })
})

// ---- shared doc store ------------------------------------------------------
// The meeting's markdown document. Data messages only reach people already
// in the room, so the document also lives here: a late joiner, a refresh, or
// an agent that wants to read what was planned all fetch it from one place.
// Memory only, like the transcript, and dropped on the same schedule.
const MAX_DOC_BYTES = 256 * 1024
const docs = new Map<string, { updatedAt: number; doc: SharedDoc }>()

setInterval(
  () => {
    const cutoff = Date.now() - TRANSCRIPT_TTL_MS
    for (const [room, entry] of docs) {
      if (entry.updatedAt < cutoff) docs.delete(room)
    }
  },
  60 * 60 * 1000,
).unref()

app.get("/rooms/:room/doc", (c) => {
  const { room } = c.req.param()
  return c.json({ doc: docs.get(room)?.doc ?? emptySharedDoc })
})

app.put("/rooms/:room/doc", async (c) => {
  const { room } = c.req.param()
  const parsed = sharedDocSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid doc" }, 400)
  if (Buffer.byteLength(parsed.data.text) > MAX_DOC_BYTES) {
    return c.json({ error: "document too large" }, 413)
  }
  // Merged, not overwritten: two clients can PUT concurrently, and the store
  // has to land on the same winner every peer's local merge did.
  const current = docs.get(room)?.doc ?? emptySharedDoc
  const doc = mergeSharedDoc(current, parsed.data)
  docs.set(room, { updatedAt: Date.now(), doc })
  return c.json({ doc })
})

// ---- debug access ----------------------------------------------------------
// First-class observability for anyone holding the BRIDGE_TOKEN (a person
// with curl, or Claude debugging a deployment): live room state and a
// per-room ring buffer of bridge events, without shelling into the box.
type DebugEvent = {
  at: number
  source: string
  level: "info" | "error"
  message: string
}
const MAX_DEBUG_EVENTS_PER_ROOM = 500
const debugEvents = new Map<
  string,
  { updatedAt: number; events: DebugEvent[] }
>()

setInterval(
  () => {
    const cutoff = Date.now() - TRANSCRIPT_TTL_MS
    for (const [room, entry] of debugEvents) {
      if (entry.updatedAt < cutoff) debugEvents.delete(room)
    }
  },
  60 * 60 * 1000,
).unref()

app.post("/internal/rooms/:room/debug", async (c) => {
  const { room } = c.req.param()
  let event: DebugEvent
  try {
    const body = (await c.req.json()) as Partial<DebugEvent>
    if (typeof body.source !== "string" || typeof body.message !== "string") {
      return c.json({ error: "invalid event" }, 400)
    }
    event = {
      at: body.at ?? Date.now(),
      source: body.source,
      level: body.level === "error" ? "error" : "info",
      message: body.message,
    }
  } catch {
    return c.json({ error: "invalid body" }, 400)
  }
  let entry = debugEvents.get(room)
  if (!entry) {
    entry = { updatedAt: 0, events: [] }
    debugEvents.set(room, entry)
  }
  entry.updatedAt = Date.now()
  entry.events.push(event)
  if (entry.events.length > MAX_DEBUG_EVENTS_PER_ROOM) {
    entry.events.splice(0, entry.events.length - MAX_DEBUG_EVENTS_PER_ROOM)
  }
  return c.json({ ok: true })
})

app.get("/debug/rooms", async (c) => {
  const list = await rooms.listRooms().catch(() => [])
  return c.json({
    rooms: list.map((r) => ({
      name: r.name,
      numParticipants: r.numParticipants,
      createdAt: Number(r.creationTime) * 1000,
    })),
  })
})

app.get("/debug/rooms/:room", async (c) => {
  const { room } = c.req.param()
  const participants = await rooms.listParticipants(room).catch(() => [])
  return c.json({
    room,
    participants: participants.map((p) => ({
      identity: p.identity,
      name: p.name,
      metadata: p.metadata,
      attributes: p.attributes,
      joinedAt: Number(p.joinedAt) * 1000,
    })),
    transcript: transcripts.get(room)?.segments ?? [],
    events: debugEvents.get(room)?.events ?? [],
  })
})

app.delete("/rooms/:room/agents/:id", async (c) => {
  const { room, id } = c.req.param()
  await rooms.removeParticipant(room, `agent-${id}`).catch(() => undefined)
  return c.json({ ok: true })
})

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`agent-bridge control API on :${info.port}`)
})

// The LiveKit Agents worker: hosts the voice pipeline for dispatched agents.
const server = new AgentServer(
  new ServerOptions({
    agent: new URL("./worker.js", import.meta.url).pathname,
    agentName: "looped-bridge",
    // One idle process is plenty for a small deployment; each prewarmed
    // process holds the VAD model in memory.
    numIdleProcesses: 1,
    requestFunc: acceptRequest,
    wsURL: LIVEKIT_URL,
    apiKey: process.env.LIVEKIT_API_KEY,
    apiSecret: process.env.LIVEKIT_API_SECRET,
    // The agents SDK exposes its own status server; keep it off the control port.
    port: Number(process.env.WORKER_HTTP_PORT ?? 8091),
    production: true,
  }),
)

server.run().catch((err) => {
  console.error("agent worker failed", err)
  process.exit(1)
})

// The platform transcriber: no agentName means automatic dispatch — it joins
// every room and live-transcribes all human mics with a local model.
if (process.env.TRANSCRIBER_ENABLED !== "false") {
  const transcriber = new AgentServer(
    new ServerOptions({
      agent: new URL("./transcriber-worker.js", import.meta.url).pathname,
      requestFunc: acceptTranscriberRequest,
      // No warm spare: a prewarmed process that idles for hours can end up
      // with stale rtc-node FFI state ("handle not found" on connect), which
      // silently kills transcription for the room it's dispatched to. A cold
      // start costs a few seconds of transcript at the top of a meeting and
      // saves ~1 GB of idle memory.
      numIdleProcesses: 0,
      wsURL: LIVEKIT_URL,
      apiKey: process.env.LIVEKIT_API_KEY,
      apiSecret: process.env.LIVEKIT_API_SECRET,
      port: Number(process.env.TRANSCRIBER_HTTP_PORT ?? 8092),
      production: true,
    }),
  )
  transcriber.run().catch((err) => {
    console.error("transcriber worker failed", err)
    // transcription is best-effort; the bridge keeps running without it
  })
}
