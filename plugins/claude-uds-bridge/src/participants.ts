import { Database } from 'bun:sqlite';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { findPeer, ownedJson, peers, processStart, uuid, type Peer } from './claude';
import { readDesktopInfo } from './desktop';
import { claudeVersionSupported } from './doctor';
import { inspectProject, type ProjectIdentity } from './project';

export type Participant = {
  sessionId: string; name: string; provider: 'codex' | 'claude'; surface: string; pid: number;
  implementationReceiver?: boolean | null; procStart: string; socketPath: string; version: string | null; status: string; project: ProjectIdentity;
};
export type ParticipantOptions = { configDir: string; stateDir: string; ipcPath: string };

export async function verifiedPeer(configDir: string, id: string) {
  uuid.parse(id); const peer = findPeer(configDir, id);
  if (!peer.procStart || await processStart(peer.pid) !== peer.procStart) throw new Error('Participant process identity is stale or unknown');
  return peer;
}

function managedReceiver(stateDir: string | undefined, peer: Peer, capability='managed_runs_v1') {
  if (!stateDir) return null;
  let db: Database | undefined;
  try {
    db=new Database(join(stateDir,`${peer.sessionId}.sqlite`),{readonly:true});
    return !!db.query("SELECT 1 FROM receiver_capabilities c JOIN receiver r ON r.pid=c.pid AND r.proc_start=c.proc_start WHERE c.capability=? AND c.pid=? AND c.proc_start=?").get(capability,peer.pid,peer.procStart??null);
  } catch { return false; } finally {db?.close();}
}

