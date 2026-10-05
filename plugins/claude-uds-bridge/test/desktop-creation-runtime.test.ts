import {test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {registerDesktopTools} from '../src/desktop-runtime';
import {inspectParticipant} from '../src/participants';
import {nativeFixture,until} from './collaboration-fixture';

test('Claude panel delegates one native Codex creation to the exact live executor; a wake cannot authorize itself and unknown is final',async()=>{
 const f=await nativeFixture(),codex=await f.connect(),server=new McpServer({name:'fixture-claude',version:'1'}),client=new Client({name:'fixture',version:'1'});let privateUrl='';
 const original=process.env.CC_CDX_PANEL_AUTO_OPEN;delete process.env.CC_CDX_PANEL_AUTO_OPEN;
 const options={configDir:f.config,stateDir:f.state,ipcPath:f.desktop.path},p=await inspectParticipant(options,f.peerId,'claude');const runtime=registerDesktopTools(server,{...options,codexHome:f.root,pluginRoot:resolve(import.meta.dir,'..'),openPrivatePanel:async url=>{privateUrl=url},authenticate:async()=>({...p,project:f.root,binding:{method:'fixture',generation:'fixture',surface:'claude-desktop',evidence:[]}})});
 const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(a),client.connect(b)]);
 const call=async(name:string,args:Record<string,unknown>)=>{const r=await client.callTool({name:'desktop_collaboration_'+name,arguments:args});if(r.isError)throw new Error(JSON.stringify(r.content));return JSON.parse((r.content as {text:string}[])[0]!.text)};
 try{await call('discover',{});await f.call(codex,'desktop_collaboration_discover',{});await call('panel',{});const origin=new URL(privateUrl).origin,token=new URLSearchParams(new URL(privateUrl).hash.slice(1)).get('token');const session=await fetch(origin+'/api/v1/session',{method:'POST',headers:{Origin:origin},body:JSON.stringify({token})}),{csrf}=await session.json() as any,cookie=session.headers.get('set-cookie')!.split(';')[0]!;
 const post=async(path:string,data:unknown)=>{const res=await fetch(origin+'/api/v1/desktop/'+path,{method:'POST',headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf},body:JSON.stringify(data)});return {status:res.status,data:await res.json() as any}};
 const requested=await call('ticket_request',{input:{requestId:randomUUID(),project:f.root,targetProvider:'codex',mode:'local',adapter:'native_tool_relay'}});expect(requested.ticket.state).toBe('requested');await expect(call('ticket_execute',{ticketId:requested.ticket.id})).rejects.toThrow('native tool relay');expect((await post('tickets/authorize',{id:requested.ticket.id,revision:requested.ticket.revision})).status).toBe(200);
 const commandId=randomUUID();const dispatch=await post('creation_dispatch',{ticketId:requested.ticket.id,executorId:f.desktop.threadId,commandId});expect(dispatch.status).toBe(200);await until(()=>f.desktop.submissions.length===1);expect(JSON.stringify(f.desktop.submissions)).toContain(commandId);expect((await post('creation_dispatch',{ticketId:requested.ticket.id,executorId:f.desktop.threadId,commandId})).data.reused).toBe(true);expect(f.desktop.submissions).toHaveLength(1);
 const command=await f.call(codex,'desktop_collaboration_panel_command',{commandId});expect(command.error).toBeFalsy();expect(command.data.ticket.id).toBe(requested.ticket.id);const plan=await f.call(codex,'desktop_collaboration_ticket_execute',{ticketId:requested.ticket.id});expect(plan.error).toBeFalsy();expect(plan.data.adapter).toBe('native_tool_relay');expect(plan.data.bootstrapPrompt).toStartWith('CCDX-CORR-');expect(plan.data.forbidden.join('\n')).toContain('127.0.0.1');
 await expect(call('ticket_outcome',{ticketId:requested.ticket.id,epoch:plan.data.epoch,outcome:{state:'created',hostRef:randomUUID()}})).rejects.toThrow('process that began');const uncertain=await f.call(codex,'desktop_collaboration_ticket_outcome',{ticketId:requested.ticket.id,epoch:plan.data.epoch,outcome:{state:'uncertain',reason:'Fixture never called a real host creation tool'}});expect(uncertain.data.state).toBe('creation_uncertain');expect((await f.call(codex,'desktop_collaboration_ticket_execute',{ticketId:requested.ticket.id})).error).toBeTruthy();expect(f.desktop.submissions).toHaveLength(1);
 const tools=await client.listTools();expect(tools.tools.some(t=>t.name==='desktop_collaboration_creation_dispatch')).toBe(false);expect(tools.tools.some(t=>t.name==='desktop_collaboration_ticket_authorize')).toBe(false);
 }finally{original===undefined?delete process.env.CC_CDX_PANEL_AUTO_OPEN:process.env.CC_CDX_PANEL_AUTO_OPEN=original;await client.close();await server.close();await runtime.close();await codex.close();await f.close()}
},15000);
