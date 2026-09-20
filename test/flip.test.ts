import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// flip-to-published.sh is a phase-5 HUMAN step: prepared here, NEVER run
// against this repo (running it would detach the tree from its pinned
// tarball). These tests execute it hermetically — FIXTURES_ROOT points the
// script at a tmp dir holding a COPY of package.json plus a fixture
// toolkit.lock — so the flip's rewrite/remove/refuse contract is proven
// without touching the real tree.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'flip-to-published.sh');
const DEP = '@camerontaylor/cq-toolkit';

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flip-test-'));
  cpSync(join(REPO_ROOT, 'package.json'), join(dir, 'package.json'));
  writeFileSync(join(dir, 'toolkit.lock'), 'phase-3-done\n');
  return dir;
}

function runFlip(dir: string, args: string[]): { status: number; stderr: string } {
  try {
    execFileSync('bash', [SCRIPT, ...args], {
      env: { ...process.env, FIXTURES_ROOT: dir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return { status: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer | string };
    return { status: e.status ?? 1, stderr: String(e.stderr ?? '') };
  }
}

function readPkg(dir: string): { dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
}

describe('flip-to-published.sh (hermetic, FIXTURES_ROOT sandbox)', () => {
  it('rewrites the file: dep to the published version and removes toolkit.lock', { timeout: 60000 }, () => {
    const dir = sandbox();
    const before = readPkg(dir).dependencies?.[DEP];
    expect(before?.startsWith('file:'), 'sandbox starts from a file: spec').toBe(true);

    const { status } = runFlip(dir, ['1.0.0']);
    expect(status).toBe(0);
    expect(readPkg(dir).dependencies?.[DEP]).toBe('1.0.0');
    expect(() => readFileSync(join(dir, 'toolkit.lock'), 'utf8')).toThrow();
  });

  it('accepts prerelease/build semver and leaves other dependencies alone', { timeout: 60000 }, () => {
    const dir = sandbox();
    const zodBefore = readPkg(dir).dependencies?.['zod'];
    const { status } = runFlip(dir, ['1.0.0-rc.1+build.5']);
    expect(status).toBe(0);
    expect(readPkg(dir).dependencies?.[DEP]).toBe('1.0.0-rc.1+build.5');
    expect(readPkg(dir).dependencies?.['zod']).toBe(zodBefore);
  });

  it('rejects a non-semver version without touching the tree', { timeout: 60000 }, () => {
    const dir = sandbox();
    const { status, stderr } = runFlip(dir, ['latest']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('semver');
    expect(readPkg(dir).dependencies?.[DEP]?.startsWith('file:')).toBe(true);
    expect(readFileSync(join(dir, 'toolkit.lock'), 'utf8')).toContain('phase-3-done');
  });

  it('refuses a second flip (one-way: dep is no longer a file: spec)', { timeout: 60000 }, () => {
    const dir = sandbox();
    expect(runFlip(dir, ['1.0.0']).status).toBe(0);
    // Restore the lock the first flip removed: the refusal under test is
    // the non-file: dep, not the missing lock.
    writeFileSync(join(dir, 'toolkit.lock'), 'phase-3-done\n');
    const { status, stderr } = runFlip(dir, ['2.0.0']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('refusing a second flip');
    expect(readPkg(dir).dependencies?.[DEP]).toBe('1.0.0');
  });
});
