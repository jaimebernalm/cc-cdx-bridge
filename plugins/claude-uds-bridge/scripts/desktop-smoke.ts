import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Database } from 'bun:sqlite';
import { Bridge } from '../src/bridge';
import { ownedJson, peers, processStart, uuid } from '../src/claude';
import { readDesktopInputs, readDesktopProject, readDesktopRuntime, watchDesktop } from '../src/desktop';
import { replyMatches, selectDesktopPeer } from '../src/smoke';

const { values } = parseArgs({ options: {
  list: { type: 'boolean' }, peer: { type: 'string' }, thread: { type: 'string' },
  project: { type: 'string' }, timeout: { type: 'string', default: '180' },
  'approve-test-reply': { type: 'boolean', default: false },
}, strict: true });
const project = realpathSync(values.project ?? resolve(import.meta.dir, '../../..'));
const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const ipc = join(codexHome, 'ipc', 'ipc.sock');
const canonicalPeers = () => peers(config).map(peer => {
  try { return { ...peer, cwd: realpathSync(peer.cwd) }; } catch { return peer; }
});
if (values.list) {
  console.log(JSON.stringify(canonicalPeers().filter(peer => peer.entrypoint === 'claude-desktop')
    .map(({ sessionId, name, cwd, status }) => ({ sessionId, name, cwd, status })), null, 2));
  process.exit(0);
}

const seconds = Number(values.timeout);
if (!Number.isInteger(seconds) || seconds < 15 || seconds > 600) throw new Error('--timeout must be 15–600 seconds');
const thread = uuid.parse(values.thread ?? process.env.CODEX_THREAD_ID);
const peer = selectDesktopPeer(canonicalPeers(), project, values.peer);
if (!peer.procStart || await processStart(peer.pid) !== peer.procStart) throw new Error('Claude process identity changed');
if (realpathSync(await readDesktopProject(ipc, thread)) !== project) throw new Error('Codex and Claude must use the same project');
if (canonicalPeers().some(item => item.sessionId === thread)) throw new Error('This Codex chat already has a receiver; do not start a competing one');
const runtime = await readDesktopRuntime(ipc, thread);
if (runtime.mode === 'unknown') throw new Error('Cannot determine Codex permission mode');

const run = randomUUID();
const output = join(project, '.local', 'desktop-smoke', run);
mkdirSync(output, { recursive: true, mode: 0o700 });
const resultFile = join(output, 'result.json');
const record = ownedJson(join(config, 'sessions', `${peer.pid}.json`), 256 * 1024) as { version?: string };
const report: Record<string, unknown> = {
  run, project, threadId: thread, claudeSessionId: peer.sessionId,
  claudeEntrypoint: peer.entrypoint, claudeVersion: record.version,
  startedAt: new Date().toISOString(), outcome: 'running',
  codexRuntime: runtime,
  executionPermissionsModified: false, filesRequestedFromClaude: false,
  checks: { actualClaudeReply: false, nativeDeliveryAccepted: false, nativeInputConsumed: false },
};
const checks = report.checks as Record<string, boolean>;
const save = () => writeFileSync(resultFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const event = (stage: string, detail: unknown) => console.log(JSON.stringify({ stage, detail }));
save();
const bridge = new Bridge(thread, config, output, ipc);
let unwatch: (() => void) | undefined;
let disconnected = false;
let cancelled = false;
process.once('SIGINT', () => { cancelled = true; });
process.once('SIGTERM', () => { cancelled = true; });
let db: Database | undefined;
try {
  const generation = bridge.beginSession();
  unwatch = await watchDesktop(ipc, thread, state => bridge.updateRuntime(state), () => { disconnected = true; });
  await bridge.start(dirname(peer.messagingSocketPath), project, generation);
  db = new Database(join(output, `${thread}.sqlite`), { readonly: true });
  const nonce = randomUUID();
  const a = randomInt(10, 90), b = randomInt(10, 90);
  report.challenge = { nonce, a, b };
  const prompt = `Prueba única de comunicación Codex Desktop ↔ Claude Desktop, autorizada por el usuario. `
    + `No leas ni modifiques archivos ni configuración. Calcula ${a} + ${b}. `
    + `Usa SendMessage para responder a la sesión remitente ${bridge.status().name} con exactamente `
    + `BRIDGE_PONG ${nonce} seguido de un espacio y el resultado de la suma. `
    + `Es una sola respuesta; después termina. Si necesitas permiso para enviar, pídelo al usuario.`;
  const sent = await bridge.sendMessage(peer.sessionId, prompt);
  report.outbound = sent;
  save();
  event('sent', { ...sent, resultFile });
  const deadline = Date.now() + seconds * 1000;
  type Row = { id: string; text: string; status: string; desktop_input_id: string | null; native_input_id: string | null };
  let previous = '';
  while (Date.now() < deadline) {
    if (cancelled || disconnected) throw new Error(cancelled ? 'Test cancelled' : 'Codex Desktop disconnected');
    const outbound = bridge.status().messages.find(message => message.id === sent.messageId);
    report.outbound = { ...sent, status: outbound?.status ?? sent.status };
    if (outbound?.status !== previous) { previous = outbound?.status ?? ''; event('outbound', outbound); }
    if (outbound && ['held', 'refused', 'denied', 'expired', 'dropped', 'not-sent'].includes(outbound.status)) {
      throw new Error(`Claude inbound outcome: ${outbound.status}. No automatic resend or permission change.`);
    }
    const replies = db.query<Row, [string]>("SELECT id,text,status,desktop_input_id,native_input_id FROM messages WHERE direction='in' AND kind='message' AND peer_id=?").all(peer.sessionId);
    const reply = replies.find(row => replyMatches(row.text, nonce, a + b));
    if (reply) {
      if (!checks.actualClaudeReply) event('claude-reply', { messageId: reply.id, status: reply.status });
      checks.actualClaudeReply = true;
      report.reply = { messageId: reply.id, text: `BRIDGE_PONG ${nonce} ${a + b}`, status: reply.status };
      checks.nativeDeliveryAccepted = ['steered', 'started'].includes(reply.status);
      save();
      if (reply.status === 'held') {
        if (!values['approve-test-reply']) throw new Error('Reply received but held by Codex inbox mode comparison. Native delivery is unverified.');
        // An explicitly authorized test can release only this selected peer's
        // exact challenge response. The inbox policy remains default.
        await bridge.resolveHeld(reply.id, 'approve');
        report.specificTestReplyApproved = true;
        event('test-reply-approved', { messageId: reply.id });
      }
      if (checks.nativeDeliveryAccepted && reply.desktop_input_id) {
        const inputs = await readDesktopInputs(ipc, thread);
        checks.nativeInputConsumed = inputs.consumed.some(input => input.clientId === reply.desktop_input_id
          || (reply.native_input_id !== null && input.id === reply.native_input_id));
        if (checks.nativeInputConsumed) {
          report.outcome = 'passed';
          event('passed', checks);
          break;
        }
      }
    }
    await Bun.sleep(1000);
  }
  if (report.outcome !== 'passed') throw new Error('Timed out before a correct Claude reply was consumed by Codex. See partial checks in result.json.');
} catch (error) {
  report.outcome = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  event('failed', report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  save();
  unwatch?.();
  await bridge.close();
  db?.close();
  event('report', resultFile);
}
