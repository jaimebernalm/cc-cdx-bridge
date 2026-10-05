// Durable tickets for opening a new Desktop conversation of the other agent. A ticket is not a
// collaboration: it records who asked, who authorized, how the chat was (or may have been)
// created and which session it was bound to. Authority comes only from a panel session or from a
// separate, revocable creation grant; the reception grant never authorizes creation. Creation is
// claimed once and never repeated after an uncertain outcome. Binding is automatic only with a
// correlated host receipt; otherwise a panel session chooses. No prompt text is stored.
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { privateDirectory, uuid } from './claude';

export type Provider = 'codex' | 'claude';
export type Principal = { provider: Provider; sessionId: string };
export type PanelActor = { kind: 'panel_session'; id: string; scope?: { project: string } };
export type Adapter = 'manual' | 'assisted_ui' | 'native_tool_relay';
export type TicketState = 'requested' | 'authorized' | 'creating' | 'awaiting_receiver' | 'creation_uncertain' | 'bound' | 'ambiguous' | 'expired' | 'cancelled' | 'failed';
export type Candidate = { provider: Provider; sessionId: string; pid: number; procStart: string; project: string; branch: string | null; head?: string | null; startedAt: number };
export type CreationReceipt = { correlationId: string; sessionId: string; enginePid: number; procStart: string; cwd: string; priorUserTurns: number | null; at: number };

const provider = z.enum(['codex', 'claude']);
const principalSchema = z.object({ provider, sessionId: uuid }).strict();
const panelSchema = z.object({ kind: z.literal('panel_session'), id: z.string().min(16).max(128), scope: z.object({ project: z.string() }).strict().optional() }).strict();
const adapter = z.enum(['manual', 'assisted_ui', 'native_tool_relay']), mode = z.enum(['local', 'worktree']);
export const ticketInputSchema = z.object({
  requestId: uuid, targetProvider: provider, project: z.string().min(1).max(4096), branch: z.string().max(255).nullable().default(null),
  head: z.string().regex(/^[0-9a-f]{40}$/).nullable().default(null), model: z.string().max(100).nullable().default(null),
  mode, adapter, ttlSeconds: z.number().int().min(60).max(3600).default(600),
}).strict();
export const grantInputSchema = z.object({
  actionId: uuid, project: z.string().min(1).max(4096), targetProvider: provider, adapter, mode,
  actions: z.array(z.enum(['create', 'bind'])).min(1).max(2), expiresAt: z.number().int().positive().nullable().default(null),
  maxActive: z.number().int().min(1).max(10), maxPerHour: z.number().int().min(1).max(60),
}).strict();
const candidateSchema = z.object({ provider, sessionId: uuid, pid: z.number().int().positive(), procStart: z.string().min(1),
  project: z.string().min(1), branch: z.string().nullable(), head: z.string().regex(/^[0-9a-f]{40}$/).nullable().default(null), startedAt: z.number() }).strict();
const receiptSchema = z.object({ correlationId: uuid, sessionId: uuid, enginePid: z.number().int().positive(), procStart: z.string().min(1),
  cwd: z.string().min(1), priorUserTurns: z.number().int().nonnegative().nullable(), at: z.number() }).loose();

type Row = {
  id: string; request_id: string; request_hash: string; requester: string; origin: string; target_provider: Provider; project: string; device: string; inode: string;
  branch: string | null; head: string | null; model: string | null; mode: string; adapter: Adapter; state: TicketState; revision: number;
  authorized_by: string | null; authorized_at: number | null; grant_id: string | null; correlation_id: string | null; epoch: number; holder: string | null;
  host_ref: string | null; degradation: string | null; bound_session: string | null; bound_pid: number | null; bound_proc_start: string | null;
  binding: string | null; bootstrap_message_id: string | null; created_at: number; expires_at: number; reason: string | null;
};
type GrantRow = {
  id: string; payload_hash: string; project: string; device: string; inode: string; target_provider: Provider; adapter: Adapter; mode: string; actions: string;
  expires_at: number | null; max_active: number; max_per_hour: number; created_at: number; created_by: string; revoked_at: number | null; revoked_by: string | null;
};

const open: TicketState[] = ['requested', 'authorized', 'creating', 'awaiting_receiver', 'creation_uncertain', 'ambiguous'];
const expirable: TicketState[] = ['requested', 'authorized', 'awaiting_receiver', 'ambiguous'];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (p: Principal) => `${p.provider}:${p.sessionId}`;

