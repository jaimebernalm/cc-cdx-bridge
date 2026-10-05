import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { analyze } from '../scripts/claude-identity-spike';

const plugin = join(import.meta.dir, '..'), claudeRoot = join(plugin, '../cc-cdx-bridge-claude');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

test('the Claude plugin root is self-contained and separate from the Codex plugin', () => {
  const manifest = z.object({ name: z.string(), version: z.string() }).loose().parse(read(join(claudeRoot, '.claude-plugin/plugin.json')));
  expect(manifest.version).toBe(read(join(plugin, 'package.json')).version);
  // Claude rejects names starting with "claude-" and merges default hooks/.mcp.json, so the
  // Codex plugin directory must not carry a Claude manifest.
  expect(manifest.name.startsWith('claude-')).toBe(false);
  expect(existsSync(join(plugin, '.claude-plugin'))).toBe(false);
  const marketplace = read(join(claudeRoot, '.claude-plugin/marketplace.json'));
  expect(marketplace.plugins.map((entry: { name: string }) => entry.name)).toEqual([manifest.name]);
  expect(readFileSync(join(claudeRoot, 'scripts/run-bun.sh'), 'utf8')).toBe(readFileSync(join(plugin, 'scripts/run-bun.sh'), 'utf8'));
});

test('every Claude plugin command points at bundled files inside the plugin root', () => {
  const mcp = read(join(claudeRoot, '.mcp.json')), hooks = JSON.stringify(read(join(claudeRoot, 'hooks/hooks.json')));
  const references = [...JSON.stringify(mcp).matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\\]+)/g), ...hooks.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\\]+)/g)].map(match => match[1]!);
  expect(references).toContain('dist/claude-server.js');
  expect(references).toContain('dist/claude-hook.js');
  for (const path of references) expect(existsSync(join(claudeRoot, path))).toBe(true);
  // Startup registration must be a command hook: mcp_tool hooks are skipped before MCP connects.
  expect(hooks).not.toContain('mcp_tool');
  expect(hooks).toContain('SessionStart');
  expect(hooks).toContain('SessionEnd');
  expect(hooks).toContain('UserPromptSubmit');
  // Production state is the bridge's shared directory. Desktop gives new chats and reloaded chats
  // different CLAUDE_PLUGIN_DATA directories (measured in S0), so the plugin must not depend on it.
  expect(JSON.stringify(mcp)).not.toContain('CLAUDE_PLUGIN_DATA');
  expect(JSON.stringify(mcp)).not.toContain('CC_CDX_STATE_DIR');
  expect(hooks).not.toContain('CLAUDE_PLUGIN_DATA');
  expect(hooks).not.toContain('CC_CDX_STATE_DIR');
});

test('server and hook default to the shared bridge state; CC_CDX_STATE_DIR is an explicit opt-in override', async () => {
  const { claudePaths } = await import('../src/claude-server'), { hookPaths } = await import('../src/claude-hook');
  for (const paths of [claudePaths, hookPaths]) {
    expect(paths({ HOME: '/h', CODEX_HOME: '/c' }).stateDir).toBe('/c/plugin-state/claude-uds-bridge');
    expect(paths({ CODEX_HOME: '/c', CLAUDE_PLUGIN_DATA: '/d' }).stateDir).toBe('/c/plugin-state/claude-uds-bridge');
    expect(paths({ CODEX_HOME: '/c', CC_CDX_STATE_DIR: '/s' }).stateDir).toBe('/s');
  }
});

test('the spike report passes only when two engines were told apart', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccdx-spike-')), spike = join(root, 'claude-spike');
  try {
    mkdirSync(spike, { recursive: true });
    const status = (at: number, sessionId: string, pid: number, hostLaunch = { pluginRootEnv: true, launcherOnly: true }) => ({ at, event: 'caller_status', ancestors: [{ pid, registered: true, command: 'claude' }],
      hostLaunch, metaKeys: ['progressToken'], caller: { sessionId, pid, binding: { method: 'claude_process_ancestry+hook', generation: 'g' } } });
    writeFileSync(join(spike, 'observations.jsonl'), [{ at: 1, event: 'server_start', serverPid: 10, parentPid: 100 }, status(3, 'a'.repeat(8), 100)].map(e => JSON.stringify(e)).join('\n'));
    writeFileSync(join(spike, 'hook-observations.jsonl'), JSON.stringify({ at: 2, event: 'SessionStart', source: 'startup', sessionId: 'a'.repeat(8), enginePid: 100, registryMatches: true }));
    expect(analyze(root).gate).toBe('not_met');
    writeFileSync(join(spike, 'observations.jsonl'), [status(3, 'a'.repeat(8), 100), status(4, 'b'.repeat(8), 200)].map(e => JSON.stringify(e)).join('\n'));
    const report = analyze(root);
    expect(report).toMatchObject({ gate: 'pass', distinctSessions: 2, distinctEngines: 2, ancestorDepths: [0], metaKeys: ['progressToken'] });
    expect(report.timeline[0]).toContain('hook SessionStart(startup)');
    // A copy started from a chat's shell (no plugin env, or a zsh in between) proves nothing.
    writeFileSync(join(spike, 'observations.jsonl'), [status(3, 'a'.repeat(8), 100), status(4, 'b'.repeat(8), 200, { pluginRootEnv: false, launcherOnly: true }),
      status(5, 'c'.repeat(8), 300, { pluginRootEnv: true, launcherOnly: false })].map(e => JSON.stringify(e)).join('\n'));
    expect(analyze(root)).toMatchObject({ gate: 'not_met', distinctSessions: 1, ignoredNotHostLaunched: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
