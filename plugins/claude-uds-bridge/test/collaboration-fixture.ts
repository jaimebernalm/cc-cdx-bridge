import {expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import net from 'node:net';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {type Report,formatWork} from '../src/routines';
import {formatManaged} from '../src/managed-message';
import {processStart,frameSchema} from '../src/claude';
import {Bridge} from '../src/bridge';
import {receiver} from './desktop-fixture';
const pluginRoot=resolve(import.meta.dir,'..');
export async function until(check:()=>boolean){const deadline=Date.now()+4000;while(!check()&&Date.now()<deadline)await Bun.sleep(10);expect(check()).toBe(true);}
export async function nativeFixture(dropAcknowledgement=false){
 const root=mkdtempSync('/tmp/phase2-native-');const desktop=await receiver('idle',dropAcknowledgement,false,root);const config=join(root,'claude');const state=join(root,'plugin-state/claude-uds-bridge');const sockets=join(root,'s');
 mkdirSync(join(config,'sessions'),{recursive:true,mode:0o700});mkdirSync(sockets,{mode:0o700});const peerId=randomUUID();const peerSocket=join(sockets,process.ppid+'.sock');const frames:ReturnType<typeof frameSchema.parse>[]=[];const clients=new Set<net.Socket>();
 const server=net.createServer(socket=>{clients.add(socket);socket.on('error',()=>{});socket.on('close',()=>clients.delete(socket));socket.setEncoding('utf8');let buffer='';socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){frames.push(frameSchema.parse(JSON.parse(buffer.slice(0,end))));buffer=buffer.slice(end+1);}});});server.listen(peerSocket);await once(server,'listening');chmodSync(peerSocket,0o600);
 writeFileSync(join(config,'sessions',process.ppid+'.json'),JSON.stringify({pid:process.ppid,procStart:await processStart(process.ppid),sessionId:peerId,messagingSocketPath:peerSocket,cwd:root,name:'Claude test',entrypoint:'claude-desktop',status:'idle',version:'2.1.286',peerProtocol:1}),{mode:0o600});
 const bridge=new Bridge(desktop.threadId,config,state,desktop.path);await bridge.start(sockets,root,bridge.beginSession());bridge.updateRuntime({status:'idle',mode:'prompting'});
 const connect=async()=>{const c=new Client({name:'phase2-fixture',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[process.env.UDS_MCP_TEST_ENTRYPOINT??join(pluginRoot,'src/server.ts')],env:{...process.env,CODEX_HOME:root,CLAUDE_CONFIG_DIR:config}}));return c;};
 const call=async(c:Client,name:string,args:Record<string,unknown>)=>{const r=await c.callTool({name,arguments:args,_meta:{threadId:desktop.threadId}});const text=(r.content as {text:string}[])[0]!.text;return {error:r.isError,data:r.isError?text:JSON.parse(text)};};
 const respond=async(runId:string,out:string,report:Report,text:string,contextVersion=1)=>{const socket=net.createConnection(bridge.status().replyAddress!.slice(4));await once(socket,'connect');socket.end(JSON.stringify({msgV:1,type:'user',msg_id:randomUUID(),from:'uds:'+peerSocket,from_mode:'prompting',session_id:desktop.threadId,message:{role:'user',content:formatManaged({runId,messageId:randomUUID(),replyTo:out,contextVersion},formatWork(report,text))}})+'\n');await once(socket,'close');};
 return {root,desktop,config,state,bridge,peerId,frames,connect,call,respond,async close(){await bridge.close();for(const socket of clients)socket.destroy();await new Promise<void>(done=>server.close(()=>done()));await desktop.close();}};
}