function folder(path: string) {
  const project = realpathSync(path), stat = statSync(project, { bigint: true });
  if (!stat.isDirectory()) throw new Error('Project must be a directory');
  return { project, device: String(stat.dev), inode: String(stat.ino) };
}

function ticket(row: Row) {
  return {
    id: row.id, requestId: row.request_id, requester: row.requester, origin: row.origin as 'agent' | 'panel', targetProvider: row.target_provider,
    project: row.project, branch: row.branch, head: row.head, model: row.model, mode: row.mode, adapter: row.adapter, state: row.state, revision: row.revision,
    authorizedBy: row.authorized_by, authorizedAt: row.authorized_at, grantId: row.grant_id, correlationId: row.correlation_id, epoch: row.epoch,
    hostRef: row.host_ref, degradation: row.degradation,
    bound: row.bound_session ? { provider: row.target_provider, sessionId: row.bound_session, pid: row.bound_pid, procStart: row.bound_proc_start, binding: row.binding } : null,
    bootstrapMessageId: row.bootstrap_message_id, createdAt: row.created_at, expiresAt: row.expires_at, reason: row.reason,
  };
}
export type Ticket = ReturnType<typeof ticket>;
function grant(row: GrantRow) {
  return { id: row.id, project: row.project, targetProvider: row.target_provider, adapter: row.adapter, mode: row.mode,
    actions: JSON.parse(row.actions) as ('create' | 'bind')[], expiresAt: row.expires_at, maxActive: row.max_active, maxPerHour: row.max_per_hour,
    createdAt: row.created_at, createdBy: row.created_by, revokedAt: row.revoked_at, revokedBy: row.revoked_by };
}
export type Grant = ReturnType<typeof grant>;

