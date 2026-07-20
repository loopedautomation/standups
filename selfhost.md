# Self-hosting Looped Meet

Operational notes for running Meet beyond `docker compose up` on localhost.
See the [README](./README.md) for the quick start.

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

- WebRTC media does NOT go through the proxy: expose `7881/tcp` and `7882/udp` directly on the host.
- **Set `"userland-proxy": false` in `/etc/docker/daemon.json`** (then restart Docker) on any host running the LiveKit container. With the default userland proxy, Docker's proxy process occupies the published UDP media port, server-initiated ICE traffic gets source-NAT'd to random ports, and calls degrade into reconnect loops and garbled audio. This applies host-wide, so plan the Docker restart around other workloads:

  ```json
  { "userland-proxy": false }
  ```
- **Set `LIVEKIT_NODE_IP` to the host's public IP** on the deploy host (e.g. Coolify's env tab). It pins the address LiveKit advertises in ICE candidates — the single easiest thing to forget when migrating servers, and media silently fails without it.
- All LiveKit config is templated from `.env` inside the compose file — there is no separate LiveKit yaml.
- Images are prebuilt by GitHub Actions (`.github/workflows/publish-images.yaml`) and pulled from GHCR — the deploy host never builds. If the GHCR packages are private, give the host registry credentials (e.g. Coolify's registry settings).
- On Coolify: add the repo as a Docker Compose resource, attach the two domains to the `web` and `livekit` services, and set the env vars in the resource's environment tab.

## Networking notes (beyond localhost)

- **WebRTC needs UDP.** Expose ports `7880` (ws), `7881/tcp` and `7882/udp` on your host, and set `LIVEKIT_USE_EXTERNAL_IP=true` (with `LIVEKIT_NODE_IP` empty) in `.env`. If a port clashes with something on your machine, change it in `docker-compose.yaml` (both the port mapping and the templated LiveKit config).
- **Set `LIVEKIT_PUBLIC_URL`** to your public LiveKit URL (`wss://…` behind TLS). It's read server-side at runtime — set it in `.env` (or Infisical `/apps/web`); no rebuild needed when it changes.
- **Restrictive NATs / corporate firewalls** may need TURN. LiveKit ships an embedded TURN server — see the [LiveKit self-hosting guide](https://docs.livekit.io/home/self-hosting/) for the `turn:` config block and TLS certificates.
- **Scaling**: a single node comfortably handles dozens of concurrent video participants. For multi-node LiveKit you'll need Redis — out of scope here.
- Alternatively, point the app at **LiveKit Cloud** (set `LIVEKIT_URL`/`LIVEKIT_PUBLIC_URL` and keys) and skip hosting the SFU entirely; you still self-host the web app, bridge, and agents.

## Secrets via Infisical

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

## In-browser transcription (optional)

Participants' browsers can transcribe their own mics locally (sherpa-onnx
WASM), offloading the server transcriber. The official WASM bundles are
pthread builds, so the web app serves COOP/COEP headers (cross-origin
isolation) — fine for this self-contained app, but note it if you embed
cross-origin resources. To enable, install the WASM ASR
bundle into `apps/web/public/stt/`:

```bash
STT_WASM_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-wasm-simd-v1.13.4-en-asr-zipformer.tar.bz2 \
  apps/web/scripts/fetch-stt-model.sh
```

Without the bundle nothing changes — clients probe `/stt/`, find nothing, and
the server transcribes everyone. A client advertises the `stt.local`
participant attribute only once its engine is running; the bridge pauses
server STT for that mic and resumes it the instant the attribute clears
(engine crash, stall, tab throttling). Client-published finals are mirrored
into the transcript store by the bridge, so agent meeting context is
unaffected. Users can opt out per-device via `localStorage.localStt = "false"`.

## Debugging a running deployment

The agent-bridge control API exposes debug endpoints (authenticated with
`BRIDGE_TOKEN`) so a person — or an AI assistant — can inspect a live meeting
without shelling into the box:

```sh
# List active rooms
curl -H "Authorization: Bearer $BRIDGE_TOKEN" http://localhost:8090/debug/rooms

# Everything about one room: participants (metadata + agent states), the
# transcript so far, and a ring buffer of bridge events (agent joins,
# realtime/transcriber errors)
curl -H "Authorization: Bearer $BRIDGE_TOKEN" http://localhost:8090/debug/rooms/<room>
```

The compose file publishes the control port (8090) on the host; in production
reach it from the box itself or over an SSH tunnel. Container logs remain the
deepest source: `docker compose logs -f agent-bridge livekit`.
