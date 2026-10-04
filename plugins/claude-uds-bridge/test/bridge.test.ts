import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { Bridge } from '../src/bridge';
import { peers, peerAddress } from '../src/claude';
import { version } from '../src/version';
import { Database } from 'bun:sqlite';

test('MCP binds state to caller metadata and rejects a different task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uds-mcp-'));
  const client = new Client({ name: 'test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [process.env.UDS_MCP_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/server.ts')],
      env: { CODEX_HOME: root, CLAUDE_CONFIG_DIR: root } }));
    expect(client.getServerVersion()?.version).toBe(version);
    const missing = await client.callTool({ name: 'status', arguments: {} });
    expect(missing.isError).toBe(true);
    const id = randomUUID();
    const valid = await client.callTool({ name: 'status', arguments: {},
      _meta: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: id }) } });
    expect(valid.isError).not.toBe(true);
    const body = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }).parse(valid);
    expect(z.object({ threadId: z.uuid() }).parse(JSON.parse(body.content[0]?.text ?? '')).threadId).toBe(id);
    const foreign = await client.callTool({ name: 'status', arguments: {}, _meta: { threadId: randomUUID() } });
    expect(foreign.isError).toBe(true);
  } finally {
    await client.close();
    rmSync(root, { recursive: true });
  }
});

test('upgrading the inbox preserves existing queue records without relabelling their IDs as turns', async () => {
  const root = mkdtempSync('/tmp/uds-upgrade-');
  const threadId = randomUUID();
  const messageId = randomUUID();
  const old = new Database(join(root, `${threadId}.sqlite`));
  old.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, peer_id TEXT, direction TEXT, text TEXT, status TEXT, queue_id TEXT, created_at INTEGER)');
  old.run('INSERT INTO messages VALUES (?,?,?,?,?,?,?)', [messageId, randomUUID(), 'in', 'old message', 'queued', randomUUID(), 1]);
  old.close();
  const bridge = new Bridge(threadId, root, root, join(root, 'unavailable.sock'));
  try {
    expect(bridge.status().messages[0]).toMatchObject({ id: messageId, status: 'queued', turn_id: null });
  } finally {
    await bridge.close();
    rmSync(root, { recursive: true });
  }
});

test('legacy raw addresses migrate once without losing held messages or idle subscriptions', async () => {
  const root = mkdtempSync('/tmp/uds-address-upgrade-');
  const threadId = randomUUID();
  const messageId = randomUUID();
  const subscriptionId = randomUUID();
  const peerId = randomUUID();
  const path = join(root, `${threadId}.sqlite`);
  const raw = '/tmp/peer 100%é-%20.sock';
  const old = new Database(path);
  old.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, peer_id TEXT, direction TEXT, text TEXT, status TEXT, peer_address TEXT, peer_start TEXT, created_at INTEGER);
    CREATE TABLE idle_requests (id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, peer_address TEXT NOT NULL, peer_start TEXT, direction TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL, UNIQUE(direction,peer_address));`);
  old.run('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)', [messageId, peerId, 'in', 'held before upgrade', 'held', `uds:${raw}`, 'start', 1]);
  old.run('INSERT INTO idle_requests VALUES (?,?,?,?,?,?,?)', [subscriptionId, peerId, `uds:${raw}`, 'start', 'out', 'waiting', Date.now() + 60000]);
  old.close();
  try {
    for (let reopen = 0; reopen < 2; reopen++) {
      const bridge = new Bridge(threadId, root, root, join(root, 'unavailable.sock'));
      try {
        expect(bridge.status().messages[0]).toMatchObject({ id: messageId, status: 'held', status_reason: null });
        expect(bridge.held()[0]?.text).toBe('held before upgrade');
        const db = new Database(path, { readonly: true });
        try {
          expect(db.query<{peer_address:string},[string]>('SELECT peer_address FROM messages WHERE id=?').get(messageId)?.peer_address).toBe(peerAddress(raw));
          expect(db.query<{peer_address:string;status:string},[string]>('SELECT peer_address,status FROM idle_requests WHERE id=?').get(subscriptionId)).toEqual({peer_address:peerAddress(raw),status:'waiting'});
        } finally { db.close(); }
      } finally { await bridge.close(); }
    }
  } finally { rmSync(root, { recursive: true }); }
});

test('registered peers can initiate contact; unknown senders and wrong targets are rejected and duplicates survive restart', async () => {
  const root = mkdtempSync('/tmp/uds-test-');
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const directory = join(root, 's');
  mkdirSync(join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const peerPath = join(directory, `${process.ppid}.sock`);
  const received: string[] = [];
  const peer = net.createServer(socket => socket.on('data', chunk => received.push(chunk.toString())));
  peer.listen(peerPath);
  await once(peer, 'listening');
  chmodSync(peerPath, 0o600);
  const sessionId = randomUUID();
  writeFileSync(join(configDir, 'sessions', `${process.ppid}.json`), JSON.stringify({
    pid: process.ppid, sessionId, messagingSocketPath: peerPath, cwd: root, peerProtocol: 1,
  }));
  const threadId = randomUUID();
  let bridge = new Bridge(threadId, configDir, stateDir, join(root, 'unavailable.sock'));
  const messageId = randomUUID();
  const transmit = async (id: string, from = `uds:${peerPath}`, target = threadId) => {
    const address = bridge.status().replyAddress;
    if (!address) throw new Error('Missing test inbox');
    const socket = net.createConnection(address.slice(4));
    await once(socket, 'connect');
    socket.end(JSON.stringify({ msgV: 1, type: 'user', msg_id: id, from, session_id: target,
      message: { role: 'user', content: 'test payload' } }) + '\n');
    await once(socket, 'close');
  };
  try {
    await expect(bridge.sendMessage(sessionId, 'must not send without a reply address'))
      .rejects.toThrow('This Codex task has no active receiver');
    expect(received).toEqual([]);
    expect(bridge.status().messages).toEqual([]);
    await bridge.start(directory, root, bridge.beginSession());
    bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    await transmit(randomUUID(), 'uds:/unselected.sock');
    await transmit(randomUUID(), `uds:${peerPath}`, randomUUID());
    await transmit(messageId);
    const deadline = Date.now() + 2000;
    while (bridge.status().messages[0]?.status !== 'unknown' && Date.now() < deadline) await Bun.sleep(10);
    expect(bridge.status().messages[0]?.status).toBe('unknown');
    await transmit(messageId);
    await bridge.close();
    bridge = new Bridge(threadId, configDir, stateDir, join(root, 'unavailable.sock'));
    await bridge.start(directory, root, bridge.beginSession());
    await transmit(messageId);
    const state = bridge.status();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ id: messageId, status: 'unknown', turn_id: null });
    expect(state.replyAddress).not.toBeNull();
    writeFileSync(join(configDir, 'sessions', `${process.ppid}.json`), JSON.stringify({
      pid: process.ppid, sessionId, messagingSocketPath: peerPath, cwd: root, peerProtocol: 1,
      procStart: 'a previous process with this PID',
    }));
    await expect(bridge.sendMessage(sessionId, 'must not reach a recycled process')).rejects.toThrow();
    expect(received).toEqual([]);
  } finally {
    await bridge.close();
    expect(peers(configDir).some(peer => peer.sessionId === threadId)).toBe(false);
    await new Promise<void>(resolve => peer.close(() => resolve()));
    rmSync(root, { recursive: true });
  }
});
