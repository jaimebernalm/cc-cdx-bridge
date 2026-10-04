import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {nativeFixture,until} from './collaboration-fixture';

// Uses real SQLite, UDS frames, MCP subprocesses and the native IPC contract fixture.
test('structured MCP barrier survives early peer response, opens once and preserves pause/context version routing',async()=>{
 const f=await nativeFixture();const c=await f.connect();try{
  const call=(name:string,args:Record<string,unknown>)=>f.call(c,name,args);
  const prepared=await call('collaboration_prepare',{requestId:randomUUID(),peerId:f.peerId,context:{objective:'Initial analysis before exchange'},coordination:{initialBarrier:true,leaseSeconds:30},limits:{maxMessages:12,maxSeconds:60}});expect(prepared.error).not.toBe(true);const runId=prepared.data.id;
  await call('collaboration_start',{runId,supervised:true});let status=(await call('collaboration_status',{runId})).data;
  const codexTask=randomUUID(),peerTask=randomUUID(),messageId=randomUUID();
  const local=await call('collaboration_control',{runId,commandId:randomUUID(),expectedRevision:status.coordination.revision,control:{action:'task',task:{taskId:codexTask,intent:'analyze'}}});expect(local.error).not.toBe(true);
  expect((await call('collaboration_send',{runId,messageId,text:'Analyze without editing',task:{taskId:peerTask,intent:'analyze'}})).error).not.toBe(true);
  await f.respond(runId,messageId,{kind:'response',taskId:peerTask,declaredState:'analysis',disagreements:[]},'EARLY_NATIVE_SECRET');await until(()=>f.bridge.status().bufferedCount===1);
  expect(f.desktop.submissions).toHaveLength(0);status=(await call('collaboration_status',{runId})).data;expect(status.reports).toHaveLength(0);expect(JSON.stringify(status)).not.toContain('EARLY_NATIVE_SECRET');
  const exportBefore=await call('collaboration_export',{runId,format:'markdown'});expect(exportBefore.data.content).not.toContain('EARLY_NATIVE_SECRET');
  expect((await call('collaboration_report',{runId,reportId:randomUUID(),report:{kind:'response',taskId:codexTask,declaredState:'analysis'},text:'Own analysis committed before visibility'})).error).not.toBe(true);
  await until(()=>f.desktop.submissions.length===1);expect(f.bridge.status().bufferedCount).toBe(0);await Bun.sleep(1100);expect(f.desktop.submissions).toHaveLength(1);
  status=(await call('collaboration_status',{runId})).data;expect(status.coordination.barrierOpen).toBe(true);expect(status.reports).toHaveLength(2);
  // Context change resets the barrier and keeps context-one rows historic.
  const updated=await call('collaboration_control',{runId,commandId:randomUUID(),expectedRevision:status.coordination.revision,control:{action:'context',context:{objective:'New context'}}});expect(updated.error).not.toBe(true);expect(updated.data.contextVersion).toBe(2);expect(updated.data.coordination.barrierOpen).toBe(false);
  await f.respond(runId,messageId,{kind:'response',taskId:peerTask,declaredState:'analysis',disagreements:[]},'OLD_CONTEXT_SECRET');await until(()=>f.bridge.runs.status(runId,f.desktop.threadId).messages.length===3);expect(f.desktop.submissions).toHaveLength(1);expect(JSON.stringify((await call('collaboration_status',{runId})).data)).not.toContain('OLD_CONTEXT_SECRET');
  const cancelled=await call('collaboration_cancel',{runId,reason:'Acceptance test finished'});expect(cancelled.data.state).toBe('cancelled');
 }finally{await c.close();await f.close();}
});
test('MCP controller crash is reconstructed as recovery_required and competing controllers cannot take live lease',async()=>{
 const f=await nativeFixture();let c=await f.connect();const competing=await f.connect();try{
  const prepared=await f.call(c,'collaboration_prepare',{requestId:randomUUID(),peerId:f.peerId,context:{objective:'Controller recovery'},coordination:{leaseSeconds:30}});const runId=prepared.data.id;
  await f.call(c,'collaboration_start',{runId,supervised:true});const stolen=await f.call(competing,'collaboration_control',{runId,commandId:randomUUID(),expectedRevision:0,control:{action:'recover'}});expect(stolen.error).toBe(true);
  await c.close();c=await f.connect();const status=await f.call(c,'collaboration_status',{runId});expect(status.data.state).toBe('recovery_required');
  const recovered=await f.call(c,'collaboration_control',{runId,commandId:randomUUID(),expectedRevision:status.data.coordination.revision,control:{action:'recover'}});expect(recovered.error).not.toBe(true);expect(recovered.data.state).toBe('paused');
  const resumed=await f.call(c,'collaboration_control',{runId,commandId:randomUUID(),expectedRevision:recovered.data.coordination.revision,control:{action:'resume'}});expect(resumed.data.state).toBe('active');expect(f.frames.filter(frame=>frame.type==='user')).toHaveLength(0);
  await f.call(c,'collaboration_cancel',{runId});
 }finally{await c.close();await competing.close();await f.close();}
});
test('lost native ACK reconciles observed input from history without reinjection or invented Claude ACK',async()=>{
 const f=await nativeFixture(true);const c=await f.connect();try{
  const prepared=await f.call(c,'collaboration_prepare',{requestId:randomUUID(),peerId:f.peerId,context:{objective:'Lost ACK'},coordination:{leaseSeconds:30}});const runId=prepared.data.id;await f.call(c,'collaboration_start',{runId,supervised:true});
  const taskId=randomUUID(),messageId=randomUUID();await f.call(c,'collaboration_send',{runId,messageId,text:'Check once',task:{taskId,intent:'discuss'}});await f.respond(runId,messageId,{kind:'response',taskId,declaredState:'perspective',disagreements:[]},'Native response');await until(()=>f.desktop.submissions.length===1);
  await until(()=>f.bridge.runs.status(runId,f.desktop.threadId).messages.some(m=>m.direction==='in'&&m.status==='unknown'));
  const db=new Database(join(f.state,f.desktop.threadId+'.sqlite'),{readonly:true});const input=db.query<{desktop_input_id:string},[]>('SELECT desktop_input_id FROM messages WHERE direction=\'in\' AND status=\'unknown\'').get()!.desktop_input_id;db.close();
  f.desktop.setHistory({turns:[{items:[{type:'userMessage',id:randomUUID(),clientId:input}]}]});await until(()=>f.bridge.runs.status(runId,f.desktop.threadId).messages.some(m=>m.direction==='in'&&m.status==='consumed'));
  expect(f.desktop.submissions).toHaveLength(1);expect(f.bridge.status().unreadCount).toBe(0);const status=(await f.call(c,'collaboration_status',{runId})).data;expect(status.state).toBe('recovery_required');expect(status.messages.find((m:{direction:string})=>m.direction==='out').evidence.responded_at).not.toBeNull();
  const resumed=await f.call(c,'collaboration_control',{runId,commandId:randomUUID(),expectedRevision:status.coordination.revision,control:{action:'resume'}});expect(resumed.data.state).toBe('active');await f.call(c,'collaboration_cancel',{runId});
 }finally{await c.close();await f.close();}
});
