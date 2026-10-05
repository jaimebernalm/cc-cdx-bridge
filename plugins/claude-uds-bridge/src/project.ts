import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export type ProjectIdentity = {
  directory: string; kind: 'git' | 'directory'; worktree: string; commonGitDir: string | null;
  head: string | null; branch: string | null; dirty: boolean | null; diffHash: string | null;
  statusHash: string | null; untrackedPaths: string[]; untrackedSnapshot: null;
};

async function readLimited(stream: ReadableStream<Uint8Array>, limit = 16 * 1024 * 1024) {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength; if (bytes > limit) throw new Error('Git inspection exceeds the 16 MiB limit');
      chunks.push(item.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

export async function git(directory: string, args: string[], extraEnv: Record<string,string> = {}, input?: string) {
  // Do not inherit Git overrides that redirect repository/index identity.
  const inherited=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('GIT_')));
  const child = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', directory, ...args], {
    env: { ...inherited, LC_ALL:'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...extraEnv }, stdin: input===undefined?'ignore':'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  if(input!==undefined && child.stdin){child.stdin.write(input);child.stdin.end();}
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const [code, output, error] = await Promise.all([child.exited, readLimited(child.stdout), readLimited(child.stderr, 65536)]);
    return { code, output, error };
  } catch (error) { child.kill(); throw error; }
  finally { clearTimeout(timer); }
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export async function inspectProject(path: string): Promise<ProjectIdentity> {
  const directory = realpathSync(path);
  if (!statSync(directory).isDirectory()) throw new Error('Project must be a directory');
  const probe = await git(directory, ['rev-parse', '--is-inside-work-tree']);
  if (probe.code !== 0 && !probe.error.includes('not a git repository')) throw new Error('Git project inspection failed; repository identity is unknown');
  if (probe.code === 0 && probe.output.trim() !== 'true') throw new Error('Bare repositories are not supported as participant worktrees');
  if (probe.code !== 0 || probe.output.trim() !== 'true') {
    // A directory without Git has no inferred repository identity.
    return { directory, kind: 'directory', worktree: directory, commonGitDir: null, head: null, branch: null,
      dirty: null, diffHash: null, statusHash: null, untrackedPaths: [], untrackedSnapshot: null };
  }
  const [paths, head, branch, status] = await Promise.all([
    git(directory, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']),
    git(directory, ['rev-parse', '--verify', 'HEAD']),
    git(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);
  if (paths.code !== 0 || status.code !== 0) throw new Error('Cannot inspect Git worktree identity');
  const [root, common] = paths.output.trim().split('\n');
  if (!root || !common) throw new Error('Incomplete Git worktree identity');
  const [staged,unstaged] = await Promise.all([
    git(directory, ['diff','--no-ext-diff','--no-textconv','--binary','--cached']),
    git(directory, ['diff','--no-ext-diff','--no-textconv','--binary']),
  ]);
  if (staged.code !== 0 || unstaged.code !== 0) throw new Error('Cannot fingerprint the current Git diff');
  if (Buffer.byteLength(staged.output)+Buffer.byteLength(unstaged.output)>16*1024*1024) throw new Error('Git diffs exceed the 16 MiB limit');
  const entries=status.output.split('\0'); const untrackedPaths: string[]=[];
  for (let i=0;i<entries.length;i++) {
    const entry=entries[i]!;
    if (entry.startsWith('?? ')) untrackedPaths.push(entry.slice(3));
    else if (/[RC]/.test(entry.slice(0,2))) i++;
  }
  return { directory, kind: 'git', worktree: realpathSync(root), commonGitDir: realpathSync(resolve(directory, common)),
    head: head.code === 0 ? head.output.trim() : null, branch: branch.code === 0 ? branch.output.trim() : null,
    dirty: status.output.length > 0, diffHash: hash(JSON.stringify({staged:staged.output,unstaged:unstaged.output})), statusHash: hash(status.output),
    untrackedPaths, untrackedSnapshot: null };
}

export async function compareProjects(first: ProjectIdentity, second: ProjectIdentity, policy: 'same' | 'compare', base?: string) {
  if (first.kind !== second.kind) throw new Error('Participants do not have comparable project identities');
  if (first.kind === 'directory') {
    if (first.directory !== second.directory || policy !== 'same') throw new Error('Non-Git participants must use the exact same directory');
    return { policy, base: null, reproducible: false, limitation: 'No Git revision or content snapshot; untracked files are not snapshotted.' };
  }
  if (first.commonGitDir !== second.commonGitDir) throw new Error('Participants belong to different repositories');
  if (policy === 'same') {
    if (first.head !== second.head || first.diffHash !== second.diffHash || first.statusHash !== second.statusHash) {
      throw new Error('Participant revisions or local changes differ; prepare an explicit comparison with a fixed base');
    }
    // Matching status does not prove matching untracked content across separate worktrees.
    if (first.worktree !== second.worktree && (first.untrackedPaths.length || second.untrackedPaths.length)) {
      throw new Error('Separate worktrees with untracked files require an explicit comparison; their content is not snapshotted');
    }
    return { policy, base: first.head, reproducible: first.head !== null && !first.dirty,
      limitation: 'Diffs are fingerprinted; untracked file content is not snapshotted.' };
  }
  if (!base || base.startsWith('-')) throw new Error('Comparison requires an explicit Git base');
  const commit = await git(first.directory, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);
  if (commit.code !== 0) throw new Error('Comparison base is not a locally available commit');
  return { policy, base: commit.output.trim(), reproducible: !first.dirty && !second.dirty,
    limitation: 'Different revisions are intentional; untracked file content is not snapshotted.' };
}
