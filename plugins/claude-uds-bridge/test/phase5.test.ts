import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {nativeFixture,until} from './collaboration-fixture';
import {startPanel} from '../src/panel';
import {doctor} from '../src/doctor';
import {ProjectAuthorizations,observeProjectAuthorization} from '../src/project-authorization';
import {inspectProject,compareProjects} from '../src/project';
import {version} from '../src/version';

const pluginRoot=resolve(import.meta.dir,'..');
async function authenticate(panel:ReturnType<typeof startPanel>){
 const auth=await fetch(panel.origin+'/api/v1/session',{method:'POST',headers:{Origin:panel.origin},body:JSON.stringify({token:new URL(panel.url).hash.slice(7)})});
 expect(auth.status).toBe(200);const {csrf}=await auth.json() as {csrf:string};const cookie=auth.headers.get('set-cookie')!.split(';')[0]!;
 return {cookie,call:(path:string,body?:unknown)=>fetch(panel.origin+'/api/v1/'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{Origin:panel.origin,'X-CSRF-Token':csrf})},body:body===undefined?undefined:JSON.stringify(body)})};
}
function request(f:Awaited<ReturnType<typeof nativeFixture>>){return {commandId:randomUUID(),ownerThread:f.desktop.threadId,project:f.root,command:{action:'create',peerId:f.peerId,context:{objective:'Restart regression',constraints:['Read only'],references:[],priorAnalysis:{}},limits:{maxMessages:4,maxSeconds:300},routine:{mode:'free'},coordination:{initialBarrier:false},revisionPolicy:'same'}};}

test('panel restart keeps actions and project grants; stale credentials fail and consumed unknown wakes reconcile via API without replay',async()=>{
 const f=await nativeFixture(true,{reception:'default'});const options={configDir:f.config,stateDir:f.state,codexHome:f.root,pluginRoot,ipcPath:f.desktop.path};let panel=startPanel(options);
 try{
  const grants=new ProjectAuthorizations(f.state);grants.change({project:f.root,ownerThread:f.desktop.threadId,actionId:randomUUID(),enabled:true,expectedRevision:0,confirmed:true});grants.close();
  const auth=await authenticate(panel),data=request(f);expect((await auth.call('commands',data)).status).toBe(202);
  await until(()=>panel.commands.get(data.commandId)?.state==='unknown');expect(f.desktop.submissions).toHaveLength(1);
  const input=panel.commands.get(data.commandId)!.input_id;
  const oldPort=new URL(panel.origin).port;await panel.close();panel=startPanel({...options,port:Number(oldPort)});
  expect((await fetch(panel.origin+'/api/v1/commands',{headers:{Cookie:auth.cookie}})).status).toBe(401);
  const connected=await authenticate(panel);
  f.desktop.setHistory({turns:[{items:[{type:'userMessage',id:randomUUID(),clientId:randomUUID()}]}]});
  expect((await (await connected.call('commands')).json() as {state:string}[])[0]!.state).toBe('unknown');
  f.desktop.setHistory({turns:[{items:[{type:'userMessage',id:randomUUID(),clientId:input}]}]});
  expect((await (await connected.call('commands')).json() as {state:string}[])[0]!.state).toBe('notified');
  expect((await connected.call('commands',data)).status).toBe(202);expect(f.desktop.submissions).toHaveLength(1);
  expect(panel.commands.get(data.commandId)!.run_id).toBeNull();expect(observeProjectAuthorization(f.state,f.root).enabled).toBe(true);expect(f.bridge.policy()).toBe('default');
 }finally{await panel.close();await f.close();}
},15000);

test('diagnosis observes inherited reception and live distribution without creating state or changing policies',async()=>{
 const f=await nativeFixture(false,{reception:'default'});try{
  const options={configDir:f.config,project:f.root,threadId:f.desktop.threadId,peerId:f.peerId,codexHome:f.root,pluginRoot};
  const missing=join(f.root,'not-created');expect(observeProjectAuthorization(missing,f.root).enabled).toBe(false);expect(existsSync(missing)).toBe(false);
  const before=readFileSync(join(f.state,'project-authorizations.sqlite'));
  const initial=await doctor(options);expect(initial.codex?.receiverVersion).toBe(version);expect(initial.codex?.projectReceptionRemembered).toBe(false);
  expect(readFileSync(join(f.state,'project-authorizations.sqlite'))).toEqual(before);
  const grants=new ProjectAuthorizations(f.state);grants.change({project:f.root,ownerThread:f.desktop.threadId,actionId:randomUUID(),enabled:true,expectedRevision:0,confirmed:true});grants.close();
  const enabled=await doctor(options);expect(enabled.codex?.projectReceptionRemembered).toBe(true);expect(enabled.codex?.receiverPolicy).toBe('default');expect(enabled.codex?.inboundFromClaude).toBe('unknown');
  expect(enabled.checks.find(c=>c.code==='project_reception')?.message).toContain('Ordinary messages are not covered');
  const db=new Database(join(f.state,f.desktop.threadId+'.sqlite'));db.run("DELETE FROM receiver_capabilities WHERE capability LIKE 'distribution_version:%'");db.run("UPDATE inbound_policy SET policy='refuse'");db.close();
  const explicit=await doctor(options);expect(explicit.checks.some(c=>c.code==='receiver_update_pending')).toBe(true);expect(explicit.codex?.inboundFromClaude).toBe('refuse');expect(explicit.codex?.projectReceptionRemembered).toBe(true);
  expect(f.desktop.submissions).toHaveLength(0);expect(f.frames).toHaveLength(0);
 }finally{await f.close();}
});

