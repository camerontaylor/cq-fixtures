import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// toolkit.lock pin resolution (interim-pin skeleton, plan §8.6): the lock may
// pin a branch/tag NAME (as today) or a full 40-hex commit SHA (the
// post-v1.0.0 interim pin), and the pack script must choose the right git
// path — `git clone --branch` cannot take a SHA. The resolution is exercised
// hermetically through the script's --print-pin-kind diagnostic with a
// TOOLKIT_LOCK override, so no network and no clone happen.
const SCRIPT = fileURLToPath(new URL('../scripts/pack-toolkit.sh', import.meta.url));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cq-fixture-lock-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeLock(content: string): string {
  const p = join(root, 'toolkit.lock');
  writeFileSync(p, content);
  return p;
}

function pinKind(lockPath: string, ...extraArgs: string[]): string {
  return execFileSync('bash', [SCRIPT, '--print-pin-kind', ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, TOOLKIT_LOCK: lockPath },
  }).trim();
}

describe('pack-toolkit.sh pin resolution (tag | commit SHA)', () => {
  it('resolves a tag name from the lock', () => {
    expect(pinKind(writeLock('phase-3-done\n'))).toBe('tag');
    expect(pinKind(writeLock('v1.0.0\n'))).toBe('tag');
  });

  it('resolves a full 40-hex commit SHA from the lock (the interim pin)', () => {
    expect(pinKind(writeLock('8fda0531cae7974b3cbf049565366099ee7ac247\n'))).toBe('commit');
  });

  it('resolves an uppercase 40-hex commit SHA too (hex is case-insensitive)', () => {
    expect(pinKind(writeLock('8FDA0531CAE7974B3CBF049565366099EE7AC247\n'))).toBe('commit');
  });

  it('an explicit argv pin overrides the lock', () => {
    const lock = writeLock('phase-3-done\n');
    expect(pinKind(lock, '8fda0531cae7974b3cbf049565366099ee7ac247')).toBe('commit');
  });

  it('a short hex string stays a tag (only a full 40-hex id is a commit)', () => {
    expect(pinKind(writeLock('abc1234\n'))).toBe('tag');
  });

  it('refuses a multi-line lock', () => {
    const lock = writeLock('phase-3-done\nextra\n');
    expect(() => pinKind(lock)).toThrow();
  });

  it('refuses an empty lock', () => {
    expect(() => pinKind(writeLock('\n\n'))).toThrow();
  });

  it('refuses a missing lock', () => {
    expect(() => pinKind(join(root, 'nope.lock'))).toThrow();
  });

  it('the script carries both git paths: --branch for tags, fetch-by-sha for commits', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toContain('git clone --depth 1 --branch "$TAG" "$REPO_URL"');
    expect(text).toContain('git fetch -q --depth 1 origin "$TAG"');
    expect(text).toContain('git checkout -q FETCH_HEAD');
  });
});
