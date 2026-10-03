import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { ownedJson, peers, processStart, uuid } from './claude';
import { readDesktopInfo } from './desktop';
import { observeClaudeSettings, evaluateInbound, type InboundPolicy } from './permissions';

export type DoctorOptions = { project: string; threadId?: string; peerId?: string; configDir: string; codexHome: string; pluginRoot: string };
type Check = { code: string; level: 'ok' | 'warning' | 'blocked'; message: string; remedy?: string };

export function claudeVersionSupported(version: unknown) {
  if (typeof version !== 'string') return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major! > 2 || major === 2 && (minor! > 1 || minor === 1 && patch! >= 224);
}

export async function doctor(options: DoctorOptions) {
  const checks: Check[] = [];
  const add = (code: string, level: Check['level'], message: string, remedy?: string) => checks.push({ code, level, message, ...(remedy ? { remedy } : {}) });
  let project: string;
  try { project = realpathSync(options.project); }
  catch { return { schemaVersion: 1, state: 'needs_selection', checks: [{ code: 'project_missing', level: 'blocked', message: 'Project directory is unavailable.', remedy: 'Select an existing local project directory.' }] }; }
  add('runtime', 'ok', `Bun ${Bun.version} at ${process.execPath}; tested runtime: 1.4.2.`);
  if (!['darwin', 'linux'].includes(process.platform)) add('platform', 'blocked', 'This fork requires POSIX Unix sockets.', 'Use macOS or Linux; Windows transport is not implemented.');
  try {
    const manifest = ownedJson(join(options.pluginRoot, '.codex-plugin', 'plugin.json'), 65536) as { name: string; version: string };
    if (manifest.name !== 'claude-uds-bridge' || manifest.version !== '0.4.0') throw new Error('Manifest mismatch');
    for (const file of ['dist/server.js', 'dist/hook.js', 'dist/cli.js', 'scripts/run-bun.sh', 'skills/bridge-collaboration/SKILL.md', 'skills/bridge-collaboration/references/api.md']) {
      if (!existsSync(join(options.pluginRoot, file))) throw new Error(`Missing ${file}`);
    }
    add('distribution', 'ok', `cc-cdx-bridge ${manifest.version}; marketplace jaimebernalm; transport identity retained.`);
  } catch { add('distribution_incomplete', 'blocked', 'The fork distribution is incomplete or has inconsistent identity.', 'Run bun run build in the plugin folder and reinstall this checkout.'); }

  let candidates: ReturnType<typeof peers> = [];
  try {
    for (const peer of peers(options.configDir)) {
      try {
        if (!peer.procStart || await processStart(peer.pid) !== peer.procStart) continue;
        if (realpathSync(peer.cwd) === project) candidates.push(peer);
      } catch { /* Stale processes and unavailable paths are not selectable. */ }
    }
  } catch { add('registry_unreadable', 'blocked', 'Claude session registry cannot be read.', 'Check CLAUDE_CONFIG_DIR and its ownership; no permissions are changed by doctor.'); }
  const surfaces = candidates.filter(peer => peer.entrypoint !== 'codex-claude-uds-bridge').map(peer => {
    let version: unknown;
    try { version = (ownedJson(join(options.configDir, 'sessions', `${peer.pid}.json`), 262144) as Record<string, unknown>).version; } catch { /* Report unknown version. */ }
    return { sessionId: peer.sessionId, name: peer.name, surface: peer.entrypoint ?? 'unknown', status: peer.status,
      version: typeof version === 'string' ? version : null, messagingVersionSupported: claudeVersionSupported(version) };
  });
  const eligible = surfaces.filter(peer => peer.surface === 'claude-desktop' && (!options.peerId || peer.sessionId === options.peerId));
  if (eligible.length !== 1) add('needs_selection', 'blocked', eligible.length ? 'Multiple Claude Desktop chats match this project.' : 'No selected Claude Desktop Code chat matches this project.',
    eligible.length ? 'Choose one exact --peer UUID from surfaces.' : 'Open a local Code chat in Claude Desktop for this folder and send its first prompt. CLI and VS Code chats are listed but are not substituted.');
  else if (!eligible[0]!.messagingVersionSupported) add('unsupported_version', 'blocked', 'Selected Claude Desktop engine version is missing or below 2.1.224.', 'Check the engine in the Desktop chat; updating the independent CLI does not update that engine.');
  else add('claude_engine', 'ok', `Selected Claude Desktop engine ${eligible[0]!.version}; peer protocol 1 observed.`);

  let native: Awaited<ReturnType<typeof readDesktopInfo>> | undefined;
  if (!options.threadId || !uuid.safeParse(options.threadId).success) add('needs_selection', 'blocked', 'No valid Codex chat identity was supplied.', 'Run from the Desktop chat (CODEX_THREAD_ID), use --thread UUID, or invoke the MCP doctor tool.');
  else {
    try {
      native = await readDesktopInfo(join(options.codexHome, 'ipc', 'ipc.sock'), options.threadId);
      if (realpathSync(native.project) !== project) add('project_mismatch', 'blocked', 'Codex chat uses a different project.', 'Select the Codex chat whose native project matches this exact directory.');
      else add('desktop_contract', 'ok', 'Native Codex owner supports external input; stream version 11 and project verified.');
      if (native.runtime.mode === 'unknown') add('policy_unknown', 'warning', 'Codex permission class is unknown.', 'Inspect the existing chat settings; do not infer a class from CLI defaults.');
    } catch (error) {
      const unsupported = error instanceof Error && /Unsupported Desktop stream version/.test(error.message);
      add(unsupported ? 'unsupported_version' : 'desktop_unavailable', 'blocked', unsupported ? 'The native Codex stream contract is unsupported.' : 'The native Codex chat could not be inspected.',
        unsupported ? 'Use a tested app contract; do not guess another schema.' : 'Keep the local Desktop chat open and check CODEX_HOME, IPC socket ownership and owner availability.');
    }
  }
  const receivers = candidates.filter(peer => peer.sessionId === options.threadId);
  let receiverPolicy: InboundPolicy = 'unknown';
  if (receivers.length === 0) add('needs_receiver', 'blocked', 'This Codex chat has no active bridge receiver.', 'Use attach_current after loading this plugin, or CLI attach for a supervised local activation. Installing the plugin alone does not load tools in an existing chat.');
  else if (receivers.length !== 1 || receivers[0]!.entrypoint !== 'codex-claude-uds-bridge') add('receiver_conflict', 'blocked', 'Conflicting receiver registrations.', 'Stop duplicate registrations and diagnose their ownership before retrying.');
  else {
    let db: Database | undefined;
    try {
      db = new Database(join(options.codexHome, 'plugin-state', 'claude-uds-bridge', `${options.threadId}.sqlite`), { readonly: true });
      const owner = db.query<{ pid: number; proc_start: string }, []>('SELECT pid,proc_start FROM receiver WHERE singleton=1').get();
      if (owner?.pid !== receivers[0]!.pid || owner.proc_start !== receivers[0]!.procStart) throw new Error('Receiver state does not match registry');
      const policy = db.query<{ policy: string }, []>('SELECT policy FROM inbound_policy WHERE singleton=1').get()?.policy;
      receiverPolicy = ['default', 'accept', 'hold', 'refuse'].includes(policy ?? '') ? policy as InboundPolicy : 'unknown';
      add('receiver', 'ok', 'One live receiver matches registry and persisted owner identity.');
    } catch { add('receiver_state_unknown', 'blocked', 'Receiver registry and persisted state could not be reconciled.', 'Check receiver ownership and state before activating or sending; doctor does not repair it.'); }
    finally { db?.close(); }
  }
  if (options.threadId && existsSync(join(options.codexHome, 'plugin-state', 'claude-uds-bridge', `${options.threadId}.activation-lock`))) {
    add('activation_lock', 'warning', 'An activation lock exists.', 'Wait for activation to finish. If its owner has stopped, inspect and remove the stale lock before retrying.');
  }
  const settings = observeClaudeSettings(options.configDir, project);
  if (settings.some(item => !item.readable || item.inbound === 'invalid')) add('settings_unreadable', 'warning', 'One or more relevant settings observations are unavailable or invalid.', 'Review the indicated scope locally; doctor never outputs the complete configuration.');
  add('policy_unknown', 'warning', 'Claude Desktop does not expose effective inbound policy, permission class or managed/session overrides in its registry.',
    'Use sessions whose reception is already allowed and an explicitly requested round-trip check. User-level accept affects all Claude sessions; project accept cannot loosen reception. No settings change or message is performed by doctor.');
  add('hook_trust_unknown', 'warning', 'Installation and hook trust cannot be established from receiver presence.', 'Review the installed fork in Codex Plugins, trust its hooks, and validate a new or resumed chat separately.');
  const blocker = checks.find(check => check.level === 'blocked');
  return { schemaVersion: 1, state: blocker?.code ?? 'policy_unknown', mode: 'supervised_pilot',
    settingsModified: false, messagesSent: false, checks, surfaces,
    selectedClaude: eligible.length === 1 ? eligible[0] : null,
    codex: native ? { ...native, receiverPolicy, inboundFromClaude: evaluateInbound(receiverPolicy, native.runtime.mode, 'unknown') } : null,
    claudeSettingsObservations: settings, effectiveClaudeInbound: 'unknown', hookTrust: 'not_observable' };
}