test('spaces and repeated names retain exact native participant identities through MCP and panel',async()=>{
 const root=mkdtempSync('/tmp/bridge space é-');const f=await nativeFixture(false,{root});const client=await f.connect();const panel=startPanel({configDir:f.config,stateDir:f.state,codexHome:f.root,pluginRoot,ipcPath:f.desktop.path});
 try{
  for(const pid of [process.pid,process.ppid]){const file=join(f.config,'sessions',pid+'.json');const entry=JSON.parse(readFileSync(file,'utf8'));entry.name='Same name';writeFileSync(file,JSON.stringify(entry),{mode:0o600});}
  const auth=await authenticate(panel);const participants=await (await auth.call('participants')).json() as {sessionId:string;name:string}[];
  expect(participants.filter(p=>p.name==='Same name')).toHaveLength(2);expect(new Set(participants.map(p=>p.sessionId)).size).toBe(2);
  const prepared=await f.call(client,'collaboration_prepare',{...request(f).command,requestId:randomUUID()});expect(prepared.error).toBeFalsy();
  const status=await f.call(client,'collaboration_status',{runId:prepared.data.id});expect(status.error).toBeFalsy();expect(status.data.participants.find((p:{provider:string})=>p.provider==='codex').sessionId).toBe(f.desktop.threadId);
  expect(status.data.participants.every((p:{project:{directory:string}})=>p.project.directory===realpathSync(root))).toBe(true);
  expect(f.desktop.submissions).toHaveLength(0);expect(f.frames).toHaveLength(0);
 }finally{await client.close();await panel.close();await f.close();}
});