export async function discoverParticipants(configDir: string, stateDir?: string) {
  const result = [];
  for (const peer of peers(configDir)) {
    try {
      if (!peer.procStart || await processStart(peer.pid) !== peer.procStart) continue;
      let version: unknown;
      try { version = (ownedJson(join(configDir, 'sessions', `${peer.pid}.json`), 262144) as Record<string, unknown>).version; } catch { /* Unknown engine. */ }
      result.push({ sessionId: peer.sessionId, name: peer.name, cwd: realpathSync(peer.cwd), status: peer.status,
        pid: peer.pid, procStart: peer.procStart, startedAt: peer.startedAt ?? null,
        provider: peer.entrypoint === 'codex-claude-uds-bridge' ? 'codex' : 'claude', surface: peer.entrypoint ?? 'unknown',
        version: typeof version === 'string' ? version : null,
        managedReceiver:peer.entrypoint==='codex-claude-uds-bridge'?managedReceiver(stateDir,peer):null,
        guidedReceiver:peer.entrypoint==='codex-claude-uds-bridge'?managedReceiver(stateDir,peer,'guided_runs_v1'):null,
        structuredReceiver:peer.entrypoint==='codex-claude-uds-bridge'?managedReceiver(stateDir,peer,'structured_runs_v1'):null,
        projectAuthorizationReceiver:peer.entrypoint==='codex-claude-uds-bridge'?managedReceiver(stateDir,peer,'project_authorization_v1'):null,
        implementationReceiver:peer.entrypoint==='codex-claude-uds-bridge'?managedReceiver(stateDir,peer,'implementation_v1'):null,
        panelReceiver:peer.entrypoint==='codex-claude-uds-bridge'?managedReceiver(stateDir,peer,'panel_commands_v1'):null,
        eligibleSurface: peer.entrypoint === 'codex-claude-uds-bridge' || peer.entrypoint === 'claude-desktop' && claudeVersionSupported(version) });
    } catch { /* Stale or ambiguous metadata is not selectable. */ }
  }
  return result.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

export async function inspectParticipant(options: ParticipantOptions, id: string, provider: 'codex' | 'claude', guided=false, structured=false): Promise<Participant> {
  const peer = await verifiedPeer(options.configDir, id);
  let version: string | null = null;
  if (provider === 'claude') {
    if (peer.entrypoint !== 'claude-desktop') throw new Error('Select a Claude Desktop Code conversation; terminal and VS Code are not substituted');
    const record = ownedJson(join(options.configDir, 'sessions', `${peer.pid}.json`), 262144) as Record<string, unknown>;
    version = typeof record.version === 'string' ? record.version : null;
    if (!claudeVersionSupported(version)) throw new Error('Selected Claude Desktop engine is unsupported or unknown');
  } else {
    if (peer.entrypoint !== 'codex-claude-uds-bridge') throw new Error('Selected Codex conversation has no bridge receiver');
    if (!managedReceiver(options.stateDir,peer)) throw new Error('Codex receiver predates managed collaborations; reload the plugin receiver before preparing a run');
    if(guided && !managedReceiver(options.stateDir,peer,'guided_runs_v1'))throw new Error('Codex receiver predates guided routines; reload the phase-2 receiver');
    if(structured && !managedReceiver(options.stateDir,peer,'structured_runs_v1'))throw new Error('Codex receiver predates structured coordination; reload the phase-3 receiver');
    const native = await readDesktopInfo(options.ipcPath, id);
    if (realpathSync(native.project) !== realpathSync(peer.cwd)) throw new Error('Native Codex project disagrees with receiver registry');
    const db = new Database(join(options.stateDir, `${id}.sqlite`), { readonly: true });
    try {
      const owner = db.query<{ pid: number; proc_start: string }, []>('SELECT pid,proc_start FROM receiver WHERE singleton=1').get();
      if (owner?.pid !== peer.pid || owner.proc_start !== peer.procStart) throw new Error('Codex receiver ownership cannot be reconciled');
    } finally { db.close(); }
    version = 'stream-11';
  }
  return { sessionId: id, name: peer.name, provider, surface: peer.entrypoint!, pid: peer.pid,
    procStart: peer.procStart!, socketPath: peer.messagingSocketPath, version, status: peer.status,
    implementationReceiver:provider==='codex'?managedReceiver(options.stateDir,peer,'implementation_v1'):null,
    project: await inspectProject(peer.cwd) };
}

export function matchesProcess(participant: Participant, peer: Peer) {
  return participant.sessionId === peer.sessionId && participant.pid === peer.pid && participant.procStart === peer.procStart
    && participant.socketPath === peer.messagingSocketPath && participant.surface === peer.entrypoint
    && participant.project.directory === realpathSync(peer.cwd);
}

export function sameSnapshot(first: Participant, second: Participant) {
  return first.sessionId === second.sessionId && first.pid === second.pid && first.procStart === second.procStart
    && first.socketPath === second.socketPath && first.surface === second.surface && first.version === second.version
    && JSON.stringify(first.project) === JSON.stringify(second.project);
}

// Human-readable reason for a pinned-snapshot mismatch, so the panel can say what changed and what to do.
export function snapshotChange(a:Participant,b:Participant){
 const who=a.provider==='codex'?'Codex':'Claude';
 if(a.pid!==b.pid||a.procStart!==b.procStart||a.socketPath!==b.socketPath||a.surface!==b.surface||a.version!==b.version)return `The ${who} chat was restarted or reloaded since this collaboration was prepared`;
 if(a.project.directory!==b.project.directory||a.project.worktree!==b.project.worktree||a.project.commonGitDir!==b.project.commonGitDir)return `The ${who} chat now uses a different folder`;
 if(a.project.branch!==b.project.branch)return `The branch changed (${a.project.branch??'none'} → ${b.project.branch??'none'}) since this collaboration was prepared`;
 if(a.project.head!==b.project.head)return 'A new commit was made since this collaboration was prepared';
 return 'Project files changed (uncommitted edits) since this collaboration was prepared';
}

// The exact chat process and the repository it has open; never re-pinned.
export function sameIdentity(a:Participant,b:Participant){
 return a.sessionId===b.sessionId&&a.provider===b.provider&&a.pid===b.pid&&a.procStart===b.procStart&&a.socketPath===b.socketPath&&a.surface===b.surface&&a.version===b.version
  &&a.project.kind===b.project.kind&&a.project.directory===b.project.directory&&a.project.worktree===b.project.worktree&&a.project.commonGitDir===b.project.commonGitDir;
}

export type RevisionMove={provider:'codex'|'claude';directory:string;from:{branch:string|null;head:string|null};to:{branch:string|null;head:string|null};filesChanged:boolean};
// Commits, branch switches or edits in the folder a chat has open, whoever made them.
export function revisionMove(a:Participant,b:Participant):RevisionMove|null{
 const x=a.project,y=b.project;
 if(x.branch===y.branch&&x.head===y.head&&x.diffHash===y.diffHash&&x.statusHash===y.statusHash)return null;
 return {provider:a.provider,directory:x.directory,from:{branch:x.branch,head:x.head},to:{branch:y.branch,head:y.head},filesChanged:x.diffHash!==y.diffHash||x.statusHash!==y.statusHash};
}

export function revisionFrozen(a:Participant,plan:import('./implementation').ImplementationPlan|null){return !!plan?.workspaces.some(w=>w.root===a.project.worktree);}

// A write contract relaxes dirty fingerprints only for its registered workspaces.
export function sameScopedSnapshot(a:Participant,b:Participant,plan:import('./implementation').ImplementationPlan|null){
 if(!revisionFrozen(a,plan))return sameSnapshot(a,b);
 return sameIdentity(a,b)&&a.project.head===b.project.head;
}

// Desktop runs pin identity, not revision: the shared folder may be changed by chats outside the run,
// so its revision is re-pinned and announced (see revisionMove). A write contract still freezes its workspace HEAD.
export function sameDesktopParticipant(a:Participant,b:Participant,plan:import('./implementation').ImplementationPlan|null){
 return revisionFrozen(a,plan)?sameScopedSnapshot(a,b,plan):sameIdentity(a,b);
}
