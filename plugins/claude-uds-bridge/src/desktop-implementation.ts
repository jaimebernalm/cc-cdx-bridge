// Scoped Git implementation candidates for Desktop collaborations (desktop_runs), started from
// either host. It reuses the existing contract, capture and private-index preview, and keeps its own
// additive tables so legacy implementation_* rows are untouched. Authors are the verified
// principals the runtime injects. Checks are declarations, never executed here; readiness needs the
// exact candidate, every declared check passing for its hash, an agreeing review of that exact
// version from the other participant and a clean preview. It is not consensus, holds no editor
// locks and publishes nothing.
import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { uuid } from './claude';
import { captureImplementation, previewIntegration, type ImplementationPlan } from './implementation';

export type Principal = { provider: 'codex' | 'claude'; sessionId: string };
export type DesktopCandidate = Awaited<ReturnType<typeof captureImplementation>> & {
  resultId: string; version: number; author: string; originalAuthor: string; createdAt: number; operationId: string;
};
export type ExactReview = { author: string; resultId: string; version: number; verdict: 'agree' | 'revise' | 'disagree'; contextVersion: number; current: boolean };
export const desktopCheckSchema = z.object({
  candidateHash: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().trim().min(1).max(120), command: z.string().trim().min(1).max(1000),
  exitCode: z.number().int().min(-1).max(255), summary: z.string().trim().min(1).max(4000),
}).strict();
export type DesktopCheck = z.infer<typeof desktopCheckSchema>;
// captureImplementation refuses patches over this many bytes in total; candidates must be split.
export const maxCapturedPatchBytes = 16000;

const principalSchema = z.object({ provider: z.enum(['codex', 'claude']), sessionId: uuid }).strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (p: Principal) => `${p.provider}:${p.sessionId}`;

