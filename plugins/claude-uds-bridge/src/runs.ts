import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { privateDirectory, uuid, type Frame, type Peer } from './claude';
import { matchesProcess, type Participant } from './participants';
import { parseManaged } from './managed-message';
import { normalizeRoutine, type RoutineInput, type Task, type Report, type Closure } from './routines';
import { RoutineLedger } from './routine-ledger';
import { Coordination, type CoordinationInput, type Control } from './coordination';
import { parseWork } from './routines';

export const contextSchema = z.object({ objective: z.string().trim().min(1).max(16000),
  constraints: z.array(z.string().max(4000)).max(50).default([]), references: z.array(z.string().max(4000)).max(50).default([]),
  priorAnalysis: z.object({ codex: z.string().max(32000).optional(), claude: z.string().max(32000).optional() }).default({}) }).strict();
export const limitsSchema = z.object({ maxMessages: z.number().int().min(2).max(500).default(24),
  maxSeconds: z.number().int().min(1).max(86400).default(1800) }).strict();
export type Context = z.infer<typeof contextSchema>;
export type Limits = z.infer<typeof limitsSchema>;
export type RunState = 'prepared' | 'active' | 'paused' | 'recovery_required' | 'blocked' | 'cancelled' | 'completed' | 'limit_reached';
type RunRow = { id: string; owner_thread: string; request_id: string; request_hash: string; state: RunState; reason: string | null;
  context: string; limits: string; comparison: string; created_at: number; started_at: number | null; deadline: number | null; messages_used: number };
type MessageRow = { id: string; run_id: string; transport_id: string | null; direction: 'in' | 'out'; peer_id: string;
  text: string; hash: string; wire_text: string | null; wire_hash: string | null; reply_to: string | null; status: string; admitted: number; delivery_claimed: number; created_at: number };
