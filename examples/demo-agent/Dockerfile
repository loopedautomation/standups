# Built with the repo root as context (see docker-compose.yaml) so it can
# copy the shared Infisical entrypoint.
FROM alpine:3 AS infisical
ARG TARGETARCH
ARG INFISICAL_VERSION=0.43.100
RUN apk add --no-cache curl tar \
 && curl -fsSL "https://github.com/Infisical/cli/releases/download/v${INFISICAL_VERSION}/cli_${INFISICAL_VERSION}_linux_${TARGETARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin infisical \
 && infisical --version

# Bakes the agent config into the image — file bind mounts break on hosts
# (e.g. Coolify) that pre-create mount sources as directories.
FROM ghcr.io/loopedautomation/agent:latest
COPY examples/demo-agent/agent.yaml /agent/agent.yaml
# Meet's first-party skills, referenced by agent.yaml relative to itself.
COPY skills /agent/skills
COPY --from=infisical /usr/local/bin/infisical /usr/local/bin/infisical
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Wraps the base image's launch command with `infisical run` when credentials
# are present. CMD mirrors the base image's ENTRYPOINT + CMD exactly — if the
# base image's launch command changes, update this to match
# (docker image inspect ghcr.io/loopedautomation/agent:latest).
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["deno", "run", "--allow-env", "--allow-read=/agent,/skills,/data,/looped,/deno-dir,/run/secrets", "--allow-write=/data", "--allow-net", "--allow-run=bash,deno", "packages/cli/main.ts", "run", "/agent/agent.yaml"]
