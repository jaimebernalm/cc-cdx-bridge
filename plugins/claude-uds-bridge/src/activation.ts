import { realpathSync } from 'node:fs';
import { readDesktopInfo } from './desktop';
import { peers, processStart, uuid } from './claude';

export type ActivationOptions = { threadId: string; project: string; configDir: string; codexHome: string; hookPath: string };

export async function activateReceiver(options: ActivationOptions) {
  const thread = uuid.parse(options.threadId);
  const project = realpathSync(options.project);
  const info = await readDesktopInfo(`${options.codexHome}/ipc/ipc.sock`, thread);
  if (realpathSync(info.project) !== project) throw new Error('Project mismatch: select the existing Codex chat for this exact folder.');
  const previous = peers(options.configDir).filter(peer => peer.sessionId === thread);
  if (previous.length > 1 || previous.some(peer => peer.entrypoint !== 'codex-claude-uds-bridge')) throw new Error('Conflicting receiver registrations; no receiver was started.');
  const child = Bun.spawn([process.execPath, options.hookPath], {
    env: { ...process.env, CODEX_HOME: options.codexHome, CLAUDE_CONFIG_DIR: options.configDir },
    stdin: 'pipe', stdout: 'ignore', stderr: 'pipe',
  });
  child.stdin.write(JSON.stringify({ session_id: thread, cwd: project, hook_event_name: 'SessionStart' }));
  child.stdin.end();
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(error.trim() || 'Receiver activation failed.');
  const matches = peers(options.configDir).filter(peer => peer.sessionId === thread && peer.entrypoint === 'codex-claude-uds-bridge');
  const peer = matches[0];
  if (matches.length !== 1 || !peer?.procStart || await processStart(peer.pid) !== peer.procStart || realpathSync(peer.cwd) !== project) {
    throw new Error('Receiver disappeared or changed identity after activation.');
  }
  return { threadId: thread, project, receiver: 'active', reused: previous.some(item => item.pid === peer.pid),
    permissionsChanged: false, historyCleared: false, hookTrust: 'not_verified_by_attach' };
}
