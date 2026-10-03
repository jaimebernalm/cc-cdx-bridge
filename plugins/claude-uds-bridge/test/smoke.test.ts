import { test, expect } from 'bun:test';
import type { Peer } from '../src/claude';
import { replyMatches, selectDesktopPeer } from '../src/smoke';

const peer = (sessionId: string, entrypoint: string, cwd = '/project'): Peer => ({
  sessionId, entrypoint, cwd, pid: 123, messagingSocketPath: '/private/123.sock',
  name: 'same-name', status: 'idle', peerProtocol: 1, peerFeatures: [],
});
test('a desktop test cannot select VS Code, another project, or an ambiguous name', () => {
  const desktop = peer('desktop', 'claude-desktop');
  const others = [peer('vscode', 'claude-vscode'), peer('other', 'claude-desktop', '/elsewhere')];
  expect(selectDesktopPeer([...others, desktop], '/project')).toEqual(desktop);
  expect(() => selectDesktopPeer(others, '/project')).toThrow('Open a local');
  const second = peer('second', 'claude-desktop');
  expect(() => selectDesktopPeer([desktop, second], '/project')).toThrow('Multiple');
  expect(selectDesktopPeer([desktop, second], '/project', 'second')).toEqual(second);
  expect(() => selectDesktopPeer([desktop, ...others], '/project', 'vscode')).toThrow('Open a local');
});
test('only the exact challenge answer counts, with or without a peer envelope', () => {
  expect(replyMatches('BRIDGE_PONG nonce 42', 'nonce', 42)).toBe(true);
  expect(replyMatches('<cross-session-message from-mode="prompting">\nBRIDGE_PONG nonce 42\n</cross-session-message>', 'nonce', 42)).toBe(true);
  expect(replyMatches('BRIDGE_PONG stale 42', 'nonce', 42)).toBe(false);
  expect(replyMatches('BRIDGE_PONG nonce 41', 'nonce', 42)).toBe(false);
  expect(replyMatches('I saw BRIDGE_PONG nonce 42 in the prompt', 'nonce', 42)).toBe(false);
});
