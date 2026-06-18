#!/usr/bin/env bash
#
# provider-entrypoint.sh — bring up the io.telepat.snoopy provider node inside
# its container.
#
# Why we COPY the bundle into the install root (instead of `pilotctl appstore
# install`): the install path copies ONLY manifest.json + the single binary at
# binary.path, which DROPS our Node app's node_modules + worker file. So we place
# the FULL, already-signed bundle dir into the writable install root ourselves;
# the always-on supervisor SCANS that root, verifies the manifest signature +
# binary sha256, and supervises the app. The app dir must be WRITABLE (named
# volume, not a read-only bind) because the supervisor writes app.sock /
# identity.json / cap-state.jsonl into it.
#
# Unlike the paid Ideon node, this FREE node has NO wallet sidecar — a single
# app bundle. The daemon runs -no-dataexchange so the wrapper owns overlay :1001.
#
# Model/temperature/maxTokens/topP are seeded into Snoopy's SQLite settings by
# the WRAPPER at startup (via the MCP snoopy_settings_set tool) — Snoopy has no
# native env override and its `settings` CLI is interactive-only. This entrypoint
# only ensures SNOOPY_ROOT_DIR exists and passes the env through to the daemon,
# which the supervisor forwards to the app, which forwards it to `snoopy mcp`.
set -euo pipefail

HOME_DIR="${HOME:-/home/pilot}"
APPS_DIR="${HOME_DIR}/.pilot/apps"
SOCK="${PILOT_SOCKET:-/run/pilot/pilot.sock}"
RUN_DIR="$(dirname "${SOCK}")"
REGISTRY="${RENDEZVOUS_REGISTRY:-rendezvous:9000}"
BEACON="${RENDEZVOUS_BEACON:-rendezvous:9001}"
HOSTN="${HOSTNAME_PILOT:-snoopy-provider}"
IDENTITY="${IDENTITY_PATH:-${HOME_DIR}/.pilot/identity.json}"
LOGLEVEL="${LOG_LEVEL:-debug}"
APP_BUNDLE="${APP_BUNDLE:-/bundles/io.telepat.snoopy}"
SNOOPY_ROOT_DIR="${SNOOPY_ROOT_DIR:-${HOME_DIR}/.snoopy}"
export SNOOPY_ROOT_DIR

log() { printf '\033[1;36m[provider-entrypoint]\033[0m %s\n' "$*" >&2; }

mkdir -p "${APPS_DIR}" "${RUN_DIR}" "$(dirname "${IDENTITY}")" "${SNOOPY_ROOT_DIR}"
[ -S "${SOCK}" ] && rm -f "${SOCK}" || true

# Install the signed bundle into the writable install root. By default install
# ONLY if not already provisioned, preserving the app's runtime state (identity,
# cap-state) across restarts. Set PILOT_REINSTALL_APPS=1 to force a clean
# reinstall when deploying a new bundle.
REINSTALL="${PILOT_REINSTALL_APPS:-0}"
if [ -d "${APP_BUNDLE}" ] && [ -f "${APP_BUNDLE}/manifest.json" ]; then
  id="$(basename "${APP_BUNDLE}")"
  dest="${APPS_DIR}/${id}"
  if [ -f "${dest}/manifest.json" ] && [ "${REINSTALL}" != "1" ]; then
    log "keeping existing install ${id} (preserves identity/state; PILOT_REINSTALL_APPS=1 to refresh)"
  else
    log "installing bundle ${id} -> ${dest} (full copy, preserves node_modules)"
    rm -rf "${dest:?}"
    cp -a "${APP_BUNDLE}" "${dest}"
  fi
  binrel="$(grep -oE '"path"[[:space:]]*:[[:space:]]*"[^"]+"' "${dest}/manifest.json" | head -1 | sed -E 's/.*"path"[^"]*"([^"]+)".*/\1/')"
  [ -n "${binrel}" ] && chmod +x "${dest}/${binrel}" 2>/dev/null || true
else
  log "FATAL: app bundle dir not found or missing manifest: ${APP_BUNDLE}"
  exit 1
fi

# ── Reddit OAuth hook (DORMANT unless SNOOPY_REDDIT_CLIENT_ID is set) ─────────
# Reddit hard-blocks unauthenticated access from many datacenter IPs (HTTP 403),
# so a live scan finds 0 posts there. Supplying Reddit OAuth creds switches Snoopy
# to authenticated access. Snoopy stores client_id/app_name in its settings DB
# (there is NO MCP/CLI setter for these — `settings` is interactive-only), and
# reads the secret from SNOOPY_REDDIT_CLIENT_SECRET (env, which the wrapper
# forwards to `snoopy mcp`). We seed client_id/app_name here, before launch.
# Today (no creds) this block is skipped entirely → unchanged unauthenticated path.
if [ -n "${SNOOPY_REDDIT_CLIENT_ID:-}" ]; then
  SNOOPY_PKG="$(npm root -g)/@telepat/snoopy"
  export SNOOPY_PKG
  log "seeding Reddit OAuth client_id/app_name into ${SNOOPY_ROOT_DIR}/snoopy.db"
  # Ensure Snoopy's schema exists first (non-interactive, zero-LLM), then UPSERT.
  snoopy job list >/dev/null 2>&1 || true
  node -e '
    const path = require("path");
    const Database = require(path.join(process.env.SNOOPY_PKG, "node_modules", "better-sqlite3"));
    const db = new Database(path.join(process.env.SNOOPY_ROOT_DIR, "snoopy.db"));
    db.prepare("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime(\x27now\x27)))").run();
    const up = db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime(\x27now\x27)");
    up.run("reddit_client_id", process.env.SNOOPY_REDDIT_CLIENT_ID);
    if (process.env.SNOOPY_REDDIT_APP_NAME) up.run("reddit_app_name", process.env.SNOOPY_REDDIT_APP_NAME);
    db.close();
  ' || log "WARN: reddit seed failed (continuing; qualify will use unauthenticated access)"
fi

log "starting pilot-daemon (no_skillinject) hostname=${HOSTN} registry=${REGISTRY} beacon=${BEACON} socket=${SOCK} snoopy_root=${SNOOPY_ROOT_DIR}"
exec pilot-daemon \
  -registry "${REGISTRY}" \
  -beacon "${BEACON}" \
  -socket "${SOCK}" \
  -identity "${IDENTITY}" \
  -public \
  -trust-auto-approve \
  -hostname "${HOSTN}" \
  -no-dataexchange \
  -log-level "${LOGLEVEL}"
