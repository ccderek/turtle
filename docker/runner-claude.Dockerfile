# syntax=docker/dockerfile:1
# turtle runner image: Claude Agent SDK + turtle-runner (docs/phase0-spec.md §11).
# Built by `pnpm docker:build`, which stages the runner into docker/.stage first.
# The SDK ships Claude Code as a native binary (with its own ripgrep), so no apt
# packages are needed. Projects that need a toolchain extend this image and set
# sandbox.image in turtle.config.json.
FROM node:24-bookworm-slim

ARG HTTPS_PROXY
ARG NO_PROXY

COPY .stage/protocol /opt/turtle/protocol
COPY .stage/runner /opt/turtle/runner
# An optional extra CA (build secret "extra_ca") supports TLS-inspecting proxies.
RUN --mount=type=secret,id=extra_ca,required=false \
    cd /opt/turtle/runner \
 && if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && npm install --omit=dev --no-audit --no-fund \
 && chmod +x dist/main.js \
 && ln -s /opt/turtle/runner/dist/main.js /usr/local/bin/turtle-runner

# Runs as the host user (docker run --user uid:gid); HOME is set to a writable path.
ENV HOME=/tmp/home
WORKDIR /workspace
CMD ["turtle-runner"]
