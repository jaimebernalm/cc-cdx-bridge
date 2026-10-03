import { join } from 'node:path';
import { ownedJson } from './claude';

export type PermissionClass = 'prompting' | 'bypass' | 'unknown';
export type InboundPolicy = 'default' | 'accept' | 'hold' | 'refuse' | 'unknown';
export type InboundDecision = 'accept' | 'hold' | 'refuse' | 'unknown';

// Only use this as an effective decision when ALL inputs were observed from
// the receiving session. Settings-file observations alone are not sufficient.
export function evaluateInbound(policy: InboundPolicy, receiver: PermissionClass, sender: PermissionClass): InboundDecision {
  if (policy === 'accept' || policy === 'hold' || policy === 'refuse') return policy;
  if (policy === 'unknown' || receiver === 'unknown' || sender === 'unknown') return 'unknown';
  return receiver === sender ? 'accept' : 'hold';
}

export function restrictedPolicy(base: InboundPolicy, project: InboundPolicy, local: InboundPolicy): InboundPolicy {
  const rank = { accept: 0, default: 0, unknown: 0, hold: 1, refuse: 2 };
  return [project, local].reduce((current, value) => rank[value] > rank[current] ? value : current, base);
}

export function observeClaudeSettings(configDir: string, project: string) {
  return [
    { scope: 'user', path: join(configDir, 'settings.json') },
    { scope: 'project', path: join(project, '.claude', 'settings.json') },
    { scope: 'local', path: join(project, '.claude', 'settings.local.json') },
  ].map(({ scope, path }) => {
    try {
      const raw = ownedJson(path, 1024 * 1024) as Record<string, unknown>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid settings');
      const value = raw.crossSessionInbound;
      const inbound = value === undefined ? 'unset' : ['accept', 'hold', 'refuse'].includes(String(value)) ? String(value) : 'invalid';
      const deny = (raw.permissions as { deny?: unknown } | undefined)?.deny;
      return { scope, readable: true, present: true, inbound,
        messagingDenied: Array.isArray(deny) ? deny.filter(rule => rule === 'SendMessage' || rule === 'ListAgents') : [] };
    } catch (error) {
      const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
      return { scope, readable: missing, present: !missing, inbound: missing ? 'unset' : 'unknown', messagingDenied: [] };
    }
  });
}
