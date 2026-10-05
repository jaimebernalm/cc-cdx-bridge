import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { doctor } from './doctor';
import { activateReceiver } from './activation';
import {PanelOpening} from './panel-opening';
import { startPanel } from './panel';

try {
  const { values, positionals } = parseArgs({ options: { thread: { type: 'string' }, peer: { type: 'string' },
    project: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: true });
  const command = positionals[0] ?? 'doctor';
  if (values.help) {
    console.log('Usage: run-bun.sh dist/cli.js doctor|attach|panel [--thread UUID] [--peer UUID] [--project DIRECTORY]\n'
      + 'doctor is read-only. attach activates only the identified existing Codex chat; it does not change reception policy or send messages.');
  } else {
    if (positionals.length > 1 || !['doctor', 'attach','panel'].includes(command)) throw new Error('Use doctor, attach or panel; see --help.');
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const stateDir = join(codexHome,'plugin-state','claude-uds-bridge');
    const pluginRoot = dirname(import.meta.dir);
    const project = resolve(values.project ?? process.cwd());
    const threadId = values.thread ?? process.env.CODEX_THREAD_ID;
    if(command==='panel'){
      const panel=startPanel({configDir,stateDir,codexHome,pluginRoot,ipcPath:join(codexHome,'ipc','ipc.sock'),ownerThread:values.thread});
      const browser=await new PanelOpening().open('cli-panel',panel.url,true);console.log(JSON.stringify({url:panel.origin+'/',browser,tokenReturned:false,scope:values.thread?'selected_chat':'local_chats',settingsModified:false}));
      for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void panel.close().then(()=>process.exit(0));});
    }else if (command === 'doctor') {
      const report = await doctor({ project, threadId, peerId: values.peer, configDir, codexHome, pluginRoot });
      console.log(JSON.stringify(report, null, 2));
      // 2: missing prerequisite; 3: valid transport but unknown reception/trust.
      process.exitCode = report.checks.some(check => check.level === 'blocked') ? 2 : 3;
    } else {
      if (!threadId) throw new Error('attach requires --thread UUID or CODEX_THREAD_ID from the existing Desktop chat.');
      console.log(JSON.stringify(await activateReceiver({ threadId, project, configDir, codexHome, hookPath: join(import.meta.dir, 'hook' + (import.meta.path.endsWith('.ts') ? '.ts' : '.js')) }), null, 2));
    }
  }
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Bridge command failed', settingsModified: false, messagesSent: false }));
  process.exitCode = 1;
}
