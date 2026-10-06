import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git, inspectProject } from '../src/project';
import { normalizeImplementation, type ImplementationInput } from '../src/implementation';
import type { Participant } from '../src/participants';
import { DesktopImplementation, type ExactReview, type Principal } from '../src/desktop-implementation';

let root: string, repo: string, state: string, db: Database, ledger: DesktopImplementation, runId: string;
let codex: Principal, claude: Principal, plan: Awaited<ReturnType<typeof normalizeImplementation>>;

async function gitOK(cwd: string, args: string[]) { const r = await git(cwd, args); if (r.code !== 0) throw new Error(r.error); return r.output; }
const input = (root: string): ImplementationInput => ({ strategy: 'files', workspaces: { codex: { root, paths: ['codex.txt'] }, claude: { root, paths: ['claude.txt'] } }, requiredChecks: ['tests'] });
const key = (p: Principal) => `${p.provider}:${p.sessionId}`;
const review = (author: Principal, extra: Partial<ExactReview> = {}): ExactReview => {
  const c = ledger.candidate(runId)!;
  return { author: key(author), resultId: c.resultId, version: c.version, verdict: 'agree', contextVersion: 1, current: true, ...extra };
};
const passing = (hash: string) => ({ candidateHash: hash, name: 'tests', command: 'bun test', exitCode: 0, summary: 'all green' });

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccdx-impl-'))); chmodSync(root, 0o700);
  repo = join(root, 'repo'); state = join(root, 'state');
  await Bun.$`mkdir -p ${repo} ${state}`.quiet(); chmodSync(state, 0o700);
  await gitOK(repo, ['init', '-q']); await gitOK(repo, ['config', 'user.email', 'f@example.invalid']); await gitOK(repo, ['config', 'user.name', 'F']);
  writeFileSync(join(repo, 'codex.txt'), 'codex base\n'); writeFileSync(join(repo, 'claude.txt'), 'claude base\n');
  await gitOK(repo, ['add', '.']); await gitOK(repo, ['commit', '-qm', 'base']);
  const project = await inspectProject(repo);
  codex = { provider: 'codex', sessionId: randomUUID() }; claude = { provider: 'claude', sessionId: randomUUID() };
  const participants = [codex, claude].map((p, i) => ({ ...p, name: p.provider, surface: i ? 'claude-desktop' : 'codex-claude-uds-bridge', pid: i + 1,
    procStart: String(i), socketPath: `/tmp/${i}.sock`, version: null, status: 'idle', project })) as Participant[];
  plan = await normalizeImplementation(input(repo), participants);
  db = new Database(join(state, 'collaborations.sqlite')); db.exec('PRAGMA foreign_keys=ON; CREATE TABLE desktop_runs(id TEXT PRIMARY KEY);');
  runId = randomUUID(); db.run('INSERT INTO desktop_runs VALUES (?)', [runId]);
  DesktopImplementation.install(db); ledger = new DesktopImplementation(db);
  ledger.prepare(runId, plan);
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

test('without a candidate the inspection is simply not ready', async () => {
  expect(await ledger.inspect(runId, { contextVersion: 1, stateDir: state, reviews: [] })).toMatchObject({ ready: false, reasons: ['No candidate captured'], evidence: null });
});

test('the contract is pinned once and only for an existing Desktop collaboration', () => {
  expect(ledger.prepare(runId, plan)).toEqual(plan);
  expect(() => ledger.prepare(runId, { ...plan, requiredChecks: ['lint'] })).toThrow('different implementation contract');
  expect(() => ledger.prepare(randomUUID(), plan)).toThrow();
  expect(ledger.status(runId)).toMatchObject({ readiness: 'not_rechecked', executesTests: false, publishesChanges: false, enforcesEditorLocks: false, maxCapturedPatchBytes: 16000 });
});

