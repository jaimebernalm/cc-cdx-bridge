// Reads the S0 measurement logs written by the Claude plugin (server_start, caller_status and hook
// events) and reports whether two Desktop conversations were told apart from process evidence.
// Read-only: it never writes state, settings or registry files.
// Usage: bun scripts/claude-identity-spike.ts [stateDir]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Entry = Record<string, unknown> & { at: number; event: string };

export function findStateDirs(configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')) {
  const data = join(configDir, 'plugins', 'data');
  if (!existsSync(data)) return [];
  return readdirSync(data).map(name => join(data, name, 'state')).filter(path => existsSync(join(path, 'claude-spike')));
}

function lines(path: string): Entry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as Entry]; } catch { return []; } });
}

export function analyze(stateDir: string) {
  const server = lines(join(stateDir, 'claude-spike', 'observations.jsonl'));
  const hooks = lines(join(stateDir, 'claude-spike', 'hook-observations.jsonl'));
  // Only servers the host launched count: a copy run from the chat's shell would also descend from the
  // engine and prove nothing about plugin MCP placement.
  const all = server.filter(entry => entry.event === 'caller_status');
  const hostLaunched = (entry: Entry) => { const launch = entry.hostLaunch as { pluginRootEnv?: boolean; launcherOnly?: boolean } | undefined; return launch?.pluginRootEnv === true && launch.launcherOnly === true; };
  const statuses = all.filter(entry => hostLaunched(entry) || entry.rejection);
  const bound = statuses.flatMap(entry => entry.caller ? [entry.caller as { sessionId: string; pid: number; binding: { method: string; generation: string } }] : []);
  const rejections = statuses.flatMap(entry => entry.rejection ? [entry.rejection as { code: string }] : []);
  const sessions = [...new Set(bound.map(caller => caller.sessionId))];
  const engines = [...new Set(bound.map(caller => caller.pid))];
  // Did the host launch the MCP server directly under the engine, or through intermediaries?
  const depth = statuses.map(entry => (entry.ancestors as { registered: boolean }[] | undefined)?.findIndex(step => step.registered) ?? -1);
  const metaKeys = [...new Set(statuses.flatMap(entry => (entry.metaKeys as string[] | undefined) ?? []))].sort();
  const timeline = [...server.filter(entry => entry.event === 'server_start').map(entry => ({ at: entry.at, what: `server_start pid=${entry.serverPid} parent=${entry.parentPid}` })),
    ...hooks.map(entry => ({ at: entry.at, what: `hook ${entry.event}${entry.source ? `(${entry.source})` : ''} session=${String(entry.sessionId).slice(0, 8)} engine=${entry.enginePid ?? entry.engine} registryMatches=${entry.registryMatches ?? '-'}` })),
    ...statuses.map(entry => ({ at: entry.at, what: `caller_status ${entry.caller ? `bound ${(entry.caller as { sessionId: string }).sessionId.slice(0, 8)} via ${(entry.caller as { binding: { method: string } }).binding.method}` : `rejected ${(entry.rejection as { code: string }).code}`}` }))]
    .sort((a, b) => a.at - b.at).map(entry => `${new Date(entry.at).toISOString()} ${entry.what}`);
  const gate = sessions.length >= 2 && engines.length >= 2 && rejections.every(rejection => rejection.code !== 'caller_unavailable');
  const firstPromptTurns = hooks.filter(entry => entry.event === 'UserPromptSubmit' && typeof entry.priorUserTurns === 'number').map(entry => entry.priorUserTurns as number);
  return { stateDir, gate: gate ? 'pass' : 'not_met', distinctSessions: sessions.length, distinctEngines: engines.length,
    ignoredNotHostLaunched: all.length - statuses.length, priorUserTurnsSeen: [...new Set(firstPromptTurns)].sort(),
    ancestorDepths: [...new Set(depth)], rejections: rejections.map(rejection => rejection.code), metaKeys,
    hookEvents: [...new Set(hooks.map(entry => `${entry.event}${entry.source ? `(${entry.source})` : ''}`))], timeline };
}

if (import.meta.main) {
  const dirs = process.argv[2] ? [process.argv[2]] : findStateDirs();
  if (!dirs.length) { console.error('No spike state found. Install the test plugin and call caller_status from two Desktop conversations first.'); process.exit(2); }
  for (const dir of dirs) console.log(JSON.stringify(analyze(dir), null, 2));
}