test('worktrees with spaces compare Git bases explicitly and never inherit another folder grant',async()=>{
 const root=mkdtempSync('/tmp/bridge worktrees-'),repo=join(root,'main project'),other=join(root,'second project'),state=join(root,'state');mkdirSync(repo,{mode:0o700});
 const git=async(args:string[])=>{const p=Bun.spawn(['git','-C',repo,...args],{stdout:'pipe',stderr:'pipe'});const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);if(code)throw new Error(err);return out.trim();};
 try{
  await git(['init','-b','main']);writeFileSync(join(repo,'content.txt'),'one\n');await git(['add','.']);await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
  await git(['worktree','add','-b','feature/test',other]);const first=await inspectProject(repo),second=await inspectProject(other);expect((await compareProjects(first,second,'same')).reproducible).toBe(true);
  const grants=new ProjectAuthorizations(state);grants.change({project:repo,ownerThread:randomUUID(),actionId:randomUUID(),enabled:true,expectedRevision:0,confirmed:true});expect(grants.status(other).enabled).toBe(false);grants.close();
  writeFileSync(join(other,'content.txt'),'two\n');const dirty=await inspectProject(other);await expect(compareProjects(first,dirty,'same')).rejects.toThrow('differ');
  expect((await compareProjects(first,dirty,'compare',first.head!)).base).toBe(first.head);await expect(compareProjects(first,dirty,'compare','--help')).rejects.toThrow('explicit');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('shareable pilot evidence projects only allowlisted facts and refuses free text in trusted fields',async()=>{
 const {publicPilotEvidence}=await import('../src/pilot-evidence');
 const secret='secret-token-/Users/person/private-project';
 const raw={schemaVersion:1,version,platform:'darwin',runtime:Bun.version,token:secret,project:secret,transcript:secret,checks:[{check:'source_suite',passed:true,count:131,error:secret,metadata:{socket:secret}}],realCases:[{case:'L01',outcome:'passed',version,sessionId:secret,text:secret}]};
 const safe=publicPilotEvidence(raw);expect(JSON.stringify(safe)).not.toContain(secret);expect(safe.checks[0]?.count).toBe(131);
 expect(()=>publicPilotEvidence({...raw,version:secret})).toThrow();expect(()=>publicPilotEvidence({...raw,checks:[{check:secret,passed:true}]})).toThrow();
});

test('new wakes persist their owner atomically; crashed and legacy queued commands become visible without replay',async()=>{
 const f=await nativeFixture(false,{reception:'default'});const panel=startPanel({configDir:f.config,stateDir:f.state,codexHome:f.root,pluginRoot,ipcPath:f.desktop.path});
 try{
  const {processStart}=await import('../src/claude');const {panelRequestSchema}=await import('../src/panel-commands');
  const atomicInput=panelRequestSchema.parse(request(f)),legacyInput=panelRequestSchema.parse(request(f));const atomic=panel.commands.enqueue(atomicInput,await processStart(process.pid));expect(atomic.command.state).toBe('waking');expect(atomic.command.processor_pid).toBe(process.pid);expect(atomic.command.processor_start).toBeTruthy();
  const legacy=panel.commands.enqueue(legacyInput);const db=new Database(join(f.state,'panel.sqlite'));
  db.run('UPDATE panel_commands SET processor_pid=? WHERE id=?',[2147483647,atomic.command.id]);db.run('UPDATE panel_commands SET created_at=0 WHERE id=?',[legacy.command.id]);db.close();
  const auth=await authenticate(panel);const rows=await (await auth.call('commands')).json() as {id:string;state:string;error:string}[];
  expect(rows.find(c=>c.id===atomic.command.id)?.state).toBe('unknown');expect(rows.find(c=>c.id===legacy.command.id)?.state).toBe('unknown');
  expect((await auth.call('commands',atomicInput)).status).toBe(202);expect((await auth.call('commands',legacyInput)).status).toBe(202);expect(f.desktop.submissions).toHaveLength(0);
  expect(panel.commands.get(atomic.command.id)?.state).toBe('unknown');expect(panel.commands.get(legacy.command.id)?.state).toBe('unknown');
 }finally{await panel.close();await f.close();}
});

test('exact consumption in a changed project is rejected and native history failures remain visible',async()=>{
 const f=await nativeFixture(false,{reception:'default'});const panel=startPanel({configDir:f.config,stateDir:f.state,codexHome:f.root,pluginRoot,ipcPath:f.desktop.path});
 try{
  const {panelRequestSchema}=await import('../src/panel-commands');const queued=panel.commands.enqueue(panelRequestSchema.parse(request(f))).command;
  const db=new Database(join(f.state,'panel.sqlite'));db.run("UPDATE panel_commands SET state='unknown' WHERE id=?",[queued.id]);db.close();
  f.desktop.setHistory({turns:[{items:[{type:'userMessage',id:randomUUID(),clientId:queued.input_id}]}]});const changed=join(f.root,'other');mkdirSync(changed);f.desktop.setProject(changed);
  const auth=await authenticate(panel);let rows=await (await auth.call('commands')).json() as {state:string;inspection:string}[];expect(rows[0]!.state).toBe('unknown');expect(rows[0]!.inspection).toContain('project changed');
  f.desktop.setHistory({turnHistory:{kind:'unknown-contract'}});f.desktop.setProject(f.root);rows=await (await auth.call('commands')).json() as typeof rows;expect(rows[0]!.state).toBe('unknown');expect(rows[0]!.inspection).toContain('unavailable');expect(f.desktop.submissions).toHaveLength(0);
 }finally{await panel.close();await f.close();}
});

test('bounded history reconciliation rotates past unavailable owners instead of starving the selected chat',async()=>{
 const f=await nativeFixture(false,{rejectUnknownOwners:true});const panel=startPanel({configDir:f.config,stateDir:f.state,codexHome:f.root,pluginRoot,ipcPath:f.desktop.path});
 try{
  const {panelRequestSchema}=await import('../src/panel-commands');const ids=[];
  // Unknown native owners cannot return a snapshot; the Desktop fixture returns
  // only its selected UUID. The second poll must still reach the fifth owner.
  for(let i=0;i<4;i++)ids.push(panel.commands.enqueue(panelRequestSchema.parse({...request(f),ownerThread:randomUUID()})).command.id);
  const selected=panel.commands.enqueue(panelRequestSchema.parse(request(f))).command;ids.push(selected.id);
  const db=new Database(join(f.state,'panel.sqlite'));for(let i=0;i<ids.length;i++)db.run("UPDATE panel_commands SET state='unknown',created_at=? WHERE id=?",[100+ids.length-i,ids[i]!]);db.close();
  f.desktop.setHistory({turns:[{items:[{type:'userMessage',id:randomUUID(),clientId:selected.input_id}]}]});
  const auth=await authenticate(panel);await auth.call('commands');expect(panel.commands.get(selected.id)?.state).toBe('unknown');await auth.call('commands');expect(panel.commands.get(selected.id)?.state).toBe('notified');expect(f.desktop.submissions).toHaveLength(0);
 }finally{await panel.close();await f.close();}
},15000);
