import { serve } from "@hono/node-server"
import { AgentServer, initializeLogger, ServerOptions } from "@livekit/agents"
import { AGENT_VOICES, type AgentVoice } from "@meet/shared"
import { Hono } from "hono"
import { AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk"
import {
  type DynamicAgentSpec,
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
  const agents = loadRegistry().map(({ id, name, description, avatar }) => ({
    id,
    name,
    description,
    avatar,
  }))
  return c.json({ agents })
})

app.post("/rooms/:room/agents/:id", async (c) => {
  const { room, id } = c.req.param()
  const entry = loadRegistry().find((a) => a.id === id)
  if (!entry) return c.json({ error: "unknown agent" }, 404)

  const participants = await rooms.listParticipants(room).catch(() => [])
  if (participants.some((p) => p.identity === `agent-${id}`)) {
    return c.json({ ok: true, already: true })
  }

  await dispatch.createDispatch(room, "looped-bridge", {
    metadata: JSON.stringify({ agentId: id }),
  })
  return c.json({ ok: true })
})

// Ad-hoc invite: paste any looped agent's TTY URL (+ token) and it joins the
// room — no agents.yaml registration. The spec lives in the bridge's memory
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

  const probe = await probeAgent(body.url, body.token ?? "")
  if ("error" in probe) return c.json({ error: probe.error }, 422)

  const spec: DynamicAgentSpec = {
    url: body.url,
    token: body.token ?? "",
    name: body.name?.trim() || probe.name,
    voice: body.voice,
  }
  const id = registerDynamicAgent(spec)
  await dispatch.createDispatch(room, "looped-bridge", {
    metadata: JSON.stringify({ agentId: id }),
  })
  return c.json({ ok: true, id, name: spec.name })
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
      // Transcriber processes are heavy (streaming ASR models); keep a
      // single warm spare. The finalizer loads lazily per active room.
      numIdleProcesses: 1,
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
