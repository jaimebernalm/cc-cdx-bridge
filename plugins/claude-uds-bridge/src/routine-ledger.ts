import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { type Routine, type Task, type Report, type Closure, reportSchema, taskSchema, closureSchema, parseWork } from './routines';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const delivered = ['started','steered','delivered','consumed'];
type Row = {id:string;run_id:string;author:string;source_message:string|null;payload:string;body:string;hash:string;created_at:number};
type TaskRow = {id:string;run_id:string;message_id:string;payload:string};
export class RoutineLedger {
  constructor(private db: Database, private event: (id:string,type:string,actor:string,payload:unknown)=>void, private now:()=>number) {}
  static install(db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS routines (run_id TEXT PRIMARY KEY REFERENCES runs(id), config TEXT NOT NULL, closure TEXT);
      CREATE TABLE IF NOT EXISTS routine_tasks (id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),message_id TEXT NOT NULL UNIQUE REFERENCES run_messages(id),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS routine_reports (id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),author TEXT NOT NULL,source_message TEXT UNIQUE REFERENCES run_messages(id),payload TEXT NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  }
  prepare(id: string, routine: Routine) { this.db.run('INSERT INTO routines VALUES (?,?,NULL)',[id,JSON.stringify(routine)]); }
  routine(id: string): Routine | null { const row=this.db.query<{config:string},[string]>('SELECT config FROM routines WHERE run_id=?').get(id); return row ? JSON.parse(row.config) : null; }
  task(messageId: string) { const row=this.db.query<TaskRow,[string]>('SELECT * FROM routine_tasks WHERE message_id=?').get(messageId); return row ? JSON.parse(row.payload) as Task : null; }
  bindTask(runId: string, messageId: string, task: Task) {
    task=taskSchema.parse(task);
    const existing=this.task(messageId);
    if (existing) { if(JSON.stringify(existing)!==JSON.stringify(task))throw new Error('Message ID reused with a different task');return; }
    if(task.target)this.result(runId,task.target.resultId,task.target.version);
    this.db.run('INSERT INTO routine_tasks VALUES (?,?,?,?)',[task.taskId,runId,messageId,JSON.stringify(task)]);
    this.event(runId,'task_declared',this.db.query<{owner_thread:string},[string]>('SELECT owner_thread FROM runs WHERE id=?').get(runId)!.owner_thread,{messageId,task});
  }
  checkTask(messageId: string, task?: Task) {
    const existing=this.task(messageId);
    if(JSON.stringify(existing??null)!==JSON.stringify(task?taskSchema.parse(task):null))throw new Error('Message ID reused with a different task');
  }
  validateTask(runId: string, task: Task) {
    task=taskSchema.parse(task);if(task.target){const target=this.result(runId,task.target.resultId,task.target.version);const context=this.db.query<{context_version:number},[string]>('SELECT context_version FROM run_control WHERE run_id=?').get(runId)?.context_version??1;const targetContext=this.db.query<{context_version:number},[string]>('SELECT context_version FROM report_contexts WHERE report_id=?').get(target.id)?.context_version??1;if(context!==targetContext)throw new Error('Task review target belongs to stale context');}
    if(this.db.query('SELECT 1 FROM routine_tasks WHERE id=?').get(task.taskId))throw new Error('Task ID is already bound to a message');
  }
  private rows(id: string) { return this.db.query<Row,[string]>('SELECT * FROM routine_reports WHERE run_id=? ORDER BY created_at,rowid').all(id); }
  private result(runId:string,resultId:string,version:number) {
    const results=this.rows(runId).map(row=>({...row,report:reportSchema.parse(JSON.parse(row.payload))}));
    const result=results.find(row=>row.report.kind==='result' && row.report.resultId===resultId && row.report.version===version);
    if(!result)throw new Error('Review/closure target result version does not exist in this run');return result;
  }
  private validateReport(runId:string,author:string,report:Report,body:string,reportId?:string) {
    report=reportSchema.parse(report);
    if(report.taskId && !this.db.query('SELECT 1 FROM routine_tasks WHERE id=? AND run_id=? UNION ALL SELECT 1 FROM structured_tasks WHERE id=? AND run_id=?').get(report.taskId,runId,report.taskId,runId))throw new Error('Report task does not belong to this run');
    if(!body.trim() || body.length>32000)throw new Error('Report body must contain 1–32000 characters');
    const rows=this.rows(runId).filter(row=>row.id!==reportId);
    if(rows.length>=500)throw new Error('Report limit reached');
    if(report.kind==='review'){const target=this.result(runId,report.resultId,report.version);const current=this.db.query<{context_version:number},[string]>('SELECT context_version FROM run_control WHERE run_id=?').get(runId)?.context_version??1;const targetContext=this.db.query<{context_version:number},[string]>('SELECT context_version FROM report_contexts WHERE report_id=?').get(target.id)?.context_version??1;if(targetContext!==current)throw new Error('Review target belongs to a stale context');}
    if(report.kind==='result') {
      const versions=rows.map(row=>({...row,p:reportSchema.parse(JSON.parse(row.payload))})).filter(row=>row.p.kind==='result' && row.p.resultId===report.resultId);
      if(versions.some(row=>row.author!==author))throw new Error('Only the result author may append a new version');
      const next=1+Math.max(0,...versions.map(row=>row.p.kind==='result'?row.p.version:0));
      if(report.version!==next)throw new Error('Result versions must be sequential and immutable');
    }
    return report;
  }
  validateIncoming(runId:string,author:string,replyTo:string|undefined,text:string) {
    const parsed=parseWork(text);if(!parsed)return;
    if(parsed.work.kind==='task')throw new Error('Peer cannot issue controller tasks through a response');
    const report=parsed.work;
    if(!report.taskId || !replyTo)throw new Error('Structured peer response requires taskId and replyTo');
    const task=this.task(replyTo);
    if(!task || task.taskId!==report.taskId)throw new Error('Peer response task does not match replyTo');
    if(report.kind==='review' && (task.intent!=='review'||task.target?.resultId!==report.resultId||task.target.version!==report.version))throw new Error('Review must target the exact requested result version');
    this.validateReport(runId,author,report,parsed.text);
  }
  existing(runId:string,author:string,id:string,report:Report,body:string,sourceMessage:string|null=null) {
    report=reportSchema.parse(report);const digest=hash(JSON.stringify({runId,author,report,body,sourceMessage}));
    const existing=this.db.query<Row,[string]>('SELECT * FROM routine_reports WHERE id=?').get(id);
    if(existing && existing.hash!==digest)throw new Error('Report ID reused with different content');return existing;
  }
  record(runId:string,author:string,id:string,report:Report,body:string,sourceMessage:string|null=null) {
    report=reportSchema.parse(report);const digest=hash(JSON.stringify({runId,author,report,body,sourceMessage}));
    const existing=this.existing(runId,author,id,report,body,sourceMessage);if(existing)return existing;
    report=this.validateReport(runId,author,report,body,id);
    const message=sourceMessage?this.db.query<{run_id:string;direction:string;admitted:number;delivery_claimed:number;status:string;peer_id:string},[string]>('SELECT * FROM run_messages WHERE id=?').get(sourceMessage):null;
    if(sourceMessage && (!message || message.run_id!==runId || message.direction!=='in' || message.peer_id!==author || !message.admitted || (!message.delivery_claimed || !delivered.includes(message.status)) && !this.db.query('SELECT 1 FROM message_observations WHERE message_id=? AND authorized=1').get(sourceMessage)))throw new Error('Peer report source has not been delivered');
    this.db.run('INSERT INTO routine_reports VALUES (?,?,?,?,?,?,?,?)',[id,runId,author,sourceMessage,JSON.stringify(report),body,digest,this.now()]);
    this.event(runId,'agent_report',author,{reportId:id,kind:report.kind,declared:true,validatedByCore:false});
    return this.db.query<Row,[string]>('SELECT * FROM routine_reports WHERE id=?').get(id)!;
  }
  capture(message: {id:string;run_id:string;peer_id:string;text:string;reply_to:string|null;status:string;admitted:number;delivery_claimed:number}) {
    if(!message.admitted || !message.delivery_claimed || !delivered.includes(message.status))return;
    if(this.db.query('SELECT 1 FROM routine_reports WHERE source_message=?').get(message.id))return;
    try {const parsed=parseWork(message.text);if(!parsed || parsed.work.kind==='task')return;
      this.validateIncoming(message.run_id,message.peer_id,message.reply_to??undefined,message.text);this.record(message.run_id,message.peer_id,message.id,parsed.work,parsed.text,message.id);}
    catch(error) {this.event(message.run_id,'agent_report_rejected',message.peer_id,{messageId:message.id,reason:error instanceof Error?error.message:'Invalid report'});}
  }
  close(id:string,closure:Closure) {
    closure=closureSchema.parse(closure);if(closure.result)this.result(id,closure.result.resultId,closure.result.version);
    const snapshot=this.status(id);const coverage=closure.result?snapshot.results.find(r=>r.report.kind==='result'&&r.report.resultId===closure.result!.resultId&&r.report.version===closure.result!.version):null;const stored={...closure,reviewCoverage:coverage?{reviewState:coverage.reviewState,reviewedByBoth:coverage.reviewedByBoth,contextVersion:coverage.contextVersion,contentHash:coverage.contentHash}:null,disagreements:snapshot.disagreements};
    this.db.run("INSERT INTO routines VALUES (?,'null',?) ON CONFLICT(run_id) DO UPDATE SET closure=excluded.closure",[id,JSON.stringify(stored)]);
    this.event(id,'closure_declared',this.db.query<{owner_thread:string},[string]>('SELECT owner_thread FROM runs WHERE id=?').get(id)!.owner_thread,{...closure,validatedConsensus:false});
  }
  status(id:string) {
    const contextVersion=this.db.query<{context_version:number},[string]>('SELECT context_version FROM run_control WHERE run_id=?').get(id)?.context_version??1;
    const reports=this.rows(id).map(row=>({...row,contextVersion:this.db.query<{context_version:number},[string]>('SELECT context_version FROM report_contexts WHERE report_id=?').get(row.id)?.context_version??1,report:reportSchema.parse(JSON.parse(row.payload)),attribution:'verified_participant' as const,declared:true as const,validatedByCore:false as const}));
    const results=reports.filter(row=>row.report.kind==='result').map(row=>{const p=row.report;if(p.kind!=='result')throw new Error('Invalid result');const latest=Math.max(...reports.filter(r=>r.report.kind==='result'&&r.report.resultId===p.resultId).map(r=>r.report.kind==='result'?r.report.version:0));const relevant=reports.filter(r=>r.report.kind==='review'&&r.report.resultId===p.resultId);const exact=relevant.filter(r=>r.report.kind==='review'&&r.report.version===p.version&&r.contextVersion===row.contextVersion&&row.contextVersion===contextVersion&&p.version===latest);const authors=new Set(exact.map(r=>r.author));const participants=this.db.query<{session_id:string},[string]>('SELECT session_id FROM participants WHERE run_id=?').all(id);const other=exact.some(r=>r.author!==row.author);const stale=relevant.some(r=>r.author!==row.author);return {...row,contentHash:hash(row.body),reviewState:other?'other_agent_current':stale?'other_agent_stale':exact.length?'self_only':'none',reviewedByBoth:participants.length===2&&participants.every(p=>authors.has(p.session_id))};});
    const reviews=reports.filter(row=>row.report.kind==='review').map(row=>{
      if(row.report.kind!=='review')throw new Error('Invalid review');const p=row.report;
      const target=results.find(r=>r.report.kind==='result'&&r.report.resultId===p.resultId&&r.report.version===p.version)!;
      const latest=Math.max(...results.filter(r=>r.report.kind==='result'&&r.report.resultId===p.resultId).map(r=>r.report.kind==='result'?r.report.version:0));
      return {...row,targetHash:target.contentHash,current:p.version===latest&&row.contextVersion===contextVersion&&target.contextVersion===contextVersion,validatedConsensus:false};
    });
    const closure=this.db.query<{closure:string|null},[string]>('SELECT closure FROM routines WHERE run_id=?').get(id)?.closure;
    return {routine:this.routine(id),tasks:this.db.query<TaskRow,[string]>('SELECT * FROM routine_tasks WHERE run_id=? ORDER BY rowid').all(id).map(t=>({id:t.id,messageId:t.message_id,...JSON.parse(t.payload)})),
      reports,results,reviews,disagreements:reports.flatMap(row=>row.report.disagreements.map(text=>({author:row.author,reportId:row.id,text}))),closure:closure?{...JSON.parse(closure),validatedConsensus:false}:null};
  }
}
