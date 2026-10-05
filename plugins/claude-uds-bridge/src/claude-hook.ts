// Claude Code command hook (SessionStart, UserPromptSubmit, SessionEnd). It records which session
// the host says is running in the engine process that spawned it, so the MCP side can detect
// /clear, resume and end. It never prints (hook stdout becomes model context), never blocks the
// prompt, and never stores prompt or transcript text: only identifiers, a correlation id when the
// prompt carries one, and a count of earlier user turns.
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { z } from 'zod';
import { processStart, uuid } from './claude';
import { registeredAncestor } from './claude-caller';
import { appendObservation, correlationPattern, privateSubdirectory, readHookSession, writeAtomic, writeOnce, type CorrelationReceipt, type HookSession } from './claude-sidecar';

export { consumeCorrelation, correlationPattern, peekCorrelation, readHookSession, type CorrelationReceipt, type HookSession } from './claude-sidecar';

const maxTranscriptBytes = 64 * 1024 * 1024;

export const hookInputSchema = z.object({
  session_id: uuid, cwd: z.string().refine(isAbsolute), hook_event_name: z.enum(['SessionStart', 'UserPromptSubmit', 'SessionEnd']),
  source: z.string().max(64).optional(), transcript_path: z.string().optional(), prompt: z.string().optional(),
  model: z.union([z.string(), z.object({ id: z.string().optional() }).loose()]).optional(),
}).loose();
export type HookInput = z.infer<typeof hookInputSchema>;
export type HookEngine = { pid: number; procStart: string; registrySessionId: string | null };

function modelName(model: HookInput['model']) {
  return typeof model === 'string' ? model.slice(0, 200) : model?.id?.slice(0, 200) ?? null;
}

// Counts earlier user entries without keeping any of their text.
// Only transcripts under Claude's own projects directory count, so a hand-run hook cannot point the
// count at a fabricated file. Measured in Desktop (S0, 2026-10-05): on a new chat's first prompt the
// host has not written the transcript yet, so a missing <session_id>.jsonl in an existing project
// directory means no earlier turns.
export function priorUserTurns(transcriptPath: string | undefined, transcriptRoot?: string, sessionId?: string) {
  if (!transcriptPath || !isAbsolute(transcriptPath)) return null;
  try {
    if (!existsSync(transcriptPath)) {
      if (transcriptRoot === undefined || sessionId === undefined || basename(transcriptPath) !== `${sessionId}.jsonl`) return null;
      return realpathSync(dirname(transcriptPath)).startsWith(realpathSync(transcriptRoot) + '/') ? 0 : null;
    }
    if (transcriptRoot !== undefined && !realpathSync(transcriptPath).startsWith(realpathSync(transcriptRoot) + '/')) return null;
    const stat = lstatSync(transcriptPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.size > maxTranscriptBytes) return null;
    let count = 0;
    for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
      if (!line.includes('"user"')) continue;
      try { const entry = JSON.parse(line) as { type?: unknown; isMeta?: unknown }; if (entry.type === 'user' && entry.isMeta !== true) count++; }
      catch { /* Partial line. */ }
    }
    return count;
  } catch { return null; }
}

export async function recordHookEvent(stateDir: string, input: HookInput, engine: HookEngine, now = Date.now(), transcriptRoot?: string) {
  const path = join(privateSubdirectory(stateDir, 'claude-callers'), `${engine.pid}.json`);
  const previous = readHookSession(stateDir, engine.pid, engine.procStart);
  const cwd = realpathSync(input.cwd);
  const fresh = input.hook_event_name === 'SessionStart' || !previous || previous.sessionId !== input.session_id;
  const session: HookSession = {
    enginePid: engine.pid, procStart: engine.procStart, sessionId: input.session_id,
    generation: fresh ? randomUUID() : previous!.generation, cwd,
    source: input.source ?? (fresh ? null : previous!.source), model: modelName(input.model) ?? previous?.model ?? null,
    startedAt: fresh ? now : previous!.startedAt, updatedAt: now, ended: input.hook_event_name === 'SessionEnd',
  };
  writeAtomic(path, session);
  // The turn count is measured on every prompt so S0 learns whether the current prompt is already
  // in the transcript when the hook runs (it decides the bind threshold); it is a number, not text.
  const turns = input.hook_event_name === 'UserPromptSubmit' ? priorUserTurns(input.transcript_path, transcriptRoot, input.session_id) : undefined;
  appendObservation(stateDir, 'hook-observations.jsonl', { event: input.hook_event_name, source: input.source ?? null, sessionId: input.session_id,
    enginePid: engine.pid, registryMatches: engine.registrySessionId === input.session_id, generation: session.generation, model: session.model,
    ...(turns === undefined ? {} : { priorUserTurns: turns }) });
  if (input.hook_event_name !== 'UserPromptSubmit') return session;
  const match = input.prompt?.match(correlationPattern);
  if (!match) return session;
  // A receipt needs the host registry to agree on the session; a mid-clear or hand-run hook gets none.
  if (engine.registrySessionId !== input.session_id) {
    appendObservation(stateDir, 'hook-observations.jsonl', { event: 'correlation_refused', reason: 'registry_mismatch', sessionId: input.session_id });
    return session;
  }
  const receipt: CorrelationReceipt = { correlationId: match[1]!, sessionId: input.session_id, enginePid: engine.pid, procStart: engine.procStart,
    cwd, generation: session.generation, priorUserTurns: turns ?? null, at: now };
  try { writeOnce(join(privateSubdirectory(stateDir, 'claude-correlations'), `${receipt.correlationId}.json`), receipt); }
  catch { appendObservation(stateDir, 'hook-observations.jsonl', { event: 'correlation_duplicate', sessionId: input.session_id }); }
  return session;
}

// The engine is the nearest ancestor that has a registry record; a hook may run under a shell.
async function hookEngine(configDir: string, start: number): Promise<HookEngine | undefined> {
  try {
    const peer = await registeredAncestor(configDir, start);
    if (!peer.procStart || await processStart(peer.pid) !== peer.procStart) return undefined;
    return { pid: peer.pid, procStart: peer.procStart, registrySessionId: peer.sessionId };
  } catch { return undefined; }
}

export function hookPaths(env = process.env) {
  return {
    configDir: env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    stateDir: env.CC_CDX_STATE_DIR ?? join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'plugin-state', 'claude-uds-bridge'),
  };
}

export async function runHook(raw: string, paths = hookPaths(), start = process.pid) {
  const input = hookInputSchema.parse(JSON.parse(raw));
  const engine = await hookEngine(paths.configDir, start);
  if (!engine) { appendObservation(paths.stateDir, 'hook-observations.jsonl', { event: input.hook_event_name, sessionId: input.session_id, engine: 'unregistered' }); return undefined; }
  return recordHookEvent(paths.stateDir, input, engine, Date.now(), join(paths.configDir, 'projects'));
}

if (import.meta.main) {
  try { await runHook(await Bun.stdin.text()); }
  catch { /* Never block or annotate the user's session. */ }
  process.exitCode = 0;
}
