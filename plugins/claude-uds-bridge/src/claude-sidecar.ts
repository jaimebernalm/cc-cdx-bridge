// Private bridge-owned records written by the Claude command hook and read by the MCP side.
// They live in the bridge state directory, never in Claude's own session registry.
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { privateDirectory, uuid } from './claude';

export const correlationPattern = /\bCCDX-CORR-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/;

export const hookSessionSchema = z.object({
  enginePid: z.number().int().positive(), procStart: z.string(), sessionId: uuid, generation: uuid,
  cwd: z.string(), source: z.string().max(64).nullable(), model: z.string().max(200).nullable(),
  startedAt: z.number(), updatedAt: z.number(), ended: z.boolean(),
}).strict();
export type HookSession = z.infer<typeof hookSessionSchema>;
export const correlationSchema = z.object({
  correlationId: uuid, sessionId: uuid, enginePid: z.number().int().positive(), procStart: z.string(),
  cwd: z.string(), generation: uuid, priorUserTurns: z.number().int().nonnegative().nullable(), at: z.number(),
}).strict();
export type CorrelationReceipt = z.infer<typeof correlationSchema>;

export function privateSubdirectory(stateDir: string, name: string) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 }); privateDirectory(stateDir);
  const directory = join(stateDir, name);
  mkdirSync(directory, { recursive: true, mode: 0o700 }); privateDirectory(directory);
  return directory;
}

function readOwned(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 65536) throw new Error('Invalid bridge sidecar file');
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally { closeSync(fd); }
}

export function writeAtomic(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, JSON.stringify(value)); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

// Write-once: a replayed correlation never replaces the first receipt.
export function writeOnce(path: string, value: unknown) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, JSON.stringify(value)); } finally { closeSync(fd); }
}

// Diagnostic logs live in shared state and grow with every prompt, so each file is capped: past the
// limit it rotates once to <file>.1, keeping at most two bounded files.
export const maxObservationBytes = 1024 * 1024;
export function appendObservation(stateDir: string, file: string, entry: Record<string, unknown>, limit = maxObservationBytes) {
  try {
    const path = join(privateSubdirectory(stateDir, 'claude-spike'), file);
    if (existsSync(path) && lstatSync(path).size >= limit) renameSync(path, `${path}.1`);
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, JSON.stringify({ at: Date.now(), ...entry }) + '\n'); } finally { closeSync(fd); }
  } catch { /* Measurement is best effort. */ }
}

export function readHookSession(stateDir: string, enginePid: number, procStart: string): HookSession | undefined {
  const path = join(stateDir, 'claude-callers', `${enginePid}.json`);
  if (!existsSync(path)) return undefined;
  const parsed = hookSessionSchema.safeParse(readOwned(path));
  // A record left by an earlier process with a reused PID says nothing about this one.
  return parsed.success && parsed.data.enginePid === enginePid && parsed.data.procStart === procStart ? parsed.data : undefined;
}

// Reads a receipt without consuming it, so a caller can validate the binding first and consume only
// once it succeeds; a rejected attempt leaves the receipt for a later, correct one.
export function peekCorrelation(stateDir: string, correlationId: string): CorrelationReceipt | undefined {
  const path = join(stateDir, 'claude-correlations', `${uuid.parse(correlationId)}.json`);
  if (!existsSync(path)) return undefined;
  const parsed = correlationSchema.safeParse(readOwned(path));
  return parsed.success ? parsed.data : undefined;
}

// Single consumer: the rename succeeds for exactly one caller, so a correlation binds at most once.
export function consumeCorrelation(stateDir: string, correlationId: string): CorrelationReceipt | undefined {
  const directory = join(stateDir, 'claude-correlations'), path = join(directory, `${uuid.parse(correlationId)}.json`);
  const claimed = join(directory, `${correlationId}.consumed-${randomUUID()}`);
  try { renameSync(path, claimed); } catch { return undefined; }
  try { return correlationSchema.parse(readOwned(claimed)); } finally { unlinkSync(claimed); }
}
