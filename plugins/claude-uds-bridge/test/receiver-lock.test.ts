import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {withReceiverLock} from '../src/receiver-lock';

function fixture(){const state=mkdtempSync('/tmp/receiver-lock-'),thread=randomUUID(),lock=join(state,thread+'.activation-lock');mkdirSync(lock,{mode:0o700});writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:process.pid,procStart:'previous owner'}),{mode:0o600});return {state,thread,lock,close:()=>rmSync(state,{recursive:true,force:true})};}
test('activation retries when the prior owner releases its lock and exits during process inspection',async()=>{
 const f=fixture();let inspected=0,activated=0;try{
  const inspect=async()=>{if(++inspected===2){rmSync(f.lock,{recursive:true});throw new Error('Cannot verify receiver process');}return 'current owner';};
  const result=await withReceiverLock(f.state,f.thread,async()=>{activated++;expect(existsSync(join(f.lock,'owner.json'))).toBe(true);return 'ready';},inspect);
  expect(result).toBe('ready');expect(activated).toBe(1);expect(existsSync(f.lock)).toBe(false);
 }finally{f.close();}
});
test('activation preserves a stale lock that still belongs to an unverifiable process',async()=>{
 const f=fixture();let inspected=0,activated=0;try{
  const inspect=async()=>{if(++inspected===2)throw new Error('Cannot verify receiver process');return 'current owner';};
  await expect(withReceiverLock(f.state,f.thread,async()=>{activated++;},inspect)).rejects.toThrow('Stale or invalid');
  expect(activated).toBe(0);expect(existsSync(join(f.lock,'owner.json'))).toBe(true);
 }finally{f.close();}
});
