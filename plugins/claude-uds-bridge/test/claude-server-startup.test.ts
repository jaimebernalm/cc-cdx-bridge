import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { processStart } from '../src/claude';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every Claude conversation with the plugin starts this server, whether or not it ever collaborates.
// Starting, listing tools and caller_status must never create or migrate the shared SQLite state:
// older Codex writers may be live on it (plan §8). The shared database belongs to the first
// desktop_collaboration_* call.
const pluginRoot = process.env.CCDX_CLAUDE_PLUGIN_ROOT ?? join(import.meta.dir, '../../cc-cdx-bridge-claude');

function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}

async function session(env: Record<string, string>, requests: unknown[]) {
  const child = Bun.spawn(['bun', join(pluginRoot, 'dist/claude-server.js')], { env: { ...process.env, ...env }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
  const replies: Record<string, unknown>[] = [];
  const reader = (async () => {
    let buffer = '';
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) { replies.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1); }
    }
  })();
  for (const request of requests) {
    child.stdin.write(JSON.stringify(request) + '\n');
    const id = (request as { id?: number }).id;
    if (id === undefined) continue;
    const deadline = Date.now() + 10000;
    while (!replies.some(reply => reply.id === id) && Date.now() < deadline) await Bun.sleep(20);
  }
  child.stdin.end(); child.kill(); await child.exited; await reader.catch(() => {});
  return replies;
}

test('starting the Claude server, listing tools and caller_status create no shared database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccdx-startup-')); chmodSync(root, 0o700);
  const codexHome = join(root, 'codex'), stateDir = join(codexHome, 'plugin-state', 'claude-uds-bridge');
  try {
    const replies = await session({ CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: join(root, 'claude'), CLAUDE_PLUGIN_ROOT: pluginRoot }, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'startup-test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'caller_status', arguments: {} } },
    ]);
    const tools = (replies.find(reply => reply.id === 2)?.result as { tools: { name: string }[] }).tools.map(tool => tool.name);
    expect(tools).toContain('caller_status');
    // Panel-only operations are never model tools.
    for (const name of ['desktop_collaboration_notify', 'desktop_collaboration_consent', 'desktop_collaboration_creation_dispatch']) expect(tools).not.toContain(name);
    expect(replies.some(reply => reply.id === 3)).toBe(true);
    const created = files(stateDir).map(path => path.slice(stateDir.length + 1));
    expect(created.filter(path => /\.sqlite(-wal|-shm|-journal)?$/.test(path))).toEqual([]);
    expect(files(root).filter(path => /\.sqlite/.test(path))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('a valid Desktop caller at startup is bound from the fixture registry without touching SQLite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccdx-startup-ok-')); chmodSync(root, 0o700);
  const codexHome = join(root, 'codex'), stateDir = join(codexHome, 'plugin-state', 'claude-uds-bridge'), configDir = join(root, 'claude');
  const project = join(root, 'project'), socks = join(root, 'socks'), socketPath = join(socks, 's.sock'), sessionId = randomUUID();
  for (const directory of [project, socks, join(configDir, 'sessions')]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(socketPath, resolve)); chmodSync(socketPath, 0o600);
  // This test process plays the session engine: the bundled server is its direct child.
  writeFileSync(join(configDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, messagingSocketPath: socketPath, cwd: project,
    peerProtocol: 1, procStart: await processStart(process.pid), entrypoint: 'claude-desktop', name: 'fixture', status: 'idle' }));
  try {
    const replies = await session({ CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: configDir, CLAUDE_PLUGIN_ROOT: pluginRoot }, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'startup-test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'caller_status', arguments: {} } },
    ]);
    const status = JSON.parse(((replies.find(reply => reply.id === 3)?.result as { content: { text: string }[] }).content[0]!).text);
    expect(status.caller).toMatchObject({ provider: 'claude', sessionId, pid: process.pid, binding: { surface: 'claude-desktop' } });
    const tools = (replies.find(reply => reply.id === 2)?.result as { tools: { name: string }[] }).tools.map(tool => tool.name);
    const created = files(root).map(path => path.slice(root.length + 1));
    expect(created.filter(path => /\.sqlite/.test(path))).toEqual([]);
    // With the shared runtime bundled, startup advertises presence privately (no database) for this exact caller.
    if (tools.includes('desktop_collaboration_discover')) {
      const presence = join(stateDir, 'desktop-presence', `claude-${sessionId}.json`);
      const deadline = Date.now() + 3000; while (!existsSync(presence) && Date.now() < deadline) await Bun.sleep(20);
      expect(JSON.parse(readFileSync(presence, 'utf8'))).toMatchObject({ provider: 'claude', sessionId, pid: process.pid });
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
}, 30000);
