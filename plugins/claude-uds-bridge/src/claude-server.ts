// MCP entrypoint for Claude Code Desktop. It neither registers in Claude's session registry nor
// opens an inbox socket: Claude keeps receiving through its native transport. Each tool call
// resolves its caller afresh from process evidence (a /clear keeps the PID but changes the session).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { appendObservation } from './claude-sidecar';
import { authenticateClaudeCaller, CallerRejected, metaSessionHints, parentPid, type AncestorStep, type AuthenticatedCaller } from './claude-caller';
import { version } from './version';
import { registerDesktopTools } from './desktop-runtime';

export type Authenticate = (meta?: Record<string, unknown>) => Promise<AuthenticatedCaller>;
export type ClaudeServerOptions = {
  configDir: string; stateDir: string; pid?: number;
  // Claude exports CLAUDE_PLUGIN_ROOT to plugin MCP servers but not to the Bash tool.
  pluginRootEnv?: boolean;
  // The shared collaboration runtime attaches here; it must derive identity only through `authenticate`.
  register?: (server: McpServer, authenticate: Authenticate) => void;
};

export function claudePaths(env = process.env) {
  return {
    configDir: env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    stateDir: env.CC_CDX_STATE_DIR ?? join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'plugin-state', 'claude-uds-bridge'),
  };
}

// Measurement log for the identity spike: identifiers and metadata keys only, never values of
// arbitrary metadata, arguments or conversation text.
export function recordObservation(stateDir: string, entry: Record<string, unknown>) {
  appendObservation(stateDir, 'observations.jsonl', entry);
}

export function metaKeys(meta: Record<string, unknown> | undefined) {
  return Object.keys(meta ?? {}).sort().slice(0, 64);
}

export function createClaudeServer(options: ClaudeServerOptions) {
  const authenticate: Authenticate = meta => authenticateClaudeCaller({ configDir: options.configDir, stateDir: options.stateDir, meta, pid: options.pid });
  const server = new McpServer({ name: 'cc-cdx-bridge-claude', version }, { instructions:
    'CC–CDX Bridge for Claude Code Desktop. Identity comes from this conversation\'s process, never from tool arguments. '
    + 'Use desktop_collaboration_discover/preflight/prepare/start/send/status/report/control/export for collaboration in either direction. Identity and authorship are derived from this host on every call. After compaction read the persistent status and context; do not reconstruct a run from peer text. New conversations need creation tickets and separate panel authorization; no CLI replacements or private creation IPC. A panel focus URL has no token; its private browser opening is handled by the server. A default Codex receiver may need panel consent for this exact Claude-origin run; explicit hold/refuse remain binding. Preparing starts no intellectual work; verify a brief correlated response before deep work and preserve uncertain outcomes without resending. '
    + 'caller_status reports whether this conversation can be bound; a rejection means bridge actions are unavailable here, not that you should supply an ID.' });
  server.registerTool('caller_status', {
    description: 'Read-only. Report which Claude Desktop conversation this bridge process is bound to, or why it cannot be bound. Takes no input; identity is derived from the host process and session registry.',
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (_args, extra) => {
    const meta = extra._meta as Record<string, unknown> | undefined, trace: AncestorStep[] = [];
    let caller: AuthenticatedCaller | undefined, rejection: { code: string; message: string } | undefined;
    try { caller = await authenticateClaudeCaller({ configDir: options.configDir, stateDir: options.stateDir, meta, pid: options.pid }, trace); }
    catch (error) {
      if (!(error instanceof CallerRejected)) throw error;
      rejection = { code: error.code, message: error.message };
    }
    // A copy started from the conversation's own shell also descends from the engine; the spike
    // counts only servers the host launched directly.
    const between = trace.filter(step => !step.registered).map(step => step.command);
    const hostLaunch = { pluginRootEnv: options.pluginRootEnv ?? !!process.env.CLAUDE_PLUGIN_ROOT, directChildOfEngine: trace[0]?.registered === true,
      launcherOnly: trace.some(step => step.registered) && between.every(command => command === 'sh' || command === 'bun') };
    const report = { serverPid: options.pid ?? process.pid, ancestors: trace, hostLaunch, metaKeys: metaKeys(meta), metaSessionHints: metaSessionHints(meta), caller, rejection };
    recordObservation(options.stateDir, { event: 'caller_status', ...report });
    return { content: [{ type: 'text' as const, text: JSON.stringify(report) }], ...(rejection ? { isError: true } : {}) };
  });
  options.register?.(server, authenticate);
  return server;
}

if (import.meta.main) {
  const paths = claudePaths();
  let parent: number | null = null;
  try { parent = await parentPid(process.pid); } catch { /* Recorded as unknown. */ }
  recordObservation(paths.stateDir, { event: 'server_start', serverPid: process.pid, parentPid: parent });
  const codexHome=process.env.CODEX_HOME??join(homedir(),'.codex');let runtime:ReturnType<typeof registerDesktopTools>|undefined;const server=createClaudeServer({...paths,register:(s,authenticate)=>{runtime=registerDesktopTools(s,{...paths,codexHome,ipcPath:join(codexHome,'ipc','ipc.sock'),registerAtStartup:true,pluginRoot:process.env.CLAUDE_PLUGIN_ROOT??join(import.meta.dir,'..'),authenticate});}});const close=async()=>{await runtime?.close();};server.server.onclose=close;process.on('SIGTERM',()=>{void close().finally(()=>process.exit(0));});await server.connect(new StdioServerTransport());
}
