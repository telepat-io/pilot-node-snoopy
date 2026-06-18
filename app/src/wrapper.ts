/**
 * wrapper.ts — entrypoint orchestration for the io.telepat.snoopy app (FREE node).
 *
 * Lifecycle (cite: supervisor.go:752-808):
 *   1. Parse the six lifecycle flags (--addr --db --socket --identity
 *      --manifest --cap-state); tolerate unknown flags.
 *   2. Open the --socket unix listener (supervisor readiness signal).
 *   3. Spawn the co-located Snoopy MCP server (`snoopy mcp`, stdio) and perform
 *      the MCP initialize handshake (one persistent client).
 *   4. Seed Snoopy settings (model/temperature/maxTokens/topP) from env, since
 *      Snoopy has NO native env override for these (they live in its SQLite
 *      settings table). We apply them via the MCP snoopy_settings_set tool.
 *   5. Optionally seed a default monitoring job from env.
 *   6. Start the dataexchange capability server on port 1001, handling:
 *        op:"qualify" -> snoopy_job_add -> snoopy_job_run (LLM) -> snoopy_export
 *        op:"leads"   -> snoopy_consume (zero-LLM)
 *        op:"jobs"    -> snoopy_job_list (zero-LLM)
 *   7. Structured logging to stderr throughout.
 *
 * There is NO payment in this node: no wallet IPC, no quote, no receipt, no
 * dedupe. The capability is free.
 *
 * Env (inherited from the daemon, then forwarded to the MCP child):
 *   PILOT_SOCKET           daemon data-plane unix socket (default /tmp/pilot.sock)
 *   SNOOPY_ROOT_DIR        Snoopy state dir (DB/logs) — a writable named volume
 *   TELEPAT_OPENROUTER_KEY OpenRouter key Snoopy reads (required for qualify)
 *   SNOOPY_MODEL           e.g. deepseek/deepseek-v4-flash
 *   SNOOPY_TEMPERATURE     0.0-2.0
 *   SNOOPY_MAX_TOKENS      positive integer
 *   SNOOPY_TOP_P           0.0-1.0
 *   SNOOPY_DEFAULT_JOB_NAME / SNOOPY_DEFAULT_SUBREDDITS (comma list) /
 *   SNOOPY_DEFAULT_PROMPT  optional seed job (added only if no jobs exist)
 *   SNOOPY_QUALIFY_LIMIT   default `limit` for qualify/leads when unspecified
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  JobStatus,
  LifecycleFlags,
  SnoopyRequest,
  SnoopyResponse,
} from './types.js';
import { serveAppSocket } from './appSock.js';
import { startCapabilityServer } from './pilotServer.js';
import { connectSnoopyMcp } from './mcpStdioClient.js';
import type { SnoopyMcpClient } from './mcpStdioClient.js';
import { log } from './log.js';

/** The capability/overlay port (1001 == dataexchange). */
const CAPABILITY_PORT = 1001;
/** MCP call budget for the LLM qualify run (Snoopy's internal job-run spawn
 *  timeout is 120s; allow headroom). */
const QUALIFY_TIMEOUT_MS = 150_000;

/** Parse the six supervisor flags; ignore anything unrecognized. */
export function parseFlags(argv: string[]): LifecycleFlags {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined || !a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq >= 0) {
      map.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        map.set(a.slice(2), next);
        i++;
      } else {
        map.set(a.slice(2), ''); // boolean-style flag, tolerated
      }
    }
  }
  const req = (k: string): string => {
    const v = map.get(k);
    if (v === undefined || v === '') throw new Error(`wrapper: missing required flag --${k}`);
    return v;
  };
  return {
    addr: req('addr'),
    db: req('db'),
    socket: req('socket'),
    identity: req('identity'),
    manifest: req('manifest'),
    capState: req('cap-state'),
  };
}

interface Config {
  daemonSocketPath: string;
  rootDir: string;
  /** Snoopy settings to seed (key -> stringified value). */
  settings: Array<{ key: string; value: string }>;
  defaultJob?: { name: string; subreddits: string[]; prompt: string };
  qualifyLimit?: number;
}

