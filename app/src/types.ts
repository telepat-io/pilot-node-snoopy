/**
 * Shared type contract for the io.telepat.snoopy Pilot app-store app.
 *
 * This FREE node has NO payment: there is no wallet IPC, no quote, no receipt,
 * no dedupe. A single dataexchange JSON capability exposes Snoopy's Reddit
 * intent-signal qualification over the Pilot overlay.
 *
 * Two distinct wire formats are in play and MUST NOT be conflated:
 *
 *   1. dataexchange frame  — peer<->peer over the Pilot overlay, port 1001.
 *      [4B type BE][4B len BE][payload]. See DxFrame / DxType below.
 *      Upstream: org/dataexchange/dataexchange.go:64-93.
 *
 *   2. app-store IPC envelope — app<->daemon/app over a unix socket.
 *      [4B len BE][JSON Envelope]. See IpcEnvelope below.
 *      Upstream: org/app-store/pkg/ipc/frame.go:15-69,
 *                org/app-store/pkg/ipc/envelope.go:33-41.
 */

// ───────────────────────────────────────────────────────────────────────────
// dataexchange wire (peer <-> peer, port 1001)
// ───────────────────────────────────────────────────────────────────────────

/**
 * dataexchange frame type discriminator.
 * Upstream: org/dataexchange/dataexchange.go:15-23 (TypeTrace=5 unused by us).
 */
export enum DxType {
  TEXT = 1,
  BINARY = 2,
  JSON = 3,
  FILE = 4,
}

/**
 * A decoded dataexchange frame. For FILE frames, `filename` is set and
 * `payload` is the raw file bytes (the [2B nameLen][name] prefix is stripped
 * by decodeFrame). For TEXT/JSON/BINARY, `filename` is undefined.
 */
