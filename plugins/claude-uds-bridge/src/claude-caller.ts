// Resolves which Claude Code Desktop conversation is calling this MCP process, from evidence the
// host controls: the process tree and Claude's own session registry (sessions/<pid>.json). Tool
// arguments never take part. A stdio MCP server is expected to be a descendant of its session's
// engine; when that does not hold (shared or app-hosted servers) the caller is rejected, not guessed.
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { peers, processStart, uuid, type Peer } from './claude';
import { readHookSession } from './claude-sidecar';

export type Provider = 'codex' | 'claude';
export type BindingMethod = 'codex_meta' | 'claude_process_ancestry' | 'claude_process_ancestry+hook';
export type AuthenticatedCaller = {
  provider: Provider; sessionId: string; pid: number; procStart: string; project: string;
  binding: { method: BindingMethod; generation: string; surface: string; evidence: string[] };
};
export type CallerRejectionCode = 'caller_unavailable' | 'caller_ambiguous' | 'caller_stale' | 'caller_mismatch' | 'caller_transition';
export class CallerRejected extends Error {
  constructor(readonly code: CallerRejectionCode, message: string) { super(`${code}: ${message}`); }
}
// command is the executable basename, kept so a spike can tell a host-launched server (direct
// child of the engine) from one started through the conversation's own shell.
export type AncestorStep = { pid: number; registered: boolean; command: string };
export type ClaudeCallerOptions = { configDir: string; stateDir: string; meta?: Record<string, unknown>; pid?: number; expectedProject?: string };

const maxDepth = 6;
// Codex's bridge registers its own receivers in the same directory; those are never Claude callers.
const bridgeEntrypoint = 'codex-claude-uds-bridge', desktopSurface = 'claude-desktop';

export async function processParent(pid: number) {
  const child = Bun.spawn(['ps', '-o', 'ppid=,comm=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, stdout: 'pipe', stderr: 'ignore' });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const match = /^\s*(\d+)\s+(.*)$/.exec(output.trim());
  if (code !== 0 || !match) throw new CallerRejected('caller_unavailable', 'Cannot read the parent process');
  return { ppid: Number(match[1]), command: match[2]!.split('/').pop()!.slice(0, 64) };
}

export async function parentPid(pid: number) { return (await processParent(pid)).ppid; }

// Nearest ancestor with a live, well-formed registry record. `pid` is the first process examined
// besides `start` itself; production passes process.pid, so an MCP server never matches itself.
export async function registeredAncestor(configDir: string, start: number, trace: AncestorStep[] = []) {
  const live = peers(configDir);
  let pid = await parentPid(start);
  for (let depth = 0; depth < maxDepth && pid > 1; depth++) {
    const matches = live.filter(peer => peer.pid === pid), info = await processParent(pid);
    trace.push({ pid, registered: matches.length > 0, command: info.command });
    if (matches.length > 1) throw new CallerRejected('caller_ambiguous', 'Several registry records claim one process');
    if (matches[0]) return matches[0];
    pid = info.ppid;
  }
  throw new CallerRejected('caller_unavailable', 'No Claude session engine among this process ancestors; shared or host-managed MCP processes are not bound');
}

// Any session-like UUID the host placed in request metadata must agree with the process evidence.
// Such hints only ever narrow; their absence is normal.
export function metaSessionHints(meta: Record<string, unknown> | undefined) {
  const hints: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 2) return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === 'string' && /session[_-]?id$|thread[_-]?id$/i.test(key) && uuid.safeParse(entry).success) hints.push(entry);
      else if (typeof entry === 'string' && entry.startsWith('{')) { try { visit(JSON.parse(entry), depth + 1); } catch { /* Not JSON. */ } }
      else visit(entry, depth + 1);
    }
  };
  visit(meta, 0);
  return [...new Set(hints)];
}

function folder(path: string) {
  const project = realpathSync(path), stat = statSync(project, { bigint: true });
  return { project, device: String(stat.dev), inode: String(stat.ino) };
}

export async function authenticateClaudeCaller(options: ClaudeCallerOptions, trace: AncestorStep[] = []): Promise<AuthenticatedCaller> {
  const engine: Peer = await registeredAncestor(options.configDir, options.pid ?? process.pid, trace);
  const evidence = ['registry_record', 'socket_owned'];
  if (engine.entrypoint === bridgeEntrypoint) throw new CallerRejected('caller_mismatch', 'The nearest registered ancestor is a bridge receiver, not a Claude session');
  // Only Desktop conversations qualify; CLI, IDE and SDK sessions are other surfaces.
  if (engine.entrypoint !== desktopSurface) throw new CallerRejected('caller_mismatch', `Session surface ${engine.entrypoint ?? 'unknown'} is not Claude Code Desktop`);
  if (!engine.procStart) throw new CallerRejected('caller_stale', 'The session record has no process start time');
  let started: string;
  try { started = await processStart(engine.pid); } catch { throw new CallerRejected('caller_stale', 'The session engine exited'); }
  if (started !== engine.procStart) throw new CallerRejected('caller_stale', 'The session record belongs to an earlier process with the same PID');
  evidence.push('process_start');
  if (peers(options.configDir).filter(peer => peer.sessionId === engine.sessionId).length !== 1) {
    throw new CallerRejected('caller_ambiguous', 'Another live process claims the same Claude session');
  }
  const hints = metaSessionHints(options.meta);
  if (hints.some(hint => hint !== engine.sessionId)) throw new CallerRejected('caller_mismatch', 'Request metadata names a different session');
  if (hints.length) evidence.push('meta_session_match');
  const project = folder(engine.cwd);
  if (options.expectedProject !== undefined) {
    const expected = folder(options.expectedProject);
    if (expected.project !== project.project || expected.device !== project.device || expected.inode !== project.inode) {
      throw new CallerRejected('caller_mismatch', 'The calling session works in another project');
    }
    evidence.push('project_identity');
  }
  let hook: ReturnType<typeof readHookSession>;
  try { hook = readHookSession(options.stateDir, engine.pid, engine.procStart); }
  catch { throw new CallerRejected('caller_stale', 'The hook record for this session is unreadable or not private'); }
  if (hook && hook.sessionId !== engine.sessionId) throw new CallerRejected('caller_transition', 'The session changed (clear or resume) and the registry has not caught up; retry');
  if (hook?.ended) throw new CallerRejected('caller_stale', 'This session has ended');
  if (hook) evidence.push('hook_generation');
  const generation = hook?.generation
    ?? createHash('sha256').update(`${engine.pid}|${engine.procStart}|${engine.sessionId}`).digest('hex').slice(0, 32);
  return {
    provider: 'claude', sessionId: engine.sessionId, pid: engine.pid, procStart: engine.procStart, project: project.project,
    binding: { method: hook ? 'claude_process_ancestry+hook' : 'claude_process_ancestry', generation, surface: engine.entrypoint ?? 'unknown', evidence },
  };
}
