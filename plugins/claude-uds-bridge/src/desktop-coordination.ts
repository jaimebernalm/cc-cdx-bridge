// Optional structured coordination for Desktop collaborations (desktop_runs): an initial analysis
// barrier, exact task assignment, phases and an attributed closure. Context versions, leases and
// delivery stay in DesktopRunStore; callers pass the current context version and verified
// principals. What this guarantees is narrow and stated in status(): reports registered through the
// core are withheld from the other participant until both initial analyses exist. It does not
// guarantee intellectual independence, does not control raw native Claude traffic, never forces
// rounds and never declares consensus.
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { uuid } from './claude';
import { closureSchema, reportSchema, taskSchema, type Closure, type Report, type Task } from './routines';

export const desktopPhaseSchema = z.enum(['context', 'independent_analysis', 'critique', 'verification', 'synthesis', 'final_review']);
export type DesktopPhase = z.infer<typeof desktopPhaseSchema>;
export const desktopCoordinationSchema = z.object({ initialBarrier: z.boolean().default(false) }).strict();
export type ResultSnapshot = { resultId: string; version: number; author: string; contentHash: string; contextVersion: number };
export type ReviewSnapshot = { author: string; resultId: string; version: number; verdict: 'agree' | 'revise' | 'disagree'; contextVersion: number; current: boolean; disagreements: string[] };
type Row = { run_id: string; participants: string; revision: number; phase: DesktopPhase; barrier: number; barrier_version: number | null; barrier_open: number; config: string };
type TaskRow = { id: string; run_id: string; message_id: string | null; assigner: string; assignee: string; context_version: number; phase: string; payload: string; state: string; response_id: string | null };

export const coordinationGuarantees = {
  withholdsRegisteredReports: true, intellectualIndependence: 'not_guaranteed', rawNativeClaudeTrafficControlled: false,
  forcesRounds: false, consensus: 'never_declared',
} as const;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const principalKey = z.string().regex(/^(codex|claude):[0-9a-f-]{36}$/);

