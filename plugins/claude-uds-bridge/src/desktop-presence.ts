import {join} from 'node:path';
import {mkdirSync,writeFileSync,renameSync,realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {ownedJson,privateDirectory,processStart} from './claude';
import {version} from './version';
import type {RuntimeCaller} from './desktop-runtime';
import type {Participant} from './participants';

// Native plugin presence is separate from collaboration databases. Loading a Claude plugin may
// advertise its verified live host, but must not create/migrate the shared run database.
export function advertiseDesktop(stateDir:string,caller:RuntimeCaller,runtimeStart:string){
 const dir=join(stateDir,'desktop-presence');mkdirSync(dir,{recursive:true,mode:0o700});privateDirectory(dir);
 const target=join(dir,caller.provider+'-'+caller.sessionId+'.json'),temp=target+'.'+randomUUID()+'.tmp';
 writeFileSync(temp,JSON.stringify({provider:caller.provider,sessionId:caller.sessionId,pid:caller.pid,procStart:caller.procStart,project:realpathSync(caller.project),generation:caller.binding.generation,runtimePid:process.pid,runtimeStart,version}),{mode:0o600,flag:'wx'});renameSync(temp,target);
}
export async function desktopPresent(stateDir:string,p:Participant|{provider:string;sessionId:string;pid:number;procStart:string;cwd:string}){
 try{const r=ownedJson(join(stateDir,'desktop-presence',p.provider+'-'+p.sessionId+'.json'),16384) as Record<string,unknown>,project='project' in p?p.project.directory:p.cwd;
 return r.provider===p.provider&&r.sessionId===p.sessionId&&r.pid===p.pid&&r.procStart===p.procStart&&r.project===project&&r.version===version&&typeof r.runtimePid==='number'&&typeof r.runtimeStart==='string'&&await processStart(r.runtimePid)===r.runtimeStart;
 }catch{return false;}
}
