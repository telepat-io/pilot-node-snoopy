#
# snoopy-runtime.Dockerfile — the PROVIDER-DAEMON image for the io.telepat.snoopy
# node.
#
# Snoopy's MCP server is STDIO-only (`snoopy mcp`), so the MCP child must live in
# the SAME container as the wrapper that drives it. We therefore bake the Snoopy
# CLI into the provider image (the image that runs the pilot-daemon + app-store
# supervisor). The supervisor spawns our wrapper bundle (bin/main.js), and the
# wrapper spawns `snoopy mcp` as a stdio child — same container, same user, same
# SNOOPY_ROOT_DIR.
#
#   base: pilot-protocol/pilot:dev  (daemon[no_skillinject] + pilotctl + wallet +
#                                    rendezvous, on node:22-bookworm-slim, USER pilot)
#   adds: @telepat/snoopy@<pin> installed globally (-> /usr/local/bin/snoopy)
#
# Native deps:
#   - better-sqlite3 (Snoopy's DB) ships prebuilt binaries for node22-linux-x64,
#     so no compiler is needed; `snoopy --version` loads it at the end as a build
#     assertion. If a future Snoopy bump lacks a prebuilt, add build-essential +
#     python3 before the install.
#   - keytar (OS keyring) is optional: we do NOT install libsecret. At runtime
#     `require('keytar')` fails to load and Snoopy gracefully falls back to env
#     secrets (TELEPAT_OPENROUTER_KEY) — which is exactly how this node is wired.
#
# Build:  docker build -f docker/snoopy-runtime.Dockerfile -t snoopy-runtime .

FROM pilot-protocol/pilot:dev

ARG SNOOPY_VERSION=0.1.18

# Global install must run as root (writes /usr/local/lib/node_modules).
USER root
RUN npm install -g --no-audit --no-fund "@telepat/snoopy@${SNOOPY_VERSION}" \
 && snoopy --version

# Pre-create the app-store state dir OWNED BY pilot so that a fresh named volume
# mounted at /home/pilot/.pilot inherits pilot ownership (Docker copies the image
# dir's uid/gid/mode into an empty volume). Without this the volume is created
# root:root and the non-root daemon cannot write apps/ or identity.json.
RUN mkdir -p /home/pilot/.pilot /home/pilot/run \
 && chown -R pilot:pilot /home/pilot/.pilot /home/pilot/run

# Back to the non-root container-local user the daemon runs as.
USER pilot
WORKDIR /home/pilot

# ENTRYPOINT/CMD supplied by compose (provider-entrypoint.sh).
