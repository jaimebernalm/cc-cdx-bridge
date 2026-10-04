import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ownedJson, privateDirectory, processStart } from './claude';

// Serialize SessionStart/attach callers before beginSession replaces a generation.
// A crash leaves an explicit recovery issue rather than deleting an unknown lock.
export async function withReceiverLock<T>(stateDir: string, thread: string, operation: () => Promise<T>, inspectProcess = processStart): Promise<T> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  privateDirectory(stateDir);
  const lock = join(stateDir, `${thread}.activation-lock`);
  const deadline = Date.now() + 12000;
  const start = await inspectProcess(process.pid);
  for (;;) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      let identity: {dev:number;ino:number}|undefined;
      try {
        privateDirectory(lock);
        identity=lstatSync(lock);
        const owner = ownedJson(join(lock, 'owner.json'), 4096) as { pid: number; procStart: string };
        if (!Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.procStart !== 'string') throw new Error('Invalid activation lock owner');
        if (await inspectProcess(owner.pid) !== owner.procStart) throw new Error('Activation lock owner changed');
      } catch (reason) {
        if (!(reason instanceof Error && 'code' in reason && reason.code === 'ENOENT')) {
          // The owner may release its directory and exit while its PID is being inspected.
          // Retry a vanished/replaced lock, but preserve an unverifiable lock that still exists.
          try {const current=lstatSync(lock);if(identity&&(current.dev!==identity.dev||current.ino!==identity.ino))continue;}
          catch(error){if(error instanceof Error&&'code' in error&&error.code==='ENOENT')continue;throw error;}
          throw new Error('Stale or invalid activation lock. Stop activation attempts, inspect the lock in plugin-state/claude-uds-bridge and remove it only after verifying its owner has stopped.');
        }
      }
      if (Date.now() >= deadline) throw new Error('Another receiver activation is still running; retry after it finishes.');
      await Bun.sleep(50);
    }
  }
  try {
    writeFileSync(join(lock, 'owner.json.tmp'), JSON.stringify({ pid: process.pid, procStart: start }), { flag: 'wx', mode: 0o600 });
    renameSync(join(lock,'owner.json.tmp'),join(lock,'owner.json')); // Readers see a complete owner record.
    return await operation();
  } finally { rmSync(lock, { recursive: true }); }
}
