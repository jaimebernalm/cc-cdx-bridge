import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { receiver } from './desktop-fixture';
import { doctor, claudeVersionSupported } from '../src/doctor';
import { evaluateInbound, restrictedPolicy, observeClaudeSettings, type PermissionClass } from '../src/permissions';
import { activateReceiver } from '../src/activation';
import { inbox, peers, processStart } from '../src/claude';
import { readDesktopInputs } from '../src/desktop';

const pluginRoot = resolve(import.meta.dir, '..');
const hookPath = process.env.UDS_HOOK_TEST_ENTRYPOINT ?? join(pluginRoot, 'src/hook.ts');

test('permission decisions preserve mismatches, explicit refusal and unknown session facts', () => {
  for (const receiving of ['prompting','bypass','unknown'] as PermissionClass[]) {
    for (const sending of ['prompting','bypass','unknown'] as PermissionClass[]) {
      expect(evaluateInbound('default', receiving, sending)).toBe(receiving === 'unknown' || sending === 'unknown' ? 'unknown' : receiving === sending ? 'accept' : 'hold');
      for (const policy of ['accept','hold','refuse'] as const) expect(evaluateInbound(policy,receiving,sending)).toBe(policy);
    }
  }
  expect(evaluateInbound('unknown','prompting','prompting')).toBe('unknown');
  expect(restrictedPolicy('default','accept','accept')).toBe('default');
  expect(restrictedPolicy('accept','hold','accept')).toBe('hold');
  expect(restrictedPolicy('accept','hold','refuse')).toBe('refuse');
});

