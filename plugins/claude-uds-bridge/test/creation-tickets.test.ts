import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CreationTickets, type Candidate, type CreationReceipt, type PanelActor, type Principal } from '../src/creation-tickets';

let root: string, project: string, other: string, now: number, store: CreationTickets;
const panel: PanelActor = { kind: 'panel_session', id: 'panel-session-0123456789' };
const agent: Principal = { provider: 'codex', sessionId: randomUUID() };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccdx-tickets-')); chmodSync(root, 0o700);
  project = join(root, 'project'); other = join(root, 'other'); mkdirSync(project); mkdirSync(other);
  now = 1_000_000; store = new CreationTickets(join(root, 'state'), () => now);
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

const input = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), targetProvider: 'claude', project, mode: 'local', adapter: 'assisted_ui', branch: 'main', ...extra });
const candidate = (extra: Partial<Candidate> = {}): Candidate => ({ provider: 'claude', sessionId: randomUUID(), pid: 4242, procStart: 'Mon Oct  5 21:00:00 2026', project, branch: 'main', startedAt: now, ...extra });
const receipt = (c: Candidate, correlationId: string, extra: Partial<CreationReceipt> = {}): CreationReceipt =>
  ({ correlationId, sessionId: c.sessionId, enginePid: c.pid, procStart: c.procStart, cwd: project, priorUserTurns: 0, at: now, ...extra });
const grantInput = (extra: Record<string, unknown> = {}) => ({ actionId: randomUUID(), project, targetProvider: 'claude', adapter: 'assisted_ui', mode: 'local', actions: ['create', 'bind'], maxActive: 1, maxPerHour: 2, ...extra });
function created() {
  const t = store.requestFromPanel(panel, input()).ticket;
  const claim = store.claimCreating(t.id, 'executor-a');
  store.markCreated(t.id, claim.epoch, { hostRef: null });
  return { id: t.id, correlationId: claim.correlationId };
}

test('an agent request waits for a panel session; agents cannot authorize', () => {
  const t = store.request(agent, input()).ticket;
  expect(t).toMatchObject({ state: 'requested', origin: 'agent', authorizedBy: null, correlationId: null });
  expect(() => store.claimCreating(t.id, 'x')).toThrow('requested');
  expect(() => store.authorize(agent as unknown as PanelActor, t.id, 0)).toThrow();
  expect(() => store.authorize(panel, t.id, 7)).toThrow('changed');
  const authorized = store.authorize(panel, t.id, t.revision);
  expect(authorized).toMatchObject({ state: 'authorized', authorizedBy: 'panel_session:' + panel.id });
  expect(authorized.correlationId).toMatch(/^[0-9a-f-]{36}$/);
});

test('request IDs are idempotent and reject changed content', () => {
  const first = input();
  const a = store.request(agent, first), b = store.request(agent, first);
  expect(b).toMatchObject({ reused: true, ticket: { id: a.ticket.id } });
  expect(() => store.request(agent, { ...first, model: 'other' })).toThrow('different content');
});

test('a separate creation grant authorizes within scope and limits, never from the reception grant', () => {
  const g = store.grant(panel, grantInput());
  const t = store.request(agent, input()).ticket;
  expect(t).toMatchObject({ state: 'authorized', authorizedBy: 'grant:' + g.id, grantId: g.id });
  // maxActive 1: a second open ticket waits for the panel.
  expect(store.request(agent, input()).ticket).toMatchObject({ state: 'requested', reason: 'grant_limit_reached' });
  // Other project, provider, adapter or mode never match.
  expect(store.request(agent, input({ project: other })).ticket.state).toBe('requested');
  expect(store.request(agent, input({ targetProvider: 'codex' })).ticket.state).toBe('requested');
  expect(store.request(agent, input({ adapter: 'manual' })).ticket.state).toBe('requested');
  store.revokeGrant(panel, g.id);
  store.cancel(agent, t.id);
  expect(store.request(agent, input()).ticket.state).toBe('requested');
  expect(() => store.grant(agent as unknown as PanelActor, grantInput())).toThrow();
});

test('grants expire, bind to the folder identity and honor the hourly rate', () => {
  store.grant(panel, grantInput({ expiresAt: now + 1000, maxActive: 10, maxPerHour: 2 }));
  expect(store.request(agent, input()).ticket.state).toBe('authorized');
  expect(store.request(agent, input()).ticket.state).toBe('authorized');
  expect(store.request(agent, input()).ticket).toMatchObject({ state: 'requested', reason: 'grant_limit_reached' });
  now += 2000;
  expect(store.request(agent, input()).ticket).toMatchObject({ state: 'requested', reason: null });
  // A folder replaced at the same path is a different project.
  const fresh = new CreationTickets(join(root, 'state2'), () => now);
  try {
    fresh.grant(panel, grantInput());
    renameSync(project, join(root, 'moved')); mkdirSync(project);
    expect(fresh.request(agent, input()).ticket.state).toBe('requested');
  } finally { fresh.close(); }
});

