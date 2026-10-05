import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { DesktopCoordination, type ReviewSnapshot, type ResultSnapshot } from '../src/desktop-coordination';
import type { Report, Task } from '../src/routines';

let db: Database, coordination: DesktopCoordination, runId: string;
const codex = `codex:${randomUUID()}`, claude = `claude:${randomUUID()}`, outsider = `claude:${randomUUID()}`;
const analyze = (): Task => ({ taskId: randomUUID(), intent: 'analyze' });
const analysis = (taskId: string): Report => ({ kind: 'response', taskId, declaredState: 'analysis', disagreements: [] });

beforeEach(() => {
  db = new Database(':memory:'); db.exec('PRAGMA foreign_keys=ON; CREATE TABLE desktop_runs(id TEXT PRIMARY KEY);');
  runId = randomUUID(); db.run('INSERT INTO desktop_runs VALUES (?)', [runId]);
  DesktopCoordination.install(db); coordination = new DesktopCoordination(db);
});
afterEach(() => db.close());

function barrierRun() {
  coordination.prepare(runId, [codex, claude], { initialBarrier: true });
  const a = analyze(), b = analyze();
  coordination.assign(runId, { assigner: codex, assignee: codex, contextVersion: 1, task: a });
  coordination.assign(runId, { assigner: codex, assignee: claude, contextVersion: 1, task: b, messageId: randomUUID() });
  return { a, b };
}

test('without coordination a run is unstructured and states its limits', () => {
  expect(coordination.sendAllowed(runId, 1).allowed).toBe(true);
  expect(coordination.status(runId, 1)).toMatchObject({ structured: false, guarantees: { intellectualIndependence: 'not_guaranteed', rawNativeClaudeTrafficControlled: false, forcesRounds: false, consensus: 'never_declared' } });
  expect(() => coordination.prepare(runId, [codex, `codex:${randomUUID()}`], {})).toThrow('one Codex and one Claude');
  expect(() => coordination.prepare(randomUUID(), [codex, claude], {})).toThrow();
});

test('the initial barrier admits one analyze task per participant and withholds reports until both analyses exist', () => {
  const { a, b } = barrierRun();
  expect(coordination.status(runId, 1)).toMatchObject({ structured: true, phase: 'independent_analysis', barrierOpen: false });
  expect(coordination.sendAllowed(runId, 1, { taskId: randomUUID(), intent: 'discuss' }).allowed).toBe(false);
  expect(coordination.sendAllowed(runId, 1).allowed).toBe(false);
  expect(coordination.sendAllowed(runId, 1, analyze()).allowed).toBe(true);
  expect(() => coordination.assign(runId, { assigner: codex, assignee: claude, contextVersion: 1, task: analyze() })).toThrow('already has');
  expect(() => coordination.assign(runId, { assigner: codex, assignee: claude, contextVersion: 1, task: { taskId: randomUUID(), intent: 'discuss' } })).toThrow('only admits');
  expect(() => coordination.assign(runId, { assigner: outsider, assignee: claude, contextVersion: 1, task: analyze() })).toThrow('participant');
  const reports = [{ id: 'r1', author: codex }, { id: 'r2', author: claude }];
  coordination.complete(runId, codex, randomUUID(), 1, analysis(a.taskId));
  expect(coordination.visibleReports(runId, claude, 1, reports)).toEqual([{ id: 'r2', author: claude }]);
  expect(coordination.visibleReports(runId, codex, 1, reports)).toEqual([{ id: 'r1', author: codex }]);
  expect(() => coordination.complete(runId, claude, randomUUID(), 1, { kind: 'response', taskId: b.taskId, declaredState: 'perspective', disagreements: [] })).toThrow('analysis response');
  expect(coordination.complete(runId, claude, randomUUID(), 1, analysis(b.taskId))).toMatchObject({ barrierOpen: true });
  expect(coordination.visibleReports(runId, claude, 1, reports)).toEqual(reports);
  expect(coordination.sendAllowed(runId, 1, { taskId: randomUUID(), intent: 'discuss' }).allowed).toBe(true);
});

