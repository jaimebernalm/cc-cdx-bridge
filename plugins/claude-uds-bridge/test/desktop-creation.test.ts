import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CreationTickets, type PanelActor } from '../src/creation-tickets';
import { DesktopCreation, type ExecutorCaller } from '../src/desktop-creation';

let root: string, project: string, other: string, tickets: CreationTickets, creation: DesktopCreation;
const panel: PanelActor = { kind: 'panel_session', id: 'panel-session-0123456789' };
const caller = (provider: 'codex' | 'claude', extra: Partial<ExecutorCaller> = {}): ExecutorCaller =>
  ({ provider, sessionId: randomUUID(), pid: 1000 + Math.floor(Math.random() * 1000), procStart: 'Mon Oct  5 21:00:00 2026', project, ...extra });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccdx-creation-')); chmodSync(root, 0o700);
  project = join(root, 'project'); other = join(root, 'other'); mkdirSync(project); mkdirSync(other);
  tickets = new CreationTickets(join(root, 'state')); creation = new DesktopCreation(tickets);
});
afterEach(() => { tickets.close(); rmSync(root, { recursive: true, force: true }); });

function ticket(requester: ExecutorCaller, extra: Record<string, unknown> = {}, authorize = true) {
  const t = tickets.request({ provider: requester.provider, sessionId: requester.sessionId },
    { requestId: randomUUID(), targetProvider: requester.provider === 'codex' ? 'claude' : 'codex', project, mode: 'local', adapter: 'assisted_ui', ...extra }).ticket;
  return authorize ? tickets.authorize(panel, t.id, t.revision) : t;
}

test('the requester runs an authorized assisted UI creation once, with a correlated bootstrap prompt', () => {
  const codex = caller('codex'), t = ticket(codex, { model: 'claude-opus-5-5', branch: 'main' });
  const plan = creation.begin(codex, t.id);
  expect(plan).toMatchObject({ adapter: 'assisted_ui', epoch: 1, correlationId: t.correlationId, evidence: 'panel_session_or_creation_grant' });
  expect(plan.bootstrapPrompt.split('\n')[0]).toBe(`CCDX-CORR-${t.correlationId}`);
  expect(plan.bootstrapPrompt).toContain('desktop_collaboration_discover');
  expect(plan.bootstrapPrompt).toContain('grants no permissions');
  expect(plan.steps.join(' ')).toContain('claude-opus-5-5');
  expect(plan.forbidden.join(' ')).toContain('127.0.0.1');
  expect(() => creation.begin(codex, t.id)).toThrow('already claimed');
  expect(creation.complete(codex, t.id, plan.epoch).state).toBe('awaiting_receiver');
});

test('without panel authorization or a creation grant nothing can begin', () => {
  const codex = caller('codex'), t = ticket(codex, {}, false);
  expect(() => creation.begin(codex, t.id)).toThrow('requested');
});

test('a caller that is neither requester nor delegated, or works elsewhere, cannot execute', () => {
  const codex = caller('codex'), t = ticket(codex);
  expect(() => creation.begin(caller('codex'), t.id)).toThrow('requester or the delegated');
  expect(() => creation.begin({ ...codex, project: other }, t.id)).toThrow('another project');
  expect(() => creation.begin({ ...codex, sessionId: 'not-a-uuid' }, t.id)).toThrow();
});

test('Claude asking for a new Codex chat needs a panel delegation to an exact live Codex process', () => {
  const claude = caller('claude'), t = ticket(claude, { adapter: 'native_tool_relay' }), codex = caller('codex');
  // The requester itself cannot use Codex's native tool.
  expect(() => creation.begin(claude, t.id)).toThrow('native tool relay');
  // Agents cannot delegate; only a panel session can.
  expect(() => creation.delegate(claude as unknown as PanelActor, t.id, codex)).toThrow();
  expect(() => creation.delegate(panel, t.id, caller('claude'))).toThrow('native tool relay');
  expect(() => creation.delegate(panel, t.id, { ...codex, project: other })).toThrow('another project');
  expect(() => creation.delegate({ ...panel, scope: { project: other } }, t.id, codex)).toThrow('scoped');
  creation.delegate(panel, t.id, codex);
  // A reused PID with another start time is a different process.
  expect(() => creation.begin({ ...codex, procStart: 'Tue Oct  6 00:00:00 2026' }, t.id)).toThrow('delegated');
  expect(() => creation.begin({ ...codex, pid: codex.pid + 1 }, t.id)).toThrow('delegated');
  const plan = creation.begin(codex, t.id);
  expect(plan.adapter).toBe('native_tool_relay');
  expect(plan.steps.join(' ')).toContain('create_thread');
  const hostRef = randomUUID();
  expect(creation.complete(codex, t.id, plan.epoch, { hostRef }).hostRef).toBe(hostRef);
});

