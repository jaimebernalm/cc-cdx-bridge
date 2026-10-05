import { version } from '../src/version';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { Database } from 'bun:sqlite';
import { Bridge } from '../src/bridge';
import { ProjectAuthorizations } from '../src/project-authorization';
import { PanelCommands } from '../src/panel-commands';

// Opt-in Codex CLI check. No real auth, trust decisions, model sessions or settings.
const repository = resolve(import.meta.dir, '../../..');
const output = join(repository, '.local', 'phase5', `installation-${randomUUID()}`);
const codexHome = join(output, 'codex home');
const marketplacePath=join(output,'marketplace with spaces');
mkdirSync(codexHome, { recursive: true, mode: 0o700 });
mkdirSync(marketplacePath,{mode:0o700});
const checks: Record<string, unknown>[] = [];
const report: Record<string, unknown> = { schemaVersion: 2, outcome: 'running', isolatedCodexHome: true,
  claudeSettingsModified: false, modelMessagesSent: false, hooksTrusted: false, checks };
const save = () => writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
save();
async function cli(args: string[]) {
  const child = Bun.spawn(['codex', ...args], { env: { ...process.env, CODEX_HOME: codexHome }, stdout: 'pipe', stderr: 'pipe' });
  const [code, text, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`codex ${args.slice(0, 3).join(' ')} failed: ${error.trim()}`);
  return JSON.parse(text);
}
try {
  // Immutable merged phase-4 distribution. This is a real old package, not a
  // fabricated version number over new bundles. Requires its local Git object.
  const archive=Bun.spawn(['git','-C',repository,'archive','--format=tar','2341cb6bb5455d26f0f515ddacd5ad3c0d5a57e6'],{stdout:'pipe',stderr:'pipe'});
  const tar=Bun.spawn(['tar','-xf','-','-C',marketplacePath],{stdin:archive.stdout,stdout:'pipe',stderr:'pipe'});
  const [archiveCode,tarCode,archiveError,tarError]=await Promise.all([archive.exited,tar.exited,new Response(archive.stderr).text(),new Response(tar.stderr).text()]);
  if(archiveCode||tarCode)throw new Error(`Previous distribution archive failed: ${archiveError} ${tarError}`);
  const registered = await cli(['plugin', 'marketplace', 'add', marketplacePath, '--json']);
  if (registered.marketplaceName !== 'jaimebernalm') throw new Error('Unexpected marketplace identity');
  checks.push({ check: 'marketplace_with_spaces', passed: true });
  const old=await cli(['plugin','add','claude-uds-bridge@jaimebernalm','--json']);
  if(old.version!=='0.6.1')throw new Error('Previous distribution was not installed');
  checks.push({check:'previous_distribution_installation',passed:true,version:old.version});
  const state=join(codexHome,'plugin-state','claude-uds-bridge'),thread=randomUUID();
  const transport=new Bridge(thread,join(output,'isolated claude'),state,join(codexHome,'ipc/ipc.sock'));
  await transport.close();
  const transportDb=new Database(join(state,thread+'.sqlite'));
  transportDb.run("UPDATE inbound_policy SET policy='refuse'");
  transportDb.run("INSERT INTO messages(id,peer_id,direction,text,status) VALUES (?,?, 'in',?, 'consumed')",[randomUUID(),randomUUID(),'PRIVATE HISTORY SENTINEL']);transportDb.close();
  const authorizations=new ProjectAuthorizations(state);authorizations.change({project:marketplacePath,ownerThread:thread,actionId:randomUUID(),enabled:true,expectedRevision:0,confirmed:true});authorizations.close();
  const queue=new PanelCommands(state),commandId=randomUUID();queue.enqueue({commandId,ownerThread:thread,project:marketplacePath,command:{action:'create',peerId:randomUUID(),context:{objective:'PRIVATE QUEUED SENTINEL',constraints:[],references:[],priorAnalysis:{}},limits:{maxMessages:4,maxSeconds:300},routine:{mode:'free',starts:{codex:'new',claude:'new'}},coordination:{initialBarrier:false,leaseSeconds:300},revisionPolicy:'same',allowBusyPeer:false}});queue.close();
  const stateFiles=readdirSync(state).filter(f=>f.endsWith('.sqlite'));
  const stateHashes=Object.fromEntries(stateFiles.map(f=>[f,digest(join(state,f))]));
  const retained=()=>{for(const [file,hash] of Object.entries(stateHashes))if(digest(join(state,file))!==hash)throw new Error('Private state changed during package lifecycle');};
  const target=join(marketplacePath,'plugins/claude-uds-bridge');rmSync(target,{recursive:true});
  cpSync(join(repository,'plugins/claude-uds-bridge'),target,{recursive:true,filter:path=>!['node_modules','.local'].includes(basename(path))});
  const installed = await cli(['plugin', 'add', 'claude-uds-bridge@jaimebernalm', '--json']);
  if (installed.version !== version || installed.pluginId !== 'claude-uds-bridge@jaimebernalm') throw new Error('Unexpected updated plugin');
  retained();checks.push({check:'update_preserves_private_state',passed:true,from:old.version,version:installed.version});
  const listing = await cli(['plugin', 'list', '--marketplace', 'jaimebernalm', '--json']);
  if (!listing.installed?.some((item: { pluginId: string; enabled: boolean }) => item.pluginId === installed.pluginId && item.enabled)) throw new Error('Installed plugin not enabled');
  for (const file of ['dist/server.js', 'dist/hook.js', 'dist/cli.js', 'scripts/run-bun.sh', '.mcp.json', 'hooks/hooks.json', '.codex-plugin/plugin.json', 'skills/bridge-collaboration/SKILL.md', 'skills/bridge-collaboration/references/api.md', 'skills/bridge-collaboration/references/structured.md', 'skills/bridge-collaboration/references/panel.md', 'panel-dist/index.html', ...readdirSync(join(target,'panel-dist/assets')).map(f=>'panel-dist/assets/'+f)]) {
    if (digest(join(installed.installedPath, file)) !== digest(join(target, file))) throw new Error(`Cached file differs: ${file}`);
  }
  checks.push({ check: 'installed_files_match_checkout', passed: true });
  const launcher = Bun.spawn(['/bin/sh', join(installed.installedPath, 'scripts/run-bun.sh'), join(installed.installedPath, 'dist/cli.js'), '--help'],
    { env: { ...process.env, PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' });
  const [code, text, error] = await Promise.all([launcher.exited, new Response(launcher.stdout).text(), new Response(launcher.stderr).text()]);
  if (code !== 0 || !text.includes('doctor|attach')) throw new Error(`Installed launcher failed with reduced PATH: ${error}`);
  checks.push({ check: 'installed_launcher_reduced_path', passed: true });
  await cli(['plugin','remove','claude-uds-bridge@jaimebernalm','--json']);retained();
  if(existsSync(installed.installedPath))throw new Error('Uninstall retained the installed cache');
  checks.push({check:'uninstall_removes_cache_preserves_private_state',passed:true});
  const again=await cli(['plugin','add','claude-uds-bridge@jaimebernalm','--json']);retained();
  if(again.version!==version)throw new Error('Reinstalled version mismatch');
  const restored=new ProjectAuthorizations(state);if(!restored.status(marketplacePath).enabled)throw new Error('Authorization not retained');restored.close();
  const restoredQueue=new PanelCommands(state);if(restoredQueue.get(commandId)?.state!=='queued')throw new Error('Command not retained');restoredQueue.close();
  const restoredTransport=new Database(join(state,thread+'.sqlite'),{readonly:true});
  if(restoredTransport.query<{policy:string},[]>('SELECT policy FROM inbound_policy').get()?.policy!=='refuse'||restoredTransport.query<{text:string},[]>('SELECT text FROM messages').get()?.text!=='PRIVATE HISTORY SENTINEL')throw new Error('History or explicit policy not retained');restoredTransport.close();
  checks.push({check:'reinstall_restores_history_command_and_authorization',passed:true});
  report.outcome = 'passed';
} catch (error) { report.outcome = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally { report.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify({ ...report, reportFile: join(output, 'result.json') }, null, 2)); }
