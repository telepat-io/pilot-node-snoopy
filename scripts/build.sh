#!/usr/bin/env bash
#
# build.sh — build the images + signed bundle for the io.telepat.snoopy node.
# Run this, then `docker compose -f compose.smoke.yaml up -d`, then the
# zero-LLM smoke (see README).
#
# Nothing here RUNS any Pilot service on the host — every Node build happens
# inside a Dockerfile; the only host actions are `docker build` and pure-crypto
# `pilotctl` subcommands in throwaway, network-less containers.
#
# REUSES prebuilt artifacts (does NOT rebuild the Go images): expects
#   pilot-protocol/pilot:dev            daemon(no_skillinject)+pilotctl+rendezvous (+node)
#   build/libpilot.so                   sdk-node FFI native lib
# Both are produced by scripts/build-all.sh — run that first for a clean clone.
#
# Images produced:
#   pilot-protocol/snoopy-wrapper:dev   our Node wrapper bundle (bin + node_modules)
#   pilot-protocol/snoopy-runtime:dev   provider-daemon image (pilot:dev + snoopy CLI)
# Artifacts:
#   bundles/io.telepat.snoopy/          signed, sha256-pinned app bundle (compose mounts ro)
#   secure/publisher.key                ed25519 publisher key (gitignored)
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"
export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-0}"

PILOT_IMAGE="${PILOT_IMAGE:-pilot-protocol/pilot:dev}"
WRAPPER_IMAGE="${WRAPPER_IMAGE:-pilot-protocol/snoopy-wrapper:dev}"
RUNTIME_IMAGE="${RUNTIME_IMAGE:-pilot-protocol/snoopy-runtime:dev}"
SNOOPY_VERSION="${SNOOPY_VERSION:-0.1.18}"
IDEON_LIBPILOT="${IDEON_LIBPILOT:-${ROOT}/../ideon/build/libpilot.so}"
BUNDLES="${ROOT}/bundles"
SECURE="${ROOT}/secure"
KEY="${SECURE}/publisher.key"
APP_ID="io.telepat.snoopy"

log() { printf '\033[1;32m[build]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[build] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
docker image inspect "${PILOT_IMAGE}" >/dev/null 2>&1 \
  || die "${PILOT_IMAGE} not found — run scripts/build-all.sh first (it builds the Go base image)"

# ── 0. libpilot.so (built by build-all.sh; do NOT rebuild here) ──────────────
# On a dev host with the sibling ideon node, fall back to copying its prebuilt
# .so; otherwise require scripts/build-all.sh to have produced it.
mkdir -p "${ROOT}/build"
if [ ! -f "${ROOT}/build/libpilot.so" ]; then
  [ -f "${IDEON_LIBPILOT}" ] || die "build/libpilot.so missing — run scripts/build-all.sh first (it builds libpilot.so)"
  log "0/4 copying libpilot.so from ${IDEON_LIBPILOT}"
  cp "${IDEON_LIBPILOT}" "${ROOT}/build/libpilot.so"
fi
log "    -> build/libpilot.so ($(stat -c%s "${ROOT}/build/libpilot.so" 2>/dev/null || echo ?) bytes)"

# ── 1. wrapper image (typecheck + tsup bundle) ───────────────────────────────
log "1/4 wrapper image ${WRAPPER_IMAGE}"
docker build -f docker/wrapper.Dockerfile -t "${WRAPPER_IMAGE}" .

# ── 2. provider-daemon runtime image (pilot:dev + snoopy CLI) ────────────────
log "2/4 runtime image ${RUNTIME_IMAGE} (FROM ${PILOT_IMAGE} + @telepat/snoopy@${SNOOPY_VERSION})"
mkdir -p /tmp/pp-emptyctx
docker build -f docker/snoopy-runtime.Dockerfile \
  --build-arg "SNOOPY_VERSION=${SNOOPY_VERSION}" \
  -t "${RUNTIME_IMAGE}" /tmp/pp-emptyctx

# ── 3. assemble the bundle from the wrapper image ────────────────────────────
log "3/4 assembling bundle -> bundles/${APP_ID}"
rm -rf "${BUNDLES:?}/${APP_ID:?}"; mkdir -p "${BUNDLES}/${APP_ID}" "${SECURE}"
chmod 700 "${SECURE}" || true
ACID="$(docker create "${WRAPPER_IMAGE}")"; trap 'docker rm -f "${ACID}" >/dev/null 2>&1 || true' EXIT
docker cp "${ACID}:/app/." "${BUNDLES}/${APP_ID}/"
docker rm -f "${ACID}" >/dev/null 2>&1 || true; trap - EXIT
chmod +x "${BUNDLES}/${APP_ID}/bin/main.js"

# ── 4. pin sha256 + sign + verify ────────────────────────────────────────────
# pilotctl in a throwaway, network-less container that mounts the project.
pctl() { docker run --rm --network none --user "$(id -u):$(id -g)" -e HOME=/tmp -v "${ROOT}:${ROOT}" -w "${ROOT}" --entrypoint pilotctl "${PILOT_IMAGE}" "$@"; }

[ -f "${KEY}" ] || { log "gen publisher key"; pctl appstore gen-key "${KEY}"; }

mf="${BUNDLES}/${APP_ID}/manifest.json"
binrel="$(grep -oE '"path"[[:space:]]*:[[:space:]]*"[^"]+"' "${mf}" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
sha="$(sha256sum "${BUNDLES}/${APP_ID}/${binrel}" | awk '{print $1}')"
log "4/4 pin ${binrel} sha256=${sha:0:16}… ; sign + verify"
sed -i -E "s/(\"sha256\"[[:space:]]*:[[:space:]]*\")[0-9a-fA-F]{64}(\")/\1${sha}\2/" "${mf}"
pctl appstore sign --key "${KEY}" "${mf}"
pctl appstore verify "${BUNDLES}/${APP_ID}"

log "DONE. bundle signed under ${BUNDLES}/${APP_ID}. Next (zero-LLM smoke):"
log "  docker compose -f compose.smoke.yaml up -d --build"
log "  # then drive the caller (see README 'Smoke test')"
