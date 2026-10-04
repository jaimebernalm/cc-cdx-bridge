import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RunStore,contextSchema,limitsSchema} from '../src/runs';
import {type Participant} from '../src/participants';
import {type Peer} from '../src/claude';
import {formatManaged} from '../src/managed-message';
import {formatWork,type Task,type Report} from '../src/routines';
import {type Control} from '../src/coordination';

function fixture(barrier=false,maxMessages=30){
 const root=realpathSync(mkdtempSync('/tmp/phase3-'));let now=100000;const store=new RunStore(root,()=>now),owner=randomUUID(),peer=randomUUID();
 const project={directory:root,kind:'directory' as const,worktree:root,commonGitDir:null,head:null,branch:null,dirty:null,diffHash:null,statusHash:null,untrackedPaths:[],untrackedSnapshot:null};
 const ps:Participant[]=[{sessionId:owner,name:'Codex',provider:'codex',surface:'codex-claude-uds-bridge',pid:1,procStart:'a',socketPath:'/tmp/1.sock',version:'stream-11',status:'idle',project},
 {sessionId:peer,name:'Claude',provider:'claude',surface:'claude-desktop',pid:2,procStart:'b',socketPath:'/tmp/2.sock',version:'2.1.286',status:'idle',project}];
 const p:Peer={sessionId:peer,name:'Claude',pid:2,procStart:'b',messagingSocketPath:'/tmp/2.sock',entrypoint:'claude-desktop',cwd:root,status:'idle',peerProtocol:1,peerFeatures:[]};
 const context=contextSchema.parse({objective:'Investigate with bounded independent exchange'}),limits=limitsSchema.parse({maxMessages,maxSeconds:90});
 const id=store.prepare(owner,randomUUID(),context,limits,ps,{},undefined,{initialBarrier:barrier,leaseSeconds:5});store.start(id,owner);
 const state=()=>store.status(id,owner);
 const control=(c:Control,commandId=randomUUID(),revision=state().coordination!.revision)=>store.control(id,owner,commandId,revision,c);
 const local=(task:Task)=>control({action:'task',task});
 const send=(task:Task)=>{const messageId=randomUUID(),transport=randomUUID();store.reserveOutgoing(id,owner,messageId,peer,'Question',undefined,task);store.claimOutgoing(id,owner,messageId,transport);store.transportStatus(transport,'socket-written');return {messageId,transport,task};};
 const reply=(out:{messageId:string},report:Report|string,version=state().contextVersion)=>{const messageId=randomUUID(),transport=randomUUID();const wire=formatManaged({runId:id,messageId,contextVersion:version,replyTo:out.messageId},typeof report==='string'?report:formatWork(report,'SECRET_CLAUDE_ANALYSIS'));return {messageId,transport,wire,admission:store.admitIncoming(owner,p,transport,wire)};};
 return {root,store,owner,peer,p,ps,id,state,control,local,send,reply,advance:(n:number)=>{now+=n;},other:()=>new RunStore(root,()=>now),close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}
const task=(intent:Task['intent']='analyze'):Task=>({taskId:randomUUID(),intent});
const analysis=(t:Task):Report=>({kind:'response',taskId:t.taskId,declaredState:'analysis',disagreements:[]});

test('optional barrier records authorized early analysis privately and opens only after both assigned analyses',()=>{
 const f=fixture(true);try{const codex=task();f.local(codex);const out=f.send(task());const r=f.reply(out,analysis(out.task));
 expect(r.admission.admitted).toBe(true);expect(f.store.claimIncoming(r.transport)).toBe(false);expect(f.store.authorizeIncoming(r.transport)).toBe('buffer');
 expect(f.state().coordination!.tasks.filter(t=>t.state==='validated')).toHaveLength(1);expect(f.state().reports).toHaveLength(0);
 expect(f.store.export(f.id,f.owner,'json')).not.toContain('SECRET_CLAUDE_ANALYSIS');expect(f.store.export(f.id,f.owner,'markdown')).not.toContain('SECRET_CLAUDE_ANALYSIS');
 expect(()=>f.send(task('discuss'))).toThrow('barrier');
 f.store.recordReport(f.id,f.owner,randomUUID(),analysis(codex),'LOCAL_CODEX_ANALYSIS');expect(f.state().coordination!.barrierOpen).toBe(true);
 expect(f.store.authorizeIncoming(r.transport)).toBe('deliver');expect(f.store.claimIncoming(r.transport)).toBe(true);expect(f.store.claimIncoming(r.transport)).toBe(false);
 f.store.transportStatus(r.transport,'delivered');expect(f.state().reports).toHaveLength(2);expect(f.store.export(f.id,f.owner,'json')).toContain('SECRET_CLAUDE_ANALYSIS');
 }finally{f.close();}
});
test('permission-held data never completes a task or leaks through reports before authorization',()=>{
 const f=fixture(true);try{const c=task();f.local(c);f.store.recordReport(f.id,f.owner,randomUUID(),analysis(c),'Own analysis');const out=f.send(task()),r=f.reply(out,analysis(out.task));
 f.store.transportStatus(r.transport,'held');expect(f.state().coordination!.barrierOpen).toBe(false);expect(f.state().reports).toHaveLength(1);expect(f.store.export(f.id,f.owner,'json')).not.toContain('SECRET_CLAUDE_ANALYSIS');
 }finally{f.close();}
});
test('unclassified and duplicate responses never validate two tasks or open a barrier',()=>{
 const f=fixture(true);try{const out=f.send(task());const malformed=f.reply(out,'CC_CDX_WORK_V1 broken\nReadable but unclassified');expect(malformed.admission.admitted).toBe(true);expect(f.store.authorizeIncoming(malformed.transport)).toBe('buffer');
 expect(f.state().coordination!.tasks[0]!.state).toBe('assigned');const good=f.reply(out,analysis(out.task));f.store.authorizeIncoming(good.transport);const used=f.state().messagesUsed;
 expect(f.store.admitIncoming(f.owner,f.p,randomUUID(),good.wire).reason).toBe('duplicate-message');expect(f.state().messagesUsed).toBe(used);
 const second=f.reply(out,analysis(out.task));f.store.authorizeIncoming(second.transport);expect(f.state().coordination!.tasks.filter(t=>t.state==='validated')).toHaveLength(1);expect(f.state().coordination!.barrierOpen).toBe(false);
 }finally{f.close();}
});
test('pause accepts a response without native delivery, resume preserves budget/deadline and command idempotency',()=>{
 const f=fixture();try{const out=f.send(task('discuss'));const command=randomUUID(),revision=f.state().coordination!.revision;const paused=f.control({action:'pause'},command,revision);const r=f.reply(out,analysis(out.task));expect(r.admission.admitted).toBe(true);
 expect(f.store.authorizeIncoming(r.transport)).toBe('buffer');expect(f.store.claimIncoming(r.transport)).toBe(false);const again=f.control({action:'pause'},command,revision);expect(again.coordination!.revision).toBe(paused.coordination!.revision);
 expect(()=>f.control({action:'pause'},command,revision+1)).toThrow('different');expect(()=>f.control({action:'resume'},randomUUID(),revision)).toThrow('revision');
 const resumed=f.control({action:'resume'});expect(resumed.deadline).toBe(paused.deadline);expect(resumed.messagesUsed).toBe(2);expect(f.store.authorizeIncoming(r.transport)).toBe('deliver');expect(f.store.claimIncoming(r.transport)).toBe(true);
 }finally{f.close();}
});
test('context change invalidates in-flight tasks and rejects old result reviews without relabeling history',()=>{
 const f=fixture();try{const out=f.send(task('discuss'));const resultTask=task('synthesize');f.local(resultTask);const resultId=randomUUID();f.store.recordReport(f.id,f.owner,randomUUID(),{kind:'result',taskId:resultTask.taskId,resultId,version:1,title:'Context one',disagreements:[]},'Old draft');
 f.control({action:'context',context:contextSchema.parse({objective:'Different question'})});const r=f.reply(out,analysis(out.task),1);expect(r.admission.admitted).toBe(false);expect(f.store.authorizeIncoming(r.transport)).toBe('drop');expect(f.state().coordination!.tasks.find(t=>t.id===out.task.taskId)!.state).toBe('stale');
 expect(f.state().results[0]!.contextVersion).toBe(1);expect(f.state().contextVersion).toBe(2);expect(f.state().coordination!.contexts).toHaveLength(2);
 expect(()=>f.send({taskId:randomUUID(),intent:'review',target:{resultId,version:1}})).toThrow('stale context');
 }finally{f.close();}
});
test('lease fencing rejects a second controller, expiry requires recovery and CAS prevents stale mutation',()=>{
 const f=fixture();const other=f.other();try{expect(()=>other.control(f.id,f.owner,randomUUID(),0,{action:'recover'})).toThrow('lease');const t=task();expect(()=>other.recordReport(f.id,f.owner,randomUUID(),analysis(t),'Forged controller')).toThrow('lease');
 f.advance(5001);expect(f.state().state).toBe('recovery_required');const recovered=other.control(f.id,f.owner,randomUUID(),0,{action:'recover'});expect(recovered.state).toBe('paused');
 expect(()=>f.control({action:'resume'})).toThrow('lease');const revision=recovered.coordination!.revision;other.control(f.id,f.owner,randomUUID(),revision,{action:'resume'});
 expect(()=>other.control(f.id,f.owner,randomUUID(),revision,{action:'pause'})).toThrow('revision');expect(other.status(f.id,f.owner).state).toBe('active');
 }finally{other.close();f.close();}
});
test('uncertain native input is reconciled only by its exact persisted ID and never resent',()=>{
 const f=fixture();try{const out=f.send(task('discuss')),r=f.reply(out,analysis(out.task));f.store.authorizeIncoming(r.transport);f.store.claimIncoming(r.transport);const input=randomUUID();f.store.nativeIntent(r.transport,input);f.store.transportStatus(r.transport,'unknown');
 f.store.nativeConsumed(r.transport,randomUUID());expect(f.state().messages.find(m=>m.id===r.messageId)!.status).toBe('unknown');f.store.nativeConsumed(r.transport,input);f.store.nativeConsumed(r.transport,input);
 const state=f.state();expect(state.messages.find(m=>m.id===r.messageId)!.status).toBe('consumed');expect(state.events.filter(e=>e.type==='transport_status'&&e.payload.status==='consumed')).toHaveLength(1);expect(f.store.claimIncoming(r.transport)).toBe(false);
 }finally{f.close();}
});
test('Claude response resolves uncertainty independently of a missing ACK; recovery remains explicit',()=>{
 const f=fixture();try{const out=f.send(task('discuss'));f.store.transportStatus(out.transport,'unknown');expect(f.state().state).toBe('recovery_required');const r=f.reply(out,analysis(out.task));expect(r.admission.admitted).toBe(true);expect(f.store.authorizeIncoming(r.transport)).toBe('buffer');
 expect(f.state().messages.find(m=>m.id===out.messageId)!.status).toBe('unknown');expect(f.state().messages.find(m=>m.id===out.messageId)!.evidence!.responded_at).not.toBeNull();f.control({action:'resume'});expect(f.store.authorizeIncoming(r.transport)).toBe('deliver');
 }finally{f.close();}
});
test('crash recovery never retries an unfinished intent, and terminal late answers stay hidden',()=>{
 const f=fixture();const other=f.other();try{const t=task();f.store.reserveOutgoing(f.id,f.owner,randomUUID(),f.peer,'Intent',undefined,t);f.advance(5001);const recovered=other.control(f.id,f.owner,randomUUID(),0,{action:'recover'});expect(recovered.state).toBe('recovery_required');
 expect(()=>other.control(f.id,f.owner,randomUUID(),recovered.coordination!.revision,{action:'resume'})).toThrow('Uncertain');expect(f.state().messagesUsed).toBe(1);f.store.stop(f.id,f.owner,'cancelled','Cannot establish delivery');
 const out={messageId:f.state().messages[0]!.id};expect(f.reply(out,analysis(t)).admission.admitted).toBe(false);expect(f.store.export(f.id,f.owner,'json')).not.toContain('SECRET_CLAUDE_ANALYSIS');
 }finally{other.close();f.close();}
});
test('both reviews must target the exact current-context version; closure freezes evidence without consensus',()=>{
 const f=fixture();try{const draft=task('synthesize');f.local(draft);const resultId=randomUUID();f.store.recordReport(f.id,f.owner,randomUUID(),{kind:'result',taskId:draft.taskId,resultId,version:1,title:'Draft',disagreements:[]},'Exact draft');
 const reviewTask:Task={taskId:randomUUID(),intent:'review',target:{resultId,version:1}};f.local(reviewTask);f.store.recordReport(f.id,f.owner,randomUUID(),{kind:'review',taskId:reviewTask.taskId,resultId,version:1,verdict:'agree',disagreements:[]},'Own review');expect(f.state().results[0]!.reviewState).toBe('self_only');
 const peerTask:Task={...reviewTask,taskId:randomUUID()};const out=f.send(peerTask),r=f.reply(out,{kind:'review',taskId:peerTask.taskId,resultId,version:1,verdict:'disagree',disagreements:['Open objection']});f.store.authorizeIncoming(r.transport);
 expect(f.state().results[0]!.reviewedByBoth).toBe(true);expect(f.state().results[0]!.reviewState).toBe('other_agent_current');f.store.stop(f.id,f.owner,'completed','Proposal',{result:{resultId,version:1},summary:'With unresolved objection',disposition:'with_disagreements'});
 expect(f.state().closure.reviewCoverage.reviewedByBoth).toBe(true);expect(f.state().closure.validatedConsensus).toBe(false);expect(f.state().closure.disagreements[0].text).toBe('Open objection');
 }finally{f.close();}
});
test('deadline survives pause and releases claims with an exportable incomplete run',()=>{
 const f=fixture();try{f.send(task());f.control({action:'pause'});f.advance(90001);const state=f.state();expect(state.state).toBe('limit_reached');expect(state.reason).toBe('deadline');expect(f.store.activeFor(f.owner)).toBeNull();expect(state.coordination!.tasks[0]!.state).toBe('assigned');expect(f.store.export(f.id,f.owner,'json')).toContain('deadline');}finally{f.close();}
});
test('process identity loss requires recovery before lease deadline',()=>{
 const f=fixture();try{const db=new Database(join(f.root,'collaborations.sqlite'));db.run("UPDATE controller_processes SET proc_start='reused PID'");db.close();expect(f.state().state).toBe('recovery_required');}finally{f.close();}
});
test('message-budget terminal closure keeps the last admitted response and creates no extra task',()=>{
 const f=fixture(false,2);try{const out=f.send(task('discuss')),r=f.reply(out,analysis(out.task));expect(r.admission.admitted).toBe(true);expect(f.store.authorizeIncoming(r.transport)).toBe('deliver');expect(f.store.claimIncoming(r.transport)).toBe(true);f.store.transportStatus(r.transport,'delivered');
 expect(f.state().state).toBe('limit_reached');expect(f.state().reason).toBe('message_budget');expect(f.state().reports).toHaveLength(1);expect(f.state().messagesUsed).toBe(2);expect(f.store.activeFor(f.peer)).toBeNull();expect(f.state().coordination!.tasks).toHaveLength(1);
 }finally{f.close();}
});
test('paused local assignments are rejected and exact review cannot substitute a different task',()=>{
 const f=fixture();try{f.control({action:'pause'});expect(()=>f.local(task())).toThrow('paused');f.control({action:'resume'});const t=task('discuss');f.local(t);expect(()=>f.store.recordReport(f.id,f.owner,randomUUID(),{kind:'review',taskId:t.taskId,resultId:randomUUID(),version:1,verdict:'agree',disagreements:[]},'Wrong target')).toThrow('exact');}finally{f.close();}
});
test('already-open legacy writers cannot bypass structured invariants and legacy report reads do not reveal a closed barrier',()=>{
 const f=fixture(true);const legacy=new Database(join(f.root,'collaborations.sqlite'));try{const out=f.send(task()),r=f.reply(out,analysis(out.task));f.store.authorizeIncoming(r.transport);
 expect(legacy.query('SELECT * FROM routine_reports').all()).toHaveLength(0);expect(()=>legacy.run("UPDATE runs SET state='completed' WHERE id=?",[f.id])).toThrow('Reload');expect(()=>legacy.run('DELETE FROM session_claims WHERE run_id=?',[f.id])).toThrow('Reload');
 expect(()=>legacy.run("INSERT INTO run_messages(id,run_id,direction,peer_id,text,hash,status,admitted,created_at) VALUES (?,?,'out',?,'bypass','x','reserved',1,0)",[randomUUID(),f.id,f.peer])).toThrow('Reload');expect(f.state().state).toBe('active');
 }finally{legacy.close();f.close();}
});