export class CreationTickets {
  readonly db: Database;
  constructor(readonly stateDir: string, private now = () => Date.now()) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 }); privateDirectory(stateDir);
    const path = join(stateDir, 'creation-tickets.sqlite');
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Creation ticket state must be a private owned file');
    }
    this.db = new Database(path, { create: true, strict: true }); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS creation_tickets(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,requester TEXT NOT NULL,origin TEXT NOT NULL,
        target_provider TEXT NOT NULL,project TEXT NOT NULL,device TEXT NOT NULL,inode TEXT NOT NULL,branch TEXT,head TEXT,model TEXT,mode TEXT NOT NULL,adapter TEXT NOT NULL,
        state TEXT NOT NULL,revision INTEGER NOT NULL,authorized_by TEXT,authorized_at INTEGER,grant_id TEXT,correlation_id TEXT UNIQUE,epoch INTEGER NOT NULL,holder TEXT,
        host_ref TEXT,degradation TEXT,bound_session TEXT UNIQUE,bound_pid INTEGER,bound_proc_start TEXT,binding TEXT,bootstrap_message_id TEXT,
        created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,reason TEXT);
      CREATE TABLE IF NOT EXISTS creation_grants(id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,project TEXT NOT NULL,device TEXT NOT NULL,inode TEXT NOT NULL,
        target_provider TEXT NOT NULL,adapter TEXT NOT NULL,mode TEXT NOT NULL,actions TEXT NOT NULL,expires_at INTEGER,max_active INTEGER NOT NULL,max_per_hour INTEGER NOT NULL,
        created_at INTEGER NOT NULL,created_by TEXT NOT NULL,revoked_at INTEGER,revoked_by TEXT);
      CREATE TABLE IF NOT EXISTS creation_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,ticket_id TEXT,type TEXT NOT NULL,actor TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL);`);
  }
  close() { this.db.close(); }

  private event(id: string | null, type: string, actor: string, payload: unknown = {}) {
    this.db.run('INSERT INTO creation_events(ticket_id,type,actor,at,payload) VALUES (?,?,?,?,?)', [id, type, actor, this.now(), JSON.stringify(payload)]);
  }
  private row(id: string) {
    const row = this.db.query<Row, [string]>('SELECT * FROM creation_tickets WHERE id=?').get(uuid.parse(id));
    if (!row) throw new Error('Creation ticket does not exist');
    if (expirable.includes(row.state) && this.now() >= row.expires_at) {
      // creating and creation_uncertain never expire into a state that could invite a second attempt.
      this.db.run("UPDATE creation_tickets SET state='expired',reason='ttl',revision=revision+1 WHERE id=?", [row.id]);
      this.event(row.id, 'expired', 'core');
      return this.db.query<Row, [string]>('SELECT * FROM creation_tickets WHERE id=?').get(row.id)!;
    }
    return row;
  }
  private set(id: string, fields: Partial<Row>, type: string, actor: string, payload: unknown = {}) {
    const names = Object.keys(fields);
    this.db.run(`UPDATE creation_tickets SET ${names.map(name => `${name}=?`).join(',')},revision=revision+1 WHERE id=?`,
      [...names.map(name => (fields as Record<string, string | number | null>)[name]!), id]);
    this.event(id, type, actor, payload);
    return ticket(this.row(id));
  }
  private panel(actor: PanelActor, row?: { project: string }) {
    const panel = panelSchema.parse(actor);
    if (row && panel.scope && folder(panel.scope.project).project !== row.project) throw new Error('Panel session is scoped to another project');
    return `panel_session:${panel.id}`;
  }
  private matchingGrant(row: Pick<Row, 'project' | 'device' | 'inode' | 'target_provider' | 'adapter' | 'mode'>, action: 'create' | 'bind') {
    const now = this.now();
    return this.db.query<GrantRow, [string, string, string, string, string, string]>(
      'SELECT * FROM creation_grants WHERE project=? AND device=? AND inode=? AND target_provider=? AND adapter=? AND mode=? AND revoked_at IS NULL ORDER BY created_at')
      .all(row.project, row.device, row.inode, row.target_provider, row.adapter, row.mode)
      .filter(g => (g.expires_at === null || g.expires_at > now) && (JSON.parse(g.actions) as string[]).includes(action));
  }
  private withinLimits(g: GrantRow) {
    const used = this.db.query<{ state: TicketState; created_at: number }, [string]>('SELECT state,created_at FROM creation_tickets WHERE grant_id=?').all(g.id);
    const active = used.filter(row => open.includes(row.state)).length, hour = used.filter(row => row.created_at > this.now() - 3600000).length;
    return active < g.max_active && hour < g.max_per_hour;
  }

  private insert(requester: string, origin: 'agent' | 'panel', raw: unknown, authorizedBy: string | null, grantId: string | null) {
    const input = ticketInputSchema.parse(raw), place = folder(input.project);
    // A new worktree would live in another folder than the pinned project, so binding could never verify it.
    if (input.mode === 'worktree') throw new Error('Creating a conversation in a new worktree is unsupported; open it manually in a registered worktree, or use local mode');
    const payload = { requester, origin, ...input, project: place.project, device: place.device, inode: place.inode }, digest = hash(payload);
    const previous = this.db.query<Row, [string]>('SELECT * FROM creation_tickets WHERE request_id=?').get(input.requestId);
    if (previous) {
      if (previous.request_hash !== digest) throw new Error('Request ID reused with different content');
      return { reused: true, ticket: ticket(this.row(previous.id)) };
    }
    const now = this.now(), id = randomUUID();
    let state: TicketState = 'requested', authorizer = authorizedBy, grantUsed = grantId, reason: string | null = null;
    if (!authorizer) {
      const grants = this.matchingGrant({ ...place, target_provider: input.targetProvider, adapter: input.adapter, mode: input.mode }, 'create');
      const usable = grants.find(g => this.withinLimits(g));
      if (usable) { authorizer = `grant:${usable.id}`; grantUsed = usable.id; }
      else if (grants.length) reason = 'grant_limit_reached';
    }
    if (authorizer) state = 'authorized';
    this.db.run(`INSERT INTO creation_tickets(id,request_id,request_hash,requester,origin,target_provider,project,device,inode,branch,head,model,mode,adapter,state,revision,
      authorized_by,authorized_at,grant_id,correlation_id,epoch,created_at,expires_at,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,0,?,?,?)`,
    [id, input.requestId, digest, requester, origin, input.targetProvider, place.project, place.device, place.inode, input.branch, input.head, input.model,
      input.mode, input.adapter, state, authorizer, authorizer ? now : null, grantUsed, authorizer ? randomUUID() : null, now, now + input.ttlSeconds * 1000, reason]);
    this.event(id, 'requested', requester, { origin, authorizedBy: authorizer, reason });
    return { reused: false, ticket: ticket(this.row(id)) };
  }

  /** An agent asks. Without a matching, unexhausted creation grant the ticket waits for a panel session. */
  request(requester: Principal, input: unknown) {
    const who = key(principalSchema.parse(requester));
    return this.db.transaction(() => this.insert(who, 'agent', input, null, null)).immediate();
  }
  /** A creation chosen in the panel authorizes exactly that ticket. */
  requestFromPanel(panel: PanelActor, input: unknown) {
    return this.db.transaction(() => {
      const actor = this.panel(panel, { project: folder(ticketInputSchema.parse(input).project).project });
      return this.insert(actor, 'panel', input, actor, null);
    }).immediate();
  }
  authorize(panel: PanelActor, id: string, expectedRevision: number) {
    return this.db.transaction(() => {
      const row = this.row(id), actor = this.panel(panel, row);
      if (row.revision !== expectedRevision) throw new Error('Ticket changed; review it again before authorizing');
      if (row.state !== 'requested') throw new Error(`Cannot authorize a ${row.state} ticket`);
      return this.set(row.id, { state: 'authorized', authorized_by: actor, authorized_at: this.now(), correlation_id: randomUUID() }, 'authorized', actor);
    }).immediate();
  }
  cancel(actor: PanelActor | Principal, id: string) {
    return this.db.transaction(() => {
      const row = this.row(id);
      const who = 'kind' in actor ? this.panel(actor, row) : key(principalSchema.parse(actor));
      if (!('kind' in actor) && who !== row.requester) throw new Error('Only the requester or a panel session can cancel');
      if (row.state === 'creating') throw new Error('Creation is in progress; wait for its outcome');
      if (!open.includes(row.state)) throw new Error(`Cannot cancel a ${row.state} ticket`);
      return this.set(row.id, { state: 'cancelled', reason: 'cancelled' }, 'cancelled', who);
    }).immediate();
  }

  grant(panel: PanelActor, raw: unknown) {
    return this.db.transaction(() => {
      const input = grantInputSchema.parse(raw), place = folder(input.project), actor = this.panel(panel, place);
      const payload = { ...input, project: place.project, device: place.device, inode: place.inode, actions: [...new Set(input.actions)].sort() }, digest = hash(payload);
      const previous = this.db.query<GrantRow, [string]>('SELECT * FROM creation_grants WHERE id=?').get(input.actionId);
      if (previous) { if (previous.payload_hash !== digest) throw new Error('Grant action ID reused with different content'); return grant(previous); }
      if (input.expiresAt !== null && input.expiresAt <= this.now()) throw new Error('Grant expiry must be in the future');
      this.db.run('INSERT INTO creation_grants VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)', [input.actionId, digest, place.project, place.device, place.inode,
        input.targetProvider, input.adapter, input.mode, JSON.stringify(payload.actions), input.expiresAt, input.maxActive, input.maxPerHour, this.now(), actor]);
      this.event(null, 'grant_created', actor, { grantId: input.actionId, ...payload });
      return grant(this.db.query<GrantRow, [string]>('SELECT * FROM creation_grants WHERE id=?').get(input.actionId)!);
    }).immediate();
  }
  // Revocation stops future use; tickets already authorized keep their own authorization.
  revokeGrant(panel: PanelActor, grantId: string) {
    return this.db.transaction(() => {
      const row = this.db.query<GrantRow, [string]>('SELECT * FROM creation_grants WHERE id=?').get(uuid.parse(grantId));
      if (!row) throw new Error('Creation grant does not exist');
      const actor = this.panel(panel, row);
      if (row.revoked_at === null) { this.db.run('UPDATE creation_grants SET revoked_at=?,revoked_by=? WHERE id=?', [this.now(), actor, row.id]); this.event(null, 'grant_revoked', actor, { grantId }); }
      return grant(this.db.query<GrantRow, [string]>('SELECT * FROM creation_grants WHERE id=?').get(row.id)!);
    }).immediate();
  }
  grants(project?: string) {
    const rows = this.db.query<GrantRow, []>('SELECT * FROM creation_grants ORDER BY created_at').all();
    const place = project ? folder(project) : undefined;
    return rows.filter(row => !place || (row.project === place.project && row.device === place.device && row.inode === place.inode)).map(grant);
  }

  /** The single creation attempt. The correlation id is not a secret and grants nothing. */
  claimCreating(id: string, holder: string) {
    return this.db.transaction(() => {
      const row = this.row(id);
      if (row.state !== 'authorized') throw new Error(row.state === 'creating' ? 'Creation already claimed; do not create again' : `Cannot create from a ${row.state} ticket`);
      this.assertPinned(row);
      const epoch = row.epoch + 1;
      const done = this.db.run("UPDATE creation_tickets SET state='creating',epoch=?,holder=?,revision=revision+1 WHERE id=? AND state='authorized' AND epoch=?", [epoch, z.string().min(1).max(128).parse(holder), row.id, row.epoch]);
      if (done.changes !== 1) throw new Error('Creation already claimed; do not create again');
      this.event(row.id, 'creating', `executor:${holder}`, { epoch, adapter: row.adapter });
      return { epoch, correlationId: row.correlation_id!, ticket: ticket(this.row(row.id)) };
    }).immediate();
  }
  private creating(id: string, epoch: number) {
    const row = this.row(id);
    if (row.state !== 'creating' || row.epoch !== epoch) throw new Error('Stale creation attempt');
    return row;
  }
  markCreated(id: string, epoch: number, outcome: { hostRef?: string | null; degradation?: string | null } = {}) {
    return this.db.transaction(() => {
      const row = this.creating(id, epoch), hostRef = outcome.hostRef == null ? null : uuid.parse(outcome.hostRef);
      this.assertPinned(row);
      return this.set(row.id, { state: 'awaiting_receiver', host_ref: hostRef, degradation: z.string().max(200).nullable().parse(outcome.degradation ?? null) },
        'created', `executor:${row.holder}`, { hostRef, pointerOnly: true });
    }).immediate();
  }
  markUncertain(id: string, epoch: number, reason: string) {
    return this.db.transaction(() => {
      const row = this.creating(id, epoch);
      return this.set(row.id, { state: 'creation_uncertain', reason: z.string().min(1).max(200).parse(reason) }, 'creation_uncertain', `executor:${row.holder}`);
    }).immediate();
  }
  markFailed(id: string, epoch: number, outcome: { effect: 'none'; reason: string }) {
    return this.db.transaction(() => {
      const row = this.creating(id, epoch);
      if (outcome.effect !== 'none') throw new Error('Only a creation with no host effect can fail; otherwise mark it uncertain');
      return this.set(row.id, { state: 'failed', reason: z.string().min(1).max(200).parse(outcome.reason) }, 'failed', `executor:${row.holder}`);
    }).immediate();
  }

  /** Reports what the candidates allow; it never binds. */
  observe(id: string, raw: Candidate[]) {
    return this.db.transaction(() => {
      const row = this.row(id), candidates = raw.map(candidate => candidateSchema.parse(candidate))
        .filter(candidate => candidate.provider === row.target_provider && candidate.startedAt >= (row.authorized_at ?? row.created_at) && this.sameProject(row, candidate.project));
      if (row.state === 'expired') return { decision: 'expired' as const, candidates };
      if (!['awaiting_receiver', 'ambiguous', 'creation_uncertain'].includes(row.state)) return { decision: 'waiting' as const, candidates };
      if (candidates.length > 1) {
        if (row.state !== 'ambiguous') this.set(row.id, { state: 'ambiguous' }, 'ambiguous', 'core', { candidates: candidates.map(c => c.sessionId) });
        return { decision: 'ambiguous' as const, candidates };
      }
      return { decision: candidates.length ? 'single_candidate_needs_receipt' as const : 'waiting' as const, candidates };
    }).immediate();
  }
  /** The folder identity pinned when the ticket was requested. */
  identity(id: string) {
    const row = this.row(id);
    return { project: row.project, device: row.device, inode: row.inode };
  }
  // A folder replaced at the same path after authorization is another project.
  private assertPinned(row: Row) {
    if (!this.sameProject(row, row.project)) throw new Error('The project folder was replaced since the request; this ticket cannot create there');
  }
  private sameProject(row: Row, path: string) {
    try { const place = folder(path); return place.project === row.project && place.device === row.device && place.inode === row.inode; } catch { return false; }
  }
  private bindable(row: Row, candidate: z.infer<typeof candidateSchema>) {
    if (!['awaiting_receiver', 'ambiguous', 'creation_uncertain'].includes(row.state)) throw new Error(`Cannot bind a ${row.state} ticket`);
    if (candidate.provider !== row.target_provider) throw new Error('Candidate is the wrong provider');
    if (!this.sameProject(row, candidate.project)) throw new Error('Candidate works in another project');
    if (row.branch !== null && candidate.branch !== row.branch) throw new Error('Candidate is on another branch');
    // The request pinned a snapshot; a moved HEAD means the new chat would start from other code.
    if (row.head !== null && candidate.head !== row.head) throw new Error('Project HEAD moved since the request');
    if (this.db.query('SELECT 1 FROM creation_tickets WHERE bound_session=?').get(candidate.sessionId)) throw new Error('Session is already bound to a ticket');
  }
  bindVerified(id: string, rawCandidate: Candidate, rawReceipt: CreationReceipt, options: { maxPriorUserTurns?: number } = {}) {
    return this.db.transaction(() => {
      const row = this.row(id), candidate = candidateSchema.parse(rawCandidate), receipt = receiptSchema.parse(rawReceipt);
      this.bindable(row, candidate);
      const authorizedAt = row.authorized_at!;
      if (row.grant_id && !this.matchingGrant(row, 'bind').some(g => g.id === row.grant_id)) throw new Error('This ticket needs a panel session to bind');
      if (receipt.correlationId !== row.correlation_id) throw new Error('Receipt belongs to another ticket');
      if (receipt.sessionId !== candidate.sessionId || receipt.enginePid !== candidate.pid || receipt.procStart !== candidate.procStart) throw new Error('Receipt and candidate disagree');
      if (candidate.startedAt < authorizedAt || receipt.at < authorizedAt) throw new Error('Candidate existed before authorization');
      if (!this.sameProject(row, receipt.cwd)) throw new Error('Receipt names another project');
      if (row.host_ref !== null && row.host_ref !== candidate.sessionId) throw new Error('Candidate differs from the host reference');
      if (receipt.priorUserTurns === null || receipt.priorUserTurns > (options.maxPriorUserTurns ?? 0)) throw new Error('Candidate already had a conversation');
      return this.set(row.id, { state: 'bound', bound_session: candidate.sessionId, bound_pid: candidate.pid, bound_proc_start: candidate.procStart, binding: 'host_receipt' },
        'bound', 'core', { binding: 'host_receipt', sessionId: candidate.sessionId });
    }).immediate();
  }
  bindManual(panel: PanelActor, id: string, rawCandidate: Candidate) {
    return this.db.transaction(() => {
      const row = this.row(id), actor = this.panel(panel, row), candidate = candidateSchema.parse(rawCandidate);
      this.bindable(row, candidate);
      if (candidate.startedAt < row.created_at) throw new Error('A new-chat ticket binds only a conversation opened after the request');
      return this.set(row.id, { state: 'bound', bound_session: candidate.sessionId, bound_pid: candidate.pid, bound_proc_start: candidate.procStart, binding: 'panel_session' },
        'bound', actor, { binding: 'panel_session', sessionId: candidate.sessionId });
    }).immediate();
  }
  /** The first message to the new chat is sent at most once per ticket. */
  claimBootstrap(id: string, messageId: string) {
    return this.db.transaction(() => {
      const row = this.row(id);
      uuid.parse(messageId);
      if (row.state !== 'bound') throw new Error('Bootstrap needs a bound ticket');
      if (row.bootstrap_message_id === messageId) return { reused: true };
      if (row.bootstrap_message_id) throw new Error('Bootstrap already sent for this ticket');
      this.set(row.id, { bootstrap_message_id: messageId }, 'bootstrap_claimed', 'core', { messageId });
      return { reused: false };
    }).immediate();
  }

  get(id: string) { return this.db.transaction(() => ticket(this.row(id))).immediate(); }
  list(project?: string) {
    const place = project ? folder(project) : undefined;
    return this.db.query<{ id: string; project: string }, []>('SELECT id,project FROM creation_tickets ORDER BY created_at DESC').all()
      .filter(row => !place || row.project === place.project).map(row => this.get(row.id));
  }
  events(id: string) {
    return this.db.query<{ sequence: number; type: string; actor: string; at: number; payload: string }, [string]>('SELECT * FROM creation_events WHERE ticket_id=? ORDER BY sequence')
      .all(uuid.parse(id)).map(event => ({ ...event, payload: JSON.parse(event.payload) }));
  }
}