function loadConfig(): Config {
  const settings: Array<{ key: string; value: string }> = [];
  const pushIf = (envName: string, key: string): void => {
    const v = process.env[envName];
    if (v !== undefined && v.trim() !== '') settings.push({ key, value: v.trim() });
  };
  pushIf('SNOOPY_MODEL', 'model');
  pushIf('SNOOPY_TEMPERATURE', 'temperature');
  pushIf('SNOOPY_MAX_TOKENS', 'maxTokens');
  pushIf('SNOOPY_TOP_P', 'topP');

  const djName = (process.env['SNOOPY_DEFAULT_JOB_NAME'] ?? '').trim();
  const djSubs = (process.env['SNOOPY_DEFAULT_SUBREDDITS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const djPrompt = (process.env['SNOOPY_DEFAULT_PROMPT'] ?? '').trim();

  const cfg: Config = {
    daemonSocketPath: process.env['PILOT_SOCKET'] ?? '/tmp/pilot.sock',
    rootDir: process.env['SNOOPY_ROOT_DIR'] ?? path.join(process.env['HOME'] ?? '/home/pilot', '.snoopy'),
    settings,
  };

  if (djName !== '' && djSubs.length > 0 && djPrompt !== '') {
    cfg.defaultJob = { name: djName, subreddits: djSubs, prompt: djPrompt };
  }
  const ql = Number.parseInt(process.env['SNOOPY_QUALIFY_LIMIT'] ?? '', 10);
  if (Number.isFinite(ql) && ql > 0) cfg.qualifyLimit = ql;

  return cfg;
}

/** Build the env handed to the `snoopy mcp` child: inherit everything, then
 *  force SNOOPY_ROOT_DIR so the child writes to the shared state volume. */
function childEnv(rootDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  env['SNOOPY_ROOT_DIR'] = rootDir;
  return env;
}

/** Apply env-provided model settings via the MCP snoopy_settings_set tool.
 *  Best-effort: a single bad value must not block startup. */
async function seedSettings(mcp: SnoopyMcpClient, cfg: Config): Promise<void> {
  for (const s of cfg.settings) {
    try {
      await mcp.callTool('snoopy_settings_set', { key: s.key, value: s.value }, { timeoutMs: 15_000 });
      log('info', 'seeded snoopy setting', { key: s.key, value: s.value });
    } catch (err) {
      log('warn', 'failed to seed snoopy setting', { key: s.key, value: s.value, error: (err as Error).message });
    }
  }
}

/** Seed a default job from env, only if no jobs exist yet (idempotent across
 *  restarts). Added disabled — this topology runs no Snoopy scheduler daemon;
 *  jobs run on demand via op:"qualify". */
async function seedDefaultJob(mcp: SnoopyMcpClient, cfg: Config): Promise<void> {
  if (!cfg.defaultJob) return;
  try {
    const list = (await mcp.callTool('snoopy_job_list', {}, { timeoutMs: 15_000 })) as { count?: number };
    if ((list?.count ?? 0) > 0) {
      log('info', 'default job seed skipped (jobs already exist)', { count: list.count });
      return;
    }
    const added = await mcp.callTool(
      'snoopy_job_add',
      {
        name: cfg.defaultJob.name,
        subreddits: cfg.defaultJob.subreddits,
        qualificationPrompt: cfg.defaultJob.prompt,
        enabled: false,
      },
      { timeoutMs: 15_000 },
    );
    log('info', 'seeded default job', { job: added });
  } catch (err) {
    log('warn', 'failed to seed default job', { error: (err as Error).message });
  }
}

/** A background qualify run tracked in memory; the caller polls by jobId. */
interface QualifyJob {
  status: JobStatus;
  jobRef?: string;
  leads?: unknown[];
  run?: unknown;
  error?: string;
}

/** Build the per-request handler over the persistent MCP client. qualify is
 *  ASYNC: it returns a jobId immediately and the caller polls, so the overlay
 *  conn is never held for the full ~minute-long scan+LLM run. */
function makeHandler(mcp: SnoopyMcpClient, cfg: Config): (req: SnoopyRequest) => Promise<SnoopyResponse> {
  const jobs = new Map<string, QualifyJob>();
  return async (req: SnoopyRequest): Promise<SnoopyResponse> => {
    switch (req.op) {
      case 'jobs':
        return handleJobs(mcp);
      case 'leads':
        return handleLeads(mcp, req, cfg);
      case 'qualify':
        return startQualify(mcp, req, cfg, jobs);
      case 'poll':
        return handlePoll(req, jobs);
      default:
        return { op: 'error', ok: false, error: `unknown op: ${String(req.op)}` };
    }
  };
}

async function handleJobs(mcp: SnoopyMcpClient): Promise<SnoopyResponse> {
  try {
    const res = (await mcp.callTool('snoopy_job_list', {}, { timeoutMs: 15_000 })) as {
      count?: number;
      jobs?: unknown[];
    };
    return { op: 'jobs', ok: true, count: res?.count ?? res?.jobs?.length ?? 0, jobs: res?.jobs ?? [] };
  } catch (err) {
    return { op: 'jobs', ok: false, error: (err as Error).message };
  }
}

async function handleLeads(mcp: SnoopyMcpClient, req: SnoopyRequest, cfg: Config): Promise<SnoopyResponse> {
  try {
    const args: Record<string, unknown> = {};
    if (req.jobRef !== undefined) args['jobRef'] = req.jobRef;
    const limit = req.limit ?? cfg.qualifyLimit;
    if (limit !== undefined) args['limit'] = limit;
    const res = (await mcp.callTool('snoopy_consume', args, { timeoutMs: 30_000 })) as {
      items?: unknown[];
      consumed?: number;
    };
    return { op: 'leads', ok: true, leads: res?.items ?? [], consumed: res?.consumed ?? 0 };
  } catch (err) {
    return { op: 'leads', ok: false, error: (err as Error).message };
  }
}

/** Validate + register a qualify job, kick off the scan+LLM run in the
 *  BACKGROUND, and return the jobId to poll. The reply returns in <1s so the
 *  overlay conn isn't held for the full run. */
function startQualify(
  mcp: SnoopyMcpClient,
  req: SnoopyRequest,
  cfg: Config,
  jobs: Map<string, QualifyJob>,
): SnoopyResponse {
  if (!Array.isArray(req.subreddits) || req.subreddits.length === 0) {
    return { op: 'error', ok: false, error: 'qualify: subreddits[] is required' };
  }
  if (typeof req.prompt !== 'string' || req.prompt.trim() === '') {
    return { op: 'error', ok: false, error: 'qualify: prompt is required' };
  }
  const subreddits = req.subreddits;
  const prompt = req.prompt;
  const name = (req.name ?? '').trim() || `qualify ${subreddits.join(',')} ${new Date().toISOString()}`;
  const limit = req.limit ?? cfg.qualifyLimit;

  const jobId = randomUUID();
  jobs.set(jobId, { status: 'pending' });
  void runQualify(mcp, { name, subreddits, prompt, limit }).then(
    (res) => {
      jobs.set(jobId, { status: 'done', ...res });
      log('info', 'qualify job done', { jobId, jobRef: res.jobRef, leads: res.leads?.length ?? 0 });
    },
    (err: Error) => {
      jobs.set(jobId, { status: 'error', error: err.message });
      log('error', 'qualify job failed', { jobId, error: err.message });
    },
  );
  log('info', 'accepted qualify job', { jobId, subreddits, limit });
  return { op: 'accepted', ok: true, jobId };
}

/** The actual scan+qualify+export chain (the LLM step). Runs detached from any
 *  overlay connection. Throws on a non-zero run exit. */
async function runQualify(
  mcp: SnoopyMcpClient,
  q: { name: string; subreddits: string[]; prompt: string; limit?: number },
): Promise<{ jobRef: string; leads: unknown[]; run: unknown }> {
  // 1. Create the job (zero-LLM).
  const added = (await mcp.callTool(
    'snoopy_job_add',
    { name: q.name, subreddits: q.subreddits, qualificationPrompt: q.prompt, enabled: true },
    { timeoutMs: 15_000 },
  )) as { id?: string; slug?: string };
  const jobRef = added?.slug ?? added?.id;
  if (!jobRef) throw new Error('qualify: job_add returned no id/slug');

  // 2. Run the job once — THIS is the LLM step (scan Reddit + qualify).
  const runArgs: Record<string, unknown> = { jobRef };
  if (q.limit !== undefined) runArgs['limit'] = q.limit;
  const run = (await mcp.callTool('snoopy_job_run', runArgs, { timeoutMs: QUALIFY_TIMEOUT_MS })) as {
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
  };

  // 3. Export this run's qualified leads (zero-LLM read-back).
  const exp = (await mcp.callTool(
    'snoopy_export',
    { jobRef, lastRun: true, format: 'json' },
    { timeoutMs: 30_000 },
  )) as { jobs?: Array<{ items?: unknown[] }>; totalRows?: number };
  const leads = exp?.jobs?.[0]?.items ?? [];

  const runSummary = {
    exitCode: run?.exitCode ?? null,
    stdoutTail: (run?.stdout ?? '').slice(-500),
    stderrTail: (run?.stderr ?? '').slice(-500),
  };
  if (run?.exitCode !== 0 && run?.exitCode != null) {
    const e = new Error(`qualify run exited ${run.exitCode}`);
    (e as Error & { jobRef?: string }).jobRef = jobRef;
    throw e;
  }
  return { jobRef, leads, run: runSummary };
}

/** Poll an async qualify job by jobId. */
function handlePoll(req: SnoopyRequest, jobs: Map<string, QualifyJob>): SnoopyResponse {
  const jobId = req.jobId ?? req.jobRef;
  if (!jobId) return { op: 'error', ok: false, error: 'poll: missing jobId' };
  const job = jobs.get(jobId);
  if (!job) return { op: 'result', ok: false, status: 'error', jobId, error: 'unknown jobId' };
  if (job.status === 'pending') return { op: 'result', ok: false, status: 'pending', jobId };
  if (job.status === 'error') return { op: 'result', ok: false, status: 'error', jobId, error: job.error ?? 'qualify failed' };
  return { op: 'result', ok: true, status: 'done', jobId, jobRef: job.jobRef, leads: job.leads ?? [], run: job.run };
}

/** Main lifecycle. Returns once the server is up; stays alive via the worker. */
export async function run(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const cfg = loadConfig();
  log('info', 'starting io.telepat.snoopy app', {
    addr: flags.addr,
    socket: flags.socket,
    daemonSocket: cfg.daemonSocketPath,
    rootDir: cfg.rootDir,
    seededSettings: cfg.settings.map((s) => s.key),
    hasDefaultJob: Boolean(cfg.defaultJob),
  });

  if (!process.env['TELEPAT_OPENROUTER_KEY']) {
    log('warn', 'TELEPAT_OPENROUTER_KEY is empty; op:"qualify" (LLM) will fail until set', {});
  }

  // 2. Readiness socket FIRST so the supervisor sees us promptly.
  const appSock = await serveAppSocket(flags.socket);

  // 3. Spawn the co-located Snoopy MCP server and connect (initialize handshake).
  let mcp: SnoopyMcpClient;
  try {
    mcp = await connectSnoopyMcp({ env: childEnv(cfg.rootDir), defaultTimeoutMs: QUALIFY_TIMEOUT_MS });
  } catch (err) {
    log('error', 'failed to start/connect snoopy mcp', { error: (err as Error).message });
    appSock.close();
    throw err;
  }

  // 4-5. Seed settings + optional default job (best-effort).
  await seedSettings(mcp, cfg);
  await seedDefaultJob(mcp, cfg);

  // 6. Capability server.
  const handler = makeHandler(mcp, cfg);
  const server = await startCapabilityServer({
    daemonSocketPath: cfg.daemonSocketPath,
    port: CAPABILITY_PORT,
    onRequest: handler,
  });

  log('info', 'io.telepat.snoopy app ready', { port: CAPABILITY_PORT });

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = (sig: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'shutting down', { signal: sig });
    server.close();
    appSock.close();
    void mcp.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
