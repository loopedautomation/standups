# LiveKit server + Infisical entrypoint. Built with the repo root as context.
#
# The stock image can't fetch secrets, and LIVEKIT_CONFIG's keys section is
# templated by compose from host env — which we don't want to set in
# production. Instead, store LIVEKIT_KEYS in Infisical (format
# "<api-key>: <api-secret>"); livekit-server reads that env var and it takes
# precedence over the keys in LIVEKIT_CONFIG.
FROM alpine:3 AS infisical
ARG TARGETARCH
ARG INFISICAL_VERSION=0.43.100
RUN apk add --no-cache curl tar \
 && curl -fsSL "https://github.com/Infisical/cli/releases/download/v${INFISICAL_VERSION}/cli_${INFISICAL_VERSION}_linux_${TARGETARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin infisical \
 && infisical --version

# v1.9+ required: livekit-client 2.20 (protocol 17) can't complete publisher
# negotiation against v1.8 (protocol 15) — every client hits "negotiation
# timed out" ~15s after connecting and reconnect-loops forever.
FROM livekit/livekit-server:v1.9
COPY --from=infisical /usr/local/bin/infisical /usr/local/bin/infisical
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["/livekit-server"]