test('creation is claimed once and an uncertain outcome is never retried', () => {
  const t = store.requestFromPanel(panel, input()).ticket;
  expect(t.state).toBe('authorized');
  const claim = store.claimCreating(t.id, 'executor-a');
  expect(() => store.claimCreating(t.id, 'executor-b')).toThrow('already claimed');
  expect(() => store.cancel(panel, t.id)).toThrow('in progress');
  store.markUncertain(t.id, claim.epoch, 'ack lost');
  expect(() => store.claimCreating(t.id, 'executor-a')).toThrow('creation_uncertain');
  expect(() => store.markCreated(t.id, claim.epoch)).toThrow('Stale');
  // The TTL does not turn an uncertain creation into something retryable.
  now += 3_600_000;
  expect(store.get(t.id).state).toBe('creation_uncertain');
});

test('failure without host effect is explicit; anything else must be uncertain', () => {
  const t = store.requestFromPanel(panel, input()).ticket, claim = store.claimCreating(t.id, 'x');
  expect(() => store.markFailed(t.id, claim.epoch, { effect: 'maybe' as 'none', reason: 'r' })).toThrow('uncertain');
  expect(store.markFailed(t.id, claim.epoch, { effect: 'none', reason: 'adapter unavailable' }).state).toBe('failed');
});

test('authorized tickets expire; open candidates: 0 waits, 2 is ambiguous', () => {
  const stale = store.requestFromPanel(panel, input({ ttlSeconds: 60 })).ticket;
  now += 61_000;
  expect(store.get(stale.id).state).toBe('expired');
  const { id } = created();
  expect(store.observe(id, []).decision).toBe('waiting');
  const old = candidate({ startedAt: now - 1 }), elsewhere = candidate({ project: other });
  expect(store.observe(id, [old, elsewhere]).decision).toBe('waiting');
  expect(store.observe(id, [candidate()]).decision).toBe('single_candidate_needs_receipt');
  expect(store.observe(id, [candidate(), candidate()]).decision).toBe('ambiguous');
  expect(store.get(id).state).toBe('ambiguous');
});

test('verified binding needs the correlated, fresh, unused session in the same project and branch', () => {
  const { id, correlationId } = created(), c = candidate();
  expect(() => store.bindVerified(id, c, receipt(c, randomUUID()))).toThrow('another ticket');
  expect(() => store.bindVerified(id, c, receipt(c, correlationId, { sessionId: randomUUID() }))).toThrow('disagree');
  expect(() => store.bindVerified(id, c, receipt(c, correlationId, { priorUserTurns: 2 }))).toThrow('already had');
  expect(() => store.bindVerified(id, c, receipt(c, correlationId, { priorUserTurns: null }))).toThrow('already had');
  expect(() => store.bindVerified(id, { ...c, startedAt: now - 5 }, receipt(c, correlationId))).toThrow('before authorization');
  expect(() => store.bindVerified(id, { ...c, branch: 'other' }, receipt(c, correlationId))).toThrow('branch');
  expect(() => store.bindVerified(id, { ...c, provider: 'codex' }, receipt(c, correlationId))).toThrow('provider');
  expect(() => store.bindVerified(id, c, receipt(c, correlationId, { cwd: other }))).toThrow('another project');
  const bound = store.bindVerified(id, c, receipt(c, correlationId));
  expect(bound).toMatchObject({ state: 'bound', bound: { sessionId: c.sessionId, binding: 'host_receipt' } });
  // The same session cannot satisfy a second ticket.
  const second = created();
  expect(() => store.bindVerified(second.id, c, receipt(c, second.correlationId))).toThrow('already bound');
});

test('a host reference is only a pointer that the receipt must match', () => {
  const t = store.requestFromPanel(panel, input()).ticket, claim = store.claimCreating(t.id, 'x'), c = candidate();
  store.markCreated(t.id, claim.epoch, { hostRef: randomUUID() });
  expect(() => store.bindVerified(t.id, c, receipt(c, claim.correlationId))).toThrow('host reference');
});

test('a grant without bind leaves binding to a panel session', () => {
  store.grant(panel, grantInput({ actions: ['create'] }));
  const t = store.request(agent, input()).ticket, claim = store.claimCreating(t.id, 'x'), c = candidate();
  store.markCreated(t.id, claim.epoch);
  expect(() => store.bindVerified(t.id, c, receipt(c, claim.correlationId))).toThrow('panel session');
  expect(() => store.bindManual(panel, t.id, candidate({ startedAt: t.createdAt - 1 }))).toThrow('opened after');
  expect(store.bindManual(panel, t.id, c)).toMatchObject({ state: 'bound', bound: { binding: 'panel_session' } });
});

