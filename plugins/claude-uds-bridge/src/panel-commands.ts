import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { privateDirectory, uuid, processStart } from './claude';
import { contextSchema, limitsSchema } from './runs';
import {implementationSchema,implementationActionSchema} from './implementation';
import { routineSchema } from './routines';
import { coordinationSchema } from './coordination';
import { type Collaboration } from './collaboration';

const preparation = z.object({ peerId: uuid, context: contextSchema, limits: limitsSchema,
  routine: routineSchema, coordination: coordinationSchema, revisionPolicy: z.enum(['same','compare']).default('same'),
  implementation:implementationSchema.optional(),
  comparisonBase: z.string().min(1).max(256).optional(), allowBusyPeer: z.boolean().default(false),
  continuedFrom: uuid.optional() }).strict();
export const panelActionSchema = z.discriminatedUnion('action',[
  preparation.extend({action:z.literal('create')}),
  z.object({action:z.literal('implementation'),runId:uuid,expectedRevision:z.number().int().min(0),work:implementationActionSchema}).strict(),
  z.object({action:z.enum(['pause','resume','recover','cancel']),runId:uuid,expectedRevision:z.number().int().min(0)}).strict(),
  z.object({action:z.literal('input'),runId:uuid,expectedRevision:z.number().int().min(0),text:z.string().trim().min(1).max(4000)}).strict(),
]);
export const panelRequestSchema=z.object({commandId:uuid,ownerThread:uuid,project:z.string().min(1).max(4096),command:panelActionSchema}).strict();
export type PanelRequest=z.infer<typeof panelRequestSchema>;
export type PanelCommand={id:string;owner:string;project:string;payload:string;hash:string;state:string;created_at:number;input_id:string;run_id:string|null;error:string|null;result:string|null;processor_pid:number|null;processor_start:string|null;reconciliation_note:string|null};

