import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {registerDesktopTools,type RuntimeCaller} from '../src/desktop-runtime';
import {desktopPresent} from '../src/desktop-presence';
import {processStart} from '../src/claude';

test('a verified startup advertises live presence without opening a collaboration database; stale process evidence is rejected',async()=>{
 const root=mkdtempSync(join(tmpdir(),'desktop-presence-')),stateDir=join(root,'state'),procStart=await processStart(process.pid);
 const c:RuntimeCaller={provider:'claude',sessionId:randomUUID(),pid:process.pid,procStart,project:root,binding:{method:'isolated_fixture',surface:'claude-desktop',generation:randomUUID(),evidence:[]}};
 const server=new McpServer({name:'presence-fixture',version:'1'}),runtime=registerDesktopTools(server,{configDir:join(root,'config'),stateDir,ipcPath:join(root,'ipc'),codexHome:root,pluginRoot:root,authenticate:async()=>c,registerAtStartup:true});
 const peer={provider:c.provider,sessionId:c.sessionId,pid:c.pid,procStart:c.procStart,cwd:realpathSync(root)};
 try{
  const deadline=Date.now()+2000;while(!await desktopPresent(stateDir,peer)&&Date.now()<deadline)await Bun.sleep(10);
  expect(await desktopPresent(stateDir,peer)).toBe(true);expect(readdirSync(stateDir)).toEqual(['desktop-presence']);
  expect(await desktopPresent(stateDir,{...peer,sessionId:randomUUID()})).toBe(false);expect(await desktopPresent(stateDir,{...peer,cwd:root+'/different'})).toBe(false);
  const path=join(stateDir,'desktop-presence','claude-'+c.sessionId+'.json'),record=JSON.parse(readFileSync(path,'utf8'));writeFileSync(path,JSON.stringify({...record,runtimeStart:'obsolete process'}),{mode:0o600});expect(await desktopPresent(stateDir,peer)).toBe(false);
 }finally{await runtime.close();await server.close();rmSync(root,{recursive:true,force:true})}
});
