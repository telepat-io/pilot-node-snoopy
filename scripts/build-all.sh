#!/usr/bin/env bash
#
# build-all.sh — full build from a CLEAN CLONE of the io.telepat.snoopy node.
#
# This repo is self-contained: it carries the upstream Go-build Dockerfiles
# (docker/{pilot,libpilot,pilotctl}.Dockerfile + upstream-pins.txt + patches/),
# so a fresh `git clone` can build everything with no sibling checkouts.
#
#   git clone <repo> && cd <repo>
#   scripts/build-all.sh
#   docker compose -f compose.smoke.yaml up -d
#   scripts/smoke.sh
#
# Nothing here RUNS any Pilot service on the host — every Go/Node build happens
# inside a Dockerfile; the only host actions are `docker build`, `docker cp`, and
# pure-crypto `pilotctl` subcommands in throwaway, network-less containers.
#
# Steps 1-2 (the heavy Go builds) are SKIPPED when their artifacts already exist,
# so re-runs are fast. Set FORCE_BASE_BUILD=1 to rebuild them.
#
#   1. pilot-protocol/pilot:dev   daemon(no_skillinject)+pilotctl+wallet+rendezvous
#                                 (+node)  — docker/pilot.Dockerfile. MULTI-MINUTE
#                                 the first time (clones + compiles upstream Go).
#   2. build/libpilot.so          sdk-node FFI native lib (CGO c-shared,
#                                 no_skillinject) — docker/libpilot.Dockerfile.
#                                 MULTI-MINUTE the first time.
#   3. wrapper + runtime images + signed bundle — delegates to scripts/build.sh
#                                 (fast: Node typecheck + tsup + sign).
#
# PINS: docker/{pilot,libpilot,pilotctl}.Dockerfile share PILOT_REF and the org
# sibling SHAs in docker/upstream-pins.txt. Keep them in lockstep on a bump.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"
export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-0}"

PILOT_IMAGE="${PILOT_IMAGE:-pilot-protocol/pilot:dev}"
LIBPILOT_IMAGE="${LIBPILOT_IMAGE:-pilot-protocol/libpilot:dev}"
FORCE="${FORCE_BASE_BUILD:-0}"

log() { printf '\033[1;32m[build-all]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[build-all] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found on PATH"

# ── 1. pilot:dev (Go binaries, no_skillinject) ───────────────────────────────
if [ "${FORCE}" = "1" ] || ! docker image inspect "${PILOT_IMAGE}" >/dev/null 2>&1; then
  log "1/3 building ${PILOT_IMAGE} (Go daemon+pilotctl+wallet+rendezvous, no_skillinject)"
  log "    NOTE: first build clones + compiles upstream Go — expect several minutes."
  mkdir -p /tmp/pp-emptyctx
  docker build -f docker/pilot.Dockerfile -t "${PILOT_IMAGE}" /tmp/pp-emptyctx
else
  log "1/3 ${PILOT_IMAGE} present — skipping (set FORCE_BASE_BUILD=1 to rebuild)"
fi

# ── 2. build/libpilot.so (CGO c-shared, no_skillinject) ──────────────────────
# Build context is the repo root so docker/patches + docker/upstream-pins.txt are
# reachable (cite: docker/libpilot.Dockerfile header).
if [ "${FORCE}" = "1" ] || [ ! -f "${ROOT}/build/libpilot.so" ]; then
  log "2/3 building libpilot.so (CGO c-shared, no_skillinject) — first build is several minutes"
  docker build -f docker/libpilot.Dockerfile -t "${LIBPILOT_IMAGE}" .
  mkdir -p "${ROOT}/build"
  LCID="$(docker create "${LIBPILOT_IMAGE}")"
  trap 'docker rm -f "${LCID}" >/dev/null 2>&1 || true' EXIT
  docker cp "${LCID}:/libpilot.so" "${ROOT}/build/libpilot.so"
  docker rm -f "${LCID}" >/dev/null 2>&1 || true
  trap - EXIT
else
  log "2/3 build/libpilot.so present — skipping (set FORCE_BASE_BUILD=1 to rebuild)"
fi
log "    -> build/libpilot.so ($(stat -c%s "${ROOT}/build/libpilot.so" 2>/dev/null || echo ?) bytes)"

# ── 3. node images + signed bundle ───────────────────────────────────────────
log "3/3 wrapper + runtime images + signed bundle (scripts/build.sh)"
bash "${ROOT}/scripts/build.sh"

log "DONE. Next:"
log "  docker compose -f compose.smoke.yaml up -d"
log "  scripts/smoke.sh"
