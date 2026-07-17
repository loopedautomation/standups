# Looped Meet

Open-source, self-hostable video meetings with **first-class AI agent participants**, powered by [LiveKit](https://livekit.io) and the [Looped agent framework](https://github.com/loopedautomation/agent-framework).

Share a link, talk face to face — and invite an agent into the room. It listens to the conversation, speaks its answers, can be interrupted mid-sentence, and streams its tool calls (web lookups, code, APIs) into the meeting as it works.

## Features

- **Google-Meet-style rooms** — create a room, share `/r/{slug}`, join with a display name. No accounts, no IdP.
- **Agents as participants** — invite a looped-af agent from the agents panel; it joins with its own tile, live state (listening / thinking / speaking), and voice.
- **Tool activity feed** — watch the agent's tool calls stream in real time while it works.
- **Agent mute** — mute an agent from its tile; it knows it's muted and replies into the chat instead of speaking. Unmute and it talks again.
- **Screenshare vision** — share your screen and the agent sees it: every question it answers comes with a current frame of the share.
- **Live transcript & chat** — built-in transcription panel and chat with `@AgentName` mentions.
- **Screen sharing**, speaking indicators, light/dark looped theming (DaisyUI — easy to whitelabel).

## Architecture

```
browser ── web (Next.js: rooms, tokens, UI)
   │             │
   ▼             ▼
LiveKit SFU ◄── agent-bridge (Node: VAD, STT, TTS, turn-taking)
                     │  TTY WebSocket
                     ▼
               looped-af agent (your agent.yaml, unchanged)
```

The bridge hosts the voice pipeline ([LiveKit Agents](https://docs.livekit.io/agents/)); the *thinking* happens in a stock looped-af agent over its TTY trigger — same tools, permissions, memory, and audit trail as everywhere else the agent runs.

## Quick start (self-host)

Requirements: Docker + Docker Compose.

```sh
git clone <this repo> && cd meet
cp .env.example .env
# edit .env:
#  - set LIVEKIT_API_SECRET (any 32+ char string)
#  - set BRIDGE_TOKEN and SCOUT_TTY_TOKEN to random strings
#  - set OPENAI_API_KEY   (speech-to-text / text-to-speech for agent voices)
#  - set ANTHROPIC_API_KEY (the demo agent's model)
docker compose up          # pulls prebuilt images from GHCR
# or build everything from source:
docker compose -f docker-compose.yaml -f docker-compose.build.yaml up --build
```

Open http://localhost:3000, create a meeting, then open the **Agents** panel and invite **Scout**.

### Registering your own agents

Agents are declared in [`agents.yaml`](./agents.yaml). Point `brain.url` at any running looped-af agent with a [`tty` trigger](https://github.com/loopedautomation/agent-framework) (streaming + tool feed) or a `webhook` trigger (simple request/reply):

```yaml
agents:
  - id: scout
    name: Scout
    brain: { kind: tty, url: ws://demo-agent:8300/tty, token_env: SCOUT_TTY_TOKEN }
    tts: { provider: openai, model: gpt-4o-mini-tts, voice: alloy }
```

The demo agent lives in [`examples/demo-agent/agent.yaml`](./examples/demo-agent/agent.yaml) — edit its `purpose`, tools, and permissions like any looped-af agent.

## Production deploy (TLS + domains)

Bring your own TLS reverse proxy (Coolify/Traefik/Caddy/nginx — anything that fronts Docker services works). Two hostnames terminate TLS at the proxy:

| Domain | Proxies to | Purpose |
|---|---|---|
| `meet.example.com` | `web:3000` | the app |
| `lk.example.com` | `livekit:7880` (WebSocket) | LiveKit signaling |

In `.env`:

```sh
LIVEKIT_PUBLIC_URL=wss://lk.example.com
LIVEKIT_USE_EXTERNAL_IP=true
LIVEKIT_NODE_IP=            # empty — auto-detect public IP
LIVEKIT_API_SECRET=<strong secret>
```

### Secrets via Infisical

In production, secrets don't need to live on the host at all. Each image ships
an entrypoint (`docker-entrypoint.sh`) that wraps its command in
`infisical run` when Infisical machine-identity credentials are present — so
the only env vars to set on the host (e.g. Coolify's environment tab) are:

```sh
INFISICAL_CLIENT_ID=<machine identity client id>
INFISICAL_CLIENT_SECRET=<machine identity client secret>
LIVEKIT_USE_EXTERNAL_IP=true   # compose-interpolation-time, can't come from Infisical
```

`LIVEKIT_PUBLIC_URL` is read server-side at runtime (the token API hands
it to the browser as `serverUrl`), so despite the name it is NOT baked into
the web build — it lives in Infisical under `/apps/web` like any other
runtime var.

The project id, API URL, and per-service secret folder paths are defaulted in
`docker-compose.yaml`. The secret layout (documented in `.env.example`): common
secrets live in `/shared`, service-specific ones under `/apps/<service>` —
including `LIVEKIT_KEYS` (`"<key>: <secret>"`) under `/apps/livekit`, which
livekit-server reads in place of the compose-templated keys. Without Infisical
credentials the entrypoints are a no-op and everything runs off `.env` as
before.

- WebRTC media does NOT go through the proxy: expose `7881/tcp` and `7882/udp` directly on the host.
- **Set `"userland-proxy": false` in `/etc/docker/daemon.json`** (then restart Docker) on any host running the LiveKit container. With the default userland proxy, Docker's proxy process occupies the published UDP media port, server-initiated ICE traffic gets source-NAT'd to random ports, and calls degrade into reconnect loops and garbled audio. This applies host-wide, so plan the Docker restart around other workloads:

  ```json
  { "userland-proxy": false }
  ```
- **Set `LIVEKIT_NODE_IP` to the host's public IP** on the deploy host (e.g. Coolify's env tab). It pins the address LiveKit advertises in ICE candidates — the single easiest thing to forget when migrating servers, and media silently fails without it.
- All LiveKit config is templated from `.env` inside the compose file — there is no separate LiveKit yaml.
- Images are prebuilt by GitHub Actions (`.github/workflows/publish-images.yaml`) and pulled from GHCR — the deploy host never builds. If the GHCR packages are private, give the host registry credentials (e.g. Coolify's registry settings).
- On Coolify: add the repo as a Docker Compose resource, attach the two domains to the `web` and `livekit` services, and set the env vars in the resource's environment tab.

## Deploying beyond localhost

- **WebRTC needs UDP.** Expose ports `7880` (ws), `7881/tcp` and `7882/udp` on your host, and set `LIVEKIT_USE_EXTERNAL_IP=true` (with `LIVEKIT_NODE_IP` empty) in `.env`. If a port clashes with something on your machine, change it in `docker-compose.yaml` (both the port mapping and the templated LiveKit config).
- **Set `LIVEKIT_PUBLIC_URL`** to your public LiveKit URL (`wss://…` behind TLS). It's read server-side at runtime — set it in `.env` (or Infisical `/apps/web`); no rebuild needed when it changes.
- **Restrictive NATs / corporate firewalls** may need TURN. LiveKit ships an embedded TURN server — see the [LiveKit self-hosting guide](https://docs.livekit.io/home/self-hosting/) for the `turn:` config block and TLS certificates.
- **Scaling**: a single node comfortably handles dozens of concurrent video participants. For multi-node LiveKit you'll need Redis — out of scope here.
- Alternatively, point the app at **LiveKit Cloud** (set `LIVEKIT_URL`/`LIVEKIT_PUBLIC_URL` and keys) and skip hosting the SFU entirely; you still self-host the web app, bridge, and agents.

## Development

Requirements: Node 22+, pnpm 10+.

```sh
pnpm install
pnpm dev            # web on :3000 (needs LiveKit running: docker compose up livekit)
pnpm -r typecheck
pnpm test           # bridge unit tests (mock TTY server)
pnpm lint
```

Repo layout:

- `apps/web` — Next.js app (rooms, lobby, meeting UI, API routes)
- `apps/agent-bridge` — LiveKit Agents worker + control API; `src/looped-tty.ts` speaks the looped-af TTY protocol
- `packages/shared` — zod schemas for data topics, participant metadata, DTOs
- `examples/demo-agent` — the Scout demo agent

## Theming / whitelabel

The looped look lives in `apps/web/src/styles/` as DaisyUI themes (`themes.css`, OKLCH tokens). Swap the two theme blocks for your own brand colors and the whole app follows — no component changes needed.

## Roadmap

- Host controls (lock room, remove human participants)
- ~~Screenshare vision~~ — done: while anyone shares a screen, agents get a frame of it with every turn (requires agent-framework > 0.9.1 and a vision-capable model)
- OpenAI Realtime speech-to-speech mode with `ask_agent` delegation (~500ms latency)
- ElevenLabs voices

## License

MIT