test('captures scoped dirty changes with immutable versions owned by the original author', async () => {
  writeFileSync(join(repo, 'codex.txt'), 'codex change\n');
  const op = randomUUID(), first = await ledger.capture(runId, codex, op, 1);
  expect(first).toMatchObject({ reused: false, candidate: { version: 1, author: key(codex), originalAuthor: key(codex) } });
  expect((await ledger.capture(runId, codex, op, 1)).reused).toBe(true);
  await expect(ledger.capture(runId, codex, op, 2)).rejects.toThrow('different content');
  await expect(ledger.capture(runId, { provider: 'claude', sessionId: randomUUID() }, randomUUID(), 1)).rejects.toThrow('participant');
  await expect(ledger.capture(runId, claude, randomUUID(), 1)).rejects.toThrow('original author');
  writeFileSync(join(repo, 'codex.txt'), 'codex change 2\n');
  const second = await ledger.capture(runId, codex, randomUUID(), 1);
  expect(second.candidate).toMatchObject({ version: 2, resultId: first.candidate.resultId });
  expect(ledger.candidateFor(runId, first.candidate.resultId, 1)?.contentHash).toBe(first.candidate.contentHash);
  // Changes outside the declared scope are refused by the shared capture.
  writeFileSync(join(repo, 'stray.txt'), 'x\n');
  await expect(ledger.capture(runId, codex, randomUUID(), 1)).rejects.toThrow('outside the declared scope');
});

test('checks are attributed declarations for the exact current candidate', async () => {
  writeFileSync(join(repo, 'codex.txt'), 'codex change\n');
  const { candidate } = await ledger.capture(runId, codex, randomUUID(), 1);
  expect(() => ledger.check(runId, randomUUID(), codex, passing('0'.repeat(64)))).toThrow('exact candidate');
  expect(() => ledger.check(runId, randomUUID(), codex, { ...passing(candidate.contentHash), name: 'lint' })).toThrow('outside the declared contract');
  expect(() => ledger.check(runId, randomUUID(), { provider: 'codex', sessionId: randomUUID() }, passing(candidate.contentHash))).toThrow('participant');
  const op = randomUUID(), check = ledger.check(runId, op, claude, passing(candidate.contentHash));
  expect(check).toMatchObject({ author: key(claude), declared: true, executedByCore: false, reused: false });
  expect(ledger.check(runId, op, claude, passing(candidate.contentHash)).reused).toBe(true);
  expect(() => ledger.check(runId, op, codex, passing(candidate.contentHash))).toThrow('different content');
});

test('readiness needs a fresh exact candidate, passing checks, the other participant agreeing and a clean preview', async () => {
  writeFileSync(join(repo, 'codex.txt'), 'codex change\n');
  const { candidate } = await ledger.capture(runId, codex, randomUUID(), 1);
  ledger.check(runId, randomUUID(), codex, passing(candidate.contentHash));
  const inspect = (reviews: ExactReview[], contextVersion = 1) => ledger.inspect(runId, { contextVersion, stateDir: state, reviews });
  // A self-review is not the other participant's review.
  expect((await inspect([review(codex)])).reasons).toContain('Missing accepted review from the other participant for this exact candidate');
  expect((await inspect([review(claude, { verdict: 'revise' })])).ready).toBe(false);
  expect((await inspect([review(claude, { version: 99 })])).ready).toBe(false);
  expect((await inspect([review(claude, { current: false })])).ready).toBe(false);
  const ready = await inspect([review(claude)]);
  expect(ready).toMatchObject({ ready: true, readiness: 'ready_to_integrate', testsVerifiedByCore: false, validatedConsensus: false,
    evidence: { candidateAuthor: key(codex), reviewAuthor: key(claude), checksOnlyByCandidateAuthor: true } });
  expect(ready.integration?.clean).toBe(true);
  expect((await inspect([review(claude, { contextVersion: 2 })], 2)).reasons).toContain('Context changed after capture');
  writeFileSync(join(repo, 'codex.txt'), 'edited after capture\n');
  expect((await inspect([review(claude)])).reasons).toContain('Workspace or context changed after capture');
});