test('settings observations redact unrelated data and do not follow symlinks', () => {
  const root = mkdtempSync('/tmp/bridge-settings-');
  try {
    mkdirSync(join(root,'.claude'));
    const content = JSON.stringify({crossSessionInbound:'accept',secret:'do-not-report',permissions:{deny:['SendMessage','Bash(*)']}});
    writeFileSync(join(root,'settings.json'),content);
    writeFileSync(join(root,'.claude/settings.json'),'{invalid');
    symlinkSync(join(root,'settings.json'),join(root,'.claude/settings.local.json'));
    const observations = observeClaudeSettings(root,root);
    expect(observations[0]?.inbound).toBe('accept');
    expect(observations[0]?.messagingDenied).toEqual(['SendMessage']);
    expect(observations[1]?.readable).toBe(false);
    expect(observations[2]?.readable).toBe(false);
    expect(JSON.stringify(observations)).not.toContain('do-not-report');
    expect(readFileSync(join(root,'settings.json'),'utf8')).toBe(content);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

async function fixture(streamVersion = 11) {
  const root = mkdtempSync('/tmp/bridge-phase0-');
  const desktop = await receiver('idle',false,false,root,{streamVersion});
  const configDir = join(root,'claude');
  mkdirSync(join(configDir,'sessions'),{recursive:true,mode:0o700});
  const sockets = join(root,'s'); mkdirSync(sockets,{mode:0o700});
  const frames: unknown[] = [];
  const listener = await inbox(sockets,frame=>frames.push(frame));
  const peerId = randomUUID();
  const peerFile = join(configDir,'sessions',`${process.pid}.json`);
  const record = {pid:process.pid,sessionId:peerId,name:'Claude example',cwd:root,entrypoint:'claude-desktop',peerProtocol:1,
    messagingSocketPath:listener.address.slice(4),procStart:await processStart(process.pid),version:'2.1.286'};
  const write = (extra:Record<string,unknown>={}) => writeFileSync(peerFile,JSON.stringify({...record,...extra}),{mode:0o600});
  write();
  const options = {project:root,threadId:desktop.threadId,peerId,configDir,codexHome:root,pluginRoot};
  return {root,desktop,configDir,frames,peerId,options,write,
    async close() {
      for (const peer of peers(configDir).filter(item=>item.entrypoint==='codex-claude-uds-bridge')) process.kill(peer.pid,'SIGTERM');
      const deadline = Date.now()+3000;
      while (peers(configDir).some(item=>item.entrypoint==='codex-claude-uds-bridge') && Date.now()<deadline) await Bun.sleep(20);
      await listener.close(); await desktop.close();
    }};
}

test('doctor distinguishes Desktop engines, missing receivers and policy uncertainty without mutation', async () => {
  const f = await fixture();
  try {
    const settings = JSON.stringify({crossSessionInbound:'accept',secret:'hidden'});
    writeFileSync(join(f.configDir,'settings.json'),settings);
    const before = await readDesktopInputs(f.desktop.path,f.desktop.threadId);
    const initial = await doctor(f.options);
    expect(initial.state).toBe('needs_receiver');
    expect(initial.effectiveClaudeInbound).toBe('unknown');
    expect(JSON.stringify(initial)).not.toContain('hidden');
    expect(existsSync(join(f.root,'plugin-state'))).toBe(false);
    f.write({entrypoint:'claude-vscode'});
    expect((await doctor(f.options)).state).toBe('needs_selection');
    f.write({version:'2.1.223'});
    expect((await doctor(f.options)).state).toBe('unsupported_version');
    expect(claudeVersionSupported('2.1.288')).toBe(true);
    expect(claudeVersionSupported('2.1.224')).toBe(true);
    expect(claudeVersionSupported('unknown')).toBe(false);
    expect(f.frames).toEqual([]); expect(f.desktop.submissions).toEqual([]);
    expect(await readDesktopInputs(f.desktop.path,f.desktop.threadId)).toEqual(before);
    expect(readFileSync(join(f.configDir,'settings.json'),'utf8')).toBe(settings);
  } finally { await f.close(); }
});

test('unsupported native stream blocks diagnosis without submitting a model turn', async () => {
  const f = await fixture(12);
  try { expect((await doctor(f.options)).checks.some(check=>check.code==='unsupported_version' && check.level==='blocked')).toBe(true); expect(f.desktop.submissions).toEqual([]); }
  finally { await f.close(); }
});

test('existing-chat activation is idempotent under concurrent requests and preserves native context', async () => {
  const f = await fixture();
  const context = {type:'userMessage',id:randomUUID(),clientId:null};
  f.desktop.setHistory({turns:[{items:[context]}]});
  try {
    const options = {...f.options,hookPath};
    const before = await readDesktopInputs(f.desktop.path,f.desktop.threadId);
    await Promise.all([activateReceiver(options),activateReceiver(options)]);
    expect(peers(f.configDir).filter(peer=>peer.sessionId===f.desktop.threadId)).toHaveLength(1);
    expect((await activateReceiver(options)).reused).toBe(true);
    expect((await doctor(f.options)).state).toBe('policy_unknown');
    expect((await doctor(f.options)).hookTrust).toBe('not_observable');
    const wrong = join(f.root,'other'); mkdirSync(wrong);
    await expect(activateReceiver({...options,project:wrong})).rejects.toThrow('Project mismatch');
    expect(await readDesktopInputs(f.desktop.path,f.desktop.threadId)).toEqual(before);
    expect(f.desktop.submissions).toEqual([]); expect(f.frames).toEqual([]);
  } finally { await f.close(); }
},20000);

test('MCP doctor and attach_current require caller identity and keep transport read-only until attach', async () => {
  const f = await fixture();
  const client = new Client({name:'phase0-test',version:'1.0.0'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[process.env.UDS_MCP_TEST_ENTRYPOINT ?? join(pluginRoot,'src/server.ts')],
      env:{...process.env,CODEX_HOME:f.root,CLAUDE_CONFIG_DIR:f.configDir}}));
    const args = {cwd:f.root,peerId:f.peerId};
    expect((await client.callTool({name:'doctor',arguments:args})).isError).toBe(true);
    const meta = {threadId:f.desktop.threadId};
    const report = await client.callTool({name:'doctor',arguments:args,_meta:meta});
    expect(report.isError).not.toBe(true);
    expect(existsSync(join(f.root,'plugin-state'))).toBe(false);
    expect((await client.callTool({name:'attach_current',arguments:{cwd:f.root},_meta:meta})).isError).not.toBe(true);
    expect((await client.callTool({name:'attach_current',arguments:{cwd:f.root},_meta:meta})).isError).not.toBe(true);
    expect((await client.callTool({name:'attach_current',arguments:{cwd:f.root},_meta:{threadId:randomUUID()}})).isError).toBe(true);
    expect(f.desktop.submissions).toEqual([]);
  } finally { await client.close(); await f.close(); }
},20000);