test("reports must answer the caller's own assignment in the current context, once", () => {
  const { a, b } = barrierRun();
  expect(() => coordination.complete(runId, claude, randomUUID(), 1, analysis(a.taskId))).toThrow('assignee');
  expect(() => coordination.complete(runId, codex, randomUUID(), 2, analysis(a.taskId))).toThrow('assignee or context');
  expect(() => coordination.complete(runId, codex, randomUUID(), 1, { kind: 'response', declaredState: 'analysis', disagreements: [] })).toThrow('assigned task');
  coordination.complete(runId, codex, randomUUID(), 1, analysis(a.taskId));
  expect(() => coordination.complete(runId, codex, randomUUID(), 1, analysis(a.taskId))).toThrow('already answered');
  expect(() => coordination.assign(runId, { assigner: codex, assignee: claude, contextVersion: 1, task: { ...b, intent: 'discuss' } })).toThrow('reused');
});

test('a context change stales open tasks and re-arms the barrier; skipping it fails closed', () => {
  const { a } = barrierRun();
  coordination.complete(runId, codex, randomUUID(), 1, analysis(a.taskId));
  coordination.contextChanged(runId, 2);
  expect(coordination.status(runId, 2)).toMatchObject({ barrierOpen: false, phase: 'independent_analysis' });
  expect((coordination.status(runId, 2) as { tasks: { state: string }[] }).tasks.map(t => t.state)).toEqual(['validated', 'stale']);
  expect(() => coordination.assign(runId, { assigner: codex, assignee: codex, contextVersion: 1, task: analyze() })).toThrow('stale context');
  // Open the barrier for version 2, then read it as version 3 without contextChanged: closed again.
  const c = analyze(), d = analyze();
  coordination.assign(runId, { assigner: codex, assignee: codex, contextVersion: 2, task: c });
  coordination.assign(runId, { assigner: claude, assignee: claude, contextVersion: 2, task: d });
  coordination.complete(runId, codex, randomUUID(), 2, analysis(c.taskId));
  coordination.complete(runId, claude, randomUUID(), 2, analysis(d.taskId));
  expect(coordination.status(runId, 2)).toMatchObject({ barrierOpen: true });
  expect(coordination.status(runId, 3)).toMatchObject({ barrierOpen: false });
});

test('reviews must match the exact assigned target; phases never cross a closed barrier and are idempotent', () => {
  coordination.prepare(runId, [codex, claude], { initialBarrier: true });
  expect(() => coordination.phase(runId, codex, randomUUID(), 0, 'synthesis', 1)).toThrow('closed initial barrier');
  const unbarred = randomUUID(); db.run('INSERT INTO desktop_runs VALUES (?)', [unbarred]);
  coordination.prepare(unbarred, [codex, claude], {});
  const command = randomUUID();
  expect(coordination.phase(unbarred, codex, command, 0, 'critique', 1)).toMatchObject({ phase: 'critique', revision: 1 });
  expect(coordination.phase(unbarred, codex, command, 0, 'critique', 1)).toMatchObject({ phase: 'critique', revision: 1 });
  expect(() => coordination.phase(unbarred, codex, command, 0, 'synthesis', 1)).toThrow('reused');
  expect(() => coordination.phase(unbarred, codex, randomUUID(), 0, 'synthesis', 1)).toThrow('inspect before');
  const resultId = randomUUID(), review: Task = { taskId: randomUUID(), intent: 'review', target: { resultId, version: 2 } };
  coordination.assign(unbarred, { assigner: codex, assignee: claude, contextVersion: 1, task: review });
  expect(() => coordination.complete(unbarred, claude, randomUUID(), 1, { kind: 'review', taskId: review.taskId, resultId, version: 1, verdict: 'agree', disagreements: [] })).toThrow('exact task target');
  expect(coordination.complete(unbarred, claude, randomUUID(), 1, { kind: 'review', taskId: review.taskId, resultId, version: 2, verdict: 'agree', disagreements: [] })).toBeTruthy();
});

