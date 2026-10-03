import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import net from 'node:net';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {RunStore,contextSchema,limitsSchema} from '../src/runs';
import {normalizeRoutine,formatWork,parseWork,type Task,type Report} from '../src/routines';
import {type Participant,discoverParticipants} from '../src/participants';
import {formatManaged,parseManaged} from '../src/managed-message';
import {processStart,type Peer,frameSchema} from '../src/claude';
import {Bridge} from '../src/bridge';
import {receiver} from './desktop-fixture';

const pluginRoot=resolve(import.meta.dir,'..');
const context=contextSchema.parse({objective:'Inspect alternatives without edits'});
const limits=limitsSchema.parse({maxMessages:20,maxSeconds:60});
function fixture() {
 const root=realpathSync(mkdtempSync('/tmp/phase2-'));const store=new RunStore(root);const owner=randomUUID();const peer=randomUUID();
 const project={directory:root,kind:'directory' as const,worktree:root,commonGitDir:null,head:null,branch:null,dirty:null,diffHash:null,statusHash:null,untrackedPaths:[],untrackedSnapshot:null};
 const ps:Participant[]=[{sessionId:owner,name:'Same',provider:'codex',surface:'codex-claude-uds-bridge',pid:1,procStart:'a',socketPath:'/tmp/1.sock',version:'stream-11',status:'idle',project},
 {sessionId:peer,name:'Same',provider:'claude',surface:'claude-desktop',pid:2,procStart:'b',socketPath:'/tmp/2.sock',version:'2.1.286',status:'idle',project}];
 const p:Peer={sessionId:peer,name:'Same',pid:2,procStart:'b',messagingSocketPath:'/tmp/2.sock',entrypoint:'claude-desktop',cwd:root,status:'idle',peerProtocol:1,peerFeatures:[]};
 const runId=store.prepare(owner,randomUUID(),context,limits,ps,{policy:'same'});store.start(runId,owner);
 const send=(task:Task)=>{const id=randomUUID();store.reserveOutgoing(runId,owner,id,peer,'task',undefined,task);store.claimOutgoing(runId,owner,id,randomUUID());store.transportStatus(store.status(runId,owner).messages.find(m=>m.id===id)!.transport_id!,'socket-written');return id;};
 const incoming=(out:string,report:Report,text='Peer answer')=>{const id=randomUUID(),transport=randomUUID();const result=store.admitIncoming(owner,p,transport,formatManaged({runId,messageId:id,contextVersion:1,replyTo:out},formatWork(report,text)));return {id,transport,result};};
 return {root,store,owner,peer,ps,p,runId,send,incoming,close(){store.close();rmSync(root,{recursive:true,force:true});}};
}
test('free is default; new/existing/mixed starts use actual supplied analyses and reject contradictory starts',()=>{
 expect(normalizeRoutine(undefined,{})).toMatchObject({mode:'free',startMode:'new',independence:'not_guaranteed'});
 expect(normalizeRoutine({mode:'research'},{codex:'A',claude:'B'})).toMatchObject({mode:'research',startMode:'existing'});
 expect(normalizeRoutine({mode:'review'},{codex:'A'}).startMode).toBe('mixed');
 expect(()=>normalizeRoutine({starts:{codex:'existing',claude:'new'}},{})).toThrow('requires explicit');
 expect(()=>normalizeRoutine({starts:{codex:'new',claude:'new'}},{claude:'B'})).toThrow('conflicts');
 expect(()=>normalizeRoutine({mode:'other' as 'free'},{})).toThrow();
});
test('work envelopes reject forged author fields, malformed metadata and review without a version',()=>{
 const task:Task={taskId:randomUUID(),intent:'discuss'};expect(parseWork(formatWork(task,'Question'))?.work).toMatchObject(task);
 expect(()=>parseWork('CC_CDX_WORK_V1 {"kind":"response","author":"codex","declaredState":"done"}\ntext')).toThrow();
 expect(()=>formatWork({taskId:randomUUID(),intent:'review'},'Review')).toThrow('exact');
 expect(parseWork('A normal answer')).toBeNull();
 expect(()=>parseWork('CC_CDX_WORK_V1 broken\ntext')).toThrow();
});
test('routine is frozen in preparation idempotency; declared done/blocked does not change run state',()=>{
 const f=fixture();try{
  const request=randomUUID();const a=f.store.prepare(f.owner,request,context,limits,f.ps,{}, {mode:'review'});
  expect(f.store.prepare(f.owner,request,context,limits,f.ps,{}, {mode:'review'})).toBe(a);
  expect(()=>f.store.prepare(f.owner,request,context,limits,f.ps,{}, {mode:'research'})).toThrow('different');
  const reportId=randomUUID();const report:Report={kind:'response',declaredState:'blocked',disagreements:['Need more evidence']};
  f.store.recordReport(f.runId,f.owner,reportId,report,'Blocked according to Codex');
  f.store.recordReport(f.runId,f.owner,reportId,report,'Blocked according to Codex');
  expect(f.store.status(f.runId,f.owner).reports).toHaveLength(1);expect(f.store.status(f.runId,f.owner).state).toBe('active');
  expect(()=>f.store.recordReport(f.runId,f.owner,reportId,report,'Different')).toThrow('different');
  expect(()=>f.store.recordReport(f.runId,randomUUID(),randomUUID(),report,'Forged')).toThrow('initiating');
  f.store.stop(f.runId,f.owner,'completed','Complete');
  expect(f.store.recordReport(f.runId,f.owner,reportId,report,'Blocked according to Codex').id).toBe(reportId);
  expect(()=>f.store.recordReport(f.runId,f.owner,randomUUID(),report,'New report')).toThrow('completed');
 }finally{f.close();}
});
test('delivered peer results derive author from transport; result versions are immutable and author-specific',()=>{
 const f=fixture();try{
  const task:Task={taskId:randomUUID(),intent:'synthesize'};const out=f.send(task);const resultId=randomUUID();
  const reply=f.incoming(out,{kind:'result',taskId:task.taskId,resultId,version:1,title:'Claude proposal',disagreements:['Open tradeoff']},'First draft');
  expect(reply.result.admitted).toBe(true);expect(f.store.status(f.runId,f.owner).results).toHaveLength(0);
  f.store.claimIncoming(reply.transport);f.store.transportStatus(reply.transport,'delivered');
  const state=f.store.status(f.runId,f.owner);expect(state.results[0]?.author).toBe(f.peer);expect(state.results[0]?.source_message).toBe(reply.id);expect(state.results[0]?.contentHash).toHaveLength(64);
  expect(()=>f.store.recordReport(f.runId,f.owner,randomUUID(),{kind:'result',resultId,version:2,title:'Take over',disagreements:[]},'Other author')).toThrow('author');
  const bad=f.incoming(out,{kind:'result',taskId:task.taskId,resultId,version:1,title:'Overwrite',disagreements:[]},'Changed');expect(bad.result.reason).toBe('invalid-work-envelope');
  expect(state.disagreements[0]?.text).toBe('Open tradeoff');expect(state.results[0]?.validatedByCore).toBe(false);
 }finally{f.close();}
});
test('exact review target and hash persist; a review stays attributed to the old version after revision',()=>{
 const f=fixture();try{
  const resultId=randomUUID();f.store.recordReport(f.runId,f.owner,randomUUID(),{kind:'result',resultId,version:1,title:'Plan',disagreements:[]},'Version one');
  const task:Task={taskId:randomUUID(),intent:'review',target:{resultId,version:1}};const out=f.send(task);
  const bad=f.incoming(out,{kind:'review',taskId:task.taskId,resultId,version:2,verdict:'agree',disagreements:[]});expect(bad.result.admitted).toBe(false);
  const reply=f.incoming(out,{kind:'review',taskId:task.taskId,resultId,version:1,verdict:'disagree',disagreements:['Missing evidence']},'A concrete objection');
  expect(reply.result.admitted).toBe(true);f.store.claimIncoming(reply.transport);f.store.transportStatus(reply.transport,'delivered');
  expect(f.store.status(f.runId,f.owner).reviews[0]?.current).toBe(true);
  f.store.recordReport(f.runId,f.owner,randomUUID(),{kind:'result',resultId,version:2,title:'Revised plan',disagreements:['Still uncertain']},'Version two');
  const state=f.store.status(f.runId,f.owner);expect(state.reviews[0]?.current).toBe(false);expect(state.reviews[0]?.targetHash).toBe(state.results[0]?.contentHash);expect(state.reviews[0]?.validatedConsensus).toBe(false);
  expect(()=>f.store.recordReport(f.runId,f.owner,randomUUID(),{kind:'review',resultId:randomUUID(),version:1,verdict:'agree',disagreements:[]},'Fake review')).toThrow('does not exist');
  expect(()=>f.store.recordReport(f.runId,f.owner,randomUUID(),{kind:'result',resultId,version:4,title:'Skip',disagreements:[]},'Four')).toThrow('sequential');
  f.store.stop(f.runId,f.owner,'completed','Retain disagreement',{result:{resultId,version:2},summary:'Proposal with limitations',disposition:'with_disagreements'});
  expect(state.disagreements).toHaveLength(2);const text=f.store.export(f.runId,f.owner,'markdown');expect(text).toContain('Missing evidence');expect(text).toContain('with_disagreements');expect(text).toContain('vigente: false');
 }finally{f.close();}
});
test('wrong task/replyTo and duplicate task IDs are rejected before admitting another managed message',()=>{
 const f=fixture();try{
  const task:Task={taskId:randomUUID(),intent:'analyze'};const out=f.send(task);
  expect(f.incoming(out,{kind:'response',taskId:randomUUID(),declaredState:'done',disagreements:[]}).result.reason).toBe('invalid-work-envelope');
  expect(f.incoming(out,{kind:'response',declaredState:'done',disagreements:[]}).result.admitted).toBe(false);
  expect(()=>f.send(task)).toThrow('already bound');expect(f.store.status(f.runId,f.owner).messagesUsed).toBe(1);
  expect(()=>f.store.outgoingExists(f.runId,f.owner,out,'task',undefined,{...task,intent:'discuss'})).toThrow('different task');
  expect(()=>f.store.recordReport(f.runId,f.owner,randomUUID(),{kind:'response',taskId:randomUUID(),declaredState:'done',disagreements:[]},'Unknown task')).toThrow('does not belong');
 }finally{f.close();}
});
test('held/denied/late content cannot bypass reception through status/export or create a report',()=>{
 const f=fixture();try{
  const task:Task={taskId:randomUUID(),intent:'discuss'};const out=f.send(task);
  const reply=f.incoming(out,{kind:'response',taskId:task.taskId,declaredState:'done',disagreements:['SECRET_UNDELIVERED_OBJECTION']},'SECRET_UNDELIVERED_BODY');
  f.store.transportStatus(reply.transport,'held');
  for(const format of ['json','markdown'] as const){const text=f.store.export(f.runId,f.owner,format);expect(text).not.toContain('SECRET_UNDELIVERED');}
  expect(f.store.status(f.runId,f.owner).messages.find(m=>m.id===reply.id)?.contentRedacted).toBe(true);expect(f.store.status(f.runId,f.owner).reports).toHaveLength(0);
  f.store.transportStatus(reply.transport,'denied');f.store.stop(f.runId,f.owner,'cancelled','Stopped');
  const late=f.incoming(out,{kind:'response',taskId:task.taskId,declaredState:'done',disagreements:[]},'SECRET_LATE_BODY');expect(late.result.admitted).toBe(false);
  expect(f.store.export(f.runId,f.owner,'json')).not.toContain('SECRET_LATE_BODY');expect(f.store.claimIncoming(late.transport)).toBe(false);
 }finally{f.close();}
});
test('permitted plain managed responses remain compatible; closure is explicit and results survive controller restart',()=>{
 const f=fixture();try{
  const task:Task={taskId:randomUUID(),intent:'discuss'};const out=f.send(task);const id=randomUUID(),transport=randomUUID();
  expect(f.store.admitIncoming(f.owner,f.p,transport,formatManaged({runId:f.runId,messageId:id,replyTo:out,contextVersion:1},'Plain answer')).admitted).toBe(true);
  f.store.claimIncoming(transport);f.store.transportStatus(transport,'delivered');expect(f.store.status(f.runId,f.owner).messages.find(m=>m.id===id)?.text).toBe('Plain answer');
  const resultId=randomUUID();f.store.recordReport(f.runId,f.owner,randomUUID(),{kind:'result',resultId,version:1,title:'Conclusion',disagreements:[]},'A conclusion');
  const reopened=new RunStore(f.root);try{expect(reopened.status(f.runId,f.owner).results[0]?.body).toBe('A conclusion');expect(()=>reopened.stop(f.runId,f.owner,'completed','Bad target',{result:{resultId,version:2},summary:'No such draft',disposition:'proposal'})).toThrow('does not exist');
   expect(reopened.status(f.runId,f.owner).state).toBe('active');reopened.stop(f.runId,f.owner,'completed','Done',{result:{resultId,version:1},summary:'One authored proposal',disposition:'proposal'});expect(reopened.activeFor(f.owner)).toBeNull();
  }finally{reopened.close();}
 }finally{f.close();}
});
test('schema 1 migration preserves legacy runs/messages without inventing analyses or reports',()=>{
 const f=fixture();let db:Database|undefined;try{
  const task:Task={taskId:randomUUID(),intent:'analyze'};f.send(task);f.store.stop(f.runId,f.owner,'completed','Legacy finished');
  db=new Database(join(f.root,'collaborations.sqlite'));db.exec('DROP TABLE routine_reports; DROP TABLE routine_tasks; DROP TABLE routines; PRAGMA user_version=1');db.close();db=undefined;
  const migrated=new RunStore(f.root);try{const state=migrated.status(f.runId,f.owner);expect(state.schemaVersion).toBe(2);expect(state.state).toBe('completed');expect(state.messages).toHaveLength(1);expect(state.routine).toBeNull();expect(state.reports).toHaveLength(0);}finally{migrated.close();}
 }finally{db?.close();f.close();}
});
test('legacy active runs can retain an explicit closure without inventing a routine',()=>{
 const f=fixture();try{
  const db=new Database(join(f.root,'collaborations.sqlite'));db.run('DELETE FROM routines WHERE run_id=?',[f.runId]);db.close();
  f.store.stop(f.runId,f.owner,'completed','Close legacy',{summary:'Explicit legacy closure',disposition:'incomplete'});
  expect(f.store.status(f.runId,f.owner).routine).toBeNull();expect(f.store.status(f.runId,f.owner).closure?.summary).toBe('Explicit legacy closure');
 }finally{f.close();}
});