export interface DxFrame {
  type: DxType;
  payload: Buffer;
  /** Only present (and required) for DxType.FILE. */
  filename?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// app-store IPC envelope (app <-> daemon)
// ───────────────────────────────────────────────────────────────────────────

export type IpcEnvelopeType = 'req' | 'reply' | 'err';

/**
 * The single message shape on the app-store IPC wire.
 * Upstream: org/app-store/pkg/ipc/envelope.go:33-41.
 */
export interface IpcEnvelope {
  type: IpcEnvelopeType;
  req_id: string;
  method?: string;
  app_id?: string;
  manifest_version?: number;
  /** Raw JSON bytes; decode per-method. */
  payload?: unknown;
  error?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// our app's peer-facing protocol (carried inside a dataexchange JSON frame)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Capability op (qualify is ASYNC — a real scan+LLM-qualify run takes longer
 * than the Pilot overlay holds an idle dataexchange conn ~60-70s, so we accept
 * a job and let the caller poll):
 *   "qualify" — start an LLM run: create a job + run it once (scan Reddit +
 *               qualify with the configured model) + export — IN BACKGROUND;
 *               reply {op:"accepted", jobId} at once.
 *   "poll"    — fetch a qualify job's status; when done, its qualified leads.
 *   "leads"   — ZERO-LLM read of already-qualified, deduped leads (consume).
 *   "jobs"    — ZERO-LLM list of monitoring jobs.
 */
export type RequestOp = 'qualify' | 'poll' | 'leads' | 'jobs';

/** Per-job status the wrapper tracks in memory for an async qualify run. */
export type JobStatus = 'pending' | 'done' | 'error';

/** Request frame our capability server accepts (decoded from a DxType.JSON
 *  frame on port 1001). Fields are op-dependent. */
export interface SnoopyRequest {
  op: RequestOp | string;
  /** qualify: subreddits to monitor (e.g. ["startups","SaaS"]). */
  subreddits?: string[];
  /** qualify: plain-language qualification criteria. */
  prompt?: string;
  /** qualify: optional job name (defaults to a generated one). */
  name?: string;
  /** leads: job id or slug. poll: the jobId returned by qualify. */
  jobRef?: string;
  /** poll: the async job handle returned by op:"qualify". */
  jobId?: string;
  /** qualify: max new items to qualify. leads: max results to consume. */
  limit?: number;
}

/** Base shape every reply shares. */
export interface SnoopyReplyBase {
  op: string;
  ok: boolean;
  error?: string;
}

/** Reply to op:"jobs". */
export interface JobsReply extends SnoopyReplyBase {
  op: 'jobs';
  count?: number;
  jobs?: unknown[];
}

/** Reply to op:"leads". */
export interface LeadsReply extends SnoopyReplyBase {
  op: 'leads';
  leads?: unknown[];
  consumed?: number;
}

/** Reply to op:"qualify" — the async job handle to poll. */
export interface AcceptedReply extends SnoopyReplyBase {
  op: 'accepted';
  jobId: string;
}

/** Reply to op:"poll". `leads` holds this run's qualified items when done. */
export interface ResultReply extends SnoopyReplyBase {
  op: 'result';
  status: JobStatus;
  jobId: string;
  jobRef?: string;
  leads?: unknown[];
  /** Summary of the underlying `snoopy job run` (exitCode/stdout tail). */
  run?: unknown;
}

export type SnoopyResponse = JobsReply | LeadsReply | AcceptedReply | ResultReply | SnoopyReplyBase;

// ───────────────────────────────────────────────────────────────────────────
// lifecycle flags (supervisor -> our binary)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Flags the app-store supervisor passes to a spawned app.
 * Upstream: org/app-store/plugin/appstore/supervisor.go:752-759.
 *   --addr <daemon-pilot-addr>  our OWN pilot address (e.g. "0:0001.HHHH.LLLL")
 *   --db <path>                 sqlite/state path (we use it as a state dir hint)
 *   --socket <app.sock>         unix socket WE must create (readiness signal)
 *   --identity <path>           our ed25519 identity file
 *   --manifest <path>           pinned manifest.json
 *   --cap-state <path>          JSONL cap-state log (unused by us)
 *
 * NOTE: the daemon DATA-PLANE socket is NOT in these flags. It is found via
 * $PILOT_SOCKET / driver.DefaultSocketPath() (inherited env).
 */
export interface LifecycleFlags {
  addr: string;
  db: string;
  socket: string;
  identity: string;
  manifest: string;
  capState: string;
}

// ───────────────────────────────────────────────────────────────────────────
// module stub SIGNATURES — implementations live in the named files
// ───────────────────────────────────────────────────────────────────────────

/** dxframe.ts — encode/decode dataexchange frames.
 *  Mirrors org/dataexchange/dataexchange.go:73-140 and
 *  org/sdk-node/src/client.ts:481-543. */
export interface DxFrameModule {
  encodeFrame(type: DxType, payload: Buffer): Buffer;
  decodeFrame(buf: Buffer): { frame: DxFrame; bytesRead: number };
  encodeFilePayload(filename: string, data: Buffer): Buffer;
}
export declare const encodeFrame: DxFrameModule['encodeFrame'];
export declare const decodeFrame: DxFrameModule['decodeFrame'];
export declare const encodeFilePayload: DxFrameModule['encodeFilePayload'];

/** A connection-like handle exposing the subset of sdk-node Conn we use. */
export interface ConnLike {
  read(size?: number): Buffer;
  write(data: Buffer | Uint8Array | string): number;
  close(): void;
}

/** appSock.ts — create the --socket unix listener the supervisor polls for
 *  readiness. We don't serve real IPC methods on it; it exists purely as the
 *  readiness signal. Upstream readiness poll: supervisor.go:795-808. */
export interface AppSockModule {
  serveAppSocket(socketPath: string): Promise<AppSockHandle>;
}
export interface AppSockHandle {
  close(): void;
}
export declare const serveAppSocket: AppSockModule['serveAppSocket'];

/** pilotServer.ts — bind the daemon data plane on port 1001 and serve our
 *  capability to peers. Uses sdk-node Driver.listen(1001). */
export interface PilotServerModule {
  startCapabilityServer(opts: CapabilityServerOpts): Promise<CapabilityServerHandle>;
}
export interface CapabilityServerOpts {
  /** Daemon data-plane unix socket (PILOT_SOCKET / default /tmp/pilot.sock). */
  daemonSocketPath: string;
  /** Port to bind on the overlay; the capability port (1001 == dataexchange). */
  port: number;
  /** Handler invoked once per decoded request frame; returns the response
   *  object to encode back as a JSON frame. */
  onRequest(req: SnoopyRequest): Promise<SnoopyResponse>;
}
export interface CapabilityServerHandle {
  close(): void;
}
export declare const startCapabilityServer: PilotServerModule['startCapabilityServer'];