test('closure names an exact result, snapshots its reviews and disagreements, and is written once', () => {
  coordination.prepare(runId, [codex, claude], {});
  const result: ResultSnapshot = { resultId: randomUUID(), version: 2, author: codex, contentHash: 'h', contextVersion: 1 };
  const reviews: ReviewSnapshot[] = [{ author: claude, resultId: result.resultId, version: 2, verdict: 'revise', contextVersion: 1, current: true, disagreements: ['naming'] },
    { author: claude, resultId: result.resultId, version: 1, verdict: 'agree', contextVersion: 1, current: false, disagreements: [] }];
  expect(() => coordination.close(runId, codex, { result: { resultId: result.resultId, version: 3 }, summary: 's', disposition: 'proposal' }, { result, reviews, contextVersion: 1 })).toThrow('exact result');
  expect(() => coordination.close(runId, outsider, { summary: 's', disposition: 'incomplete' }, { result: null, reviews: [], contextVersion: 1 })).toThrow('participant');
  // A proposal despite a current objection is allowed; the objection is kept and flagged.
  const closure = coordination.close(runId, codex, { result: { resultId: result.resultId, version: 2 }, summary: 'own proposal', disposition: 'proposal' }, { result, reviews, contextVersion: 1 });
  expect(closure).toMatchObject({ disagreements: ['naming'], consensus: 'not_declared', reviews: [reviews[0]], derivedReviewState: 'objections_present', hasCurrentObjections: true });
  expect(coordination.close(runId, codex, { result: { resultId: result.resultId, version: 2 }, summary: 'own proposal', disposition: 'proposal' }, { result, reviews, contextVersion: 1 })).toEqual(closure);
  expect(() => coordination.close(runId, claude, { summary: 'other', disposition: 'incomplete' }, { result: null, reviews: [], contextVersion: 1 })).toThrow('different closure');
  expect(coordination.status(runId, 1).closure).toMatchObject({ closer: codex, closure: { disposition: 'proposal' }, consensus: 'not_declared' });
});

test('closure review state is derived: unreviewed, agreed by reviewers, or objections present', () => {
  coordination.prepare(runId, [codex, claude], {});
  const result: ResultSnapshot = { resultId: randomUUID(), version: 1, author: codex, contentHash: 'h', contextVersion: 1 };
  const other = randomUUID(); db.run('INSERT INTO desktop_runs VALUES (?)', [other]);
  expect(coordination.close(runId, codex, { result: { resultId: result.resultId, version: 1 }, summary: 's', disposition: 'proposal' }, { result, reviews: [], contextVersion: 1 }))
    .toMatchObject({ derivedReviewState: 'unreviewed', hasCurrentObjections: false });
  expect(coordination.close(other, claude, { result: { resultId: result.resultId, version: 1 }, summary: 's', disposition: 'proposal' },
    { result, reviews: [{ author: claude, resultId: result.resultId, version: 1, verdict: 'agree', contextVersion: 1, current: true, disagreements: [] }], contextVersion: 1 }))
    .toMatchObject({ derivedReviewState: 'agreed_by_reviewers', consensus: 'not_declared' });
});

test('a task ID replays only exactly: another assigner, context version or message is refused', () => {
  coordination.prepare(runId, [codex, claude], {});
  const task: Task = { taskId: randomUUID(), intent: 'discuss' }, messageId = randomUUID();
  const first = coordination.assign(runId, { assigner: codex, assignee: claude, contextVersion: 1, messageId, task });
  expect(coordination.assign(runId, { assigner: codex, assignee: claude, contextVersion: 1, messageId, task })).toEqual(first);
  expect(() => coordination.assign(runId, { assigner: claude, assignee: claude, contextVersion: 1, messageId, task })).toThrow('reused');
  expect(() => coordination.assign(runId, { assigner: codex, assignee: claude, contextVersion: 2, messageId, task })).toThrow('reused');
  expect(() => coordination.assign(runId, { assigner: codex, assignee: claude, contextVersion: 1, messageId: randomUUID(), task })).toThrow('reused');
  expect(() => coordination.assign(runId, { assigner: codex, assignee: claude, contextVersion: 1, task })).toThrow('reused');
  // After a context change the old task is stale; reusing its ID for the new version is refused, not revived.
  coordination.contextChanged(runId, 2);
  expect(() => coordination.assign(runId, { assigner: codex, assignee: claude, contextVersion: 2, messageId, task })).toThrow('reused');
});
