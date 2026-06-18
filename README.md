# pilot-node-snoopy

A **free** [Pilot Protocol](https://pilotprotocol.network) node that wraps the
[Telepat **Snoopy**](https://docs.telepat.io/snoopy/) agent — AI Reddit
intent-signal qualification — and exposes it as a single dataexchange capability
on the Pilot overlay. No payment, no wallet: the capability is free.

## What it does

Snoopy monitors subreddits and uses an LLM to qualify posts/comments that match
a plain-language prompt (e.g. "people asking for a tool like ours"). This node
exposes that over Pilot's peer-to-peer dataexchange (`:1001`) with three ops:

| op | LLM? | does |
|----|------|------|
| `{"op":"qualify","subreddits":[...],"prompt":"...","limit":5}` | **yes** | create a job → run it once (scan Reddit + qualify) → return this run's leads |
| `{"op":"leads","jobRef":"...","limit":10}` | no | read already-qualified, deduped leads (`snoopy consume`) |
| `{"op":"jobs"}` | no | list monitoring jobs |

Replies are `{"op":..., "ok":true|false, ...}`.

## Architecture

```
caller ──overlay:1001──▶ provider-daemon (pilot, no_skillinject, -no-dataexchange)
                          └─ app-store supervisor spawns ▶ io.telepat.snoopy (bin/main.js)
                                                            └─ spawns stdio child ▶ `snoopy mcp`
```

Unlike the paid Ideon node (HTTP MCP in a separate container), **Snoopy's MCP is
stdio-only**, so the `snoopy mcp` server runs as a child process **co-located in
the same container** as the wrapper. The wrapper keeps one persistent MCP client
(`@modelcontextprotocol/sdk` `StdioClientTransport`) and calls Snoopy's tools
(`snoopy_job_add`, `snoopy_job_run`, `snoopy_export`, `snoopy_consume`,
`snoopy_job_list`, `snoopy_settings_set`).

The blocking sdk-node FFI accept loop runs on a worker thread
(`pilotServerWorker`); the main thread does the async MCP work — identical to the
Ideon node's pilotServer design.

### Model settings (seeded from env)

Snoopy stores `model` / `temperature` / `maxTokens` / `topP` in its SQLite
`settings` table and has **no native env override**; its `settings` CLI is an
interactive TUI (unusable headless). So the **wrapper seeds them at startup via
the MCP `snoopy_settings_set` tool**, reading `SNOOPY_MODEL`,
`SNOOPY_TEMPERATURE`, `SNOOPY_MAX_TOKENS`, `SNOOPY_TOP_P` from the environment.
The OpenRouter key is read by Snoopy directly from `TELEPAT_OPENROUTER_KEY`
(keytar/OS-keyring is absent in the container; Snoopy falls back to the env var).
Reddit needs **no** OAuth — Snoopy uses public JSON.

## Build

This repo is **self-contained** — it carries the upstream Go-build Dockerfiles
(`docker/{pilot,libpilot,pilotctl}.Dockerfile` + `upstream-pins.txt` + `patches/`),
so a clean clone builds with no sibling checkouts:

```sh
scripts/build-all.sh
```

`build-all.sh` builds (skipping any artifact that already exists):
1. `pilot-protocol/pilot:dev` — the Go daemon + pilotctl + wallet + rendezvous
   (`-tags no_skillinject`),
2. `build/libpilot.so` — the sdk-node FFI native lib (CGO c-shared),

then delegates to `scripts/build.sh` for the fast Node layers:
- `pilot-protocol/snoopy-wrapper:dev` — the Node app bundle (tsup),
- `pilot-protocol/snoopy-runtime:dev` — the provider-daemon image
  (`FROM pilot:dev` + `npm i -g @telepat/snoopy`),
- `bundles/io.telepat.snoopy/` — the signed, sha256-pinned app bundle,
- `secure/publisher.key` — a fresh ed25519 publisher key (gitignored).

> **First build is slow.** Steps 1–2 clone and compile upstream Go from source —
> typically **~5–15 min** the first time (host-dependent). They are cached
> afterwards; re-runs only rebuild the fast Node layers. Set `FORCE_BASE_BUILD=1`
> to force a base rebuild. `scripts/build.sh` on its own assumes `pilot:dev` and
> `build/libpilot.so` already exist.

## Smoke test (zero-LLM)

```sh
docker compose -f compose.smoke.yaml up -d
scripts/smoke.sh
```

`smoke.sh` waits for provider readiness, confirms the MCP handshake in the logs,
then drives `{"op":"jobs"}` and `{"op":"leads"}` from a caller container over the
overlay. Expected:

```
reply: {"op":"jobs","ok":true,"count":1,"jobs":[{...,"slug":"default-snoopy-watch",...}]}
reply: {"op":"leads","ok":true,"leads":[],"consumed":0}
```

These ops touch no LLM and need no egress. `{"op":"qualify"}` **does** call the
LLM (and Reddit) — set `TELEPAT_OPENROUTER_KEY` first.

## Production

```sh
cp .env.example .env   # set TELEPAT_OPENROUTER_KEY, model, overlay endpoints
docker compose up -d
```

## Host-safety

The pilot image is built `-tags no_skillinject`; `HOME` is the container-local
`/home/pilot`; no host path is mounted. **Never run the Pilot daemon on the
host — containers only.**

## Layout

```
app/                TypeScript wrapper (tsup → bin/main.js + bin/pilotServerWorker.js)
  src/mcpStdioClient.ts   persistent stdio MCP client to `snoopy mcp`
  src/wrapper.ts          lifecycle: serve readiness, spawn MCP, seed settings, serve :1001
  src/{dxframe,appSock,pilotServer,pilotServerWorker,types,log,main}.ts
docker/
  wrapper.Dockerfile          builds the app bundle
  snoopy-runtime.Dockerfile   provider image = pilot:dev + global snoopy
  pilot.Dockerfile            Go daemon+pilotctl+wallet+rendezvous (no_skillinject)
  libpilot.Dockerfile         sdk-node FFI native lib (CGO c-shared)
  pilotctl.Dockerfile         pilotctl-only image (CI release verification)
  upstream-pins.txt           pinned org sibling-repo SHAs (libpilot replace layout)
  patches/libpilot-stubs.go   no-op //export stubs for 3 unexported SDK symbols
scripts/{build-all,build,provider-entrypoint,smoke,dx-client}.*
compose.yaml          production (real overlay)
compose.smoke.yaml    local rendezvous + provider + caller
```

## Reddit OAuth (optional — real leads where this IP is blocked)

Snoopy uses Reddit's public JSON by default, but Reddit returns **HTTP 403** to
many datacenter IPs for unauthenticated access, so a live `qualify` may find 0
posts. To enable authenticated scans (real qualified leads), create a Reddit
**script** app at <https://www.reddit.com/prefs/apps> and set in `.env`:

```
SNOOPY_REDDIT_CLIENT_ID=<your app id>
SNOOPY_REDDIT_APP_NAME=snoopy-pilot/0.1 (by /u/yourname)
SNOOPY_REDDIT_CLIENT_SECRET=<your app secret>
```

`client_id` + `app_name` are seeded into Snoopy's settings DB by
`scripts/provider-entrypoint.sh` at startup; the secret is read directly by
`snoopy mcp` from the env var. Leave them unset to stay on the unauthenticated
public-JSON path. The Pilot capability (`qualify`/`poll`/`leads`/`jobs`) is
unchanged either way.
