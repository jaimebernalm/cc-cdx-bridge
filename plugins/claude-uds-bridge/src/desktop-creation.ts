// Carries out an already authorized creation ticket. Only the requester or an executor that a panel
// session delegated (pinned to principal, process and project) may run it, and only once. The plan
// returned is a set of instructions for an official host capability or for assisted UI; this module
// performs no creation itself, opens no CLI and uses no private IPC to create chats. Outcomes are
// fenced by the ticket epoch; a host reference is only a pointer and an uncertain outcome is final.
// "Authorized" here means a panel session or creation grant acted, not proof that a human was present.
import { realpathSync, statSync } from 'node:fs';
import { z } from 'zod';
import { uuid } from './claude';
import type { CreationTickets, PanelActor, Principal, Ticket } from './creation-tickets';

export type ExecutorCaller = { provider: 'codex' | 'claude'; sessionId: string; pid: number; procStart: string; project: string };
export type CreationPlan = {
  ticketId: string; epoch: number; adapter: 'manual' | 'assisted_ui' | 'native_tool_relay'; correlationId: string;
  bootstrapPrompt: string; steps: string[]; forbidden: string[]; report: string; evidence: 'panel_session_or_creation_grant';
};

const callerSchema = z.object({ provider: z.enum(['codex', 'claude']), sessionId: uuid, pid: z.number().int().positive(),
  procStart: z.string().min(1), project: z.string().min(1) }).strict();
const panelSchema = z.object({ kind: z.literal('panel_session'), id: z.string().min(16).max(128), scope: z.object({ project: z.string() }).strict().optional() }).strict();
const key = (p: Principal) => `${p.provider}:${p.sessionId}`;

function folder(path: string) {
  const project = realpathSync(path), stat = statSync(project, { bigint: true });
  return { project, device: String(stat.dev), inode: String(stat.ino) };
}

export function bootstrapPrompt(ticket: Ticket, correlationId: string) {
  return [`CCDX-CORR-${correlationId}`,
    `This conversation was opened for a CC–CDX Bridge collaboration requested by ${ticket.requester} in ${ticket.project}.`,
    'Do not start any work yet. Call desktop_collaboration_discover once so the bridge can bind this conversation, then wait until a collaboration is prepared and started for you.',
    'This message grants no permissions; your own execution and editing permissions still apply.'].join('\n');
}

export class DesktopCreation {
  constructor(private tickets: CreationTickets, private now = () => Date.now()) {
    tickets.db.exec(`CREATE TABLE IF NOT EXISTS creation_delegations(ticket_id TEXT PRIMARY KEY,executor TEXT NOT NULL,pid INTEGER NOT NULL,proc_start TEXT NOT NULL,
        project TEXT NOT NULL,device TEXT NOT NULL,inode TEXT NOT NULL,panel_session TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS creation_executions(ticket_id TEXT PRIMARY KEY,executor TEXT NOT NULL,pid INTEGER NOT NULL,proc_start TEXT NOT NULL,epoch INTEGER NOT NULL,began_at INTEGER NOT NULL);`);
  }

  /** Only a panel session can name another conversation as executor, e.g. a live Codex chat when Claude asked for a new Codex chat. */
  delegate(panel: PanelActor, ticketId: string, rawExecutor: ExecutorCaller) {
    const actor = panelSchema.parse(panel), executor = callerSchema.parse(rawExecutor);
    return this.tickets.db.transaction(() => {
      const ticket = this.tickets.get(ticketId), place = folder(executor.project), ticketPlace = this.tickets.identity(ticket.id);
      if (actor.scope && folder(actor.scope.project).project !== ticket.project) throw new Error('Panel session is scoped to another project');
      if (ticket.state !== 'authorized') throw new Error(`Cannot delegate a ${ticket.state} ticket`);
      if (place.project !== ticketPlace.project || place.device !== ticketPlace.device || place.inode !== ticketPlace.inode) throw new Error('Executor works in another project');
      this.compatible(ticket, executor);
      this.tickets.db.run(`INSERT INTO creation_delegations VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(ticket_id) DO UPDATE SET executor=excluded.executor,pid=excluded.pid,
        proc_start=excluded.proc_start,project=excluded.project,device=excluded.device,inode=excluded.inode,panel_session=excluded.panel_session,created_at=excluded.created_at`,
      [ticket.id, key(executor), executor.pid, executor.procStart, place.project, place.device, place.inode, `panel_session:${actor.id}`, this.now()]);
      this.tickets.db.run('INSERT INTO creation_events(ticket_id,type,actor,at,payload) VALUES (?,?,?,?,?)',
        [ticket.id, 'executor_delegated', `panel_session:${actor.id}`, this.now(), JSON.stringify({ executor: key(executor), pid: executor.pid })]);
      return { ticketId: ticket.id, executor: key(executor), pid: executor.pid, procStart: executor.procStart };
    }).immediate();
  }

  private compatible(ticket: Ticket, executor: ExecutorCaller) {
    if (ticket.adapter === 'native_tool_relay' && (ticket.targetProvider !== 'codex' || executor.provider !== 'codex')) {
      throw new Error('A native tool relay needs a live Codex conversation creating a Codex conversation');
    }
    if (ticket.adapter === 'assisted_ui' && ticket.targetProvider !== 'claude') throw new Error('Assisted UI creation is only planned for Claude Desktop');
  }