export class PanelCommands {
  private db:Database;
  constructor(stateDir:string){mkdirSync(stateDir,{recursive:true,mode:0o700});privateDirectory(stateDir);
    const path=join(stateDir,'panel.sqlite');if(existsSync(path)){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077))throw new Error('Panel state must be private and owned');}
    this.db=new Database(path,{create:true,strict:true});chmodSync(path,0o600);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS panel_commands(id TEXT PRIMARY KEY,owner TEXT NOT NULL,project TEXT NOT NULL,payload TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,input_id TEXT NOT NULL,run_id TEXT,error TEXT,result TEXT);`);
    const columns=this.db.query<{name:string},[]>('PRAGMA table_info(panel_commands)').all();
    if(!columns.some(c=>c.name==='processor_pid'))this.db.exec('ALTER TABLE panel_commands ADD COLUMN processor_pid INTEGER;');
    if(!columns.some(c=>c.name==='processor_start'))this.db.exec('ALTER TABLE panel_commands ADD COLUMN processor_start TEXT;');
    if(!columns.some(c=>c.name==='reconciliation_note'))this.db.exec('ALTER TABLE panel_commands ADD COLUMN reconciliation_note TEXT;');
  }
  get(id:string){return this.db.query<PanelCommand,[string]>('SELECT * FROM panel_commands WHERE id=?').get(uuid.parse(id));}
  list(owner?:string){return owner?this.db.query<PanelCommand,[string]>('SELECT * FROM panel_commands WHERE owner=? ORDER BY created_at DESC LIMIT 200').all(owner):this.db.query<PanelCommand,[]>('SELECT * FROM panel_commands ORDER BY created_at DESC LIMIT 200').all();}
  enqueue(input:PanelRequest,wakeStart?:string){input=panelRequestSchema.parse(input);input.project=realpathSync(input.project);const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.db.transaction(()=>{const old=this.get(input.commandId);if(old){if(old.hash!==hash)throw new Error('Command ID reused with different content');return {command:old,reused:true};}
      this.db.run('INSERT INTO panel_commands(id,owner,project,payload,hash,state,created_at,input_id,processor_pid,processor_start) VALUES (?,?,?,?,?,?,?,?,?,?)',[input.commandId,input.ownerThread,input.project,JSON.stringify(input.command),hash,wakeStart?'waking':'queued',Date.now(),randomUUID(),wakeStart?process.pid:null,wakeStart??null]);return {command:this.get(input.commandId)!,reused:false};}).immediate();
  }
  beginWake(id:string,procStart:string){return this.db.run("UPDATE panel_commands SET state='waking',processor_pid=?,processor_start=? WHERE id=? AND state='queued'",[process.pid,procStart,id]).changes===1;}
  wakeResult(id:string,status:string,error?:string){this.db.run("UPDATE panel_commands SET state=?,error=? WHERE id=? AND state='waking'",[status,error??null,id]);}
  consumed(id:string){this.db.run("UPDATE panel_commands SET state='notified',error=NULL,reconciliation_note=NULL WHERE id=? AND state='unknown'",[id]);}
  reconciliationIssue(ids:string[],note:string){for(const id of ids)this.db.run("UPDATE panel_commands SET reconciliation_note=? WHERE id=? AND state='unknown'",[note,id]);}
  async inspectApplications(){for(const row of this.db.query<PanelCommand,[]>("SELECT * FROM panel_commands WHERE state IN ('applying','waking')").all()){
    if(!row.processor_pid||!row.processor_start||await processStart(row.processor_pid).catch(()=>null)!==row.processor_start)
      this.db.run("UPDATE panel_commands SET state=?,error='Process ended during delivery/application; inspect before a new action' WHERE id=? AND state=?",[row.state==='waking'?'unknown':'application_uncertain',row.id,row.state]);
  }
    // Legacy queued rows have no recorded wake owner. Never replay them. New
    // API commands atomically record waking + owner in enqueue's transaction.
    this.db.run("UPDATE panel_commands SET state='unknown',error='No recorded wake owner; inspect the durable command before a new action' WHERE state='queued' AND created_at<?",[Date.now()-15000]);
  }
  public(row:PanelCommand){return {id:row.id,ownerThread:row.owner,project:row.project,action:JSON.parse(row.payload).action,state:row.state,createdAt:row.created_at,runId:row.run_id,error:row.error,inspection:row.reconciliation_note,result:row.result?JSON.parse(row.result):null};}
  async apply(id:string,c:Collaboration,project:string){const row=this.get(id);if(!row||row.owner!==c.owner||row.project!==project)throw new Error('Panel command belongs to another conversation or project');
    if(row.state==='applied')return {...JSON.parse(row.result!),reused:true};
    const procStart=await processStart(process.pid);
    if(!this.db.run("UPDATE panel_commands SET state='applying',processor_pid=?,processor_start=? WHERE id=? AND state IN ('queued','waking','notified','unknown')",[process.pid,procStart,id]).changes)throw new Error('Command is already applying or failed; do not replay uncertain work');
    const command=panelActionSchema.parse(JSON.parse(row.payload));let runId:string|undefined;let implementationResult:unknown;
    try{
      if(command.action==='create'){
        if(command.continuedFrom)c.store.assertOwner(command.continuedFrom,c.owner);
        const prepared=await c.prepare({...command,requestId:row.id});runId=prepared.id;
        this.db.run('UPDATE panel_commands SET run_id=? WHERE id=?',[runId,id]);
        await c.start(runId,command.allowBusyPeer);
      }else{
        runId=command.runId;const status=c.store.status(runId,c.owner);
        if(status.coordination?.revision!==command.expectedRevision)throw new Error('Control revision changed; refresh before submitting again');
        if(command.action==='implementation'){
          if(command.work.action==='capture')await c.control(runId,row.id,command.expectedRevision,{action:'task',task:{taskId:command.work.taskId,intent:'synthesize'}});
          implementationResult=await c.store.implementationAction(runId,c.owner,row.id,command.work);
        }else if(command.action==='cancel')c.store.stop(runId,c.owner,'cancelled','Cancelled from the local panel');
        else if(command.action==='input')await c.control(runId,row.id,command.expectedRevision,{action:'context',context:{...status.context,constraints:[...status.context.constraints,command.text]}});
        else await c.control(runId,row.id,command.expectedRevision,{action:command.action});
      }
      const run=c.store.status(runId,c.owner);const result={runId,action:command.action,continuedFrom:command.action==='create'?command.continuedFrom:null,state:run.state,implementation:implementationResult,
        guidance:command.action==='create'?'The human started this collaboration in the local panel. Continue the objective in this exact chat using collaboration tools and the bridge skill. Preparing/start sent no intellectual tasks. Assign your own task, send Claude one task, do your analysis and preserve disagreements. If an implementation contract is present, follow its exact assigned roots/paths; use normal permitted editing/test tools, capture the candidate, record declared check receipts, then request an exact-candidate peer review before integration inspection. Preparing integration never authorizes commit, push or deployment. Do not change settings or permissions.':command.action==='input'?'The human versioned the shared context. Inspect stale tasks and adapt work; never resend an uncertain delivery.':'Panel control applied. Inspect authoritative state before further work.'};
      this.db.run("UPDATE panel_commands SET state='applied',run_id=?,result=?,error=NULL WHERE id=?",[runId,JSON.stringify(result),id]);return result;
    }catch(error){this.db.run("UPDATE panel_commands SET state='failed',run_id=?,error=? WHERE id=?",[runId??null,error instanceof Error?error.message:'Command failed',id]);throw error;}
  }
  close(){this.db.close();}
}
