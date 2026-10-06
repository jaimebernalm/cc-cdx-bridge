import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import net from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { processStart } from '../src/claude';
import { authenticateClaudeCaller, CallerRejected, metaSessionHints, type AncestorStep } from '../src/claude-caller';
import { consumeCorrelation, peekCorrelation, priorUserTurns, readHookSession, recordHookEvent, type HookEngine } from '../src/claude-hook';
import { createClaudeServer } from '../src/claude-server';

let root: string, configDir: string, stateDir: string, project: string, socketPath: string;
let socket: net.Server, child: ReturnType<typeof Bun.spawn>, ownStart: string;
const sessionId = randomUUID();

beforeAll(async () => {
  ownStart = await processStart(process.pid);
  // A live child whose parent is this test process: the test process plays the session engine.
  child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
});
afterAll(() => { child.kill(); });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ccdx-caller-'));
  chmodSync(root, 0o700);
  configDir = join(root, 'config'); stateDir = join(root, 'state'); project = join(root, 'project');
  for (const directory of [configDir, join(configDir, 'sessions'), project, join(root, 'socks')]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  socketPath = join(root, 'socks', 's.sock');
  socket = net.createServer();
  await new Promise<void>(resolve => socket.listen(socketPath, resolve));
  chmodSync(socketPath, 0o600);
});
afterEach(async () => {
  await new Promise<void>(resolve => socket.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

function record(pid: number, fields: Record<string, unknown> = {}) {
  const path = join(configDir, 'sessions', `${pid}.json`);
  writeFileSync(path, JSON.stringify({ pid, sessionId, messagingSocketPath: socketPath, cwd: project, peerProtocol: 1,
    procStart: ownStart, entrypoint: 'claude-desktop', name: 'test', status: 'idle', ...fields }));
}
const authenticate = (extra: { meta?: Record<string, unknown>; expectedProject?: string } = {}, trace?: AncestorStep[]) =>
  authenticateClaudeCaller({ configDir, stateDir, pid: child.pid, ...extra }, trace);
async function rejection(promise: Promise<unknown>) {
  try { await promise; } catch (error) { if (error instanceof CallerRejected) return error.code; throw error; }
  throw new Error('Expected a rejection');
}
const engine = (): HookEngine => ({ pid: process.pid, procStart: ownStart, registrySessionId: sessionId });
const hookInput = (event: 'SessionStart' | 'UserPromptSubmit' | 'SessionEnd', extra: Record<string, unknown> = {}) =>
  ({ session_id: sessionId, cwd: project, hook_event_name: event, ...extra }) as Parameters<typeof recordHookEvent>[1];

test('binds the nearest registered ancestor from process evidence alone', async () => {
  record(process.pid);
  const trace: AncestorStep[] = [];
  const caller = await authenticate({}, trace);
  expect(caller).toMatchObject({ provider: 'claude', sessionId, pid: process.pid, procStart: ownStart,
    binding: { method: 'claude_process_ancestry', surface: 'claude-desktop' } });
  expect(caller.project).toBe(realpathSync(project));
  expect(trace[0]).toEqual({ pid: process.pid, registered: true, command: expect.stringMatching(/bun/) });
  expect(caller.binding.generation).toMatch(/^[0-9a-f]{32}$/);
});

test('rejects when no ancestor is a registered session (shared or host-managed MCP)', async () => {
  expect(await rejection(authenticate())).toBe('caller_unavailable');
});

test('rejects a reused PID whose recorded start time differs', async () => {
  record(process.pid, { procStart: 'Thu Jan  1 00:00:00 2026' });
  expect(await rejection(authenticate())).toBe('caller_stale');
});

test('metadata can only confirm the session, never choose it', async () => {
  record(process.pid);
  expect(await rejection(authenticate({ meta: { sessionId: randomUUID() } }))).toBe('caller_mismatch');
  expect(await rejection(authenticate({ meta: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: randomUUID() }) } }))).toBe('caller_mismatch');
  expect((await authenticate({ meta: { 'claude/sessionId': sessionId } })).binding.evidence).toContain('meta_session_match');
  expect(metaSessionHints({ progressToken: 3, nested: { session_id: sessionId } })).toEqual([sessionId]);
});

test('only Claude Code Desktop sessions qualify; bridge receivers and other surfaces are rejected', async () => {
  for (const entrypoint of ['codex-claude-uds-bridge', 'cli', 'claude-vscode', undefined]) {
    record(process.pid, { entrypoint });
    expect(await rejection(authenticate())).toBe('caller_mismatch');
  }
});

test('two live processes claiming one session are ambiguous', async () => {
  record(process.pid); record(child.pid);
  expect(await rejection(authenticate())).toBe('caller_ambiguous');
});

