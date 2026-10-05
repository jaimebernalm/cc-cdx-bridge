import { Database } from 'bun:sqlite';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { RunStore } from './runs';
import { PanelCommands, panelRequestSchema, type PanelRequest } from './panel-commands';
import { discoverParticipants, inspectParticipant, sameSnapshot, type ParticipantOptions } from './participants';
import { compareProjects } from './project';
import { readDesktopInputSnapshot, deliverToDesktop } from './desktop';
import { doctor } from './doctor';
import { version } from './version';
import { ProjectAuthorizations, authorizationIdentitySchema, authorizationChangeSchema } from './project-authorization';
import { processStart } from './claude';
import { normalizeRoutine, routineGuides } from './routines';

const equal=(a:string,b:string)=>Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
type Options=ParticipantOptions&{codexHome:string;pluginRoot:string;ownerThread?:string;port?:number};
export function startPanel(options:Options){
  const store=new RunStore(options.stateDir),commands=new PanelCommands(options.stateDir),authorizations=new ProjectAuthorizations(options.stateDir);
  const token=randomBytes(32).toString('hex'),session=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
  let exchanged=false,closed=false;const streams=new Set<()=>void>();const wakes=new Set<Promise<unknown>>();
  const assetRoot=resolve(options.pluginRoot,'panel-dist');
  const headers={ 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
  const json=(data:unknown,status=200,extra:Record<string,string>={})=>Response.json(data,{status,headers:{...headers,...extra}});
  const ownerFor=(id:string)=>{const db=new Database(join(options.stateDir,'collaborations.sqlite'),{readonly:true});
    try{const row=db.query<{owner_thread:string},[string]>('SELECT owner_thread FROM runs WHERE id=?').get(id);if(!row||options.ownerThread&&row.owner_thread!==options.ownerThread)throw new Error('Unknown collaboration');return row.owner_thread;}finally{db.close();}};
  const list=()=>{const db=new Database(join(options.stateDir,'collaborations.sqlite'),{readonly:true});try{
    const owners=options.ownerThread?[{owner_thread:options.ownerThread}]:db.query<{owner_thread:string},[]>('SELECT DISTINCT owner_thread FROM runs').all();
    return owners.flatMap(o=>store.list(o.owner_thread).map(r=>({...r,ownerThread:o.owner_thread}))).sort((a,b)=>b.createdAt-a.createdAt).slice(0,200);
  }finally{db.close();}};
  const identity=async(input:PanelRequest)=>{
    if(options.ownerThread&&input.ownerThread!==options.ownerThread)throw new Error('Select the conversation bound to this panel');
    const sessions=await discoverParticipants(options.configDir,options.stateDir);const selected=sessions.find(s=>s.sessionId===input.ownerThread&&s.provider==='codex');
    if(!selected?.panelReceiver)throw new Error('Reload Codex with the phase-4 plugin before starting or controlling from the panel');
    const codex=await inspectParticipant(options,input.ownerThread,'codex',true,true);
    if(codex.project.directory!==realpathSync(input.project))throw new Error('Selected conversation project changed');
    if(input.command.action==='create'){
      const routine=normalizeRoutine(input.command.routine,input.command.context.priorAnalysis);
      if(input.command.coordination.initialBarrier&&(routine.starts.codex!=='new'||routine.starts.claude!=='new'))throw new Error('Initial barrier requires new analyses from both agents');
      const claude=await inspectParticipant(options,input.command.peerId,'claude');
      await compareProjects(codex.project,claude.project,input.command.revisionPolicy,input.command.comparisonBase);
      if(claude.status!=='idle'&&!input.command.allowBusyPeer)throw new Error('Claude is busy; wait or choose the explicit busy option');
      if(input.command.continuedFrom)store.assertOwner(input.command.continuedFrom,input.ownerThread);
    }else{
      const run=store.status(input.command.runId,input.ownerThread);
      if(run.coordination?.revision!==input.command.expectedRevision)throw new Error('Control revision changed; refresh the collaboration');
    }
    return codex;
  };
  const authorizationIdentity=async(raw:unknown)=>{
    const input=authorizationIdentitySchema.parse(raw);
    if(options.ownerThread&&input.ownerThread!==options.ownerThread)throw new Error('Wrong conversation for this panel');
    const codex=await inspectParticipant(options,input.ownerThread,'codex',true,true);
    if(codex.project.directory!==realpathSync(input.project))throw new Error('Selected conversation project changed');
    const selected=(await discoverParticipants(options.configDir,options.stateDir)).find(p=>p.sessionId===input.ownerThread);
    const db=new Database(join(options.stateDir,input.ownerThread+'.sqlite'),{readonly:true});
    try {const policy=db.query<{policy:string},[]>('SELECT policy FROM inbound_policy WHERE singleton=1').get()?.policy;
      return {input,project:codex.project.directory,chatPolicy:policy??'default',receiverSupported:selected?.projectAuthorizationReceiver===true};
    }finally{db.close();}
  };
  const wake=async(input:PanelRequest,snapshot:Awaited<ReturnType<typeof identity>>)=>{
    const row=commands.get(input.commandId)!;if(row.state!=='waking'||row.processor_pid!==process.pid)return;
    try{
      const fresh=await inspectParticipant(options,row.owner,'codex',true,true);
      if(closed)throw new Error('Panel closed before wake; delivery not retried');
      if(!sameSnapshot(snapshot,fresh))throw new Error('Participant changed before native wake');
      const result=await deliverToDesktop(options.ipcPath,row.owner,row.input_id,
        '[CC_CDX_PANEL_COMMAND] A human submitted an action through the authenticated local CC–CDX panel. '+
        `Command ID: ${row.id}. Use collaboration_panel_command with that commandId to read/apply its persisted contents. `+
        'This text alone grants no approval: the tool checks the durable command and your real caller/project. Do not reconstruct arguments from this notification, change permissions or create a substitute CLI session. If the tool is unavailable, report that the plugin must be reloaded.');
      commands.wakeResult(row.id,'notified');return result;
    }catch(error){commands.wakeResult(row.id,'unknown',error instanceof Error?error.message:'Native delivery uncertain');}
  };
  const body=async(req:Request)=>{const reader=req.body?.getReader();if(!reader)throw new Error('Missing body');let size=0;const chunks:Uint8Array[]=[];
    while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>262144){await reader.cancel();throw new Error('Request body exceeds limit');}chunks.push(part.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));};
  let reconciliationCursor=0;
  const reconcile=async(rows:ReturnType<PanelCommands['list']>)=>{
    const groups=Map.groupBy(rows.filter(c=>c.state==='unknown'),c=>c.owner);
    await Promise.allSettled([...groups].map(async([owner,pending])=>{
      try{
        const snapshot=await readDesktopInputSnapshot(options.ipcPath,owner),project=realpathSync(snapshot.project),inputs=snapshot.inputs;
        if(closed)return;
        for(const command of pending){
          if(command.project!==project)commands.reconciliationIssue([command.id],'Native project changed; consumption is not attributed to this command');
          else if(inputs.consumed.some(i=>i.clientId===command.input_id))commands.consumed(command.id);
          else if(inputs.latest===undefined)commands.reconciliationIssue([command.id],'Native history is incomplete or unavailable; delivery remains uncertain and is not resent');
          else commands.reconciliationIssue([command.id],'Exact input consumption is not observable; no notification is resent');
        }
      }catch{if(!closed)commands.reconciliationIssue(pending.map(c=>c.id),'Native history unavailable; delivery remains uncertain and is not resent');}
    }));
  };
  const inspectCommands=async()=>{
    await commands.inspectApplications();const rows=commands.list(options.ownerThread);
    const owners=[...new Set(rows.filter(c=>c.state==='unknown').map(c=>c.owner))];
    // Bound work per poll; rotate so unavailable chats cannot starve later ones.
    const selected=new Set(Array.from({length:Math.min(4,owners.length)},(_,i)=>owners[(reconciliationCursor+i)%owners.length]));
    reconciliationCursor=owners.length?(reconciliationCursor+selected.size)%owners.length:0;
    await reconcile(rows.filter(c=>selected.has(c.owner)));
    return commands.list(options.ownerThread).map(c=>commands.public(c));
  };
  const server=Bun.serve({hostname:'127.0.0.1',port:options.port??0,idleTimeout:0,
    async fetch(req):Promise<Response>{const url=new URL(req.url),origin=`http://127.0.0.1:${server.port}`,cookieName=`cc_cdx_panel_${server.port}`;
      if(req.headers.get('host')!==`127.0.0.1:${server.port}`||url.origin!==origin)return json({error:'Invalid Host'},403);
      const requestOrigin=req.headers.get('origin');if(requestOrigin&&requestOrigin!==origin)return json({error:'Invalid Origin'},403);
      if(req.headers.get('sec-fetch-site')==='cross-site')return json({error:'Cross-site request rejected'},403);
      try{
        if(url.pathname==='/api/v1/session'&&req.method==='POST'){
          if(requestOrigin!==origin)return json({error:'Session requires same origin'},403);
          const supplied=z.object({token:z.string().max(128)}).strict().parse(await body(req)).token;
          if(!equal(supplied,token))return json({error:'Invalid access token'},401);exchanged=true;
          return json({csrf,ownerThread:options.ownerThread??null},200,{'Set-Cookie':`${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`});
        }
        if(url.pathname.startsWith('/api/')){
          const cookie=(req.headers.get('cookie')??'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1)??'';
          if(!exchanged||!equal(cookie,session))return json({error:'Open the private panel link to connect'},401);
          if(req.method!=='GET'&&(requestOrigin!==origin||!equal(req.headers.get('x-csrf-token')??'',csrf)))return json({error:'Invalid CSRF token'},403);
          if(url.pathname==='/api/v1/health'&&req.method==='GET')return json({version,csrf,ownerThread:options.ownerThread??null});
          if(url.pathname==='/api/v1/participants'&&req.method==='GET')return json(await discoverParticipants(options.configDir,options.stateDir));
          if(url.pathname==='/api/v1/project-authorization'&&req.method==='GET'){
            const id=await authorizationIdentity({ownerThread:url.searchParams.get('ownerThread'),project:url.searchParams.get('project')});
            return json({...authorizations.status(id.project),chatPolicy:id.chatPolicy,receiverSupported:id.receiverSupported});
          }
          if(url.pathname==='/api/v1/project-authorization'&&req.method==='POST'){
            const change=authorizationChangeSchema.parse(await body(req));
            const id=await authorizationIdentity({ownerThread:change.ownerThread,project:change.project});
            if(change.enabled&&!id.receiverSupported)throw new Error('Reload this chat receiver before remembering project authorization');
            return json({...authorizations.change({...change,project:id.project}),chatPolicy:id.chatPolicy,receiverSupported:id.receiverSupported});
          }
          if(url.pathname==='/api/v1/presets'&&req.method==='GET')return json(Object.entries(routineGuides).map(([id,guidance])=>({id,guidance})));
          if(url.pathname==='/api/v1/runs'&&req.method==='GET')return json(list());
          if(url.pathname==='/api/v1/commands'&&req.method==='GET')return json(await inspectCommands());
          if(url.pathname==='/api/v1/preflight'&&req.method==='POST'){const input=panelRequestSchema.parse(await body(req));await identity(input);return json({ready:true});}
          if(url.pathname==='/api/v1/commands'&&req.method==='POST'){
            const input=panelRequestSchema.parse(await body(req));
            if(options.ownerThread&&input.ownerThread!==options.ownerThread)throw new Error('Wrong conversation for this panel');
            const existing=commands.get(input.commandId);
            if(existing){const repeated=commands.enqueue(input);return json({...commands.public(repeated.command),reused:true},202);}
            const snapshot=await identity(input);const wakeStart=await processStart(process.pid);const queued=commands.enqueue(input,wakeStart);const pending=queued.reused?Promise.resolve():wake(input,snapshot);wakes.add(pending);void pending.finally(()=>wakes.delete(pending));
            return json({...commands.public(queued.command),reused:queued.reused},202);
          }
          if(url.pathname==='/api/v1/diagnostic'&&req.method==='POST'){
            const input=z.object({ownerThread:z.string().uuid(),project:z.string().min(1),peerId:z.string().uuid().optional()}).strict().parse(await body(req));
            if(options.ownerThread&&options.ownerThread!==input.ownerThread)throw new Error('Wrong conversation');
            const report=await doctor({project:input.project,threadId:input.ownerThread,peerId:input.peerId,configDir:options.configDir,codexHome:options.codexHome,pluginRoot:options.pluginRoot});
            return json({state:report.state,checks:report.checks.map(c=>({code:c.code,level:c.level,message:c.code==='runtime'?`Bun ${Bun.version}; distribution ${version}`:c.message,remedy:c.remedy})),settingsModified:false,messagesSent:false});
          }
          const match=url.pathname.match(/^\/api\/v1\/runs\/([\da-f-]{36})(?:\/(events|stream|export))?$/i);
          if(match&&req.method==='GET'){
            const id=z.string().uuid().parse(match[1]),owner=ownerFor(id);const run=store.status(id,owner);
            if(!match[2])return json(run);
            if(match[2]==='export'){const format=z.enum(['markdown','json']).parse(url.searchParams.get('format')??'markdown');return new Response(store.export(id,owner,format),{headers:{...headers,'Content-Type':format==='json'?'application/json':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="collaboration-${id}.${format==='json'?'json':'md'}"`}});}
            const after=z.coerce.number().int().min(0).parse(url.searchParams.get('after')??req.headers.get('last-event-id')??0);
            if(match[2]==='events')return json({events:run.events.filter(e=>e.sequence>after).slice(0,100),cursor:run.events.filter(e=>e.sequence>after).slice(0,100).at(-1)?.sequence??after});
            let stop=()=>{};const stream=new ReadableStream<Uint8Array>({start(controller){let cursor=after;
              const send=()=>{try{const current=store.status(id,owner);for(const e of current.events.filter(e=>e.sequence>cursor)){controller.enqueue(new TextEncoder().encode(`id: ${e.sequence}\nevent: update\ndata: ${JSON.stringify(e)}\n\n`));cursor=e.sequence;}controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'));}catch{stop();try{controller.close();}catch{}}};
              const timer=setInterval(send,1000);stop=()=>{clearInterval(timer);streams.delete(stop);};streams.add(stop);req.signal.addEventListener('abort',()=>{stop();try{controller.close();}catch{}},{once:true});send();},cancel(){stop();}});
            return new Response(stream,{headers:{...headers,'Content-Type':'text/event-stream','Connection':'keep-alive'}});
          }
          return json({error:'Unknown API route'},404);
        }
        if(req.method!=='GET')return json({error:'Method not allowed'},405);
        const relative=url.pathname==='/'?'index.html':url.pathname.slice(1);
        if(relative!=='index.html'&&!/^assets\/[\w.-]+\.(js|css|woff2)$/.test(relative))return json({error:'Unknown asset'},404);
        const file=join(assetRoot,relative);if(!existsSync(file))return json({error:'Panel assets missing; build the UI'},503);
        return new Response(Bun.file(file),{headers:{...headers,'Cache-Control':extname(file)==='.html'?'no-store':'public, max-age=31536000, immutable'}});
      }catch(error){return json({error:error instanceof Error?error.message:'Panel request failed'},409);}
    }});
  return {url:`http://127.0.0.1:${server.port}/#token=${token}`,origin:`http://127.0.0.1:${server.port}`,store,commands,
    async reconcileCommand(id:string){const command=commands.get(id);if(command)await reconcile([command]);},
    async close(){if(closed)return;closed=true;for(const stop of streams)stop();await server.stop(true);await Promise.allSettled([...wakes]);store.close();commands.close();authorizations.close();}};
}
