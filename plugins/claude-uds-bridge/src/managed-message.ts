import { z } from 'zod';
import { uuid } from './claude';

export const managedHeader = z.object({ runId: uuid, messageId: uuid, contextVersion: z.number().int().min(1).max(1000000), replyTo: uuid.optional() }).strict();
export type ManagedHeader = z.infer<typeof managedHeader>;
export const managedPrefix = 'CC_CDX_RUN_V1 ';

export function managedBody(text: string) {
  return /^<cross-session-message\s[^>]*>\n([\s\S]*)\n<\/cross-session-message>$/.exec(text)?.[1] ?? text;
}

export function parseManaged(text: string) {
  const body = managedBody(text);
  if (!body.startsWith(managedPrefix)) return null;
  const newline = body.indexOf('\n');
  if (newline < 0 || newline > 1024) throw new Error('Invalid managed message header');
  return { header: managedHeader.parse(JSON.parse(body.slice(managedPrefix.length, newline))), text: body.slice(newline + 1) };
}

export function formatManaged(header: ManagedHeader, text: string) {
  return managedPrefix + JSON.stringify(managedHeader.parse(header)) + '\n' + text;
}