test('a different project is rejected when the caller must work in a given folder', async () => {
  record(process.pid);
  const other = join(root, 'other'); mkdirSync(other);
  expect(await rejection(authenticate({ expectedProject: other }))).toBe('caller_mismatch');
  expect((await authenticate({ expectedProject: project })).binding.evidence).toContain('project_identity');
});

test('hook generations bind, detect clear/resume transitions and end the session', async () => {
  record(process.pid);
  const started = await recordHookEvent(stateDir, hookInput('SessionStart', { source: 'startup', model: 'claude-opus-5-5' }), engine());
  const bound = await authenticate();
  expect(bound.binding).toMatchObject({ method: 'claude_process_ancestry+hook', generation: started.generation });
  // /clear: the hook sees the new session before the registry does.
  const cleared = randomUUID();
  await recordHookEvent(stateDir, { ...hookInput('SessionStart', { source: 'clear' }), session_id: cleared }, { ...engine(), registrySessionId: sessionId });
  expect(await rejection(authenticate())).toBe('caller_transition');
  await recordHookEvent(stateDir, hookInput('SessionStart', { source: 'resume' }), engine());
  expect((await authenticate()).binding.generation).not.toBe(started.generation);
  await recordHookEvent(stateDir, hookInput('SessionEnd'), engine());
  expect(await rejection(authenticate())).toBe('caller_stale');
});

test('a sidecar from an earlier process with the same PID is ignored', async () => {
  record(process.pid);
  await recordHookEvent(stateDir, hookInput('SessionEnd'), { ...engine(), procStart: 'Thu Jan  1 00:00:00 2026' });
  expect(readHookSession(stateDir, process.pid, ownStart)).toBeUndefined();
  expect((await authenticate()).binding.method).toBe('claude_process_ancestry');
});