const digest = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export class RunStore {
  private db: Database;
  private ledger: RoutineLedger;
  private coordination: Coordination;
  constructor(stateDir: string, private now = () => Date.now()) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 }); privateDirectory(stateDir);
    const path = join(stateDir, 'collaborations.sqlite');
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Collaboration state must be a private owned file');
    }
    this.db = new Database(path, { create: true, strict: true }); chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; CREATE TEMP TABLE cc_cdx_writer_v3(capability INTEGER);');
    const version = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
    if (version > 3) { this.db.close(); throw new Error('Unsupported future collaboration schema'); }
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, owner_thread TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
        state TEXT NOT NULL, reason TEXT, context TEXT NOT NULL, limits TEXT NOT NULL, comparison TEXT NOT NULL,
        created_at INTEGER NOT NULL, started_at INTEGER, deadline INTEGER, messages_used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS participants (
        run_id TEXT NOT NULL REFERENCES runs(id), provider TEXT NOT NULL, session_id TEXT NOT NULL, snapshot TEXT NOT NULL,
        PRIMARY KEY(run_id,provider), UNIQUE(run_id,session_id)
      );
      CREATE TABLE IF NOT EXISTS session_claims (
        session_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS run_messages (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), transport_id TEXT UNIQUE,
        direction TEXT NOT NULL, peer_id TEXT NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL, wire_text TEXT, wire_hash TEXT, reply_to TEXT,
        status TEXT NOT NULL, admitted INTEGER NOT NULL, delivery_claimed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), type TEXT NOT NULL,
        actor TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL
      );
      `);
    this.db.transaction(() => { RoutineLedger.install(this.db); Coordination.install(this.db); this.db.exec('PRAGMA user_version=3'); }).immediate();
    this.ledger = new RoutineLedger(this.db,(...args)=>this.event(...args),this.now);
    this.coordination = new Coordination(this.db,this.now,(...args)=>this.event(...args));
  }
  close() { this.db.close(); }
  private row(id: string) {
    uuid.parse(id); const run = this.db.query<RunRow, [string]>('SELECT * FROM runs WHERE id=?').get(id);
    if (!run) throw new Error('Collaboration does not exist'); return run;
  }
  private event(id: string, type: string, actor: string, payload: unknown) {
    this.db.run('INSERT INTO events (run_id,type,actor,at,payload) VALUES (?,?,?,?,?)', [id,type,actor,this.now(),JSON.stringify(payload)]);
  }
  private terminal(id: string, state: RunState, reason: string, actor = 'core') {
    this.db.run('UPDATE runs SET state=?,reason=? WHERE id=?', [state,reason,id]);
    this.db.run('DELETE FROM session_claims WHERE run_id=?', [id]); this.event(id,state,actor,{reason});
  }
  private expire(id: string) {
    const run = this.row(id);
    if (['active','paused','recovery_required','blocked'].includes(run.state) && run.deadline !== null && this.now() >= run.deadline) this.terminal(id,'limit_reached','deadline');
    this.coordination.inspect(id);
    return this.row(id);
  }
  private requireActive(id: string) {
    const run = this.expire(id);
    if(['active','paused'].includes(run.state) && run.messages_used >= (JSON.parse(run.limits) as Limits).maxMessages){this.terminal(id,'limit_reached','message_budget');return {run:this.row(id),error:'Collaboration message budget exhausted'};}
    if (run.state !== 'active') return { run, error: `Collaboration is ${run.state}: ${run.reason ?? 'no new deliveries'}` };
    if (run.messages_used >= (JSON.parse(run.limits) as Limits).maxMessages) {
      this.terminal(id,'limit_reached','message_budget'); return { run:this.row(id),error:'Collaboration message budget exhausted' };
    }
    return { run, error: null };
  }
  assertOwner(id: string, owner: string) { if (this.row(id).owner_thread !== owner) throw new Error('Only the initiating Codex conversation can control this collaboration'); }
  participants(id: string) {
    this.row(id);
    return this.db.query<{ snapshot: string }, [string]>('SELECT snapshot FROM participants WHERE run_id=? ORDER BY provider').all(id)
      .map(row => JSON.parse(row.snapshot) as Participant);
  }
  activeFor(sessionId: string) {
    return this.db.transaction(() => {
      const claim = this.db.query<{ run_id: string }, [string]>('SELECT run_id FROM session_claims WHERE session_id=?').get(sessionId);
      if (!claim) return null;
      const run = this.expire(claim.run_id); return ['active','paused','recovery_required','blocked'].includes(run.state) ? run.id : null;
    }).immediate();
  }
  // A transport receipt survives /clear, but the managed conversation binding does not.
  private samePeerProcess(participant: Participant, peer: Pick<Peer, 'pid' | 'procStart' | 'messagingSocketPath'>) {
    return participant.pid === peer.pid && participant.procStart === peer.procStart
      && participant.socketPath === peer.messagingSocketPath;
  }
  activeForPeer(peer: Pick<Peer, 'sessionId' | 'pid' | 'procStart' | 'messagingSocketPath'>) {
    const exact = this.activeFor(peer.sessionId);
    if (exact) return exact;
    const claims = this.db.query<{ run_id: string; snapshot: string }, []>(
      "SELECT p.run_id,p.snapshot FROM participants p JOIN session_claims c ON c.run_id=p.run_id AND c.session_id=p.session_id WHERE p.provider='claude'").all();
    for (const claim of claims) {
      const participant = JSON.parse(claim.snapshot) as Participant;
      if (!this.samePeerProcess(participant, peer) || !this.activeFor(participant.sessionId)) continue;
      this.block(claim.run_id, 'participant_session_changed');
      return claim.run_id;
    }
    return null;
  }
  observePeerSession(threadId: string, peer: Peer) {
    const id = this.activeFor(threadId);
    if (!id) return false;
    const participant = this.participants(id).find(p => p.provider === 'claude');
    if (!participant || participant.sessionId === peer.sessionId || !this.samePeerProcess(participant, peer)) return false;
    this.block(id, 'participant_session_changed');
    return true;
  }
  prepare(owner: string, requestId: string, context: Context, limits: Limits, participants: Participant[], comparison: unknown, routine?: RoutineInput, coordination?: CoordinationInput) {
    uuid.parse(owner); uuid.parse(requestId); context = contextSchema.parse(context); limits = limitsSchema.parse(limits);
    const normalized = normalizeRoutine(routine,context.priorAnalysis);
    if(coordination?.initialBarrier && normalized.startMode!=='new')throw new Error('Initial barrier requires new/new starts');
    if (participants.length !== 2 || participants.filter(p=>p.provider==='codex' && p.sessionId===owner).length !== 1
      || participants.filter(p=>p.provider==='claude').length !== 1 || participants[0]!.sessionId===participants[1]!.sessionId) throw new Error('A collaboration requires the caller Codex and one distinct Claude participant');
    const requestHash = digest({owner,context,limits,participants:participants.map(p=>({...p,status:undefined,name:undefined})),comparison,routine:normalized,coordination});
    return this.db.transaction(() => {
      const existing = this.db.query<RunRow, [string]>('SELECT * FROM runs WHERE request_id=?').get(requestId);
      if (existing) { if (existing.request_hash !== requestHash || existing.owner_thread !== owner) throw new Error('Preparation request ID was reused with different content'); return existing.id; }
      const id = randomUUID();
      this.db.run("INSERT INTO runs (id,owner_thread,request_id,request_hash,state,context,limits,comparison,created_at) VALUES (?,?,?,?,'prepared',?,?,?,?)",
        [id,owner,requestId,requestHash,JSON.stringify(context),JSON.stringify(limits),JSON.stringify(comparison),this.now()]);
      for (const peer of participants) this.db.run('INSERT INTO participants VALUES (?,?,?,?)',[id,peer.provider,peer.sessionId,JSON.stringify(peer)]);
      this.ledger.prepare(id,normalized);this.coordination.prepare(id,coordination,context);
      this.event(id,'prepared',owner,{contextVersion:1,reception:'unknown',mode:'supervised'}); return id;
    }).immediate();
  }
  start(id: string, owner: string) {
    this.assertOwner(id,owner);
    this.db.transaction(() => {
      const run = this.expire(id); if (run.state === 'active') return;
      if (run.state !== 'prepared') throw new Error(`Cannot start a ${run.state} collaboration`);
      const participants = this.participants(id);
      for (const peer of participants.filter(p => p.provider === 'claude')) {
        const claim = this.activeForPeer({ ...peer, messagingSocketPath: peer.socketPath });
        if (claim && claim !== id) throw new Error('Participant process already belongs to an active collaboration; close it before selecting the new session');
      }
      for (const peer of participants) {
        const claim = this.db.query<{run_id:string},[string]>('SELECT run_id FROM session_claims WHERE session_id=?').get(peer.sessionId);
        if (claim) this.expire(claim.run_id);
      }
      for (const peer of participants) {
        if (this.db.query('SELECT 1 FROM session_claims WHERE session_id=?').get(peer.sessionId)) throw new Error('Participant already belongs to an active collaboration');
        this.db.run('INSERT INTO session_claims VALUES (?,?)',[peer.sessionId,id]);
      }
      this.coordination.acquire(id);
      const deadline = this.now() + (JSON.parse(run.limits) as Limits).maxSeconds*1000;
      this.db.run("UPDATE runs SET state='active',started_at=?,deadline=? WHERE id=?",[this.now(),deadline,id]);
      this.event(id,'started',owner,{deadline,reception:'unknown',mode:'supervised'});
    }).immediate();
    return this.status(id,owner);
  }
  stop(id: string, owner: string, state: 'cancelled' | 'completed', reason: string, closure?: Closure) {
    this.assertOwner(id,owner);
    if(state==='completed'&&!['cancelled','completed','limit_reached'].includes(this.expire(id).state))this.coordination.guard(id);
    this.db.transaction(() => {
      const run = this.expire(id);
      if (['cancelled','completed','limit_reached'].includes(run.state)) return;
      if(closure)this.ledger.close(id,closure);
      this.terminal(id,state,reason,owner);
    }).immediate();
    return this.status(id,owner);
  }
  block(id: string, reason: string) {
    this.db.transaction(() => {
      const run = this.expire(id);
      if (run.state !== 'active') return;
      this.db.run("UPDATE runs SET state='blocked',reason=? WHERE id=?",[reason,id]); this.event(id,'blocked','core',{reason});
    }).immediate();
  }
  reserveOutgoing(id: string, owner: string, messageId: string, peerId: string, text: string, replyTo?: string, task?: Task) {
    this.assertOwner(id,owner); uuid.parse(messageId);this.coordination.guard(id);
    const result = this.db.transaction(() => {
      const existing = this.db.query<MessageRow,[string]>('SELECT * FROM run_messages WHERE id=?').get(messageId);
      if (existing) {
        this.ledger.checkTask(messageId,task);
        if (existing.run_id!==id || existing.direction!=='out' || existing.peer_id!==peerId || existing.hash!==digest(text) || existing.reply_to!==(replyTo??null)) throw new Error('Message ID was reused with different content');
        return {existing,error:null};
      }
      if (!this.participants(id).some(p=>p.provider==='claude' && p.sessionId===peerId)) throw new Error('Wrong collaboration recipient');
      if (replyTo && !this.db.query("SELECT 1 FROM run_messages WHERE id=? AND run_id=? AND direction='in' AND delivery_claimed=1 AND status IN ('started','steered','delivered','consumed')").get(uuid.parse(replyTo),id)) throw new Error('replyTo must identify an admitted incoming message from this run');
      this.coordination.fence(id);
      const {error} = this.requireActive(id); if (error) return {existing:null,error};
      if(task)this.ledger.validateTask(id,task);
      if (this.db.query("SELECT 1 FROM run_messages m LEFT JOIN message_observations o ON o.message_id=m.id WHERE m.run_id=? AND m.direction='out' AND m.status IN ('reserved','submitting','unknown') AND o.responded_at IS NULL").get(id)) {
        this.db.run("UPDATE runs SET state='blocked',reason='unfinished_delivery' WHERE id=?",[id]);
        this.event(id,'blocked','core',{reason:'unfinished_delivery'});
        return {existing:null,error:'Unfinished delivery is uncertain; inspect status instead of sending another task'};
      }
      this.db.run("INSERT INTO run_messages (id,run_id,direction,peer_id,text,hash,reply_to,status,admitted,created_at) VALUES (?,?,'out',?,?,?,?,'reserved',1,?)",[messageId,id,peerId,text,digest(text),replyTo??null,this.now()]);
      this.db.run('UPDATE runs SET messages_used=messages_used+1 WHERE id=?',[id]); this.event(id,'message_reserved',owner,{messageId,direction:'out'});
      if(task){this.ledger.bindTask(id,messageId,task);this.coordination.bind(id,messageId,peerId,task);}else if(this.coordination.row(id))throw new Error('Structured coordination requires a task');
      this.coordination.observe(messageId,this.coordination.version(id),'task');
      return {existing:null,error:null};
    }).immediate();
    if (result.error) throw new Error(result.error);
    return result.existing;
  }
  claimOutgoing(id: string, owner: string, messageId: string, transportId: string, wire?: string) {
    this.assertOwner(id,owner);this.coordination.guard(id);
    const result = this.db.transaction(() => {
      this.coordination.fence(id);
      const run = this.expire(id);
      if (run.state !== 'active') return {error:`Collaboration is ${run.state}`,claimed:false};
      const changed = this.db.run("UPDATE run_messages SET status='submitting',transport_id=?,wire_text=?,wire_hash=?,delivery_claimed=1 WHERE id=? AND run_id=? AND direction='out' AND status='reserved'",[transportId,wire??null,wire?digest(wire):null,messageId,id]);
      if (changed.changes) this.event(id,'delivery_admitted',owner,{messageId,transportId,direction:'out'});
      return {error:null,claimed:changed.changes===1};
    }).immediate();
    if (result.error) throw new Error(result.error); if (!result.claimed) throw new Error('Message already admitted; inspect its status, do not resend');
  }
  outgoingExists(id: string, owner: string, messageId: string, text: string, replyTo?: string, task?: Task) {
    this.assertOwner(id,owner);
    const row = this.db.query<MessageRow,[string]>('SELECT * FROM run_messages WHERE id=?').get(messageId);
    if (!row) return null;
    this.ledger.checkTask(messageId,task);
    if (row.run_id!==id || row.direction!=='out' || row.hash!==digest(text) || row.reply_to!==(replyTo??null)) throw new Error('Message ID was reused with different content');
    return row;
  }
  messageFailed(messageId: string, status: 'unknown' | 'not-sent') {
    const row=this.db.query<MessageRow,[string]>('SELECT * FROM run_messages WHERE id=?').get(messageId);
    if (!row || !['reserved','submitting'].includes(row.status)) return;
    if (row.transport_id) this.transportStatus(row.transport_id,status);
    else {
      this.db.run('UPDATE run_messages SET status=? WHERE id=?',[status,messageId]);
      this.event(row.run_id,'transport_status','core',{messageId,status}); this.block(row.run_id,`transport:${status}`);
    }
  }
  allowOutgoingFrame(owner: string, frame: Frame, peer?: Peer) {
    if (frame.type !== 'user') return true;
    let parsed: ReturnType<typeof parseManaged>;
    try { parsed=parseManaged(frame.message.content); } catch { return false; }
    if (!parsed) return peer ? !this.activeForPeer(peer) : !frame.session_id || !this.activeFor(frame.session_id);
    const message=this.db.query<MessageRow,[string]>('SELECT * FROM run_messages WHERE id=?').get(parsed.header.messageId);
    if (!message || message.run_id!==parsed.header.runId || message.direction!=='out' || message.transport_id!==frame.msg_id
      || message.peer_id!==frame.session_id || !message.delivery_claimed || message.status!=='submitting' || message.wire_hash!==digest(frame.message.content)) return false;
    const run=this.db.transaction(()=>this.expire(message.run_id)).immediate();
    return run.owner_thread===owner && run.state==='active' && parsed.header.contextVersion===this.coordination.version(run.id);
  }
  transportStatus(transportId: string, status: string, evidence: unknown = {}) {
    this.db.transaction(() => {
      const message = this.db.query<MessageRow,[string]>('SELECT * FROM run_messages WHERE transport_id=?').get(transportId);
      if (!message || message.status === status) return;
      // A socket-write completion cannot downgrade a receipt that raced ahead of it.
      if (status === 'socket-written' && !['reserved','submitting'].includes(message.status)) return;
      if(message.status==='consumed'&&status!=='consumed')return;
      this.db.run('UPDATE run_messages SET status=? WHERE id=?',[status,message.id]);
      if(message.direction==='in' && !this.coordination.row(message.run_id))this.ledger.capture({...message,status});
      this.event(message.run_id,'transport_status','transport',{messageId:message.id,transportId,status,evidence});
      if(status==='unknown' && this.coordination.row(message.run_id)){const run=this.expire(message.run_id);if(['active','blocked'].includes(run.state)){this.db.run("UPDATE runs SET state='recovery_required',reason='delivery_unknown' WHERE id=?",[run.id]);this.event(run.id,'recovery_required','transport',{reason:'delivery_unknown',messageId:message.id});}}
      if(['socket-written','started','steered','delivered','consumed'].includes(status)&&this.coordination.row(message.run_id)){const run=this.expire(message.run_id);if(['active','paused'].includes(run.state)&&run.messages_used>=(JSON.parse(run.limits) as Limits).maxMessages)this.terminal(run.id,'limit_reached','message_budget');}
      if (message.direction==='out' && ['held','refused','denied','expired','dropped','unknown','not-sent'].includes(status)) {
        const run = this.expire(message.run_id);
        if (run.state==='active') { this.db.run("UPDATE runs SET state='blocked',reason=? WHERE id=?",[`transport:${status}`,run.id]); this.event(run.id,'blocked','transport',{reason:`transport:${status}`}); }
      }
    }).immediate();
  }
  admitIncoming(threadId: string, peer: Peer, transportId: string, wire: string) {
    if (this.observePeerSession(threadId, peer)) return {managed:true,admitted:false,reason:'participant-session-changed'};
    let parsed: ReturnType<typeof parseManaged>;
    try { parsed = parseManaged(wire); }
    catch { return {managed:true,admitted:false,reason:'invalid-correlation'}; }
    const active = this.activeFor(threadId);
    if (!parsed) {
      if (active && this.participants(active).some(p=>p.sessionId===peer.sessionId)) {
        this.db.transaction(()=>this.event(active,'uncorrelated_message',peer.sessionId,{transportId,delivered:false})).immediate();
        return {managed:true,admitted:false,reason:'missing-correlation'};
      }
      return {managed:false,admitted:true,reason:null};
    }
    const {header,text}=parsed;
    return this.db.transaction(() => {
      let run: RunRow;
      try { run=this.row(header.runId); } catch { return {managed:true,admitted:false,reason:'unknown-run'}; }
      const participant=this.participants(run.id).find(p=>p.provider==='claude');
      if (run.owner_thread!==threadId || !participant || !matchesProcess(participant,peer)) return {managed:true,admitted:false,reason:'wrong-participant'};
      const existing = this.db.query<MessageRow,[string]>('SELECT * FROM run_messages WHERE id=?').get(header.messageId);
      if (existing) return {managed:true,admitted:false,reason:'duplicate-message'};
      if (header.replyTo && !this.db.query("SELECT 1 FROM run_messages WHERE id=? AND run_id=? AND direction='out' AND delivery_claimed=1").get(header.replyTo,run.id)) {
        this.event(run.id,'invalid_reply',peer.sessionId,{transportId}); return {managed:true,admitted:false,reason:'unknown-reply'};
      }
      const structured=!!this.coordination.row(run.id);
      let classification=header.contextVersion===this.coordination.version(run.id)?'valid':'stale';
      if(!structured && header.contextVersion!==1)return {managed:true,admitted:false,reason:'stale-context'};
      try { this.ledger.validateIncoming(run.id,peer.sessionId,header.replyTo,text);
        if(structured && classification!=='stale'){const work=parseWork(text);if(!work||work.work.kind==='task')throw new Error('Unclassified response');this.coordination.validate(run.id,peer.sessionId,header.contextVersion,work.work);}
      } catch (error) {this.event(run.id,'invalid_work_envelope',peer.sessionId,{transportId,reason:error instanceof Error?error.message:'Invalid work envelope'});
        if(!structured)return {managed:true,admitted:false,reason:'invalid-work-envelope'};if(classification!=='stale')classification='unclassified';}
      let duplicateResponse=false;
      if(structured){try{const parsed=parseWork(text);if(parsed&&parsed.work.kind!=='task'&&parsed.work.taskId){const task=this.coordination.task(parsed.work.taskId);duplicateResponse=task?.run_id===run.id&&task.state==='validated';}}catch{}}
      let {error}=this.requireActive(run.id);
      const current=this.row(run.id);
      if(['paused','blocked','recovery_required'].includes(current.state) && header.replyTo && classification==='valid' && current.messages_used<(JSON.parse(current.limits) as Limits).maxMessages)error=null;
      if(classification==='stale')error='stale-context';
      if(duplicateResponse){classification='duplicate-response';error='duplicate-response';}
      this.db.run("INSERT INTO run_messages (id,run_id,transport_id,direction,peer_id,text,hash,wire_text,wire_hash,reply_to,status,admitted,created_at) VALUES (?,?,?,'in',?,?,?,?,?,?,?,?,?)",
        [header.messageId,run.id,transportId,peer.sessionId,text,digest(text),wire,digest(wire),header.replyTo??null,error?'late':'received',error?0:1,this.now()]);
      this.coordination.observe(header.messageId,header.contextVersion,['stale','duplicate-response'].includes(classification)?classification:error?'late':classification);
      if (!error) this.db.run('UPDATE runs SET messages_used=messages_used+1 WHERE id=?',[run.id]);
      this.event(run.id,error?'late_message':'message_received',peer.sessionId,{messageId:header.messageId,transportId,replyTo:header.replyTo??null,delivered:false,reason:error});
      return {managed:true,admitted:!error,reason:error==='duplicate-response'?'duplicate-response':error?'run-not-active':null};
    }).immediate();
  }
  claimIncoming(transportId: string) {
    return this.db.transaction(() => {
      const message=this.db.query<MessageRow,[string]>("SELECT * FROM run_messages WHERE transport_id=? AND direction='in'").get(transportId);
      if (!message) return true; // Ordinary transport outside the managed route.
      const run=this.expire(message.run_id);
      if (run.state!=='active' || !message.admitted || message.delivery_claimed) return false;
      const c=this.coordination.row(run.id),o=this.coordination.observation(message.id);if(c&&(!c.barrier_open||!o?.authorized||o.context_version!==c.context_version))return false;
      this.db.run('UPDATE run_messages SET delivery_claimed=1 WHERE id=?',[message.id]);
      this.event(run.id,'delivery_admitted',run.owner_thread,{messageId:message.id,transportId,direction:'in'}); return true;
    }).immediate();
  }
  incomingParticipants(transportId: string) {
    const row=this.db.query<{run_id:string},[string]>("SELECT run_id FROM run_messages WHERE transport_id=? AND direction='in'").get(transportId);
    return row?{runId:row.run_id,participants:this.participants(row.run_id)}:null;
  }
  projectAuthorizationCandidate(transportId:string,owner:string,project:string) {
    const message=this.db.query<MessageRow,[string]>("SELECT * FROM run_messages WHERE transport_id=? AND direction='in'").get(transportId);
    if(!message||!message.admitted||!message.reply_to)return null;
    const run=this.expire(message.run_id),observation=this.coordination.observation(message.id);
    if(run.owner_thread!==owner||!['active','paused','blocked','recovery_required'].includes(run.state))return null;
    if(this.coordination.row(run.id)&&observation?.classification!=='valid')return null;
    const participants=this.participants(run.id);
    if(!participants.every(p=>p.project.directory===project)||!participants.some(p=>p.provider==='codex'&&p.sessionId===owner)||!participants.some(p=>p.provider==='claude'&&p.sessionId===message.peer_id))return null;
    return {receivedAt:message.created_at};
  }
  participantEnded(threadId: string) { const id=this.activeFor(threadId); if (id) this.block(id,'participant_unavailable'); }
  recordNotice(threadId: string, peer: Peer, transportId: string, text: string) {
    const id=this.activeFor(threadId); if (!id) return false;
    const participant=this.participants(id).find(p=>p.provider==='claude');
    if (!participant || !matchesProcess(participant,peer)) return false;
    this.event(id,'transport_notice',peer.sessionId,{transportId,text,modelDelivery:false}); return true;
  }
  recordReport(id:string,owner:string,reportId:string,report:Report,text:string) {
    this.assertOwner(id,owner);uuid.parse(reportId);
    if(!this.ledger.existing(id,owner,reportId,report,text))this.coordination.guard(id);
    return this.db.transaction(()=>{const existing=this.ledger.existing(id,owner,reportId,report,text);if(existing)return existing;
      this.coordination.fence(id);const run=this.expire(id);if(run.state!=='active')throw new Error(`Cannot record a report in a ${run.state} run`);
      this.coordination.validate(id,owner,this.coordination.version(id),report);
      const result=this.ledger.record(id,owner,reportId,report,text);this.coordination.complete(id,owner,reportId,report);this.publishBarrierReports(id);return result;}).immediate();
  }
  control(id:string,owner:string,commandId:string,expectedRevision:number,control:Control) {
    this.assertOwner(id,owner);this.expire(id);
    if(control.action!=='recover')this.coordination.inspect(id);
    this.db.transaction(()=>{if(control.action==='task'&&!this.db.query('SELECT 1 FROM run_commands WHERE id=?').get(commandId))this.ledger.validateTask(id,control.task);this.coordination.command(id,owner,commandId,expectedRevision,control);}).immediate();
    return this.status(id,owner);
  }
  authorizeIncoming(transportId:string): 'deliver'|'buffer'|'drop' {
    return this.db.transaction(()=>{
      const message=this.db.query<MessageRow,[string]>("SELECT * FROM run_messages WHERE transport_id=? AND direction='in'").get(transportId);
      if(!message)return 'deliver';
      const run=this.expire(message.run_id),c=this.coordination.row(run.id);
      if(!c){if(run.state==='active' && message.reply_to)this.db.run('UPDATE message_observations SET responded_at=? WHERE message_id=?',[this.now(),message.reply_to]);return run.state==='active'?'deliver':'drop';}
      const observation=this.coordination.observation(message.id)!;
      if(!message.admitted || observation.context_version!==c.context_version || !['active','paused','blocked','recovery_required'].includes(run.state))return 'drop';
      this.db.run('UPDATE message_observations SET authorized=1 WHERE message_id=?',[message.id]);
      if(observation.classification==='valid' && !this.db.query('SELECT 1 FROM routine_reports WHERE id=? UNION ALL SELECT 1 FROM barrier_reports WHERE id=?').get(message.id,message.id)){
        try {const parsed=parseWork(message.text);if(!parsed||parsed.work.kind==='task')throw new Error('Unclassified');
          this.coordination.validate(run.id,message.peer_id,c.context_version,parsed.work);
          if(c.barrier&&!c.barrier_open){this.db.run('INSERT INTO barrier_reports VALUES (?,?,?,?,?,?)',[message.id,run.id,message.peer_id,JSON.stringify(parsed.work),parsed.text,c.context_version]);this.coordination.complete(run.id,message.peer_id,message.id,parsed.work,false);}else{this.ledger.record(run.id,message.peer_id,message.id,parsed.work,parsed.text,message.id);this.coordination.complete(run.id,message.peer_id,message.id,parsed.work);}
          if(message.reply_to){this.db.run('UPDATE message_observations SET responded_at=? WHERE message_id=?',[this.now(),message.reply_to]);
            this.event(run.id,'correlated_response',message.peer_id,{messageId:message.id,replyTo:message.reply_to});}
        }catch(error){this.db.run("UPDATE message_observations SET classification='unclassified' WHERE message_id=?",[message.id]);this.event(run.id,'response_unclassified','core',{messageId:message.id});}
      }
      if(run.state!=='active'||!this.coordination.row(run.id)!.barrier_open)return 'buffer';
      this.publishBarrierReports(run.id);return 'deliver';
    }).immediate();
  }
  private publishBarrierReports(id:string){
    const c=this.coordination.row(id);if(!c?.barrier_open)return;
    const pending=this.db.query<{id:string;author:string;payload:string;body:string;context_version:number},[string,number]>('SELECT * FROM barrier_reports WHERE run_id=? AND context_version=? ORDER BY rowid').all(id,c.context_version);
    for(const report of pending){this.ledger.record(id,report.author,report.id,JSON.parse(report.payload),report.body,report.id);this.db.run('INSERT INTO report_contexts VALUES (?,?)',[report.id,report.context_version]);this.db.run('DELETE FROM barrier_reports WHERE id=?',[report.id]);}
  }
  nativeIntent(transportId:string,inputId:string) {
    const message=this.db.query<MessageRow,[string]>('SELECT * FROM run_messages WHERE transport_id=?').get(transportId);if(!message)return;
    this.db.run("INSERT OR IGNORE INTO message_observations(message_id,context_version,classification) VALUES (?,1,'legacy')",[message.id]);
    this.db.run('UPDATE message_observations SET native_input_id=? WHERE message_id=?',[uuid.parse(inputId),message.id]);
    this.event(message.run_id,'native_delivery_intent','transport',{messageId:message.id,inputId});
  }
  nativeConsumed(transportId:string,inputId:string) {
    this.db.transaction(()=>{const message=this.db.query<MessageRow,[string]>('SELECT * FROM run_messages WHERE transport_id=?').get(transportId);if(!message)return;
      const observation=this.coordination.observation(message.id);if(!observation||observation.native_input_id!==inputId||observation.consumed_at)return;
      this.db.run('UPDATE message_observations SET consumed_at=? WHERE message_id=?',[this.now(),message.id]);
      this.transportStatus(transportId,'consumed',{inputId,source:'exact_native_history'});
    }).immediate();
  }
  status(id: string, owner: string) {
    this.assertOwner(id,owner);
    return this.db.transaction(() => {
      const row=this.expire(id);
      const messages=this.db.query<MessageRow,[string]>('SELECT * FROM run_messages WHERE run_id=? ORDER BY created_at,rowid').all(id);
      const control=this.coordination.row(id);const coordination=this.coordination.status(id);const ledger=this.ledger.status(id);
      if(control && (!control.barrier_open || row.state==='paused')){const visible=new Set(ledger.reports.filter(r=>!r.source_message).map(r=>r.id));ledger.reports=ledger.reports.filter(r=>visible.has(r.id));ledger.results=ledger.results.filter(r=>visible.has(r.id));ledger.reviews=ledger.reviews.filter(r=>visible.has(r.id));ledger.disagreements=ledger.disagreements.filter(d=>visible.has(d.reportId));}
      return { schemaVersion:3, id:row.id, ownerThread:row.owner_thread, state:row.state, reason:row.reason,
        contextVersion:this.coordination.version(id), coordination, pendingTasks:coordination?.tasks.filter(t=>t.state==='assigned').map(t=>t.id)??[], context:JSON.parse(row.context) as Context, limits:JSON.parse(row.limits) as Limits,
        comparison:JSON.parse(row.comparison), reception:'unknown', mode:'supervised', createdAt:row.created_at,
        startedAt:row.started_at, deadline:row.deadline, messagesUsed:row.messages_used, participants:this.participants(id),
        ...ledger,
        messages:messages.map(message=>{
          const visible=message.direction==='out'||(!!message.admitted && !!message.delivery_claimed && ['started','steered','delivered','consumed'].includes(message.status));
          return {...message,evidence:this.coordination.observation(message.id),text:visible?message.text:null,wire_text:visible?message.wire_text:null,contentRedacted:!visible,observation:['reserved','submitting'].includes(message.status)?'delivery_uncertain':message.status};
        }),
        events:this.db.query<{sequence:number;type:string;actor:string;at:number;payload:string},[string]>('SELECT sequence,type,actor,at,payload FROM events WHERE run_id=? ORDER BY sequence').all(id)
          .map(event=>({...event,payload:JSON.parse(event.payload)})) };
    }).immediate();
  }
  list(owner: string) {
    uuid.parse(owner);
    return this.db.query<{id:string},[string]>('SELECT id FROM runs WHERE owner_thread=? ORDER BY created_at DESC,rowid DESC').all(owner)
      .map(row=>{const run=this.status(row.id,owner);return {id:run.id,state:run.state,reason:run.reason,objective:run.context.objective,createdAt:run.createdAt};});
  }
  export(id: string, owner: string, format: 'json' | 'markdown') {
    const run=this.status(id,owner);
    if (format==='json') return JSON.stringify(run,null,2)+'\n';
    const lines=[`# Colaboración ${run.id}`,'',`Estado: ${run.state}${run.reason?` (${run.reason})`:''}`,
      'Recepción: desconocida; piloto supervisado. Los estados de transporte no prueban consumo del modelo.',
      `Contexto: versión ${run.contextVersion}. Encargos pendientes: ${run.pendingTasks.length}. Mensajes admitidos: ${run.messagesUsed}/${run.limits.maxMessages}.`,
      '', '## Objetivo','',run.context.objective,'','## Contexto','',JSON.stringify(run.context,null,2),'','## Participantes',''];
    for (const peer of run.participants) lines.push(`- ${peer.provider}: ${peer.name} (${peer.sessionId}); ${peer.surface}; PID ${peer.pid}; inicio ${peer.procStart}; carpeta ${peer.project.directory}; HEAD ${peer.project.head??'sin Git/HEAD'}.`);
    lines.push('','## Coordinación estructurada','',JSON.stringify(run.coordination,null,2),'','## Rutina','',JSON.stringify(run.routine,null,2),'','Colaboración guiada; independencia no garantizada.');
    lines.push('','## Resultados y revisiones','');
    for(const report of run.reports)lines.push(`### ${report.id}`,'',`Autor: ${report.author}; fuente: ${report.source_message??'declaración local'}; declaración del agente, sin validación intelectual del núcleo.`,'',JSON.stringify(report.report),'',report.body,'');
    for(const review of run.reviews)lines.push(`Revisión ${review.id}: hash objetivo ${review.targetHash}; versión vigente: ${review.current}; consenso validado: false.`);
    lines.push('','## Desacuerdos','',...run.disagreements.map(d=>`- ${d.author}: ${d.text}`),'','## Cierre','',JSON.stringify(run.closure,null,2));
    lines.push('','## Mensajes','');
    for (const message of run.messages) lines.push(`### ${message.id}`,'',`${message.direction}; participante ${message.peer_id}; transporte ${message.transport_id??'sin ID'}; ${message.observation}; evidencia ${JSON.stringify(message.evidence)}; respuesta a ${message.reply_to??'—'}.`,'',message.text??'[Contenido no entregado: oculto]','');
    lines.push('## Eventos','');
    for (const event of run.events) lines.push(`- ${event.sequence} · ${new Date(event.at).toISOString()} · ${event.type} · ${event.actor}: ${JSON.stringify(event.payload)}`);
    return lines.join('\n')+'\n';
  }
}
