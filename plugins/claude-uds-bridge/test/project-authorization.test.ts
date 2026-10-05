import {test,expect,spyOn} from 'bun:test';
import {mkdtempSync,mkdirSync,symlinkSync,renameSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {once} from 'node:events';
import {ProjectAuthorizations} from '../src/project-authorization';
import {nativeFixture,until} from './collaboration-fixture';

test('project grant persists, aliases share scope, recreated folders and other worktrees do not; CAS and old actions cannot regrant',()=>{
 const root=mkdtempSync('/tmp/project-auth-'),project=join(root,'project'),other=join(root,'other');mkdirSync(project);mkdirSync(other);symlinkSync(project,join(root,'alias'));
 let now=100;let store=new ProjectAuthorizations(join(root,'state'),()=>now);const change={project,ownerThread:randomUUID(),actionId:randomUUID(),enabled:true,expectedRevision:0,confirmed:true as const};
 try {
  expect(store.status(project).enabled).toBe(false);expect(store.change(change).revision).toBe(1);expect(store.allows(project,100)).toBe(false);expect(store.allows(join(root,'alias'),101)).toBe(true);expect(store.allows(other,101)).toBe(false);
  expect(statSync(join(root,'state/project-authorizations.sqlite')).mode&0o077).toBe(0);
  store.close();store=new ProjectAuthorizations(join(root,'state'),()=>now);expect(store.status(project).enabled).toBe(true);
  expect(store.change(change).reused).toBe(true);expect(()=>store.change({...change,enabled:false})).toThrow('reused');
  expect(()=>store.change({...change,actionId:randomUUID(),expectedRevision:0})).toThrow('revision');
  now=200;store.change({...change,actionId:randomUUID(),enabled:false,expectedRevision:1});expect(store.allows(project,201)).toBe(false);
  expect(store.change(change).enabled).toBe(false);expect(store.status(project).revision).toBe(2);
  now=300;store.change({...change,actionId:randomUUID(),expectedRevision:2});expect(store.allows(project,150)).toBe(false);expect(store.allows(project,301)).toBe(true);
  renameSync(project,join(root,'old-project'));mkdirSync(project);expect(store.status(project).folderChanged).toBe(true);expect(store.status(project).enabled).toBe(false);expect(store.allows(project,400)).toBe(false);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

async function running(){const f=await nativeFixture();f.desktop.setPermissions({approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});f.bridge.updateRuntime({status:'idle',mode:'bypass'});const c=await f.connect();
 const prepared=await f.call(c,'collaboration_prepare',{requestId:randomUUID(),peerId:f.peerId,context:{objective:'Project authorization acceptance'},coordination:{initialBarrier:false,leaseSeconds:300},limits:{maxMessages:20,maxSeconds:300}});expect(prepared.error).toBeFalsy();const id=prepared.data.id;expect((await f.call(c,'collaboration_start',{runId:id,supervised:true})).error).toBeFalsy();
 const authorizations=new ProjectAuthorizations(f.state);const grant=()=>authorizations.change({project:f.root,ownerThread:f.desktop.threadId,actionId:randomUUID(),enabled:true,expectedRevision:authorizations.status(f.root).revision,confirmed:true});
 const send=async(text:string,context=1)=>{const taskId=randomUUID(),messageId=randomUUID();expect((await f.call(c,'collaboration_send',{runId:id,messageId,text:'Read only check',task:{taskId,intent:'discuss'}})).error).toBeFalsy();await f.respond(id,messageId,{kind:'response',taskId,declaredState:'perspective',disagreements:[]},text,context);};
 return {f,c,id,grant,send,authorizations,async close(){authorizations.close();await c.close();await f.close();}};
}
test('default receiver inherits only new verified replies; revocation stops inheritance without changing the chat policy',async()=>{
 const x=await running();try {
  x.grant();await Bun.sleep(3);await x.send('AUTHORIZED_REPLY');await until(()=>x.f.desktop.submissions.length===1);expect(x.f.bridge.policy()).toBe('default');expect(JSON.stringify(x.f.desktop.submissions)).toContain('AUTHORIZED_REPLY');
  x.authorizations.change({project:x.f.root,ownerThread:x.f.desktop.threadId,actionId:randomUUID(),enabled:false,expectedRevision:1,confirmed:true});
  await x.send('REVOKED_REPLY');await until(()=>x.f.bridge.runs.status(x.id,x.f.desktop.threadId).messages.filter(m=>m.direction==='in').length===2);await Bun.sleep(150);expect(x.f.desktop.submissions).toHaveLength(1);expect(x.f.bridge.policy()).toBe('default');
  x.grant();await Bun.sleep(50);expect(x.f.desktop.submissions).toHaveLength(1); // No retroactive replay of a held/denied reply.
 }finally{await x.close();}
});
for(const policy of ['hold','refuse'] as const)test(`project authorization respects explicit ${policy}`,async()=>{
 const x=await running();try {x.grant();await x.f.bridge.setPolicy(policy);await Bun.sleep(3);await x.send('EXPLICIT_OVERRIDE');await until(()=>x.f.bridge.runs.status(x.id,x.f.desktop.threadId).messages.some(m=>m.direction==='in'));await Bun.sleep(50);expect(x.f.desktop.submissions).toHaveLength(0);expect(x.f.bridge.policy()).toBe(policy);}finally{await x.close();}
});
test('project grant does not accept ordinary peer traffic or stale-context responses',async()=>{
 const x=await running();try {x.grant();await Bun.sleep(3);await x.send('STALE_REPLY',2);await until(()=>x.f.bridge.runs.status(x.id,x.f.desktop.threadId).messages.some(m=>m.direction==='in'));await Bun.sleep(50);expect(x.f.desktop.submissions).toHaveLength(0);
  await x.f.call(x.c,'collaboration_cancel',{runId:x.id});
  const socket=net.createConnection(x.f.bridge.status().replyAddress!.slice(4));await once(socket,'connect');socket.end(JSON.stringify({msgV:1,type:'user',msg_id:randomUUID(),from:'uds:'+join(x.f.root,'s',process.ppid+'.sock'),from_mode:'prompting',session_id:x.f.desktop.threadId,message:{role:'user',content:'ORDINARY_UNCORRELATED'}})+'\n');await once(socket,'close');await Bun.sleep(150);expect(x.f.desktop.submissions).toHaveLength(0);
 }finally{await x.close();}
});
test('a grant for a different folder does not authorize this receiver',async()=>{
 const x=await running();try {const other=join(x.f.root,'other');mkdirSync(other);x.authorizations.change({project:other,ownerThread:x.f.desktop.threadId,actionId:randomUUID(),enabled:true,expectedRevision:0,confirmed:true});await x.send('OTHER_PROJECT');await until(()=>x.f.bridge.runs.status(x.id,x.f.desktop.threadId).messages.some(m=>m.direction==='in'));await Bun.sleep(80);expect(x.f.desktop.submissions).toHaveLength(0);}finally{await x.close();}
});

test('revocation also covers barrier-buffered replies and preserves an explicit chat accept',async()=>{
 const f=await nativeFixture();f.desktop.setPermissions({approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});f.bridge.updateRuntime({status:'idle',mode:'bypass'});const c=await f.connect();const auth=new ProjectAuthorizations(f.state);
 try {
  const grant={project:f.root,ownerThread:f.desktop.threadId,actionId:randomUUID(),enabled:true,expectedRevision:0,confirmed:true as const};auth.change(grant);await Bun.sleep(3);
  const p=await f.call(c,'collaboration_prepare',{requestId:randomUUID(),peerId:f.peerId,context:{objective:'Revocation behind barrier'},coordination:{initialBarrier:true,leaseSeconds:300},limits:{maxMessages:10,maxSeconds:300}});expect(p.error).toBeFalsy();const runId=p.data.id;await f.call(c,'collaboration_start',{runId,supervised:true});
  const ownTask=randomUUID(),peerTask=randomUUID(),messageId=randomUUID();let status=(await f.call(c,'collaboration_status',{runId})).data;
  await f.call(c,'collaboration_control',{runId,commandId:randomUUID(),expectedRevision:status.coordination.revision,control:{action:'task',task:{taskId:ownTask,intent:'analyze'}}});
  await f.call(c,'collaboration_send',{runId,messageId,text:'Initial check',task:{taskId:peerTask,intent:'analyze'}});
  await f.respond(runId,messageId,{kind:'response',taskId:peerTask,declaredState:'analysis',disagreements:[]},'BUFFERED_PRIVATE');await until(()=>f.bridge.status().bufferedCount===1);expect(f.desktop.submissions).toHaveLength(0);
  auth.change({...grant,actionId:randomUUID(),enabled:false,expectedRevision:1});
  await f.call(c,'collaboration_report',{runId,reportId:randomUUID(),report:{kind:'response',taskId:ownTask,declaredState:'analysis'},text:'Own initial analysis'});await Bun.sleep(1150);expect(f.desktop.submissions).toHaveLength(0);
  await f.call(c,'collaboration_cancel',{runId});await f.bridge.setPolicy('accept');expect(f.bridge.policy()).toBe('accept');expect(auth.status(f.root).enabled).toBe(false);
 }finally{auth.close();await c.close();await f.close();}
});


test('revocation between routing decision and delivery entry cannot leave a stale acceptance',async()=>{
 const x=await running();const original=ProjectAuthorizations.prototype.allows;let revoked=false;
 const lookup=spyOn(ProjectAuthorizations.prototype,'allows').mockImplementation(function(this:ProjectAuthorizations,path:string,receivedAt:number){
  const allowed=original.call(this,path,receivedAt);
  if(allowed&&!revoked){revoked=true;x.authorizations.change({project:x.f.root,ownerThread:x.f.desktop.threadId,actionId:randomUUID(),enabled:false,expectedRevision:1,confirmed:true});}
  return allowed;
 });
 try {x.grant();await Bun.sleep(3);await x.send('REVOKED_DURING_ROUTE');await until(()=>revoked);await until(()=>x.f.bridge.runs.status(x.id,x.f.desktop.threadId).messages.some(m=>m.direction==='in'&&['held','denied'].includes(m.status)));expect(x.f.desktop.submissions).toHaveLength(0);expect(x.f.bridge.policy()).toBe('default');}
 finally{lookup.mockRestore();await x.close();}
});