export class DesktopCoordination {
  constructor(private db: Database, private now = () => Date.now()) {}
  static install(db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS desktop_coordination(run_id TEXT PRIMARY KEY REFERENCES desktop_runs(id),participants TEXT NOT NULL,revision INTEGER NOT NULL,
        phase TEXT NOT NULL,barrier INTEGER NOT NULL,barrier_version INTEGER,barrier_open INTEGER NOT NULL,config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_tasks(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES desktop_runs(id),message_id TEXT UNIQUE,assigner TEXT NOT NULL,assignee TEXT NOT NULL,
        context_version INTEGER NOT NULL,phase TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,response_id TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS desktop_coordination_commands(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES desktop_runs(id),hash TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_closures(run_id TEXT PRIMARY KEY REFERENCES desktop_runs(id),closer TEXT NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  }

  private row(runId: string) { return this.db.query<Row, [string]>('SELECT * FROM desktop_coordination WHERE run_id=?').get(uuid.parse(runId)); }
  private participants(row: Row) { return JSON.parse(row.participants) as [string, string]; }
  private member(row: Row, who: string) { if (!this.participants(row).includes(who)) throw new Error('Only a participant of this collaboration can do this'); }

  /** Optional: runs without a row behave as unstructured (no barrier, no task rules). */
  prepare(runId: string, participants: [string, string], input: unknown, contextVersion = 1) {
    const config = desktopCoordinationSchema.parse(input ?? {}), pair = participants.map(p => principalKey.parse(p)) as [string, string];
    if (pair[0] === pair[1] || pair[0].split(':')[0] === pair[1].split(':')[0]) throw new Error('Coordination needs one Codex and one Claude participant');
    if (this.row(runId)) throw new Error('Coordination is already prepared for this collaboration');
    this.db.run('INSERT INTO desktop_coordination VALUES (?,?,0,?,?,?,?,?)', [runId, JSON.stringify(pair), config.initialBarrier ? 'independent_analysis' : 'context',
      config.initialBarrier ? 1 : 0, config.initialBarrier ? contextVersion : null, config.initialBarrier ? 0 : 1, JSON.stringify(config)]);
  }

  // Fail-closed: an open barrier only counts for the context version it opened in. If the core moves
  // to a new version without calling contextChanged, the barrier reads as closed again.
  private barrierClosed(row: Row, contextVersion: number) { return !!row.barrier && (!row.barrier_open || row.barrier_version !== contextVersion); }

  /** Whether the core may send this work now. Before the barrier only one initial analyze task per participant passes. */
  sendAllowed(runId: string, contextVersion: number, task?: Task) {
    const row = this.row(runId);
    if (!row || !this.barrierClosed(row, contextVersion)) return { allowed: true as const };
    if (task?.intent === 'analyze' && row.phase === 'independent_analysis') return { allowed: true as const };
    return { allowed: false as const, reason: 'Initial barrier: only the initial analysis task may be sent until both analyses are registered' };
  }

  /** Assigns a task to the caller itself (local) or to the exact other participant (destination). */
  assign(runId: string, input: { assigner: string; assignee: string; contextVersion: number; messageId?: string | null; task: Task }) {
    return this.db.transaction(() => {
      const row = this.row(runId); if (!row) throw new Error('No structured coordination in this collaboration');
      const task = taskSchema.parse(input.task), assigner = principalKey.parse(input.assigner), assignee = principalKey.parse(input.assignee);
      this.member(row, assigner); this.member(row, assignee);
      // A replay is answered before any rule that the first assignment itself changed.
      const old = this.db.query<TaskRow, [string]>('SELECT * FROM desktop_tasks WHERE id=?').get(task.taskId);
      // Only an exact replay is idempotent: same run, both principals, context version, message and task.
      if (old) {
        if (old.run_id !== runId || old.assigner !== assigner || old.assignee !== assignee || old.context_version !== input.contextVersion
          || old.message_id !== (input.messageId ?? null) || old.payload !== JSON.stringify(task)) throw new Error('Task ID reused with different content');
        return this.taskView(old);
      }
      if (row.barrier_version !== null && input.contextVersion < row.barrier_version) throw new Error('Task belongs to a stale context');
      if (this.barrierClosed(row, input.contextVersion)) {
        if (task.intent !== 'analyze' || row.phase !== 'independent_analysis') throw new Error('Initial barrier only admits initial analyze tasks');
        if (this.db.query("SELECT 1 FROM desktop_tasks WHERE run_id=? AND assignee=? AND context_version=? AND phase='independent_analysis' AND state!='stale'").get(runId, assignee, input.contextVersion)) {
          throw new Error('This participant already has its initial analysis task');
        }
      }
      this.db.run("INSERT INTO desktop_tasks VALUES (?,?,?,?,?,?,?,?,'assigned',NULL)", [task.taskId, runId, input.messageId ?? null, assigner, assignee, input.contextVersion, row.phase, JSON.stringify(task)]);
      return this.taskView(this.db.query<TaskRow, [string]>('SELECT * FROM desktop_tasks WHERE id=?').get(task.taskId)!);
    }).immediate();
  }
  private taskView(row: TaskRow) { return { ...row, task: JSON.parse(row.payload) as Task, payload: undefined }; }

  /** Checks a report against its exact assignment without recording anything. */
  validate(runId: string, author: string, contextVersion: number, raw: Report) {
    const row = this.row(runId); if (!row) return;
    const report = reportSchema.parse(raw); this.member(row, principalKey.parse(author));
    if (!report.taskId) throw new Error('Structured coordination requires an assigned task');
    const task = this.db.query<TaskRow, [string]>('SELECT * FROM desktop_tasks WHERE id=?').get(report.taskId);
    if (!task || task.run_id !== runId || task.assignee !== author || task.context_version !== contextVersion) throw new Error('Wrong task assignee or context');
    if (task.state !== 'assigned') throw new Error('Task already answered or invalidated');
    const requested = taskSchema.parse(JSON.parse(task.payload));
    if (report.kind === 'review' && (requested.intent !== 'review' || requested.target?.resultId !== report.resultId || requested.target.version !== report.version)) throw new Error('Review does not match the exact task target');
    if (this.barrierClosed(row, contextVersion) && !(report.kind === 'response' && report.declaredState === 'analysis')) throw new Error('Initial task requires an analysis response');
  }

  /** Marks the task answered; opens the barrier once both participants answered their initial analysis. */
  complete(runId: string, author: string, reportId: string, contextVersion: number, raw: Report) {
    return this.db.transaction(() => {
      const row = this.row(runId); if (!row) return null;
      this.validate(runId, author, contextVersion, raw);
      const report = reportSchema.parse(raw);
      this.db.run("UPDATE desktop_tasks SET state='validated',response_id=? WHERE id=? AND state='assigned'", [uuid.parse(reportId), report.taskId!]);
      if (this.barrierClosed(row, contextVersion)) {
        const answered = this.db.query<{ n: number }, [string, number]>("SELECT COUNT(DISTINCT assignee) n FROM desktop_tasks WHERE run_id=? AND context_version=? AND phase='independent_analysis' AND state='validated'").get(runId, contextVersion)!.n;
        if (answered === 2) this.db.run('UPDATE desktop_coordination SET barrier_open=1,barrier_version=?,revision=revision+1 WHERE run_id=?', [contextVersion, runId]);
      }
      return this.status(runId, contextVersion);
    }).immediate();
  }

  /** Reports registered while the barrier is closed are visible only to their own author. */
  visibleReports<T extends { id: string; author: string }>(runId: string, viewer: string, contextVersion: number, reports: T[]) {
    const row = this.row(runId);
    if (!row || !this.barrierClosed(row, contextVersion)) return reports;
    return reports.filter(report => report.author === viewer);
  }

  /** Called by the core after it increments the context version: open tasks go stale and the barrier re-arms. */
  contextChanged(runId: string, newVersion: number) {
    const row = this.row(runId); if (!row) return;
    this.db.run("UPDATE desktop_tasks SET state='stale' WHERE run_id=? AND state='assigned'", [runId]);
    this.db.run('UPDATE desktop_coordination SET barrier_version=?,barrier_open=?,phase=?,revision=revision+1 WHERE run_id=?',
      [row.barrier ? newVersion : null, row.barrier ? 0 : 1, row.barrier ? 'independent_analysis' : 'context', runId]);
  }

  /** Phase changes are declared steps, not required rounds; they cannot cross a closed barrier. */
  phase(runId: string, actor: string, commandId: string, expectedRevision: number, phase: DesktopPhase, contextVersion: number) {
    return this.db.transaction(() => {
      const row = this.row(runId); if (!row) throw new Error('No structured coordination in this collaboration');
      const next = desktopPhaseSchema.parse(phase), digest = hash({ runId, actor, expectedRevision, phase: next });
      const old = this.db.query<{ hash: string }, [string]>('SELECT hash FROM desktop_coordination_commands WHERE id=?').get(uuid.parse(commandId));
      if (old) { if (old.hash !== digest) throw new Error('Command ID reused with different content'); return this.status(runId, contextVersion); }
      if (row.revision !== expectedRevision) throw new Error('Coordination changed; inspect before acting');
      if (this.barrierClosed(row, contextVersion) && next !== 'independent_analysis') throw new Error('Cannot cross a closed initial barrier');
      this.db.run('UPDATE desktop_coordination SET phase=?,revision=revision+1 WHERE run_id=?', [next, runId]);
      this.db.run('INSERT INTO desktop_coordination_commands VALUES (?,?,?,?)', [commandId, runId, digest, row.revision + 1]);
      return this.status(runId, contextVersion);
    }).immediate();
  }

  /**
   * Records how the collaboration ended. The core supplies exact snapshots of the named result and of
   * the current reviews; disagreements are copied, never resolved, and never block the closure.
   * One closure per run.
   */
  close(runId: string, closer: string, raw: Closure, evidence: { result: ResultSnapshot | null; reviews: ReviewSnapshot[]; contextVersion: number }) {
    return this.db.transaction(() => {
      const closure = closureSchema.parse(raw), who = principalKey.parse(closer), row = this.row(runId);
      if (row) this.member(row, who);
      if (closure.result && (!evidence.result || evidence.result.resultId !== closure.result.resultId || evidence.result.version !== closure.result.version)) {
        throw new Error('Closure must name an existing exact result version');
      }
      if (!closure.result && evidence.result) throw new Error('Result evidence supplied without naming a result');
      const reviews = evidence.result ? evidence.reviews.filter(r => r.resultId === evidence.result!.resultId && r.version === evidence.result!.version) : [];
      const disagreements = [...new Set(reviews.flatMap(r => r.disagreements))];
      // The closer may propose despite objections; they are derived and shown, never a gate or a verdict.
      const current = reviews.filter(r => r.current);
      const derivedReviewState = !current.length ? 'unreviewed' : current.every(r => r.verdict === 'agree') ? 'agreed_by_reviewers' : 'objections_present';
      const payload = { closure, result: evidence.result, reviews, disagreements, derivedReviewState, hasCurrentObjections: derivedReviewState === 'objections_present',
        contextVersion: evidence.contextVersion, consensus: 'not_declared', closedAt: this.now() };
      const digest = hash({ closer: who, closure, result: evidence.result, reviews });
      const old = this.db.query<{ hash: string; payload: string }, [string]>('SELECT hash,payload FROM desktop_closures WHERE run_id=?').get(runId);
      if (old) { if (old.hash !== digest) throw new Error('This collaboration already has a different closure'); return JSON.parse(old.payload); }
      this.db.run('INSERT INTO desktop_closures VALUES (?,?,?,?,?)', [runId, who, digest, JSON.stringify(payload), this.now()]);
      return payload;
    }).immediate();
  }

  status(runId: string, contextVersion: number) {
    const row = this.row(runId), closure = this.db.query<{ payload: string; closer: string }, [string]>('SELECT payload,closer FROM desktop_closures WHERE run_id=?').get(uuid.parse(runId));
    const closed = closure ? { closer: closure.closer, ...JSON.parse(closure.payload) } : null;
    if (!row) return { structured: false as const, closure: closed, guarantees: coordinationGuarantees };
    return { structured: true as const, revision: row.revision, phase: row.phase, initialBarrier: !!row.barrier, barrierOpen: !this.barrierClosed(row, contextVersion),
      participants: this.participants(row),
      tasks: this.db.query<TaskRow, [string]>('SELECT * FROM desktop_tasks WHERE run_id=? ORDER BY rowid').all(runId).map(t => this.taskView(t)),
      closure: closed, guarantees: coordinationGuarantees };
  }
}
