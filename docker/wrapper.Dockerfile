#
# wrapper.Dockerfile — builds the io.telepat.snoopy Node app bundle.
#
# WHAT THIS PRODUCES
#   A self-contained app directory at /app containing:
#     /app/bin/main.js               the bundled wrapper entrypoint (tsup ESM)
#     /app/bin/pilotServerWorker.js  the blocking-IO worker thread
#     /app/node_modules              RUNTIME deps only (pilotprotocol FFI +
#                                    @modelcontextprotocol/sdk)
#     /app/manifest.json             the app-store manifest
#     /app/package.json              (kept; declares "type":"module")
#
# The app binary is NOT run as its own service. The Pilot app-store supervisor
# execs it as a CHILD PROCESS inside the provider-daemon container:
#   node /app/bin/main.js --addr ... --db ... --socket ... \
#                         --identity ... --manifest ... --cap-state ...
# So this image's job is to BUILD a clean /app tree that the provider-daemon
# (snoopy-runtime) image carries via the signed bundle.
#
# NB: unlike Ideon, the Snoopy MCP server is a STDIO child co-located in the
# provider-daemon image (`npm install -g @telepat/snoopy`); it is NOT part of
# this bundle. This bundle only needs the wrapper + its two runtime deps.
#
# Build context MUST be the repo root (so `app/` is reachable):
#   docker build -f docker/wrapper.Dockerfile -t snoopy-wrapper .
#

# ── Stage 1: build — install ALL deps, typecheck, bundle with tsup ───────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Copy manifests first for layer-cached dependency install.
COPY app/package.json app/package-lock.json app/tsconfig.json app/tsup.config.ts ./

# Full install (incl. devDeps: typescript, tsup, tsx, @types/node) via `npm ci`
# against the committed lockfile so the dependency tree (and the release tarball
# sha) is reproducible. pilotprotocol ships a prebuilt FFI binding; the MCP SDK
# is pure JS — no native toolchain required.
RUN npm ci --no-audit --no-fund

# Bring in the TypeScript sources and the manifest.
COPY app/src ./src
COPY app/manifest.json ./manifest.json

# Typecheck then bundle src/main.ts -> bin/main.js (ESM, node20).
RUN npm run typecheck \
 && npm run build \
 && test -f bin/main.js \
 && test -f bin/pilotServerWorker.js

# ── Stage 2: prune — runtime-only node_modules for a slim, portable bundle ───
FROM node:22-bookworm-slim AS prune
WORKDIR /app
COPY app/package.json ./package.json
COPY app/package-lock.json ./package-lock.json
RUN npm ci --omit=dev --no-audit --no-fund

# ── Stage 3: bundle — the artifact the provider-daemon bundle is assembled from ─
FROM node:22-bookworm-slim AS bundle
WORKDIR /app

COPY --from=build  /app/bin            ./bin
COPY --from=build  /app/manifest.json  ./manifest.json
COPY --from=build  /app/package.json   ./package.json
COPY --from=prune  /app/node_modules   ./node_modules

LABEL org.telepat.snoopy.bundle="/app" \
      org.telepat.snoopy.entrypoint="/app/bin/main.js" \
      org.telepat.snoopy.integration="copy /app into the signed bundle; supervisor execs 'node /app/bin/main.js'"

CMD ["node", "-e", "console.error('io.telepat.snoopy bundle: not a standalone service. The app-store supervisor execs `node /app/bin/main.js`. See docker/wrapper.Dockerfile header.'); process.exit(1)"]