async function until(check:()=>boolean){const deadline=Date.now()+4000;while(!check()&&Date.now()<deadline)await Bun.sleep(10);expect(check()).toBe(true);}
async function nativeFixture(){
 const root=mkdtempSync('/tmp/phase2-native-');const desktop=await receiver('idle',false,false,root);const config=join(root,'claude');const state=join(root,'plugin-state/claude-uds-bridge');const sockets=join(root,'s');
 mkdirSync(join(config,'sessions'),{recursive:true,mode:0o700});mkdirSync(sockets,{mode:0o700});const peerId=randomUUID();const peerSocket=join(sockets,process.ppid+'.sock');const frames:ReturnType<typeof frameSchema.parse>[]=[];const clients=new Set<net.Socket>();
 const server=net.createServer(socket=>{clients.add(socket);socket.on('error',()=>{});socket.on('close',()=>clients.delete(socket));socket.setEncoding('utf8');let buffer='';socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){frames.push(frameSchema.parse(JSON.parse(buffer.slice(0,end))));buffer=buffer.slice(end+1);}});});server.listen(peerSocket);await once(server,'listening');chmodSync(peerSocket,0o600);
 writeFileSync(join(config,'sessions',process.ppid+'.json'),JSON.stringify({pid:process.ppid,procStart:await processStart(process.ppid),sessionId:peerId,messagingSocketPath:peerSocket,cwd:root,name:'Claude test',entrypoint:'claude-desktop',status:'idle',version:'2.1.286',peerProtocol:1}),{mode:0o600});
 const bridge=new Bridge(desktop.threadId,config,state,desktop.path);await bridge.start(sockets,root,bridge.beginSession());bridge.updateRuntime({status:'idle',mode:'prompting'});
 const connect=async()=>{const c=new Client({name:'phase2-fixture',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[process.env.UDS_MCP_TEST_ENTRYPOINT??join(pluginRoot,'src/server.ts')],env:{...process.env,CODEX_HOME:root,CLAUDE_CONFIG_DIR:config}}));return c;};
 const call=async(c:Client,name:string,args:Record<string,unknown>)=>{const r=await c.callTool({name,arguments:args,_meta:{threadId:desktop.threadId}});const text=(r.content as {text:string}[])[0]!.text;return {error:r.isError,data:r.isError?text:JSON.parse(text)};};
 const respond=async(runId:string,out:string,report:Report,text:string)=>{const socket=net.createConnection(bridge.status().replyAddress!.slice(4));await once(socket,'connect');socket.end(JSON.stringify({msgV:1,type:'user',msg_id:randomUUID(),from:'uds:'+peerSocket,from_mode:'prompting',session_id:desktop.threadId,message:{role:'user',content:formatManaged({runId,messageId:randomUUID(),replyTo:out,contextVersion:1},formatWork(report,text))}})+'\n');await once(socket,'close');};
 return {root,desktop,config,state,bridge,peerId,frames,connect,call,respond,async close(){await bridge.close();for(const socket of clients)socket.destroy();await new Promise<void>(done=>server.close(()=>done()));await desktop.close();}};
}
test('real MCP/socket fixture supports mixed guided review, exact draft transport, authored reply and restart/export',async()=>{
 const f=await nativeFixture();let c=await f.connect();try{
  const call=(name:string,args:Record<string,unknown>)=>f.call(c,name,args);
  const prepared=await call('collaboration_prepare',{requestId:randomUUID(),peerId:f.peerId,context:{objective:'Review an earlier plan',priorAnalysis:{codex:'Earlier Codex analysis'}},routine:{mode:'review',starts:{codex:'existing',claude:'new'}},limits});expect(prepared.error).not.toBe(true);const runId=prepared.data.id;
  expect(prepared.data.routine.startMode).toBe('mixed');await call('collaboration_start',{runId,supervised:true});
  const resultId=randomUUID();await call('collaboration_report',{runId,reportId:randomUUID(),report:{kind:'result',resultId,version:1,title:'Pinned draft'},text:'Specific draft content'});
  const messageId=randomUUID(),taskId=randomUUID();const sent=await call('collaboration_send',{runId,messageId,text:'Review this draft',task:{taskId,intent:'review',target:{resultId,version:1}}});expect(sent.error).not.toBe(true);
  await until(()=>f.frames.some(frame=>frame.type==='user'));const frame=f.frames.find(frame=>frame.type==='user')!;if(frame.type!=='user')throw new Error('Missing user frame');
  expect(frame.message.content).toContain('Specific draft content');expect(frame.message.content).toContain('Orientación de colaboración');expect(parseManaged(frame.message.content)?.header.runId).toBe(runId);
  await f.respond(runId,messageId,{kind:'review',taskId,resultId,version:1,verdict:'disagree',disagreements:['Missing a concrete check']},'Peer identifies a risk');await until(()=>f.desktop.submissions.length===1);
  await until(()=>f.bridge.runs.status(runId,f.desktop.threadId).reviews.length===1);
  await c.close();c=await f.connect();const restored=await call('collaboration_status',{runId});expect(restored.data.reviews[0].author).toBe(f.peerId);expect(restored.data.state).toBe('active');
  const exported=await call('collaboration_export',{runId,format:'markdown'});expect(exported.data.content).toContain('Missing a concrete check');expect(exported.data.content).toContain('Peer identifies a risk');
  const finished=await call('collaboration_finish',{runId,reason:'Review ended with disagreement',closure:{result:{resultId,version:1},summary:'Retain objection',disposition:'with_disagreements'}});expect(finished.data.closure.validatedConsensus).toBe(false);expect(finished.data.state).toBe('completed');expect(f.bridge.runs.activeFor(f.peerId)).toBeNull();
 }finally{await c.close();await f.close();}
});
test('phase 2 capability gate rejects an older receiver; MCP guide remains read-only and cancellation gates tasks',async()=>{
 const f=await nativeFixture();const c=await f.connect();try{
  const call=(name:string,args:Record<string,unknown>)=>f.call(c,name,args);const guide=await call('collaboration_guide',{});expect(guide.data.mode).toBe('free');expect(f.frames).toHaveLength(0);
  const db=new Database(join(f.state,f.desktop.threadId+'.sqlite'));db.run("DELETE FROM receiver_capabilities WHERE capability='guided_runs_v1'");
  const rejected=await call('collaboration_prepare',{requestId:randomUUID(),peerId:f.peerId,context});expect(rejected.error).toBe(true);
  const proc=db.query<{pid:number;proc_start:string},[]>('SELECT pid,proc_start FROM receiver').get()!;db.run("INSERT INTO receiver_capabilities VALUES ('guided_runs_v1',?,?)",[proc.pid,proc.proc_start]);db.close();
  expect((await discoverParticipants(f.config,f.state)).find(p=>p.sessionId===f.desktop.threadId)?.guidedReceiver).toBe(true);
  const prepared=await call('collaboration_prepare',{requestId:randomUUID(),peerId:f.peerId,context});const runId=prepared.data.id;await call('collaboration_start',{runId,supervised:true});await call('collaboration_cancel',{runId});
  expect((await call('collaboration_send',{runId,messageId:randomUUID(),text:'No work after cancel',task:{taskId:randomUUID(),intent:'analyze'}})).error).toBe(true);expect(f.frames).toHaveLength(0);
 }finally{await c.close();await f.close();}
});
