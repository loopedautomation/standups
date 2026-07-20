<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme-cover.png">
  <img alt="Looped Meet" src=".github/readme-cover-light.png" width="100%">
</picture>

<div align="center">

# Looped Meet<br/><sub><b>Dial your agent into your next call.</b></sub><br/><br/>[![CI](https://github.com/loopedautomation/meet/actions/workflows/ci.yaml/badge.svg)](https://github.com/loopedautomation/meet/actions/workflows/ci.yaml) [![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE) [![Powered by looped-af](https://img.shields.io/badge/powered%20by-looped--af-8b5cf6)](https://github.com/loopedautomation/agent-framework)

</div>

Self-hostable video meetings with first-class AI agent participants. Share a link, talk face to face — and invite an agent into the room. It listens to the conversation, speaks its answers, can be interrupted mid-sentence, and streams its tool calls (web lookups, code, APIs) into the meeting as it works. Open source, powered by [LiveKit](https://livekit.io) and the [Looped agent framework](https://github.com/loopedautomation/agent-framework).

**Contents:** [Features](#features) · [Architecture](#architecture) · [Quick start](#quick-start) · [Your own agents](#registering-your-own-agents) · [Self-hosting](./selfhost.md) · [Development](#development) · [Theming](#theming--whitelabel) · [Roadmap](#roadmap)

## Features

- **Google-Meet-style rooms** — create a room, share `/r/{slug}`, join with a display name. No accounts, no IdP.
- **Agents as participants** — invite any [looped-af](https://github.com/loopedautomation/agent-framework) agent from the agents panel, unchanged; it joins with its own tile, live state (listening / thinking / speaking), and voice.
- **Realtime speech-to-speech agents** — optionally run an agent on a realtime voice model (~500ms responses) that delegates tool work to the looped agent brain in the background.
- **Turn policies** — per-agent etiquette a host can change mid-call: speak freely (`open`), only when addressed (`on-mention`), or raise a hand and wait to be called on (`raise-hand`). Zap an agent to wake it up for a while.
- **Tool activity feed** — watch the agent's tool calls stream in real time while it works.
- **Interrupt & mute** — tap to cut an agent off mid-sentence; mute it and it knows, replying into the chat instead of speaking until unmuted.
- **Screenshare vision** — share your screen and the agent sees it: every question it answers comes with a current frame of the share.
- **Live transcript & chat** — built-in transcription panel (server-side, or in-browser via WASM) and chat with `@AgentName` mentions.
- **Voices** — OpenAI or ElevenLabs TTS per agent; light/dark looped theming (DaisyUI — easy to whitelabel).

## Architecture

```mermaid
flowchart TB
    browser["browser"] --> web["web<br/>(Next.js: rooms, tokens, UI)"]
    browser --> sfu["LiveKit SFU"]
    web --> sfu
    bridge["agent-bridge<br/>(Node: VAD, STT, TTS, turn-taking)"] --> sfu
    bridge -- "TTY WebSocket" --> agent["looped-af agent<br/>(your agent.yaml, unchanged)"]
```

**Bring any looped agent-framework agent.** The bridge hosts the voice pipeline ([LiveKit Agents](https://docs.livekit.io/agents/)); the *thinking* happens in a stock [looped-af](https://github.com/loopedautomation/agent-framework) agent over its TTY trigger. No meeting-specific code in the agent: any agent you already run — with its tools, permissions, memory, and audit trail intact — joins a meeting as-is by pasting its TTY URL and token into the agents panel (or add it to the registry for a permanent roster). Realtime agents swap the STT/TTS pipeline for a speech-to-speech model that delegates tool work to the same brain.

## Quick start

Requirements: Docker + Docker Compose.

```sh
git clone git@github.com:loopedautomation/meet.git && cd meet
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

Deploying for real (TLS, domains, WebRTC ports, secrets, debugging a live
deployment)? See **[selfhost.md](./selfhost.md)**.

### Registering your own agents

The quickest way to bring your own agent is no registration at all: in the meeting's **Agents** panel, paste the agent's TTY URL and token and it joins on the spot. For a permanent roster, declare agents in [`agent-registry.yaml`](./agent-registry.yaml). Point `brain.url` at any running looped-af agent with a [`tty` trigger](https://github.com/loopedautomation/agent-framework) — the recommended kind: streaming, tool feed, and task cancellation. (A `webhook` trigger also works for simple request/reply.)

```yaml
agents:
  - id: scout
    name: Scout
    brain: { kind: tty, url: ws://demo-agent:8300/tty, token_env: SCOUT_TTY_TOKEN }
    tts: { provider: openai, model: gpt-4o-mini-tts, voice: alloy }
```

The demo agent lives in [`examples/demo-agent/agent.yaml`](./examples/demo-agent/agent.yaml) — edit its `purpose`, tools, and permissions like any looped-af agent.

## Built on the Looped agent framework

Everything the agents do in a meeting — tools, memory, permissions, audit
trail — comes from **[loopedautomation/agent-framework](https://github.com/loopedautomation/agent-framework)** (looped-af). Meet is just another
surface for the same agent: the one you invite into a room is the same
`agent.yaml` you can run in a terminal, on a schedule, over email, Slack, or
Discord. Define an agent once and it works everywhere, meetings included.

If Meet interests you, start there — ⭐ the framework repo and build your
first agent; inviting it to a meeting is just pasting its TTY URL and token.

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
- Server-side cancel frame in the TTY protocol — today, aborting a task detaches it ([agent-framework#153](https://github.com/loopedautomation/agent-framework/issues/153))
- Multi-node LiveKit (Redis) deployment story

## License

[Apache 2.0](./LICENSE)
