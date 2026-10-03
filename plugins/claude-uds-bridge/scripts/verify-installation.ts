import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Opt-in real Codex CLI package check. The isolated home receives no auth files,
// model prompts, hook trust decisions or Claude settings changes.
const repository = resolve(import.meta.dir, '../../..');
const output = join(repository, '.local', 'phase0', `installation-${randomUUID()}`);
const codexHome = join(output, 'codex-home');
mkdirSync(codexHome, { recursive: true, mode: 0o700 });
const checks: Record<string, unknown>[] = [];
const report: Record<string, unknown> = { schemaVersion: 1, outcome: 'running', isolatedCodexHome: true,
  claudeSettingsModified: false, modelMessagesSent: false, hooksTrusted: false, checks };
const save = () => writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
save();
async function cli(args: string[]) {
  const child = Bun.spawn(['codex', ...args], { env: { ...process.env, CODEX_HOME: codexHome }, stdout: 'pipe', stderr: 'pipe' });
  const [code, text, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`codex ${args.slice(0, 3).join(' ')} failed: ${error.trim()}`);
  return JSON.parse(text);
}
try {
  const marketplace = await cli(['plugin', 'marketplace', 'add', repository, '--json']);
  if (marketplace.marketplaceName !== 'jaimebernalm') throw new Error('Unexpected marketplace identity');
  checks.push({ check: 'marketplace', passed: true });
  const installed = await cli(['plugin', 'add', 'claude-uds-bridge@jaimebernalm', '--json']);
  if (installed.version !== '0.4.0' || installed.pluginId !== 'claude-uds-bridge@jaimebernalm') throw new Error('Unexpected installed plugin');
  const listing = await cli(['plugin', 'list', '--marketplace', 'jaimebernalm', '--json']);
  if (!listing.installed?.some((item: { pluginId: string; enabled: boolean }) => item.pluginId === installed.pluginId && item.enabled)) throw new Error('Installed plugin not enabled');
  checks.push({ check: 'installation', passed: true, version: installed.version });
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  for (const file of ['dist/server.js', 'dist/hook.js', 'dist/cli.js', 'scripts/run-bun.sh', '.mcp.json', 'hooks/hooks.json', '.codex-plugin/plugin.json', 'skills/bridge-collaboration/SKILL.md', 'skills/bridge-collaboration/references/api.md']) {
    if (digest(join(installed.installedPath, file)) !== digest(join(repository, 'plugins', 'claude-uds-bridge', file))) throw new Error(`Cached file differs: ${file}`);
  }
  checks.push({ check: 'installed_files_match_checkout', passed: true });
  const launcher = Bun.spawn(['/bin/sh', join(installed.installedPath, 'scripts/run-bun.sh'), join(installed.installedPath, 'dist/cli.js'), '--help'],
    { env: { ...process.env, PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' });
  const [code, text, error] = await Promise.all([launcher.exited, new Response(launcher.stdout).text(), new Response(launcher.stderr).text()]);
  if (code !== 0 || !text.includes('doctor|attach')) throw new Error(`Installed launcher failed with reduced PATH: ${error}`);
  checks.push({ check: 'installed_launcher_reduced_path', passed: true });
  report.outcome = 'passed';
} catch (error) { report.outcome = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally { report.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify({ ...report, reportFile: join(output, 'result.json') }, null, 2)); }