test('panel scope limits which project a panel session can act on', () => {
  const scoped: PanelActor = { ...panel, scope: { project: other } };
  expect(() => store.requestFromPanel(scoped, input())).toThrow('scoped');
  const t = store.request(agent, input()).ticket;
  expect(() => store.authorize(scoped, t.id, t.revision)).toThrow('scoped');
});

test('bootstrap is claimed once per bound ticket', () => {
  const { id, correlationId } = created(), c = candidate(), message = randomUUID();
  expect(() => store.claimBootstrap(id, message)).toThrow('bound');
  store.bindVerified(id, c, receipt(c, correlationId));
  expect(store.claimBootstrap(id, message)).toEqual({ reused: false });
  expect(store.claimBootstrap(id, message)).toEqual({ reused: true });
  expect(() => store.claimBootstrap(id, randomUUID())).toThrow('already sent');
});

test('only the requester or a panel session cancels; events attribute every change', () => {
  const t = store.request(agent, input()).ticket;
  expect(() => store.cancel({ provider: 'claude', sessionId: randomUUID() }, t.id)).toThrow('requester');
  store.cancel(agent, t.id);
  expect(store.events(t.id).map(event => [event.type, event.actor])).toEqual([['requested', 'codex:' + agent.sessionId], ['cancelled', 'codex:' + agent.sessionId]]);
});

test('state is private and holds no prompt text', () => {
  const decoy = 'decoy-' + randomUUID();
  store.request(agent, input({ model: 'claude-opus-5-5' }));
  expect(() => store.request(agent, input({ prompt: decoy }))).toThrow();
  const state = join(root, 'state');
  for (const name of readdirSync(state)) {
    const path = join(state, name);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(readFileSync(path).includes(decoy)).toBe(false);
  }
  expect(store.list(project).length).toBe(1);
  expect(store.list(realpathSync(other)).length).toBe(0);
});

test('every creation effect is fenced by the claimed epoch', () => {
  const t = store.requestFromPanel(panel, input()).ticket, claim = store.claimCreating(t.id, 'x');
  for (const effect of [() => store.markCreated(t.id, claim.epoch + 1), () => store.markUncertain(t.id, claim.epoch - 1, 'r'),
    () => store.markFailed(t.id, claim.epoch + 1, { effect: 'none', reason: 'r' })]) expect(effect).toThrow('Stale');
  store.markCreated(t.id, claim.epoch);
  // After the outcome is recorded the same epoch cannot record a different one.
  expect(() => store.markUncertain(t.id, claim.epoch, 'late')).toThrow('Stale');
  expect(() => store.markFailed(t.id, claim.epoch, { effect: 'none', reason: 'late' })).toThrow('Stale');
});

test('binding requires the requested snapshot: branch, detached HEAD and commit', () => {
  const head = 'a'.repeat(40), t = store.requestFromPanel(panel, input({ head })).ticket, claim = store.claimCreating(t.id, 'x');
  store.markCreated(t.id, claim.epoch);
  const c = candidate({ head });
  expect(() => store.bindVerified(t.id, { ...c, head: 'b'.repeat(40) }, receipt(c, claim.correlationId))).toThrow('HEAD moved');
  expect(() => store.bindVerified(t.id, { ...c, head: null }, receipt(c, claim.correlationId))).toThrow('HEAD moved');
  expect(() => store.bindManual(panel, t.id, { ...c, branch: null })).toThrow('branch');
  expect(() => store.bindManual(panel, t.id, { ...c, head: 'b'.repeat(40) })).toThrow('HEAD moved');
  expect(store.bindVerified(t.id, c, receipt(c, claim.correlationId)).state).toBe('bound');
});

test('a chat created under a grant still binds after the grant is revoked', () => {
  const g = store.grant(panel, grantInput());
  const t = store.request(agent, input()).ticket, claim = store.claimCreating(t.id, 'x'), c = candidate();
  store.markCreated(t.id, claim.epoch);
  store.revokeGrant(panel, g.id);
  expect(store.bindVerified(t.id, c, receipt(c, claim.correlationId))).toMatchObject({ state: 'bound', bound: { binding: 'host_receipt' } });
});

test('the binding window starts when the chat is created, not at the request', () => {
  const t = store.requestFromPanel(panel, input({ ttlSeconds: 60 })).ticket;
  now += 50_000;
  const claim = store.claimCreating(t.id, 'x');
  store.markCreated(t.id, claim.epoch);
  now += 50_000; // past the original expiry, within 60s of creation
  const c = candidate({ startedAt: now });
  expect(store.get(t.id).state).toBe('awaiting_receiver');
  expect(store.bindVerified(t.id, c, receipt(c, claim.correlationId))).toMatchObject({ state: 'bound' });
  const late = store.requestFromPanel(panel, input({ ttlSeconds: 60 })).ticket, lateClaim = store.claimCreating(late.id, 'y');
  store.markCreated(late.id, lateClaim.epoch);
  now += 61_000;
  expect(store.get(late.id).state).toBe('expired');
});
