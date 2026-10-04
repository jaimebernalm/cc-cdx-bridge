import { Database } from 'bun:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { uuid } from './claude';
import { taskSchema, type Task, type Report } from './routines';

export const phaseSchema = z.enum(['context','independent_analysis','critique','verification','synthesis','final_review']);
export const coordinationSchema = z.object({initialBarrier:z.boolean().default(false),leaseSeconds:z.number().int().min(5).max(3600).default(300)}).strict();
export type CoordinationInput = z.input<typeof coordinationSchema>;
export type ControlRow = {run_id:string;context_version:number;revision:number;phase:z.infer<typeof phaseSchema>;barrier:number;barrier_open:number;lease_owner:string|null;lease_until:number|null;config:string};
export type StructuredTask = {id:string;run_id:string;message_id:string|null;author:string;context_version:number;phase:string;payload:string;state:string;response_id:string|null};
export const controlSchema = z.discriminatedUnion('action',[
  z.object({action:z.literal('pause')}).strict(),z.object({action:z.literal('resume')}).strict(),
  z.object({action:z.literal('recover')}).strict(),
  z.object({action:z.literal('phase'),phase:phaseSchema}).strict(),
  z.object({action:z.literal('task'),task:taskSchema}).strict(),
  z.object({action:z.literal('context'),context:z.object({objective:z.string().trim().min(1).max(16000),constraints:z.array(z.string().max(4000)).max(50).default([]),references:z.array(z.string().max(4000)).max(50).default([]),priorAnalysis:z.object({codex:z.string().max(32000).optional(),claude:z.string().max(32000).optional()}).strict().default({})}).strict()}).strict(),
]);
export type Control = z.infer<typeof controlSchema>;
export class Coordination {
  readonly controller = randomUUID();
  constructor(private db:Database,private now:()=>number,private event:(id:string,type:string,actor:string,payload:unknown)=>void){const start=this.processStart(process.pid);if(!start)throw new Error('Controller process identity unavailable');this.db.run('INSERT INTO controller_processes VALUES (?,?,?)',[this.controller,process.pid,start]);}
  private processStart(pid:number){const r=spawnSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:2000,env:{...process.env,LC_ALL:'C',TZ:'UTC'}});return r.status===0?r.stdout.trim():null;}
  static install(db:Database){db.exec(`
    CREATE TABLE IF NOT EXISTS controller_processes(id TEXT PRIMARY KEY,pid INTEGER NOT NULL,proc_start TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS run_control(run_id TEXT PRIMARY KEY REFERENCES runs(id),context_version INTEGER NOT NULL,revision INTEGER NOT NULL,phase TEXT NOT NULL,barrier INTEGER NOT NULL,barrier_open INTEGER NOT NULL,lease_owner TEXT,lease_until INTEGER,config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS run_contexts(run_id TEXT NOT NULL REFERENCES runs(id),version INTEGER NOT NULL,context TEXT NOT NULL,PRIMARY KEY(run_id,version));
    CREATE TABLE IF NOT EXISTS run_commands(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),hash TEXT NOT NULL,revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS structured_tasks(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),message_id TEXT UNIQUE,author TEXT NOT NULL,context_version INTEGER NOT NULL,phase TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,response_id TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS message_observations(message_id TEXT PRIMARY KEY REFERENCES run_messages(id),context_version INTEGER NOT NULL,classification TEXT NOT NULL,authorized INTEGER NOT NULL DEFAULT 0,native_input_id TEXT,consumed_at INTEGER,responded_at INTEGER);
    CREATE TABLE IF NOT EXISTS barrier_reports(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),author TEXT NOT NULL,payload TEXT NOT NULL,body TEXT NOT NULL,context_version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS report_contexts(report_id TEXT PRIMARY KEY REFERENCES routine_reports(id),context_version INTEGER NOT NULL);
  `);
    // Connection-local capability marker prevents already-open older writers bypassing new invariants.
    for(const [table,key] of [['runs','id'],['run_messages','run_id'],['routine_reports','run_id'],['routine_tasks','run_id'],['routines','run_id'],['session_claims','run_id']]){
      for(const operation of ['INSERT','UPDATE','DELETE']){
        const row=operation==='DELETE'?'OLD':'NEW';
        db.exec(`CREATE TRIGGER IF NOT EXISTS phase3_${table}_${operation} BEFORE ${operation} ON ${table}
          WHEN EXISTS(SELECT 1 FROM run_control WHERE run_id=${row}.${key})
          AND NOT EXISTS(SELECT 1 FROM pragma_table_list WHERE schema='temp' AND name='cc_cdx_writer_v3')
          BEGIN SELECT RAISE(ABORT,'Reload phase-3 plugin writer'); END;`);
      }
    }
  }
  row(id:string){return this.db.query<ControlRow,[string]>('SELECT * FROM run_control WHERE run_id=?').get(id);}
  version(id:string){return this.row(id)?.context_version??1;}
  prepare(id:string,input:CoordinationInput|undefined,context:unknown){if(!input)return;const c=coordinationSchema.parse(input);
    this.db.run('INSERT INTO run_control VALUES (?,1,0,?,?,?,NULL,NULL,?)',[id,c.initialBarrier?'independent_analysis':'context',c.initialBarrier?1:0,c.initialBarrier?0:1,JSON.stringify(c)]);
    this.db.run('INSERT INTO run_contexts VALUES (?,1,?)',[id,JSON.stringify(context)]);}
  acquire(id:string){const c=this.row(id);if(!c)return;
    const old=c.lease_owner?this.db.query<{pid:number;proc_start:string},[string]>('SELECT * FROM controller_processes WHERE id=?').get(c.lease_owner):null;
    const live=old&&this.processStart(old.pid)===old.proc_start;
    if(c.lease_owner && c.lease_owner!==this.controller && live && (c.lease_until??0)>this.now())throw new Error('Another controller holds the lease');
    this.db.run('UPDATE run_control SET lease_owner=?,lease_until=? WHERE run_id=?',[this.controller,this.now()+JSON.parse(c.config).leaseSeconds*1000,id]);}
  inspect(id:string){const c=this.row(id);if(!c)return;
    const processOwner=c.lease_owner?this.db.query<{pid:number;proc_start:string},[string]>('SELECT * FROM controller_processes WHERE id=?').get(c.lease_owner):null;
    const dead=!!c.lease_owner&&(!processOwner||this.processStart(processOwner.pid)!==processOwner.proc_start);
    if(c.lease_owner && ((c.lease_until??0)<=this.now()||dead)){
      const result=this.db.run("UPDATE runs SET state='recovery_required',reason='lease_expired' WHERE id=? AND state IN ('active','paused','blocked')",[id]);
      if(result.changes)this.event(id,'recovery_required','core',{reason:'lease_expired'});
    }
  }
  guard(id:string){this.inspect(id);const c=this.row(id);if(!c)return;
    if(c.lease_owner!==this.controller || (c.lease_until??0)<=this.now())throw new Error('Controller lease unavailable; inspect and explicitly recover');
    this.acquire(id);}
  fence(id:string){const c=this.row(id);if(c&&(c.lease_owner!==this.controller||(c.lease_until??0)<=this.now()))throw new Error('Stale controller lease');}
  uncertain(id:string){return this.db.query("SELECT 1 FROM run_messages m LEFT JOIN message_observations o ON o.message_id=m.id WHERE m.run_id=? AND m.status IN ('reserved','submitting','unknown') AND o.responded_at IS NULL AND o.consumed_at IS NULL").get(id);}
  bind(id:string,messageId:string|null,author:string,task:Task){const c=this.row(id);if(!c)return;
    if(c.barrier && !c.barrier_open && (task.intent!=='analyze'||c.phase!=='independent_analysis'))throw new Error('Initial barrier only admits initial analyze tasks');
    if(c.barrier && !c.barrier_open && this.db.query('SELECT 1 FROM structured_tasks WHERE run_id=? AND author=? AND context_version=?').get(id,author,c.context_version))throw new Error('Initial analysis task already exists for this participant');
    this.db.run("INSERT INTO structured_tasks VALUES (?,?,?,?,?,?,?,'assigned',NULL)",[task.taskId,id,messageId,author,c.context_version,c.phase,JSON.stringify(task)]);
  }
  task(taskId:string){return this.db.query<StructuredTask,[string]>('SELECT * FROM structured_tasks WHERE id=?').get(taskId);}
  validate(id:string,author:string,version:number,report:Report){const c=this.row(id);if(!c)return;
    if(version!==c.context_version)throw new Error('Response belongs to a stale context');
    if(!report.taskId)throw new Error('Structured coordination requires an assigned task');
    const task=this.task(report.taskId);
    if(!task||task.run_id!==id||task.author!==author||task.context_version!==version)throw new Error('Wrong task author or context');
    const requested=taskSchema.parse(JSON.parse(task.payload));if(report.kind==='review'&&(requested.intent!=='review'||requested.target?.resultId!==report.resultId||requested.target.version!==report.version))throw new Error('Review does not match exact task target');
    if(task.state!=='assigned')throw new Error('Task already answered or invalidated');
    if(c.barrier&&!c.barrier_open && !(report.kind==='response'&&report.declaredState==='analysis'))throw new Error('Initial task requires an analysis response');
  }
  complete(id:string,author:string,reportId:string,report:Report,persistContext=true){const c=this.row(id);if(!c)return;
    this.validate(id,author,c.context_version,report);
    this.db.run("UPDATE structured_tasks SET state='validated',response_id=? WHERE id=? AND state='assigned'",[reportId,report.taskId!]);
    if(persistContext)this.db.run('INSERT INTO report_contexts VALUES (?,?)',[reportId,c.context_version]);
    this.event(id,'task_response_validated',author,{taskId:report.taskId,reportId,contextVersion:c.context_version,intellectualValidation:false});
    if(c.barrier&&!c.barrier_open){const answered=this.db.query<{n:number},[string,number]>("SELECT COUNT(DISTINCT author) n FROM structured_tasks WHERE run_id=? AND context_version=? AND phase='independent_analysis' AND state='validated'").get(id,c.context_version)!.n;
      if(answered===2){this.db.run('UPDATE run_control SET barrier_open=1,revision=revision+1 WHERE run_id=?',[id]);this.event(id,'barrier_opened','core',{contextVersion:c.context_version,guarantee:'withheld_current_run_exchange'});}}
  }
  observe(messageId:string,version:number,classification:string){this.db.run('INSERT INTO message_observations(message_id,context_version,classification) VALUES (?,?,?)',[messageId,version,classification]);}
  observation(messageId:string){return this.db.query<{context_version:number;classification:string;authorized:number;native_input_id:string|null;consumed_at:number|null;responded_at:number|null},[string]>('SELECT * FROM message_observations WHERE message_id=?').get(messageId);}
  command(id:string,owner:string,commandId:string,expected:number,control:Control){uuid.parse(commandId);control=controlSchema.parse(control);const hash=createHash('sha256').update(JSON.stringify({id,owner,expected,control})).digest('hex');
    const old=this.db.query<{hash:string},[string]>('SELECT hash FROM run_commands WHERE id=?').get(commandId);if(old){if(old.hash!==hash)throw new Error('Command ID reused with different content');return;}
    const c=this.row(id);if(!c)throw new Error('Prepare with coordination to use structured control');
    if(c.revision!==expected)throw new Error('Control revision changed; inspect status before acting');
    const state=this.db.query<{state:string},[string]>('SELECT state FROM runs WHERE id=?').get(id)!.state;
    if(['prepared','completed','cancelled','limit_reached'].includes(state))throw new Error(`Cannot control ${state} run`);
    if(control.action==='recover'){this.acquire(id);const uncertain=this.uncertain(id);
      this.db.run('UPDATE runs SET state=?,reason=? WHERE id=?',[uncertain?'recovery_required':'paused',uncertain?'unfinished_delivery':'recovered_paused',id]);
    }else{
      this.guard(id);
      if(control.action==='pause')this.db.run("UPDATE runs SET state='paused',reason='owner_pause' WHERE id=?",[id]);
      if(control.action==='resume'){
        if(!['paused','blocked','recovery_required'].includes(state))throw new Error('Resume requires paused or blocked state');
        if(this.uncertain(id))throw new Error('Uncertain delivery requires evidence or cancellation, never a resend');
        this.db.run("UPDATE runs SET state='active',reason=NULL WHERE id=?",[id]);}
      if(control.action==='context'){
        if(this.uncertain(id))throw new Error('Resolve uncertain delivery before changing context');
        if(c.barrier && (control.context.priorAnalysis.codex?.trim()||control.context.priorAnalysis.claude?.trim()))throw new Error('Barrier context cannot include prior analyses');
        this.db.run('INSERT INTO run_contexts VALUES (?,?,?)',[id,c.context_version+1,JSON.stringify(control.context)]);
        this.db.run('UPDATE runs SET context=? WHERE id=?',[JSON.stringify(control.context),id]);
        this.db.run("UPDATE structured_tasks SET state='stale' WHERE run_id=? AND state='assigned'",[id]);
        this.db.run('UPDATE run_control SET context_version=context_version+1,barrier_open=?,phase=? WHERE run_id=?',[c.barrier?0:1,c.barrier?'independent_analysis':'context',id]);
      }
      if(control.action==='phase'){
        if(c.barrier&&!c.barrier_open && control.phase!=='independent_analysis')throw new Error('Cannot cross a closed initial barrier');
        this.db.run('UPDATE run_control SET phase=? WHERE run_id=?',[control.phase,id]);}
      if(control.action==='task'){if(state!=='active')throw new Error('Cannot assign work while paused or blocked');this.bind(id,null,owner,control.task);}
    }
    this.db.run('UPDATE run_control SET revision=revision+1 WHERE run_id=?',[id]);
    const revision=this.row(id)!.revision;this.db.run('INSERT INTO run_commands VALUES (?,?,?,?)',[commandId,id,hash,revision]);
    this.event(id,'control',owner,{commandId,action:control.action,previousRevision:expected,revision,previousPhase:c.phase,phase:this.row(id)!.phase,contextVersion:this.version(id)});
  }
  status(id:string){const c=this.row(id);if(!c)return null;
    return {contextVersion:c.context_version,revision:c.revision,phase:c.phase,initialBarrier:!!c.barrier,barrierOpen:!!c.barrier_open,
      lease:{ownedByCaller:c.lease_owner===this.controller,expiresAt:c.lease_until},
      tasks:this.db.query<StructuredTask,[string]>('SELECT * FROM structured_tasks WHERE run_id=? ORDER BY rowid').all(id).map(t=>({...t,task:JSON.parse(t.payload),payload:undefined})),
      contexts:this.db.query<{version:number;context:string},[string]>('SELECT * FROM run_contexts WHERE run_id=? ORDER BY version').all(id).map(r=>({version:r.version,context:JSON.parse(r.context)}))};}
}
