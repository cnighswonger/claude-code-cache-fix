# claude-code-cache-fix proxy — minimal container.
#
# Runs the proxy server on port 9801 (override with -e CACHE_FIX_PROXY_PORT=...).
# Forwards to api.anthropic.com by default (override with -e CACHE_FIX_PROXY_UPSTREAM=...).
#
# Usage:
#   docker run -d -p 9801:9801 --name cache-fix-proxy \
#     ghcr.io/cnighswonger/claude-code-cache-fix:latest
#
# Then set ANTHROPIC_BASE_URL=http://127.0.0.1:9801 in the shell that runs claude.

FROM node:22-alpine

# curl is needed for the HEALTHCHECK directive below (Alpine doesn't ship it).
RUN apk add --no-cache curl

WORKDIR /app

# Copy package manifests first so npm install is cached separately from source.
COPY package.json package-lock.json* ./

# We only need the runtime dependency (hpagent) for the proxy. --omit=dev keeps
# the image small. --no-audit / --no-fund silences npm noise. --ignore-scripts
# skips the postinstall.js wrapper-install that's irrelevant in a container.
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts

# Copy only the files the proxy needs at runtime.
COPY proxy/ ./proxy/

# Run as a non-root user. node:22-alpine ships a `node` user by uid 1000.
RUN chown -R node:node /app
USER node

# Default port; override with `-e CACHE_FIX_PROXY_PORT=...`.
ENV CACHE_FIX_PROXY_PORT=9801

# Bind to all interfaces by default in container land — the publishing layer
# (-p 9801:9801) is what gates external exposure. The default 127.0.0.1 bind
# would make the proxy unreachable from the host through -p.
ENV CACHE_FIX_PROXY_BIND=0.0.0.0

EXPOSE 9801

# HEALTHCHECK runs every 30s; the proxy's /health endpoint returns ok JSON
# when the server is listening and extension pipeline is loaded.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -fs "http://127.0.0.1:${CACHE_FIX_PROXY_PORT}/health" || exit 1

CMD ["node", "proxy/server.mjs"]
