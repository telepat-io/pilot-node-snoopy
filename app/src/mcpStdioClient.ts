/**
 * mcpStdioClient.ts — a persistent stdio MCP client to the co-located Snoopy
 * MCP server.
 *
 * Snoopy's MCP transport is STDIO ONLY (`snoopy mcp`), so — unlike Ideon's HTTP
 * MCP — the server child MUST run in the SAME container as this wrapper. We
 * spawn it once at startup, perform the MCP `initialize` handshake via
 * client.connect(), and keep a single long-lived Client. The Snoopy tools
 * operate directly on its SQLite DB (under SNOOPY_ROOT_DIR); no Snoopy daemon
 * is required.
 *
 * Tool results follow Snoopy's helpers.formatToolResult / formatToolError:
 *   success: { content: [{type:'text', text: JSON.stringify(data)}],
 *              structuredContent: data }
 *   error:   { content: [{type:'text', text: message}], isError: true }
 * (cite: snoopy/src/mcp/helpers.ts:43-58). We return structuredContent when
 * present, else parse content[0].text as JSON, and throw on isError.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { log } from './log.js';

interface ToolContentText {
  type: string;
  text?: string;
}
interface ToolCallResult {
  content?: ToolContentText[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface SnoopyMcpClient {
  /** Call a Snoopy MCP tool and return its parsed result (structuredContent,
   *  or the JSON-parsed text content). Throws on a tool error. */
  callTool(name: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown>;
  /** Tear down the client and kill the `snoopy mcp` child. */
  close(): Promise<void>;
}

export interface ConnectOpts {
  /** Executable to spawn (default "snoopy"). */
  command?: string;
  /** Args (default ["mcp"]). */
  args?: string[];
  /** Environment for the child. Must carry PATH, SNOOPY_ROOT_DIR, and any
   *  secrets Snoopy reads (TELEPAT_OPENROUTER_KEY). */
  env: Record<string, string>;
  /** Default per-call timeout (ms). Long enough for an LLM `snoopy job run`. */
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 150_000;

function firstText(res: ToolCallResult): string {
  const t = res.content?.find((c) => c.type === 'text' && typeof c.text === 'string')?.text;
  return t ?? '';
}

/** structuredContent if present; else the text content JSON-parsed; else raw. */
function parseToolResult(res: ToolCallResult): unknown {
  if (res.structuredContent !== undefined) return res.structuredContent;
  const text = firstText(res);
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export async function connectSnoopyMcp(opts: ConnectOpts): Promise<SnoopyMcpClient> {
  const command = opts.command ?? 'snoopy';
  const args = opts.args ?? ['mcp'];
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const transport = new StdioClientTransport({
    command,
    args,
    env: opts.env,
    // Surface the child's stderr in our container logs for debuggability.
    stderr: 'inherit',
  });

  const client = new Client(
    { name: 'io.telepat.snoopy-wrapper', version: '0.1.0' },
    { capabilities: {} },
  );

  // connect() performs the MCP initialize handshake over the spawned child.
  await client.connect(transport);
  log('info', 'snoopy mcp connected (initialize handshake complete)', { command, args });

  return {
    async callTool(name, args2, callOpts): Promise<unknown> {
      const timeout = callOpts?.timeoutMs ?? defaultTimeoutMs;
      const res = (await client.callTool(
        { name, arguments: args2 ?? {} },
        undefined,
        { timeout },
      )) as ToolCallResult;
      if (res.isError) {
        throw new Error(`snoopy mcp tool ${name} failed: ${firstText(res) || 'unknown error'}`);
      }
      return parseToolResult(res);
    },
    async close(): Promise<void> {
      try {
        await client.close();
      } catch (err) {
        log('warn', 'snoopy mcp close errored', { error: (err as Error).message });
      }
    },
  };
}