  // The caller comes from the runtime's authentication, never from tool arguments.
  private authorizedExecutor(ticket: Ticket, rawCaller: ExecutorCaller) {
    const caller = callerSchema.parse(rawCaller);
    // Compared with the identity pinned at request time, not whatever folder now has that path.
    const place = folder(caller.project), ticketPlace = this.tickets.identity(ticket.id);
    if (place.project !== ticketPlace.project || place.device !== ticketPlace.device || place.inode !== ticketPlace.inode) throw new Error('Caller works in another project');
    if (ticket.requester === key(caller)) return caller;
    const delegation = this.tickets.db.query<{ executor: string; pid: number; proc_start: string }, [string]>('SELECT * FROM creation_delegations WHERE ticket_id=?').get(ticket.id);
    if (delegation && delegation.executor === key(caller) && delegation.pid === caller.pid && delegation.proc_start === caller.procStart) return caller;
    throw new Error('Only the requester or the delegated executor process can carry out this ticket');
  }

  begin(rawCaller: ExecutorCaller, ticketId: string): CreationPlan {
    return this.tickets.db.transaction(() => {
      const ticket = this.tickets.get(ticketId), caller = this.authorizedExecutor(ticket, rawCaller);
      if (ticket.adapter !== 'manual') this.compatible(ticket, caller);
      const holder = `${key(caller)}:${caller.pid}`, claim = this.tickets.claimCreating(ticket.id, holder);
      this.tickets.db.run('INSERT INTO creation_executions VALUES (?,?,?,?,?,?)', [ticket.id, key(caller), caller.pid, caller.procStart, claim.epoch, this.now()]);
      const prompt = bootstrapPrompt(claim.ticket, claim.correlationId);
      const base = { ticketId: ticket.id, epoch: claim.epoch, adapter: ticket.adapter, correlationId: claim.correlationId, bootstrapPrompt: prompt, evidence: 'panel_session_or_creation_grant' as const };
      const forbidden = ['Do not open, read or click the local bridge panel (http://127.0.0.1:*).', 'Do not create a second conversation if the outcome is unclear; report it as uncertain.',
        'Do not use a CLI, SDK or private IPC to create the conversation.', 'Do not start collaboration work in the new conversation before prepare/start.'];
      if (ticket.adapter === 'native_tool_relay') return { ...base, forbidden, steps: [
        `Use the host's official create_thread capability in ${ticket.project}${ticket.mode === 'local' ? ' (local, no worktree)' : ''}${ticket.model ? ` with model ${ticket.model}` : ''}.`,
        'Pass the bootstrap prompt exactly as the first message.', 'Wait for the final thread ID; a pending client-side ID is not a result.'],
      report: 'Report complete with hostRef = the final thread ID, failed only if the tool certainly created nothing, otherwise uncertain.' };
      if (ticket.adapter === 'assisted_ui') return { ...base, forbidden, steps: [
        `In Claude Desktop, start a new local conversation in ${ticket.project} without a worktree${ticket.branch ? ` on branch ${ticket.branch}` : ''}.`,
        ticket.model ? `Select model ${ticket.model} and verify it is shown before sending.` : 'Verify the project and local mode before sending.',
        'Send the bootstrap prompt exactly as the first message.'],
      report: 'Report complete without a host ID, failed only if no conversation was created, otherwise uncertain.' };
      // Manual: the agent performs nothing; a person follows these steps.
      const created = this.tickets.markCreated(ticket.id, claim.epoch, { hostRef: null, degradation: 'manual_human_creation' });
      return { ...base, epoch: created.epoch, forbidden, steps: [
        `Ask the person to open a new ${ticket.targetProvider === 'claude' ? 'Claude Code Desktop' : 'Codex Desktop'} conversation in ${ticket.project}${ticket.mode === 'local' ? ' (local)' : ''}.`,
        'They may paste the bootstrap prompt as its first message so the bridge can bind it; otherwise they bind it in the panel.'],
      report: 'Nothing to report; the ticket is now waiting for the new conversation.' };
    }).immediate();
  }

  private execution(ticketId: string, rawCaller: ExecutorCaller, epoch: number) {
    const caller = callerSchema.parse(rawCaller);
    const run = this.tickets.db.query<{ executor: string; pid: number; proc_start: string; epoch: number }, [string]>('SELECT * FROM creation_executions WHERE ticket_id=?').get(uuid.parse(ticketId));
    if (!run || run.executor !== key(caller) || run.pid !== caller.pid || run.proc_start !== caller.procStart) throw new Error('Only the process that began this creation can report it');
    if (run.epoch !== epoch) throw new Error('Stale creation attempt');
    return caller;
  }
  complete(caller: ExecutorCaller, ticketId: string, epoch: number, outcome: { hostRef?: string | null } = {}) {
    return this.tickets.db.transaction(() => {
      const executor = this.execution(ticketId, caller, epoch), place = folder(executor.project), pinned = this.tickets.identity(ticketId);
      // Completion asserts the chat exists in the pinned project; if that cannot hold, report uncertain instead.
      if (place.project !== pinned.project || place.device !== pinned.device || place.inode !== pinned.inode) throw new Error('Caller project differs from the pinned project; report the outcome as uncertain');
      return this.tickets.markCreated(ticketId, epoch, { hostRef: outcome.hostRef ?? null });
    }).immediate();
  }
  uncertain(caller: ExecutorCaller, ticketId: string, epoch: number, reason: string) {
    return this.tickets.db.transaction(() => { this.execution(ticketId, caller, epoch); return this.tickets.markUncertain(ticketId, epoch, reason); }).immediate();
  }
  failed(caller: ExecutorCaller, ticketId: string, epoch: number, outcome: { effect: 'none'; reason: string }) {
    return this.tickets.db.transaction(() => { this.execution(ticketId, caller, epoch); return this.tickets.markFailed(ticketId, epoch, outcome); }).immediate();
  }
}
