import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { observeProjectAuthorization } from './project-authorization';
import { observeClaudeSettings, type InboundPolicy } from './permissions';
import { inspectParticipant, type ParticipantOptions, type Participant } from './participants';

export type ReceptionCheck = {
  readyForCheck: boolean; code: string; project: string; chatPolicy: InboundPolicy;
  projectRemembered: boolean; receiverSupported: boolean; effectiveClaudeInbound: 'unknown';
  roundTripVerified: false; message: string;
};

export async function receptionPreflight(options: ParticipantOptions, owner: string, peerId: string, participants?: Participant[]): Promise<ReceptionCheck> {
  const [codex, claude] = participants ?? await Promise.all([
    inspectParticipant(options, owner, 'codex', true), inspectParticipant(options, peerId, 'claude'),
  ]);
  if (!codex || !claude || codex.sessionId !== owner || claude.sessionId !== peerId) throw new Error('Wrong preflight participants');
  const db = new Database(join(options.stateDir, owner + '.sqlite'), {readonly: true});
  let policy: InboundPolicy = 'unknown', supported = false;
  try {
    const stored = db.query<{policy: string}, []>('SELECT policy FROM inbound_policy WHERE singleton=1').get()?.policy;
    if (['default', 'accept', 'hold', 'refuse'].includes(stored ?? '')) policy = stored as InboundPolicy;
    supported = !!db.query('SELECT 1 FROM receiver_capabilities WHERE capability=? AND pid=? AND proc_start=?').get('project_authorization_v1', codex.pid, codex.procStart);
  } finally { db.close(); }
  const project = codex.project.directory;
  const grant = observeProjectAuthorization(options.stateDir, project);
  const inherited = policy === 'default' && supported && grant.enabled && project === claude.project.directory;
  const base = {project, chatPolicy: policy, projectRemembered: grant.enabled, receiverSupported: supported,
    effectiveClaudeInbound: 'unknown' as const, roundTripVerified: false as const};
  const blocked = (code: string, message: string): ReceptionCheck => ({...base, readyForCheck: false, code, message});
  if (policy === 'hold' || policy === 'refuse') return blocked('explicit_reception_block', 'El chat Codex tiene recepción explícita ' + policy + '. La autorización del proyecto no la sustituye. Requiere una elección humana en la bandeja de este chat.');
  if (policy !== 'accept' && !inherited) return blocked('reception_authorization_required', 'Antes de iniciar, confirma «Recordar autorización para este proyecto» en el panel de esta carpeta. Si el receptor es antiguo, recárgalo primero. No se enviará un nuevo encargo hasta resolverlo.');
  const settings = observeClaudeSettings(options.configDir, claude.project.directory);
  if (settings.some(s => s.inbound === 'hold' || s.inbound === 'refuse' || s.messagingDenied.length)) return blocked('claude_reception_restricted', 'Hay una restricción observada de recepción o mensajería en Claude. Revísala en la conversación de Claude; el puente no modifica sus permisos.');
  return {...base, readyForCheck: true, code: 'ready_for_round_trip', message: 'La recepción de Codex permite una comprobación. La recepción efectiva de Claude sigue sin observarse: verifica una respuesta correlacionada breve antes de analizar el objetivo. Los ajustes no prueban recepción por el modelo.'};
}

export class PreflightBlocked extends Error {
  constructor(readonly preflight: ReceptionCheck) { super(preflight.message); }
}
export function requireReception(check: ReceptionCheck) { if (!check.readyForCheck) throw new PreflightBlocked(check); }
