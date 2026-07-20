import { randomBytes } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"

// Ad-hoc agents invited by URL (no agent-registry.yaml entry). Specs are persisted to
// a file rather than process memory because the control API (index.ts) and
// the LiveKit job processes (worker.ts) are separate processes in the same
// container — dispatch metadata carries only the generated id, never the
// token.
//
// NOTE: the bridge dials whatever URL is pasted, from inside the deployment
// network. Fine for a single-tenant self-hosted deployment; a multi-tenant
// deployment needs an allowlist / deny-internal-ranges policy here (tracked
// in issue #6).

const FILE = process.env.DYNAMIC_AGENTS_FILE ?? "/tmp/dynamic-agents.json"
const MAX_AGE_MS = 24 * 60 * 60 * 1000

export { AGENT_VOICES } from "@meet/shared"

export type DynamicAgentSpec = {
  url: string
  token: string
  name: string
  voice?: string
}

type Stored = DynamicAgentSpec & { at: number }

function load(): Record<string, Stored> {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"))
  } catch {
    return {}
  }
}

export function registerDynamicAgent(spec: DynamicAgentSpec): string {
  const id = `dyn-${randomBytes(4).toString("hex")}`
  const all = load()
  const now = Date.now()
  for (const [key, value] of Object.entries(all)) {
    if (now - value.at > MAX_AGE_MS) delete all[key]
  }
  all[id] = { ...spec, at: now }
  writeFileSync(FILE, JSON.stringify(all), { mode: 0o600 })
  return id
}

export function getDynamicAgent(id: string): DynamicAgentSpec | null {
  return load()[id] ?? null
}

/**
 * Turn whatever a person pastes into a dialable TTY websocket URL, or null
 * if it can't be one. Bare domains get wss:// and the conventional /tty
 * path; http(s) schemes are mapped to their websocket equivalents.
 */
export function normalizeAgentUrl(input: string): string | null {
  let raw = input.trim()
  if (!raw) return null
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `wss://${raw}`
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol === "https:") parsed.protocol = "wss:"
  if (parsed.protocol === "http:") parsed.protocol = "ws:"
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null
  if (parsed.pathname === "" || parsed.pathname === "/") {
    parsed.pathname = "/tty"
  }
  return parsed.toString()
}

/**
 * Validate a pasted agent URL by performing the TTY handshake: connect with
 * the bearer subprotocol and wait for the `hello` frame, which carries the
 * agent's handle.
 */
export async function probeAgent(
  url: string,
  token: string,
): Promise<{ name: string } | { error: string }> {
  return new Promise((resolve) => {
    let settled = false
    const done = (result: { name: string } | { error: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      resolve(result)
    }
    const timer = setTimeout(
      () => done({ error: "agent did not respond (timeout)" }),
      5000,
    )
    let ws: WebSocket
    try {
      ws = new WebSocket(url, token ? [`bearer.${token}`] : [])
    } catch (err) {
      clearTimeout(timer)
      return resolve({ error: (err as Error).message })
    }
    ws.onmessage = (raw) => {
      try {
        const frame = JSON.parse(String(raw.data)) as {
          type?: string
          handle?: string
        }
        if (frame.type === "hello") {
          done({ name: frame.handle || "Agent" })
        }
      } catch {}
    }
    ws.onerror = () =>
      done({ error: "could not connect (check url and token)" })
    ws.onclose = (ev) =>
      done({
        error:
          ev.code === 1008 || ev.code === 4401
            ? "agent rejected the token"
            : "connection closed before handshake",
      })
  })
}