test('adapters must match the target: assisted UI only creates Claude chats', () => {
  const claude = caller('claude'), t = ticket(claude, { adapter: 'assisted_ui' });
  expect(() => creation.begin(claude, t.id)).toThrow('only planned for Claude');
});

test('outcomes are fenced by epoch and executor; uncertain is final and never recreated', () => {
  const codex = caller('codex'), t = ticket(codex), plan = creation.begin(codex, t.id);
  expect(() => creation.complete(codex, t.id, plan.epoch + 1)).toThrow('Stale');
  expect(() => creation.complete(caller('codex'), t.id, plan.epoch)).toThrow('began');
  expect(() => creation.complete({ ...codex, procStart: 'other' }, t.id, plan.epoch)).toThrow('began');
  expect(() => creation.failed(codex, t.id, plan.epoch, { effect: 'maybe' as 'none', reason: 'x' })).toThrow('uncertain');
  expect(creation.uncertain(codex, t.id, plan.epoch, 'ack lost').state).toBe('creation_uncertain');
  // Replays of the same epoch cannot rewrite the outcome, and nothing can start a second creation.
  expect(() => creation.complete(codex, t.id, plan.epoch)).toThrow('Stale');
  expect(() => creation.uncertain(codex, t.id, plan.epoch, 'again')).toThrow('Stale');
  expect(() => creation.begin(codex, t.id)).toThrow('creation_uncertain');
  expect(() => creation.delegate(panel, t.id, caller('codex'))).toThrow('creation_uncertain');
});

test('manual creation performs nothing: it only instructs a person and waits for the new chat', () => {
  const claude = caller('claude'), t = ticket(claude, { adapter: 'manual' });
  const plan = creation.begin(claude, t.id);
  expect(plan.adapter).toBe('manual');
  expect(plan.steps[0]).toContain('Ask the person');
  expect(tickets.get(t.id)).toMatchObject({ state: 'awaiting_receiver', degradation: 'manual_human_creation', hostRef: null });
  expect(() => creation.complete(claude, t.id, plan.epoch)).toThrow('Stale');
});

test('delegation and execution are recorded as attributed ticket events', () => {
  const claude = caller('claude'), t = ticket(claude, { adapter: 'native_tool_relay' }), codex = caller('codex');
  creation.delegate(panel, t.id, codex);
  creation.begin(codex, t.id);
  const events = tickets.events(t.id).map(event => [event.type, event.actor]);
  expect(events).toContainEqual(['executor_delegated', 'panel_session:' + panel.id]);
  expect(events).toContainEqual(['creating', `executor:codex:${codex.sessionId}:${codex.pid}`]);
});

test('a project folder replaced at the same path after authorization cannot be used', () => {
  const codex = caller('codex'), t = ticket(codex);
  renameSync(project, join(root, 'old-project')); mkdirSync(project);
  expect(() => creation.begin(codex, t.id)).toThrow('another project');
  expect(() => tickets.claimCreating(t.id, 'direct')).toThrow('replaced');
});

test('completion requires the pinned folder; a replacement mid-creation can only be reported uncertain', () => {
  const codex = caller('codex'), t = ticket(codex), plan = creation.begin(codex, t.id);
  renameSync(project, join(root, 'old-project')); mkdirSync(project);
  expect(() => creation.complete(codex, t.id, plan.epoch)).toThrow('uncertain');
  expect(creation.uncertain(codex, t.id, plan.epoch, 'project folder replaced').state).toBe('creation_uncertain');
});

test('new-worktree creation is refused up front: binding could never verify another folder', () => {
  expect(() => tickets.request({ provider: 'codex', sessionId: randomUUID() }, { requestId: randomUUID(), targetProvider: 'claude', project, mode: 'worktree', adapter: 'assisted_ui' })).toThrow('unsupported');
});
