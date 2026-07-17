FROM node:22-alpine AS base
RUN corepack enable pnpm

# Infisical CLI — lets the entrypoint pull secrets at container start (see
# docker-entrypoint.sh). Pinned static Go binary from GitHub releases, so it
# runs on Alpine/musl and any TARGETARCH.
FROM alpine:3 AS infisical
ARG TARGETARCH
ARG INFISICAL_VERSION=0.43.100
RUN apk add --no-cache curl tar \
 && curl -fsSL "https://github.com/Infisical/cli/releases/download/v${INFISICAL_VERSION}/cli_${INFISICAL_VERSION}_linux_${TARGETARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin infisical \
 && infisical --version

FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile=false --filter @meet/web... --filter .

FROM base AS builder
WORKDIR /repo
COPY --from=deps /repo ./
COPY packages/shared packages/shared
COPY apps/web apps/web
# LIVEKIT_PUBLIC_URL is only read server-side at runtime (the token API
# returns it as serverUrl) — nothing is inlined into the client bundle, so the
# image needs no build-time env and is fully generic.
RUN cd apps/web && pnpm build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /repo/apps/web/public ./apps/web/public
COPY --from=infisical /usr/local/bin/infisical /usr/local/bin/infisical
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
# The entrypoint wraps the command with `infisical run` when credentials are
# present, so secrets are fetched fresh at start (no baked .env).
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "apps/web/server.js"]