test('prompts are never persisted; a correlation id is recorded once and consumed once', async () => {
  const correlationId = randomUUID(), decoy = `secret-decoy-${randomUUID()}`;
  const transcript = join(root, 'transcript.jsonl');
  writeFileSync(transcript, [{ type: 'user', message: { content: decoy } }, { type: 'assistant' }, { type: 'user', isMeta: true }]
    .map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
  await recordHookEvent(stateDir, hookInput('UserPromptSubmit', { prompt: `${decoy} CCDX-CORR-${correlationId}`, transcript_path: transcript }), engine());
  await recordHookEvent(stateDir, hookInput('UserPromptSubmit', { prompt: `again CCDX-CORR-${correlationId}` }), engine());
  await recordHookEvent(stateDir, hookInput('UserPromptSubmit', { prompt: decoy }), engine());
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
  for (const file of files(stateDir)) {
    expect(readFileSync(file, 'utf8')).not.toContain(decoy);
    expect(statSync(file).mode & 0o077).toBe(0);
  }
  const receipt = consumeCorrelation(stateDir, correlationId);
  expect(receipt).toMatchObject({ correlationId, sessionId, enginePid: process.pid, priorUserTurns: 1 });
  expect(consumeCorrelation(stateDir, correlationId)).toBeUndefined();
  expect(priorUserTurns('relative/path')).toBeNull();
});

test('the hook entrypoint never writes to stdout and always exits 0', async () => {
  record(process.pid);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, CC_CDX_STATE_DIR: stateDir };
  for (const input of [JSON.stringify(hookInput('SessionStart', { source: 'startup' })), 'not json']) {
    const run = Bun.spawn(['bun', join(import.meta.dir, '../src/claude-hook.ts')], { env, stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe' });
    expect(await run.exited).toBe(0);
    expect(await new Response(run.stdout).text()).toBe('');
  }
  // The hook's own parent is this registered test process, so the record names it.
  expect(readHookSession(stateDir, process.pid, ownStart)?.sessionId).toBe(sessionId);
});

test('caller_status takes no input and reports bound identity or a rejection', async () => {
  const server = createClaudeServer({ configDir, stateDir, pid: child.pid });
  const client = new Client({ name: 'test', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const tools = await client.listTools();
  expect(tools.tools.map(tool => tool.name)).toEqual(['caller_status']);
  expect(Object.keys(tools.tools[0]!.inputSchema.properties ?? {})).toEqual([]);
  const rejected = await client.callTool({ name: 'caller_status', arguments: {} });
  expect(rejected.isError).toBe(true);
  record(process.pid);
  const ok = await client.callTool({ name: 'caller_status', arguments: {}, _meta: { note: 'value-not-logged' } });
  const report = JSON.parse((ok.content as { text: string }[])[0]!.text);
  expect(report.caller.sessionId).toBe(sessionId);
  // This server was not launched by the host as a plugin (no CLAUDE_PLUGIN_ROOT here).
  expect(report.hostLaunch).toMatchObject({ pluginRootEnv: false, directChildOfEngine: true, launcherOnly: true });
  const log = readFileSync(join(stateDir, 'claude-spike', 'observations.jsonl'), 'utf8');
  expect(log).toContain('"note"');
  expect(log).not.toContain('value-not-logged');
  await client.close();
});

test('correlation receipts need registry agreement and a transcript under Claude projects', async () => {
  const correlationId = randomUUID(), projects = join(configDir, 'projects', 'p');
  mkdirSync(projects, { recursive: true });
  const inside = join(projects, 't.jsonl'), outside = join(root, 'fake.jsonl');
  writeFileSync(inside, JSON.stringify({ type: 'user' }) + '\n', { mode: 0o600 });
  writeFileSync(outside, '', { mode: 0o600 });
  await recordHookEvent(stateDir, hookInput('UserPromptSubmit', { prompt: `CCDX-CORR-${correlationId}` }), { ...engine(), registrySessionId: randomUUID() });
  expect(consumeCorrelation(stateDir, correlationId)).toBeUndefined();
  await recordHookEvent(stateDir, hookInput('UserPromptSubmit', { prompt: `CCDX-CORR-${correlationId}`, transcript_path: outside }), engine(), Date.now(), join(configDir, 'projects'));
  expect(consumeCorrelation(stateDir, correlationId)?.priorUserTurns).toBeNull();
  const second = randomUUID();
  await recordHookEvent(stateDir, hookInput('UserPromptSubmit', { prompt: `CCDX-CORR-${second}`, transcript_path: inside }), engine(), Date.now(), join(configDir, 'projects'));
  expect(consumeCorrelation(stateDir, second)?.priorUserTurns).toBe(1);
  // Every prompt also records the bare count, which S0 uses to set the bind threshold.
  expect(readFileSync(join(stateDir, 'claude-spike', 'hook-observations.jsonl'), 'utf8')).toContain('"priorUserTurns":1');
});

test('an unreadable or shared hook record fails closed', async () => {
  record(process.pid);
  await recordHookEvent(stateDir, hookInput('SessionStart'), engine());
  chmodSync(join(stateDir, 'claude-callers', `${process.pid}.json`), 0o644);
  expect(await rejection(authenticate())).toBe('caller_stale');
});

test('a receipt can be inspected without consuming it, then consumed exactly once', async () => {
  const correlationId = randomUUID();
  expect(peekCorrelation(stateDir, correlationId)).toBeUndefined();
  await recordHookEvent(stateDir, hookInput('UserPromptSubmit', { prompt: `CCDX-CORR-${correlationId}` }), engine());
  expect(peekCorrelation(stateDir, correlationId)?.sessionId).toBe(sessionId);
  expect(peekCorrelation(stateDir, correlationId)?.sessionId).toBe(sessionId);
  expect(consumeCorrelation(stateDir, correlationId)?.sessionId).toBe(sessionId);
  expect(peekCorrelation(stateDir, correlationId)).toBeUndefined();
  expect(() => peekCorrelation(stateDir, 'not-a-uuid')).toThrow();
});

test('a first prompt whose transcript the host has not written yet counts as zero earlier turns', async () => {
  const projects = join(configDir, 'projects'), folder = join(projects, 'p');
  mkdirSync(folder, { recursive: true });
  expect(priorUserTurns(join(folder, `${sessionId}.jsonl`), projects, sessionId)).toBe(0);
  // Only the host's own naming in an existing project folder qualifies.
  expect(priorUserTurns(join(folder, 'other.jsonl'), projects, sessionId)).toBeNull();
  expect(priorUserTurns(join(projects, 'missing-folder', `${sessionId}.jsonl`), projects, sessionId)).toBeNull();
  expect(priorUserTurns(join(root, `${sessionId}.jsonl`), projects, sessionId)).toBeNull();
  expect(priorUserTurns(join(folder, `${sessionId}.jsonl`), undefined, sessionId)).toBeNull();
  const correlationId = randomUUID();
  await recordHookEvent(stateDir, hookInput('UserPromptSubmit', { prompt: `CCDX-CORR-${correlationId}`, transcript_path: join(folder, `${sessionId}.jsonl`) }), engine(), Date.now(), projects);
  expect(consumeCorrelation(stateDir, correlationId)?.priorUserTurns).toBe(0);
});

test('diagnostic observation logs rotate once past their size cap', async () => {
  const { appendObservation } = await import('../src/claude-sidecar');
  for (let i = 0; i < 40; i++) appendObservation(stateDir, 'cap.jsonl', { i, pad: 'x'.repeat(100) }, 1000);
  const spike = join(stateDir, 'claude-spike');
  expect(statSync(join(spike, 'cap.jsonl')).size).toBeLessThan(1200);
  expect(statSync(join(spike, 'cap.jsonl.1')).size).toBeLessThan(1200);
  expect(readdirSync(spike).filter(name => name.startsWith('cap.jsonl')).sort()).toEqual(['cap.jsonl', 'cap.jsonl.1']);
});