test('a failed declared check or evidence that changes during inspection is never ready', async () => {
  writeFileSync(join(repo, 'claude.txt'), 'claude change\n');
  const { candidate } = await ledger.capture(runId, claude, randomUUID(), 1);
  ledger.check(runId, randomUUID(), codex, { ...passing(candidate.contentHash), exitCode: 1 });
  expect((await ledger.inspect(runId, { contextVersion: 1, stateDir: state, reviews: [review(codex)] })).reasons).toContain('Missing or failed declared check: tests');
  ledger.check(runId, randomUUID(), codex, passing(candidate.contentHash));
  const changing = await ledger.inspect(runId, { contextVersion: 1, stateDir: state, reviews: [review(codex)],
    evidence: () => ({ contextVersion: 1, reviews: [review(codex, { verdict: 'disagree' })] }) });
  expect(changing.reasons).toContain('Candidate, context or evidence changed during inspection');
  expect((await ledger.inspect(runId, { contextVersion: 1, stateDir: state, reviews: [review(codex)] })).evidence?.checksOnlyByCandidateAuthor).toBe(false);
});

test('legacy implementation tables are not touched', () => {
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  expect(tables.filter(name => name.startsWith('implementation_'))).toEqual([]);
  expect(tables.filter(name => name.startsWith('desktop_implementation_')).sort()).toEqual(['desktop_implementation_candidates', 'desktop_implementation_checks', 'desktop_implementation_operations', 'desktop_implementation_plans']);
});

test('the runtime guard runs before reading and again inside the write; a failing guard records nothing', async () => {
  writeFileSync(join(repo, 'codex.txt'), 'codex change\n');
  let calls = 0, closeAfter = 1;
  const guard = () => { calls++; if (calls > closeAfter) throw new Error('Desktop collaboration is paused'); };
  await expect(ledger.capture(runId, codex, randomUUID(), 1, guard)).rejects.toThrow('paused');
  expect(calls).toBe(2);
  expect(ledger.candidate(runId)).toBeNull();
  const { candidate } = await ledger.capture(runId, codex, randomUUID(), 1);
  expect(() => ledger.check(runId, randomUUID(), claude, passing(candidate.contentHash), () => { throw new Error('Context changed'); })).toThrow('Context changed');
  expect(ledger.status(runId)!.checks).toEqual([]);
});

test('a review from outside the contract never satisfies readiness', async () => {
  writeFileSync(join(repo, 'codex.txt'), 'codex change\n');
  const { candidate } = await ledger.capture(runId, codex, randomUUID(), 1);
  ledger.check(runId, randomUUID(), codex, passing(candidate.contentHash));
  const outsider = await ledger.inspect(runId, { contextVersion: 1, stateDir: state, reviews: [review({ provider: 'claude', sessionId: randomUUID() })] });
  expect(outsider.reasons).toContain('Missing accepted review from the other participant for this exact candidate');
});

test('the candidate hash binds context, contract and every snapshot', async () => {
  writeFileSync(join(repo, 'codex.txt'), 'codex change\n');
  const one = (await ledger.capture(runId, codex, randomUUID(), 1)).candidate;
  const again = await ledger.capture(runId, codex, randomUUID(), 1);
  // Recapturing identical content keeps the reviewed version instead of minting a new one.
  expect(again).toMatchObject({ unchanged: true, candidate: { version: 1, contentHash: one.contentHash } });
  const otherContext = (await ledger.capture(runId, codex, randomUUID(), 2)).candidate;
  expect(otherContext.contentHash).not.toBe(one.contentHash);
  writeFileSync(join(repo, 'claude.txt'), 'claude change\n');
  expect((await ledger.capture(runId, codex, randomUUID(), 1)).candidate.contentHash).not.toBe(one.contentHash);
});
