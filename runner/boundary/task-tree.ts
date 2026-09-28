import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync, lstatSync, readdirSync, readlinkSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { join, resolve, posix } from 'node:path';

export interface TaskEntry { path: string; kind: 'directory' | 'file' | 'symlink'; mode: number; data?: string; target?: string }
export interface TaskTree { entries: TaskEntry[]; inventoryHash: string }
export const TREE_LIMITS = { files: 12_000, bytes: 64 * 1024 * 1024 };
export const SAFE_GIT_CONFIG = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n';

export function validateTaskEntries(entries: TaskEntry[], normalizeSourceGit = false, requireGit = true): TaskTree {
  if (!Array.isArray(entries) || entries.length > TREE_LIMITS.files) throw new Error('bounded task inventory required');
  const seen = new Map<string, TaskEntry>(); let bytes = 0;
  const normalized: TaskEntry[] = [];
  for (const input of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const e = { ...input };
    if (!e.path || e.path.includes('\\') || e.path.includes('\0') || e.path.startsWith('/') ||
        e.path.split('/').some((part) => !part || part === '.' || part === '..') || seen.has(e.path) ||
        !['directory', 'file', 'symlink'].includes(e.kind) || !Number.isInteger(e.mode) || (e.mode & ~0o777) !== 0) throw new Error('unsafe task entry');
    const parent = posix.dirname(e.path);
    if (parent !== '.' && seen.get(parent)?.kind !== 'directory') throw new Error('missing directory or symlink ancestor');
    if (e.path === '.git' && e.kind !== 'directory') throw new Error('task must be an independent clone, not a linked worktree');
    if (e.path.startsWith('.git/') && e.kind === 'symlink') throw new Error('Git metadata symlinks forbidden');
    if (['.git/info/grafts', '.git/commondir', '.git/gitdir', '.git/objects/info/alternates', '.git/objects/info/http-alternates'].includes(e.path)) throw new Error('external Git storage forbidden');
    if (e.kind === 'file') {
      if (typeof e.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.data)) throw new Error('canonical file encoding required');
      const data = Buffer.from(e.data, 'base64'); bytes += data.length;
      if (bytes > TREE_LIMITS.bytes) throw new Error('task bytes exceed limit');
      if (e.path === '.git/config') {
        if (!normalizeSourceGit && data.toString() !== SAFE_GIT_CONFIG) throw new Error('Git config integrity changed');
        e.data = Buffer.from(SAFE_GIT_CONFIG).toString('base64'); e.mode = 0o644;
      }
    } else if (e.kind === 'symlink') {
      if (typeof e.target !== 'string' || !e.target || e.target.startsWith('/') || e.target.includes('\\') || e.target.includes('\0')) throw new Error('unsafe symlink target');
      const target = posix.normalize(posix.join(posix.dirname(e.path), e.target));
      if (target === '..' || target.startsWith('../')) throw new Error('symlink escapes task');
    }
    seen.set(e.path, e); normalized.push(e);
  }
  // Resolve link chains virtually, including .. after intermediate symlinks.
  // Lexical normalization alone can miss a kernel traversal outside the root.
  for (const entry of normalized.filter((e) => e.kind === 'symlink')) {
    const pending = entry.path.split('/'); const resolved: string[] = []; let links = 0;
    while (pending.length) {
      const part = pending.shift()!;
      if (part === '.' || !part) continue;
      if (part === '..') { if (!resolved.length) throw new Error('symlink chain escapes task'); resolved.pop(); continue; }
      const path = [...resolved, part].join('/'); const next = seen.get(path);
      if (next?.kind === 'symlink') { if (++links > 40) throw new Error('symlink cycle or excessive chain'); pending.unshift(...next.target!.split('/')); }
      else resolved.push(part);
    }
  }
  if (requireGit && (!seen.has('.git/HEAD') || !seen.has('.git/config') || seen.get('.git/objects')?.kind !== 'directory')) throw new Error('task Git baseline required');
  const inventory = normalized.map((e) => ({ path: e.path, kind: e.kind, mode: e.mode,
    ...(e.data !== undefined ? { bytes: Buffer.from(e.data, 'base64').length, sha256: createHash('sha256').update(Buffer.from(e.data, 'base64')).digest('hex') } : {}),
    ...(e.target !== undefined ? { target: e.target } : {}) }));
  return { entries: normalized, inventoryHash: createHash('sha256').update(JSON.stringify(inventory)).digest('hex') };
}

/** Walk only the supplied clone; lstat/open(O_NOFOLLOW), never dereference symlinks. */
export function snapshotTask(root: string, normalizeSourceGit = false, requireGit = true): TaskTree {
  const base = resolve(root); if (!lstatSync(base).isDirectory() || lstatSync(base).isSymbolicLink()) throw new Error('plain clone root required');
  const entries: TaskEntry[] = [];
  function walk(relative: string) {
    const directory = join(base, relative);
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('directory changed during snapshot');
    for (const name of readdirSync(directory).sort()) {
      const path = relative ? relative + '/' + name : name; const absolute = join(base, path); const stat = lstatSync(absolute);
      if (stat.mode & 0o7000) throw new Error('special mode bits forbidden');
      if (entries.length >= TREE_LIMITS.files) throw new Error('task file limit');
      if (stat.isDirectory()) { entries.push({ path, kind: 'directory', mode: stat.mode & 0o777 }); walk(path); }
      else if (stat.isSymbolicLink()) entries.push({ path, kind: 'symlink', mode: stat.mode & 0o777, target: readlinkSync(absolute) });
      else if (stat.isFile()) {
        if (stat.size > TREE_LIMITS.bytes || stat.nlink > 1) throw new Error('oversize or hard-linked task file');
        const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const actual = fstatSync(fd); if (actual.ino !== stat.ino || actual.dev !== stat.dev) throw new Error('file changed during snapshot');
          entries.push({ path, kind: 'file', mode: stat.mode & 0o777, data: readFileSync(fd).toString('base64') });
        } finally { closeSync(fd); }
      } else throw new Error('special task files forbidden');
    }
  }
  walk(''); return validateTaskEntries(entries, normalizeSourceGit, requireGit);
}

/** Destination is newly-created private directory; validate the whole tree before writes. */
export function materializeTask(tree: TaskTree, destination: string, requireGit = true): void {
  const valid = validateTaskEntries(tree.entries, false, requireGit);
  if (valid.inventoryHash !== tree.inventoryHash) throw new Error('task inventory mismatch');
  if (readdirSync(destination).length || lstatSync(destination).isSymbolicLink()) throw new Error('fresh export directory required');
  for (const e of valid.entries) {
    const path = join(destination, e.path);
    if (e.kind === 'directory') mkdirSync(path, { mode: 0o700 });
    else if (e.kind === 'file') writeFileSync(path, Buffer.from(e.data!, 'base64'), { flag: 'wx', mode: e.mode });
    else symlinkSync(e.target!, path);
  }
  for (const e of [...valid.entries].reverse()) if (e.kind !== 'symlink') chmodSync(join(destination, e.path), e.mode);
}

export function taskIdentity(tree: TaskTree, baselineCommit: string): string {
  if (!/^[a-f0-9]{40}$/.test(baselineCommit)) throw new Error('exact SHA-1 Git baseline required');
  return createHash('sha256').update(JSON.stringify({ baselineCommit, inventoryHash: tree.inventoryHash })).digest('hex');
}
