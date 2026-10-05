import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import { Database } from 'bun:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bridge } from '../src/bridge';
import { RunStore, contextSchema, limitsSchema } from '../src/runs';
import { Collaboration } from '../src/collaboration';
import { inspectProject, compareProjects } from '../src/project';
import { discoverParticipants, inspectParticipant, type Participant } from '../src/participants';
import { formatManaged, parseManaged } from '../src/managed-message';
import { frameSchema, peers, findPeer, socketPath, processStart, type Peer } from '../src/claude';
import { receiver } from './desktop-fixture';
import { sendViaReceiver } from '../src/outbound';

const pluginRoot=resolve(import.meta.dir,'..');
const context=contextSchema.parse({objective:'Contrast two approaches',constraints:['No file edits'],priorAnalysis:{codex:'Earlier analysis A',claude:'Earlier analysis B'}});
const limits=limitsSchema.parse({maxMessages:4,maxSeconds:60});

function fakeParticipants(root: string, owner=randomUUID(), claude=randomUUID()): Participant[] {
  root=realpathSync(root);
  const project={directory:root,kind:'directory' as const,worktree:root,commonGitDir:null,head:null,branch:null,dirty:null,diffHash:null,statusHash:null,untrackedPaths:[],untrackedSnapshot:null};
  return [{sessionId:owner,name:'Same name',provider:'codex',surface:'codex-claude-uds-bridge',pid:123,procStart:'start1',socketPath:'/tmp/123.sock',version:'stream-11',status:'idle',project},
    {sessionId:claude,name:'Same name',provider:'claude',surface:'claude-desktop',pid:456,procStart:'start2',socketPath:'/tmp/456.sock',version:'2.1.286',status:'idle',project}];
}
function fakePeer(p: Participant): Peer { return {sessionId:p.sessionId,name:p.name,pid:p.pid,procStart:p.procStart,messagingSocketPath:p.socketPath,entrypoint:p.surface,cwd:p.project.directory,status:'idle',peerProtocol:1,peerFeatures:[]}; }
function prepare(store: RunStore, participants: Participant[], options=limits) {
  return store.prepare(participants[0]!.sessionId,randomUUID(),context,options,participants,{policy:'same',base:null});
}
async function until(predicate:()=>boolean) {
  const deadline=Date.now()+4000;
  while(!predicate() && Date.now()<deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}
async function git(root: string,args: string[]) {
  const child=Bun.spawn(['git','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Bridge test','-c','user.email=bridge@example.invalid','-C',root,...args],{stdout:'pipe',stderr:'pipe'});
  const [code,text,error]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  if(code!==0) throw new Error(error); return text.trim();
}

test('Git identity pins worktree, common repo, diff and explicit comparison base without reading remotes',async()=>{
  const root=mkdtempSync('/tmp/phase1-git-'); const second=join(root,'second');
  try {
    await git(root,['init','--template=']); writeFileSync(join(root,'file.txt'),'base\n');
    await git(root,['add','file.txt']); await git(root,['commit','-m','base']);
    const clean=await inspectProject(root); expect(clean.dirty).toBe(false); expect(clean.head).toHaveLength(40);
    await git(root,['worktree','add','-b','other',second]);
    const worktree=await inspectProject(second); expect(worktree.commonGitDir).toBe(clean.commonGitDir);
    expect((await compareProjects(clean,worktree,'same')).base).toBe(clean.head);
    writeFileSync(join(second,'file.txt'),'new\n'); const dirty=await inspectProject(second);
    expect(dirty.diffHash).not.toBe(clean.diffHash);
    await expect(compareProjects(clean,dirty,'same')).rejects.toThrow('differ');
    await expect(compareProjects(clean,dirty,'compare')).rejects.toThrow('explicit');
    expect((await compareProjects(clean,dirty,'compare',clean.head!)).base).toBe(clean.head);
    await expect(compareProjects(clean,dirty,'compare','--help')).rejects.toThrow('explicit');
    writeFileSync(join(root,'untracked.txt'),'private content not snapshotted');
    const untracked=await inspectProject(root); expect(untracked.untrackedPaths).toContain('untracked.txt'); expect(untracked.untrackedSnapshot).toBeNull();
    expect(JSON.stringify(untracked)).not.toContain('private content');
    const other=mkdtempSync('/tmp/phase1-othergit-');
    try {await git(other,['init','--template=']);await expect(compareProjects(clean,await inspectProject(other),'same')).rejects.toThrow('different repositories');}
    finally {rmSync(other,{recursive:true,force:true});}
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('persistent context, caller ownership, request idempotency and uncertain sends survive reopening',()=>{
  const root=mkdtempSync('/tmp/phase1-store-'); let store=new RunStore(root); const participants=fakeParticipants(root); const owner=participants[0]!.sessionId;
  try {
    const requestId=randomUUID(); const id=store.prepare(owner,requestId,context,limits,participants,{policy:'same'});
    expect(store.prepare(owner,requestId,context,limits,participants,{policy:'same'})).toBe(id);
    expect(()=>store.prepare(owner,requestId,{...context,objective:'Changed'},limits,participants,{policy:'same'})).toThrow('different content');
    expect(()=>store.status(id,randomUUID())).toThrow('initiating');
    store.start(id,owner); const msg=randomUUID(); store.reserveOutgoing(id,owner,msg,participants[1]!.sessionId,'payload');
    const transport=randomUUID(); store.claimOutgoing(id,owner,msg,transport);
    store.close(); store=new RunStore(root);
    const restored=store.status(id,owner); expect(restored.context.priorAnalysis).toEqual(context.priorAnalysis);
    expect(restored.messages[0]?.observation).toBe('delivery_uncertain'); expect(restored.messagesUsed).toBe(1);
    expect(store.outgoingExists(id,owner,msg,'payload')?.transport_id).toBe(transport);
    expect(()=>store.outgoingExists(id,owner,msg,'different')).toThrow('different content');
    expect(()=>store.reserveOutgoing(id,owner,randomUUID(),participants[1]!.sessionId,'another task')).toThrow('Unfinished delivery');
    const output=JSON.parse(store.export(id,owner,'json')); expect(output.events.map((e:{sequence:number})=>e.sequence)).toEqual([...output.events.map((e:{sequence:number})=>e.sequence)].sort((a:number,b:number)=>a-b));
    expect(store.export(id,owner,'markdown')).toContain('delivery_uncertain');
    store.transportStatus(transport,'held'); expect(store.status(id,owner).state).toBe('blocked');
    expect(()=>store.reserveOutgoing(id,owner,randomUUID(),participants[1]!.sessionId,'more')).toThrow('blocked');
    store.stop(id,owner,'cancelled','stop'); expect(store.activeFor(owner)).toBeNull();
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

test('independent controller processes cannot reserve the same conversation concurrently',async()=>{
  const root=mkdtempSync('/tmp/phase1-race-'); const store=new RunStore(root);
  try {
    const peer=randomUUID(); const first=fakeParticipants(root,randomUUID(),peer); const second=fakeParticipants(root,randomUUID(),peer);
    const ids=[prepare(store,first),prepare(store,second)]; const owners=[first[0]!.sessionId,second[0]!.sessionId];
    const code='import {RunStore} from '+JSON.stringify(join(pluginRoot,'src/runs.ts'))+'; const s=new RunStore(process.argv[1]);try{s.start(process.argv[2],process.argv[3]);console.log("started")}catch(e){console.log(e.message);process.exitCode=2}finally{s.close()}';
    const children=ids.map((id,i)=>Bun.spawn([process.execPath,'-e',code,root,id,owners[i]!],{stdout:'pipe',stderr:'pipe'}));
    const results=await Promise.all(children.map(async child=>({exit:await child.exited,text:await new Response(child.stdout).text(),error:await new Response(child.stderr).text()})));
    expect(results.map(r=>r.exit).sort()).toEqual([0,2]); expect(results.some(r=>r.text.includes('already belongs'))).toBe(true);
    const winner=store.activeFor(peer)!; const owner=winner===ids[0]?owners[0]!:owners[1]!;
    store.stop(winner,owner,'cancelled','release'); const loser=winner===ids[0]?1:0;
    expect(store.start(ids[loser]!,owners[loser]!).state).toBe('active');
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

test('deadline and shared message budgets gate new admissions; cancellation retains late replies without delivery',()=>{
  const root=mkdtempSync('/tmp/phase1-budget-'); let now=1000; const store=new RunStore(root,()=>now); const ps=fakeParticipants(root); const owner=ps[0]!.sessionId;
  try {
    const id=prepare(store,ps,{maxMessages:2,maxSeconds:1}); store.start(id,owner);
    const out=randomUUID(); store.reserveOutgoing(id,owner,out,ps[1]!.sessionId,'question'); store.claimOutgoing(id,owner,out,randomUUID());
    const incoming=randomUUID(); const transport=randomUUID();
    expect(store.admitIncoming(owner,fakePeer(ps[1]!),transport,formatManaged({runId:id,messageId:incoming,replyTo:out,contextVersion:1},'answer')).admitted).toBe(true);
    expect(store.claimIncoming(transport)).toBe(true); expect(store.claimIncoming(transport)).toBe(false);
    expect(()=>store.reserveOutgoing(id,owner,randomUUID(),ps[1]!.sessionId,'over budget')).toThrow('budget');
    expect(store.status(id,owner).state).toBe('limit_reached');
    const expiring=prepare(store,ps); store.start(expiring,owner); now+=60001;
    expect(()=>store.reserveOutgoing(expiring,owner,randomUUID(),ps[1]!.sessionId,'late')).toThrow('deadline'); expect(store.activeFor(owner)).toBeNull();
    const cancelled=prepare(store,ps); store.start(cancelled,owner); store.stop(cancelled,owner,'cancelled','human decision');
    const lateTransport=randomUUID(); expect(store.admitIncoming(owner,fakePeer(ps[1]!),lateTransport,formatManaged({runId:cancelled,messageId:randomUUID(),contextVersion:1},'late reply')).admitted).toBe(false);
    expect(store.claimIncoming(lateTransport)).toBe(false); expect(store.status(cancelled,owner).messages.at(-1)?.status).toBe('late');
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

test('forged identities, unknown replies and unmanaged text cannot be attributed to an active run',()=>{
  const root=mkdtempSync('/tmp/phase1-correlation-'); const store=new RunStore(root); const ps=fakeParticipants(root); const owner=ps[0]!.sessionId;
  try {
    const id=prepare(store,ps); store.start(id,owner); const frame=formatManaged({runId:id,messageId:randomUUID(),contextVersion:1},'text');
    expect(store.admitIncoming(owner,{...fakePeer(ps[1]!),procStart:'restarted'},randomUUID(),frame).reason).toBe('wrong-participant');
    expect(store.admitIncoming(owner,fakePeer(ps[1]!),randomUUID(),'plain text').reason).toBe('missing-correlation');
    expect(store.admitIncoming(owner,fakePeer(ps[1]!),randomUUID(),formatManaged({runId:id,messageId:randomUUID(),replyTo:randomUUID(),contextVersion:1},'text')).reason).toBe('unknown-reply');
    expect(store.admitIncoming(owner,fakePeer(ps[1]!),randomUUID(),'CC_CDX_RUN_V1 {"contextVersion":2}\ntext').reason).toBe('invalid-correlation');
    expect(store.status(id,owner).messagesUsed).toBe(0);
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

async function liveFixture() {
  const root=mkdtempSync('/tmp/phase1-native-'); const desktop=await receiver('idle',false,false,root);
  const configDir=join(root,'claude'); const stateDir=join(root,'plugin-state','claude-uds-bridge'); const sockets=join(root,'s');
  mkdirSync(join(configDir,'sessions'),{recursive:true,mode:0o700});mkdirSync(sockets,{mode:0o700});
  const peerId=randomUUID(); const peerPath=join(sockets,`${process.ppid}.sock`); const frames: ReturnType<typeof frameSchema.parse>[]=[];
  const connections=new Set<net.Socket>(); const server=net.createServer(socket=>{
    connections.add(socket);socket.once('close',()=>connections.delete(socket));socket.on('error',()=>{});socket.setEncoding('utf8');let buffer='';
    socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))!==-1){frames.push(frameSchema.parse(JSON.parse(buffer.slice(0,end))));buffer=buffer.slice(end+1);}});
  });server.listen(peerPath);await once(server,'listening');chmodSync(peerPath,0o600);
  const record={pid:process.ppid,sessionId:peerId,messagingSocketPath:peerPath,cwd:root,peerProtocol:1,name:'Repeated name',entrypoint:'claude-desktop',status:'idle',procStart:await processStart(process.ppid),version:'2.1.286'};
  const write=(extra:Record<string,unknown>={})=>writeFileSync(join(configDir,'sessions',`${process.ppid}.json`),JSON.stringify({...record,...extra}),{mode:0o600});write();
  const bridge=new Bridge(desktop.threadId,configDir,stateDir,desktop.path);await bridge.start(sockets,root,bridge.beginSession());bridge.updateRuntime({status:'idle',mode:'prompting'});await bridge.setPolicy('accept');
  const collaboration=new Collaboration(bridge.runs,desktop.threadId,{configDir,stateDir,ipcPath:desktop.path},bridge);
  const make=()=>collaboration.prepare({requestId:randomUUID(),peerId,context,limits,revisionPolicy:'same'});
  const transmit=async (fields:Record<string,unknown>)=>{
    const socket=net.createConnection(bridge.status().replyAddress!.slice(4));await once(socket,'connect');
    socket.end(JSON.stringify({msgV:1,from:`uds:${peerPath}`,...fields})+'\n');await once(socket,'close');
  };
  const reply=async(runId:string,replyTo:string,text='peer response')=>{
    const transportId=randomUUID(); const messageId=randomUUID();
    await transmit({type:'user',msg_id:transportId,session_id:desktop.threadId,message:{role:'user',content:formatManaged({runId,messageId,replyTo,contextVersion:1},text)}});
    return {transportId,messageId};
  };
  return {root,desktop,configDir,stateDir,bridge,collaboration,peerId,frames,make,transmit,reply,write,
    async close(){await bridge.close();for(const socket of connections)socket.destroy();await new Promise<void>(done=>server.close(()=>done()));await desktop.close();}};
}

test('Desktop selection verifies surface/process and rejects stale engines or busy peers without sending',async()=>{
  const f=await liveFixture();
  try {
    const discovered=await discoverParticipants(f.configDir); expect(discovered.some(p=>p.sessionId===f.peerId && p.surface==='claude-desktop')).toBe(true);
    f.write({entrypoint:'claude-vscode'}); await expect(f.make()).rejects.toThrow('Desktop');
    f.write({procStart:'different'}); await expect(f.make()).rejects.toThrow('stale');
    f.write({version:'2.1.223'}); await expect(f.make()).rejects.toThrow('unsupported');
    f.write({status:'busy'}); const prepared=await f.make(); await expect(f.collaboration.start(prepared.id)).rejects.toThrow('busy');
    expect((await f.collaboration.start(prepared.id,true)).state).toBe('active');expect(f.frames).toHaveLength(0);expect(f.desktop.submissions).toHaveLength(0);
    f.write({cwd:join(f.root,'missing')});await expect(f.collaboration.send(prepared.id,randomUUID(),'x')).rejects.toThrow();
    expect(f.bridge.runs.status(prepared.id,f.desktop.threadId).state).toBe('blocked');
  } finally {await f.close();}
});

test('homonymous Desktop conversations require exact IDs; duplicate registrations and old receivers are rejected',async()=>{
  const f=await liveFixture();const child=Bun.spawn([process.execPath,'-e','await Bun.sleep(60000)'],{stdout:'ignore',stderr:'ignore'});
  const socketPath=join(f.root,'s',`${child.pid}.sock`);const secondSocket=net.createServer(socket=>socket.end());secondSocket.listen(socketPath);await once(secondSocket,'listening');chmodSync(socketPath,0o600);
  try {
    const secondId=randomUUID();const file=join(f.configDir,'sessions',`${child.pid}.json`);
    const base=JSON.parse(readFileSync(join(f.configDir,'sessions',`${process.ppid}.json`),'utf8'));
    const second={...base,pid:child.pid,sessionId:secondId,messagingSocketPath:socketPath,procStart:await processStart(child.pid)};
    writeFileSync(file,JSON.stringify(second),{mode:0o600});
    expect((await discoverParticipants(f.configDir)).filter(p=>p.name==='Repeated name')).toHaveLength(2);
    const first=await f.make();const other=await f.collaboration.prepare({requestId:randomUUID(),peerId:secondId,context,limits,revisionPolicy:'same'});
    expect(first.participants.find(p=>p.provider==='claude')?.sessionId).toBe(f.peerId);
    expect(other.participants.find(p=>p.provider==='claude')?.sessionId).toBe(secondId);
    writeFileSync(file,JSON.stringify({...second,sessionId:f.peerId}));await expect(f.make()).rejects.toThrow('ambiguous');
    const capabilityDb=new Database(join(f.stateDir,`${f.desktop.threadId}.sqlite`));
    const original=capabilityDb.query<{pid:number;proc_start:string},[]>('SELECT pid,proc_start FROM receiver_capabilities').get()!;
    capabilityDb.run('DELETE FROM receiver_capabilities');
    await expect(inspectParticipant({configDir:f.configDir,stateDir:f.stateDir,ipcPath:f.desktop.path},f.desktop.threadId,'codex')).rejects.toThrow('reload');
    capabilityDb.run("INSERT INTO receiver_capabilities VALUES ('managed_runs_v1',?,?)",[original.pid,original.proc_start]);capabilityDb.close();
  } finally {child.kill();await child.exited;await new Promise<void>(done=>secondSocket.close(()=>done()));await f.close();}
});

test('managed socket exchange correlates receipts and replies, rejects raw bypass and never resends an ID',async()=>{
  const f=await liveFixture();
  try {
    const prepared=await f.make();await f.collaboration.start(prepared.id);
    await expect(f.bridge.sendMessage(f.peerId,'raw bypass')).rejects.toThrow('managed collaboration');
    const messageId=randomUUID();await f.collaboration.send(prepared.id,messageId,'Compare proposals');
    await until(()=>f.frames.some(frame=>frame.type==='user'));
    const user=f.frames.find(frame=>frame.type==='user')!;
    if(user.type!=='user')throw new Error('missing frame');
    expect(parseManaged(user.message.content)?.header.runId).toBe(prepared.id);
    await f.collaboration.send(prepared.id,messageId,'Compare proposals');expect(f.frames.filter(frame=>frame.type==='user')).toHaveLength(1);
    await f.transmit({type:'control',action:'peer_message_status',orig_msg_id:user.msg_id,status:'delivered'});
    await until(()=>f.bridge.runs.status(prepared.id,f.desktop.threadId).messages[0]?.status==='delivered');
    const reply=await f.reply(prepared.id,messageId);await until(()=>f.desktop.submissions.length===1);
    expect(JSON.stringify(f.desktop.submissions)).toContain('peer response');
    const state=f.bridge.runs.status(prepared.id,f.desktop.threadId);expect(state.messagesUsed).toBe(2);
    expect(state.messages[0]?.wire_text).toContain('Contexto compartido');expect(state.messages[0]?.wire_hash).toHaveLength(64);
    expect(state.messages.find(m=>m.id===reply.messageId)?.reply_to).toBe(messageId);
    expect(state.events.some(event=>event.type==='message_received')).toBe(true);
    const next=randomUUID();await f.collaboration.send(prepared.id,next,'Counterargument',reply.messageId);
    expect(f.bridge.runs.status(prepared.id,f.desktop.threadId).messages.find(m=>m.id===next)?.reply_to).toBe(reply.messageId);
  } finally {await f.close();}
});

test('cancelling an admitted but held reply prevents later native delivery and logs late messages',async()=>{
  const f=await liveFixture();
  try {
    const prepared=await f.make();await f.collaboration.start(prepared.id);const messageId=randomUUID();await f.collaboration.send(prepared.id,messageId,'question');
    await f.bridge.setPolicy('hold');const first=await f.reply(prepared.id,messageId);
    await until(()=>f.bridge.status().heldCount===1);
    f.bridge.runs.stop(prepared.id,f.desktop.threadId,'cancelled','human cancel');await f.bridge.setPolicy('accept');
    expect(f.desktop.submissions).toHaveLength(0);
    await until(()=>f.bridge.status().messages.some(m=>m.id===first.transportId && m.status==='dropped'));
    const late=await f.reply(prepared.id,messageId,'late');
    await until(()=>f.bridge.runs.status(prepared.id,f.desktop.threadId).messages.some(m=>m.id===late.messageId && m.admitted===0));
    expect(f.bridge.runs.status(prepared.id,f.desktop.threadId).events.some(e=>e.type==='late_message')).toBe(true);
    expect(f.desktop.submissions).toHaveLength(0);
  } finally {await f.close();}
});

test('receiver socket gate rejects a cancelled outbound intention before any peer write',async()=>{
  const f=await liveFixture();
  try {
    const run=await f.make();await f.collaboration.start(run.id);const messageId=randomUUID();
    const claim=f.bridge.runs.claimOutgoing.bind(f.bridge.runs);
    f.bridge.runs.claimOutgoing=(...args)=>{claim(...args);f.bridge.runs.stop(run.id,f.desktop.threadId,'cancelled','race before socket write');};
    await expect(f.collaboration.send(run.id,messageId,'never written')).rejects.toThrow('before writing');
    expect(f.frames.filter(frame=>frame.type==='user')).toHaveLength(0);expect(f.bridge.runs.status(run.id,f.desktop.threadId).messages[0]?.status).toBe('not-sent');
  } finally {await f.close();}
});

test('MCP phase-1 API uses caller identity, reconstructs logs across processes and exports without file writes',async()=>{
  const f=await liveFixture();let client=new Client({name:'phase1',version:'1.0'});
  const connect=()=>client.connect(new StdioClientTransport({command:process.execPath,args:[process.env.UDS_MCP_TEST_ENTRYPOINT??join(pluginRoot,'src/server.ts')],env:{...process.env,CODEX_HOME:f.root,CLAUDE_CONFIG_DIR:f.configDir,CC_CDX_PANEL_AUTO_OPEN:'0'}}));
  const call=(name:string,args:Record<string,unknown>,owner=f.desktop.threadId)=>client.callTool({name,arguments:args,_meta:{threadId:owner}});
  const data=(result:Awaited<ReturnType<typeof call>>)=>JSON.parse((result.content as {type:string;text:string}[])[0]!.text);
  try {
    await connect();const tools=await client.listTools();expect(tools.tools.filter(t=>t.name.startsWith('collaboration_'))).toHaveLength(16);
    const prepared=data(await call('collaboration_prepare',{requestId:randomUUID(),peerId:f.peerId,context,limits}));
    expect(f.frames).toHaveLength(0);expect((await call('collaboration_start',{runId:prepared.id,supervised:true})).isError).not.toBe(true);
    const messageId=randomUUID();expect((await call('collaboration_send',{runId:prepared.id,messageId,text:'MCP controlled message'})).isError).not.toBe(true);
    await until(()=>f.frames.some(frame=>frame.type==='user'));
    expect((await call('collaboration_status',{runId:prepared.id},randomUUID())).isError).toBe(true);
    await client.close();client=new Client({name:'phase1-restart',version:'1.0'});await connect();
    const restored=data(await call('collaboration_status',{runId:prepared.id}));expect(restored.messages[0].id).toBe(messageId);
    expect(data(await call('collaboration_send',{runId:prepared.id,messageId,text:'MCP controlled message'})).reused).toBe(true);
    expect(f.frames.filter(frame=>frame.type==='user')).toHaveLength(1);
    const exported=data(await call('collaboration_export',{runId:prepared.id,format:'json'}));expect(JSON.parse(exported.content).participants).toHaveLength(2);
    expect((await call('collaboration_cancel',{runId:prepared.id})).isError).not.toBe(true);
    expect((await call('collaboration_send',{runId:prepared.id,messageId:randomUUID(),text:'after cancellation'})).isError).toBe(true);
  } finally {await client.close();await f.close();}
});

test('unsupported future collaboration schemas fail without rewriting their version',()=>{
  const root=mkdtempSync('/tmp/phase1-schema-');const path=join(root,'collaborations.sqlite');
  try {const db=new Database(path);db.exec('PRAGMA user_version=4');db.close();chmodSync(path,0o600);expect(()=>new RunStore(root)).toThrow('future');const verify=new Database(path,{readonly:true});expect(verify.query<{user_version:number},[]>('PRAGMA user_version').get()?.user_version).toBe(4);verify.close();}
  finally {rmSync(root,{recursive:true,force:true});}
});


test('managed /clear keeps verified receipts but blocks new-session input, raw sends and reassignment until closure', async () => {
  const f = await liveFixture();
  try {
    const run = await f.make(); await f.collaboration.start(run.id);
    const messageId = randomUUID(); await f.collaboration.send(run.id, messageId, 'Pinned conversation question');
    const sent = f.frames.find(frame => frame.type === 'user')!;
    if (sent.type !== 'user') throw new Error('Missing outbound frame');
    const cleared = randomUUID(); f.write({ sessionId: cleared });
    await f.transmit({ type: 'control', session_id: randomUUID(), action: 'peer_message_status', orig_msg_id: sent.msg_id, status: 'delivered' });
    await f.bridge.setPolicy('default');
    expect(f.bridge.runs.status(run.id, f.desktop.threadId).state).toBe('active');
    await f.transmit({ type: 'control', session_id: f.desktop.threadId, action: 'peer_message_status', orig_msg_id: sent.msg_id, status: 'delivered', reason: 'Released before clear' });
    await until(() => f.bridge.runs.status(run.id, f.desktop.threadId).messages[0]?.status === 'delivered');
    const state = f.bridge.runs.status(run.id, f.desktop.threadId);
    expect(state.state).toBe('blocked'); expect(state.reason).toBe('participant_session_changed');
    expect(state.participants.find(p => p.provider === 'claude')?.sessionId).toBe(f.peerId);
    expect(f.bridge.status().messages.find(m => m.id === sent.msg_id)?.status_reason).toBe('Released before clear');
    const late = await f.reply(run.id, messageId, 'reply from the cleared session');
    const rawId = randomUUID();
    await f.transmit({ type: 'user', msg_id: rawId, message: { role: 'user', content: 'raw input from the cleared session' } });
    await until(() => f.bridge.status().messages.find(m => m.id === rawId)?.status === 'dropped');
    expect(f.bridge.status().messages.find(m => m.id === late.transportId)?.drop_reason).toBe('participant-session-changed');
    expect(f.desktop.submissions).toHaveLength(0);
    await expect(f.bridge.sendMessage(cleared, 'raw bypass')).rejects.toThrow('managed collaboration');
    const peer = findPeer(f.configDir, cleared);
    const written = await sendViaReceiver(socketPath(f.bridge.status().replyAddress!).replace(/\.sock$/, '.out'), peer,
      [{ msgV: 1, type: 'user', msg_id: randomUUID(), from: f.bridge.status().replyAddress!, session_id: cleared,
        message: { role: 'user', content: 'receiver socket bypass' } }]);
    expect(written).toBe(false);
    expect(f.frames.filter(frame => frame.type === 'user')).toHaveLength(1);
    expect(f.bridge.runs.status(run.id, f.desktop.threadId).messagesUsed).toBe(1);
    await f.bridge.setPolicy('accept'); // Isolate reservation fencing from the new reception gate.
    const selected = await f.collaboration.prepare({ requestId: randomUUID(), peerId: cleared, context, limits, revisionPolicy: 'same' });
    await expect(f.collaboration.start(selected.id)).rejects.toThrow('already belongs');
    f.bridge.runs.stop(run.id, f.desktop.threadId, 'cancelled', 'Close the cleared conversation');
    expect((await f.collaboration.start(selected.id)).state).toBe('active');
  } finally { await f.close(); }
});

test('a managed reply held before /clear is never released into a changed conversation', async () => {
  const f = await liveFixture();
  try {
    const run = await f.make(); await f.collaboration.start(run.id);
    const messageId = randomUUID(); await f.collaboration.send(run.id, messageId, 'question before clear');
    await f.bridge.setPolicy('hold');
    const held = await f.reply(run.id, messageId, 'held response before clear');
    await until(() => f.bridge.status().heldCount === 1);
    f.write({ sessionId: randomUUID() });
    await f.bridge.setPolicy('accept');
    expect(f.desktop.submissions).toHaveLength(0);
    expect(f.bridge.status().messages.find(m => m.id === held.transportId)).toMatchObject({ status: 'dropped', drop_reason: 'participant-or-project-changed' });
    const state = f.bridge.runs.status(run.id, f.desktop.threadId);
    expect(state.state).toBe('blocked');
    expect(state.messages.find(m => m.id === held.messageId)?.text).toBeNull();
    expect(state.results).toHaveLength(0);
    expect(state.participants.find(p => p.provider === 'claude')?.sessionId).toBe(f.peerId);
  } finally { await f.close(); }
});
