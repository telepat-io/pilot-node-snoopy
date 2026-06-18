#!/usr/bin/env bash
#
# smoke.sh — ZERO-LLM end-to-end check for the io.telepat.snoopy node.
#
# Drives the full path: caller -> overlay:1001 -> wrapper -> stdio MCP ->
# `snoopy mcp` -> reply, using only zero-LLM ops (op:"jobs", op:"leads"). It does
# NOT run op:"qualify" (that costs an LLM call — left for the operator who holds
# the OpenRouter key).
#
# Prereq: scripts/build.sh, then `docker compose -f compose.smoke.yaml up -d`.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"; cd "${ROOT}"
PROJECT="${COMPOSE_PROJECT:-snoopy-smoke}"
NET="${PROJECT}_pilot-net"
CALLER_RUN_VOL="${PROJECT}_caller-run"
WRAPPER_IMAGE="${WRAPPER_IMAGE:-pilot-protocol/snoopy-wrapper:dev}"
export COMPOSE_FILE="${COMPOSE_FILE:-compose.smoke.yaml}"
log() { printf '\033[1;36m[smoke]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[smoke:FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

[ -f build/libpilot.so ] || die "build/libpilot.so missing — run scripts/build.sh first"

log "waiting for provider app readiness (its app.sock == ready)"
st=none
for _ in $(seq 1 40); do
  st="$(docker inspect -f '{{.State.Health.Status}}' "${PROJECT}-provider-daemon-1" 2>/dev/null || echo none)"
  [ "${st}" = healthy ] && break
  sleep 2
done
[ "${st}" = healthy ] || die "provider-daemon not healthy (status=${st}); check 'docker compose -f ${COMPOSE_FILE} logs provider-daemon'"

# Confirm the wrapper spawned `snoopy mcp` and completed the MCP handshake.
if docker compose logs provider-daemon 2>&1 | grep -q 'snoopy mcp connected'; then
  log "MCP initialize handshake confirmed in provider logs"
else
  log "WARN: did not see 'snoopy mcp connected' in logs (continuing)"
fi

PADDR="$(docker compose logs provider-daemon 2>&1 | grep -oE 'addr=0:[0-9.A-F]+' | tail -1 | cut -d= -f2)"
[ -n "${PADDR}" ] || die "could not determine provider overlay address from logs"
log "provider overlay address: ${PADDR}"

drive() { # $1 = request json
  docker run --rm --network "${NET}" \
    -v "${CALLER_RUN_VOL}:/caller-run" \
    -v "${ROOT}/build/libpilot.so:/opt/libpilot.so:ro" \
    -v "${ROOT}/scripts:/app/scripts:ro" \
    -e PILOT_LIB_PATH=/opt/libpilot.so \
    --entrypoint node -w /app \
    "${WRAPPER_IMAGE}" \
    /app/scripts/dx-client.mjs --socket /caller-run/pilot.sock --target "${PADDR}" --json "$1"
}

log 'caller -> provider:1001  {"op":"jobs"}'
JOBS="$(drive '{"op":"jobs"}')"
echo "reply: ${JOBS}"
echo "${JOBS}" | grep -q '"op":"jobs"' || die "no jobs op in reply"
echo "${JOBS}" | grep -q '"ok":true'   || die "jobs reply not ok"

log 'caller -> provider:1001  {"op":"leads"}'
LEADS="$(drive '{"op":"leads"}')"
echo "reply: ${LEADS}"
echo "${LEADS}" | grep -q '"op":"leads"' || die "no leads op in reply"
echo "${LEADS}" | grep -q '"ok":true'    || die "leads reply not ok"

log "PASS ✅  zero-LLM round-trips succeeded (jobs + leads) over the overlay"