export class DesktopImplementation {
  constructor(private db: Database, private now = () => Date.now()) {}
  static install(db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS desktop_implementation_plans(run_id TEXT PRIMARY KEY REFERENCES desktop_runs(id),plan_hash TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_implementation_candidates(run_id TEXT NOT NULL REFERENCES desktop_runs(id),version INTEGER NOT NULL,author TEXT NOT NULL,content_hash TEXT NOT NULL,
        payload TEXT NOT NULL,PRIMARY KEY(run_id,version));
      CREATE TABLE IF NOT EXISTS desktop_implementation_operations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES desktop_runs(id),author TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_implementation_checks(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES desktop_runs(id),candidate_hash TEXT NOT NULL,author TEXT NOT NULL,
        payload TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  }

  /** Pins the contract once; the same contract is idempotent, a different one is refused. */
  prepare(runId: string, plan: ImplementationPlan) {
    const digest = hash(plan), old = this.db.query<{ plan_hash: string }, [string]>('SELECT plan_hash FROM desktop_implementation_plans WHERE run_id=?').get(uuid.parse(runId));
    if (old) { if (old.plan_hash !== digest) throw new Error('This collaboration already has a different implementation contract'); return plan; }
    this.db.run('INSERT INTO desktop_implementation_plans VALUES (?,?,?)', [runId, digest, JSON.stringify(plan)]);
    return plan;
  }
  plan(runId: string) {
    const row = this.db.query<{ payload: string }, [string]>('SELECT payload FROM desktop_implementation_plans WHERE run_id=?').get(uuid.parse(runId));
    return row ? JSON.parse(row.payload) as ImplementationPlan : null;
  }
  candidate(runId: string) {
    const row = this.db.query<{ payload: string }, [string]>('SELECT payload FROM desktop_implementation_candidates WHERE run_id=? ORDER BY version DESC LIMIT 1').get(uuid.parse(runId));
    return row ? JSON.parse(row.payload) as DesktopCandidate : null;
  }
  candidateFor(runId: string, resultId: string, version: number) {
    const row = this.db.query<{ payload: string }, [string, number]>('SELECT payload FROM desktop_implementation_candidates WHERE run_id=? AND version=?').get(uuid.parse(runId), version);
    const candidate = row ? JSON.parse(row.payload) as DesktopCandidate : null;
    return candidate?.resultId === resultId ? candidate : null;
  }
  private participant(plan: ImplementationPlan, raw: Principal) {
    const author = principalSchema.parse(raw);
    if (!plan.workspaces.some(w => w.provider === author.provider && w.sessionId === author.sessionId)) throw new Error('Only a participant of this contract can act on it');
    return key(author);
  }
  private requirePlan(runId: string) {
    const plan = this.plan(runId);
    if (!plan) throw new Error('No implementation contract in this collaboration');
    return plan;
  }
  private replay(runId: string, operationId: string, author: string, request: unknown) {
    const row = this.db.query<{ run_id: string; author: string; hash: string; result: string }, [string]>('SELECT * FROM desktop_implementation_operations WHERE id=?').get(uuid.parse(operationId));
    if (!row) return null;
    if (row.run_id !== runId || row.author !== author || row.hash !== hash(request)) throw new Error('Implementation operation ID reused with different content');
    return { ...JSON.parse(row.result), reused: true };
  }

  /** Captures both scoped workspaces. Versions are immutable; a result line keeps its original author. */
  // `guard` is the runtime's own check (run active, context version unchanged, caller still the same
  // process). Capture reads Git asynchronously, so it runs before reading and again inside the write.
  async capture(runId: string, rawAuthor: Principal, operationId: string, contextVersion: number, guard: () => void = () => {}) {
    const plan = this.requirePlan(runId), author = this.participant(plan, rawAuthor), request = { action: 'capture', contextVersion };
    const previous = this.replay(runId, operationId, author, request);
    if (previous) return previous as { candidate: DesktopCandidate; reused: true };
    guard();
    const captured = await captureImplementation(plan, contextVersion);
    return this.db.transaction(() => {
      const repeated = this.replay(runId, operationId, author, request);
      if (repeated) return repeated as { candidate: DesktopCandidate; reused: true };
      guard();
      const old = this.candidate(runId);
      if (old && old.originalAuthor !== author) throw new Error('Only the original author can version this candidate; review it instead');
      // Identical content is the same candidate: a new version would only invalidate its reviews and checks.
      if (old && old.contentHash === captured.contentHash) {
        const result = { candidate: old, unchanged: true };
        this.db.run('INSERT INTO desktop_implementation_operations VALUES (?,?,?,?,?)', [operationId, runId, author, hash(request), JSON.stringify(result)]);
        return { ...result, reused: false };
      }
      const candidate: DesktopCandidate = { ...captured, resultId: old?.resultId ?? randomUUID(), version: (old?.version ?? 0) + 1,
        author, originalAuthor: old?.originalAuthor ?? author, createdAt: this.now(), operationId };
      this.db.run('INSERT INTO desktop_implementation_candidates VALUES (?,?,?,?,?)', [runId, candidate.version, author, candidate.contentHash, JSON.stringify(candidate)]);
      const result = { candidate };
      this.db.run('INSERT INTO desktop_implementation_operations VALUES (?,?,?,?,?)', [operationId, runId, author, hash(request), JSON.stringify(result)]);
      return { ...result, reused: false };
    }).immediate();
  }

  /** Records a declared check for the exact current candidate; the core never runs it. */
  check(runId: string, operationId: string, rawAuthor: Principal, raw: DesktopCheck, guard: () => void = () => {}) {
    return this.db.transaction(() => {
      const plan = this.requirePlan(runId), author = this.participant(plan, rawAuthor), check = desktopCheckSchema.parse(raw);
      const previous = this.replay(runId, operationId, author, { action: 'check', ...check });
      if (previous) return previous;
      guard();
      const candidate = this.candidate(runId);
      if (!candidate || candidate.contentHash !== check.candidateHash) throw new Error('Check must name the current exact candidate hash');
      if (!plan.requiredChecks.includes(check.name)) throw new Error('Check name is outside the declared contract');
      const value = { ...check, author, declared: true, executedByCore: false, createdAt: this.now() };
      this.db.run('INSERT INTO desktop_implementation_checks VALUES (?,?,?,?,?,?)', [operationId, runId, check.candidateHash, author, JSON.stringify(value), this.now()]);
      this.db.run('INSERT INTO desktop_implementation_operations VALUES (?,?,?,?,?)', [operationId, runId, author, hash({ action: 'check', ...check }), JSON.stringify(value)]);
      return { ...value, reused: false };
    }).immediate();
  }

  status(runId: string) {
    const plan = this.plan(runId);
    if (!plan) return null;
    return { plan, candidate: this.candidate(runId), maxCapturedPatchBytes,
      checks: this.db.query<{ payload: string }, [string]>('SELECT payload FROM desktop_implementation_checks WHERE run_id=? ORDER BY created_at,rowid').all(runId).map(row => JSON.parse(row.payload)),
      readiness: 'not_rechecked' as const, enforcesEditorLocks: false, executesTests: false, publishesChanges: false };
  }

  /**
   * Rechecks the workspaces against the exact candidate. `reviews` come from the core's own report
   * store (never from tool arguments); `evidence()` re-reads them after the asynchronous work so a
   * change during inspection is reported instead of trusted.
   */
  async inspect(runId: string, input: { contextVersion: number; stateDir: string; reviews: ExactReview[]; evidence?: () => { contextVersion: number; reviews: ExactReview[] } }) {
    const implementation = this.status(runId);
    if (!implementation) throw new Error('No implementation contract in this collaboration');
    const { plan, candidate } = implementation, reasons: string[] = [];
    let integration: { clean: boolean; patch: string | null; error: string | null } | null = null;
    if (!candidate) return { ...implementation, ready: false, readiness: 'not_ready' as const, reasons: ['No candidate captured'], integration, evidence: null,
      verifiedAt: this.now(), testsVerifiedByCore: false, validatedConsensus: false };
    if (candidate.contextVersion !== input.contextVersion) reasons.push('Context changed after capture');
    const fresh = async (label: string) => {
      try { if ((await captureImplementation(plan, input.contextVersion)).contentHash !== candidate.contentHash) reasons.push(label); }
      catch (error) { reasons.push(error instanceof Error ? error.message : 'Workspace inspection failed'); }
    };
    await fresh('Workspace or context changed after capture');
    const checks = implementation.checks.filter((c: { candidateHash: string }) => c.candidateHash === candidate.contentHash) as (DesktopCheck & { author: string })[];
    for (const name of plan.requiredChecks) {
      const latest = checks.filter(c => c.name === name).at(-1);
      if (!latest || latest.exitCode !== 0) reasons.push('Missing or failed declared check: ' + name);
    }
    // The reviewer must be the other participant of this contract, not merely someone else.
    const participants = new Set(plan.workspaces.map(w => `${w.provider}:${w.sessionId}`));
    const review = input.reviews.filter(r => r.current && r.contextVersion === input.contextVersion && r.author !== candidate.originalAuthor && participants.has(r.author)
      && r.resultId === candidate.resultId && r.version === candidate.version).at(-1);
    if (!review || review.verdict !== 'agree') reasons.push('Missing accepted review from the other participant for this exact candidate');
    if (!candidate.snapshots.some(s => s.patch)) reasons.push('Candidate has no changes');
    if (!reasons.some(r => /changed|scope|identity/i.test(r))) {
      try { integration = await previewIntegration(plan, candidate, input.stateDir); if (!integration.clean) reasons.push('Integration conflict: ' + integration.error); }
      catch (error) { reasons.push(error instanceof Error ? error.message : 'Integration inspection failed'); }
    }
    await fresh('Workspace changed during inspection');
    const after = input.evidence?.();
    const latest = this.status(runId)!;
    if ((after && (after.contextVersion !== input.contextVersion || hash(after.reviews) !== hash(input.reviews)))
      || latest.candidate?.version !== candidate.version || hash(latest.checks) !== hash(implementation.checks)) {
      reasons.push('Candidate, context or evidence changed during inspection');
    }
    const checkAuthors = [...new Set(checks.map(c => c.author))];
    return { ...implementation, ready: reasons.length === 0, readiness: reasons.length ? 'not_ready' as const : 'ready_to_integrate' as const, reasons, integration,
      evidence: { candidateAuthor: candidate.originalAuthor, reviewAuthor: review?.author ?? null, checkAuthors,
        checksOnlyByCandidateAuthor: checkAuthors.length > 0 && checkAuthors.every(a => a === candidate.originalAuthor) },
      verifiedAt: this.now(), testsVerifiedByCore: false, validatedConsensus: false };
  }
}
