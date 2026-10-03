import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { doctor } from './doctor';
import { activateReceiver } from './activation';

try {
  const { values, positionals } = parseArgs({ options: { thread: { type: 'string' }, peer: { type: 'string' },
    project: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: true });
  const command = positionals[0] ?? 'doctor';
  if (values.help) {
    console.log('Usage: run-bun.sh dist/cli.js doctor|attach [--thread UUID] [--peer UUID] [--project DIRECTORY]\n'
      + 'doctor is read-only. attach activates only the identified existing Codex chat; it does not change reception policy or send messages.');
  } else {
    if (positionals.length > 1 || !['doctor', 'attach'].includes(command)) throw new Error('Use doctor or attach; see --help.');
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const pluginRoot = dirname(import.meta.dir);
    const project = resolve(values.project ?? process.cwd());
    const threadId = values.thread ?? process.env.CODEX_THREAD_ID;
    if (command === 'doctor') {
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
