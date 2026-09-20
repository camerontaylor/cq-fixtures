import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';

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
  sandboxes.push(dir);
  cpSync(join(REPO_ROOT, 'package.json'), join(dir, 'package.json'));
  writeFileSync(join(dir, 'toolkit.lock'), 'phase-3-done\n');
  // Minimal lock fixture: the script's post-flip verification reads the
  // root entry's dep pin from it (the stub npm below performs the sync).
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'flip-sandbox',
      version: '0.0.0',
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { [DEP]: 'file:vendor/cq-toolkit-0.0.0.tgz' } },
        [`node_modules/${DEP}`]: { version: '0.0.0', resolved: 'file:vendor/cq-toolkit-0.0.0.tgz' },
      },
    }),
  );
  return dir;
}

// Hermetic npm: the flip's lock sync must never reach the registry from a
// test. The stub records its argv, exits NPM_EXIT, and — on success —
// performs the sync the real `npm install --package-lock-only` would: copy
// package.json's dep pin into the lock's root entry AND repoint the tree
// entry at the registry. It runs with cwd set to the sandbox by the
// script's `(cd "$ROOT" && npm ...)`. syncEntry=false simulates npm's
// version-coincidence shortcut (root pin moved, stale file: resolved kept)
// so the entry-verification leg has a failure to catch.
function stubNpm(dir: string, exitCode: number, syncEntry = true): { env: Record<string, string>; log: string } {
  const bin = join(dir, 'stubbin');
  mkdirSync(bin, { recursive: true });
  const log = join(dir, 'npm-calls.log');
  const body = [
    '#!/usr/bin/env bash',
    'echo "$@" >> "$NPM_CALL_LOG"',
    'if [ "${NPM_EXIT:-0}" != "0" ]; then exit "$NPM_EXIT"; fi',
    'node -e \'const fs=require("node:fs");' +
      'const pkg=JSON.parse(fs.readFileSync("package.json","utf8"));' +
      'const lock=JSON.parse(fs.readFileSync("package-lock.json","utf8"));' +
      'const v=pkg.dependencies["@camerontaylor/cq-toolkit"];' +
      'const reg="https://registry.npmjs.org/@camerontaylor/cq-toolkit/-/cq-toolkit-"+v+".tgz";' +
      'if(lock.packages?.[""])lock.packages[""].dependencies["@camerontaylor/cq-toolkit"]=v;' +
      'if(lock.dependencies?.["@camerontaylor/cq-toolkit"])lock.dependencies["@camerontaylor/cq-toolkit"].version=v;' +
      'if(process.env.NPM_SYNC_ENTRY==="1"){' +
      'if(lock.packages?.["node_modules/@camerontaylor/cq-toolkit"])lock.packages["node_modules/@camerontaylor/cq-toolkit"].resolved=reg;' +
      'if(lock.dependencies?.["@camerontaylor/cq-toolkit"])lock.dependencies["@camerontaylor/cq-toolkit"].resolved=reg;}' +
      'fs.writeFileSync("package-lock.json",JSON.stringify(lock,null,2)+"\\n");\'',
  ].join('\n');
  writeFileSync(join(bin, 'npm'), body + '\n');
  chmodSync(join(bin, 'npm'), 0o755);
  return {
    env: {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      NPM_CALL_LOG: log,
      NPM_EXIT: String(exitCode),
      NPM_SYNC_ENTRY: syncEntry ? '1' : '0',
    },
    log,
  };
}

const sandboxes: string[] = [];

afterEach(() => {
  // The hermetic sandboxes must not litter tmp on every CI run.
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readLockDep(dir: string): unknown {
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { dependencies?: Record<string, string> }>;
  };
  return lock.packages?.['']?.dependencies?.[DEP];
}

function runFlip(dir: string, args: string[], extraEnv: Record<string, string> = {}): { status: number; stderr: string } {
  try {
    execFileSync('bash', [SCRIPT, ...args], {
      env: { ...process.env, FIXTURES_ROOT: dir, ...extraEnv },
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
    const { env } = stubNpm(dir, 0);
    const before = readPkg(dir).dependencies?.[DEP];
    expect(before?.startsWith('file:'), 'sandbox starts from a file: spec').toBe(true);

    const { status } = runFlip(dir, ['1.0.0'], env);
    expect(status).toBe(0);
    expect(readPkg(dir).dependencies?.[DEP]).toBe('1.0.0');
    expect(() => readFileSync(join(dir, 'toolkit.lock'), 'utf8')).toThrow();
  });

  it('accepts prerelease/build semver and leaves other dependencies alone', { timeout: 60000 }, () => {
    const dir = sandbox();
    const { env } = stubNpm(dir, 0);
    const zodBefore = readPkg(dir).dependencies?.['zod'];
    const { status } = runFlip(dir, ['1.0.0-rc.1+build.5'], env);
    expect(status).toBe(0);
    expect(readPkg(dir).dependencies?.[DEP]).toBe('1.0.0-rc.1+build.5');
    expect(readPkg(dir).dependencies?.['zod']).toBe(zodBefore);
  });

  it('rejects a non-semver version without touching the tree', { timeout: 60000 }, () => {
    const dir = sandbox();
    const { env } = stubNpm(dir, 0);
    const { status, stderr } = runFlip(dir, ['latest'], env);
    expect(status).not.toBe(0);
    expect(stderr).toContain('semver');
    expect(readPkg(dir).dependencies?.[DEP]?.startsWith('file:')).toBe(true);
    expect(readFileSync(join(dir, 'toolkit.lock'), 'utf8')).toContain('phase-3-done');
  });

  it('refuses a second flip (one-way: dep is no longer a file: spec)', { timeout: 60000 }, () => {
    const dir = sandbox();
    const { env } = stubNpm(dir, 0);
    expect(runFlip(dir, ['1.0.0'], env).status).toBe(0);
    // Restore the lock the first flip removed: the refusal under test is
    // the non-file: dep, not the missing lock.
    writeFileSync(join(dir, 'toolkit.lock'), 'phase-3-done\n');
    const { status, stderr } = runFlip(dir, ['2.0.0'], env);
    expect(status).not.toBe(0);
    expect(stderr).toContain('refusing a second flip');
    expect(readPkg(dir).dependencies?.[DEP]).toBe('1.0.0');
  });

  it('syncs package-lock.json through npm --package-lock-only (cycle-1 review)', { timeout: 60000 }, () => {
    // Without the sync the committed lock still resolves the file:
    // tarball and the next `npm ci` fails — the flip is incomplete.
    const dir = sandbox();
    const { env, log } = stubNpm(dir, 0);
    expect(readLockDep(dir)).toBe('file:vendor/cq-toolkit-0.0.0.tgz');
    const { status } = runFlip(dir, ['1.0.0'], env);
    expect(status).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('--package-lock-only');
    expect(readLockDep(dir)).toBe('1.0.0');
    const entry = (JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { resolved?: string }>;
    }).packages?.[`node_modules/${DEP}`];
    expect(entry?.resolved?.startsWith('file:')).toBe(false);
  });

  it('aborts loudly when the lock sync fails, leaving the lock file in place', { timeout: 60000 }, () => {
    const dir = sandbox();
    const { env } = stubNpm(dir, 1);
    const { status, stderr } = runFlip(dir, ['1.0.0'], env);
    expect(status).not.toBe(0);
    expect(stderr).toContain('lock sync failed');
    // Rollback: package.json is restored to the file: spec (retryable),
    // the restore cleans its own backups (only a killed run leaves them),
    // and toolkit.lock must NOT be removed: removal claims a completeness
    // the tree does not have.
    expect(readPkg(dir).dependencies?.[DEP]?.startsWith('file:')).toBe(true);
    expect(existsSync(join(dir, 'package.json.bak-flip'))).toBe(false);
    expect(existsSync(join(dir, 'package-lock.json.bak-flip'))).toBe(false);
    expect(readFileSync(join(dir, 'toolkit.lock'), 'utf8')).toContain('phase-3-done');
  });

  it('rejects a lock whose tree entry still resolves via file: (stale-entry guard)', { timeout: 60000 }, () => {
    // Real-flip evidence: `npm install --package-lock-only` can leave
    // `resolved: file:vendor/...` on the tree entry when the tarball
    // version coincides with the requested one — the next `npm ci` (after
    // vendor/ is gone) would fail fetching it. The flip must not complete.
    const dir = sandbox();
    const { env } = stubNpm(dir, 0, false);
    const { status, stderr } = runFlip(dir, ['1.0.0'], env);
    expect(status).not.toBe(0);
    expect(stderr).toContain('package-lock.json entry still resolves');
    // Rollback applies on this leg too: the tree is retryable as-is.
    expect(readPkg(dir).dependencies?.[DEP]?.startsWith('file:')).toBe(true);
    expect(readFileSync(join(dir, 'toolkit.lock'), 'utf8')).toContain('phase-3-done');
  });

  it('reads a legacy lockfileVersion<=2 lock via the dependencies fallback', { timeout: 60000 }, () => {
    // The committed lock is v3, but a hand-maintained older lock must fail
    // on the pin — never on the shape. Seed the v1 shape already synced
    // (the tolerant stub keeps it synced) and flip through it.
    const dir = sandbox();
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        name: 'flip-sandbox',
        version: '0.0.0',
        lockfileVersion: 1,
        dependencies: {
          [DEP]: {
            version: 'file:vendor/cq-toolkit-0.0.0.tgz',
            resolved: 'file:vendor/cq-toolkit-0.0.0.tgz',
          },
        },
      }),
    );
    const { env } = stubNpm(dir, 0);
    const { status } = runFlip(dir, ['1.0.0'], env);
    expect(status).toBe(0);
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as {
      dependencies?: Record<string, { version?: string; resolved?: string }>;
    };
    expect(lock.dependencies?.[DEP]?.version).toBe('1.0.0');
    expect(lock.dependencies?.[DEP]?.resolved?.startsWith('file:')).toBe(false);
  });

  it('refuses loudly when package-lock.json is absent (nothing to back up)', { timeout: 60000 }, () => {
    const dir = sandbox();
    const { env } = stubNpm(dir, 0);
    rmSync(join(dir, 'package-lock.json'));
    const { status, stderr } = runFlip(dir, ['1.0.0'], env);
    expect(status).not.toBe(0);
    expect(stderr).toContain('cannot back it up for rollback');
    // Nothing rewritten, nothing removed: the refusal precedes all writes.
    expect(readPkg(dir).dependencies?.[DEP]?.startsWith('file:')).toBe(true);
    expect(readFileSync(join(dir, 'toolkit.lock'), 'utf8')).toContain('phase-3-done');
  });

  it('refuses when a stale .bak-flip backup exists (never overwrites recovery)', { timeout: 60000 }, () => {
    // A killed run leaves .bak-flip files with ORIGINAL content; a rerun
    // must refuse before copying, or the restore would hand back a partial
    // state and destroy the recovery copy.
    const dir = sandbox();
    const { env } = stubNpm(dir, 0);
    writeFileSync(join(dir, 'package.json.bak-flip'), 'original-pkg');
    const { status, stderr } = runFlip(dir, ['1.0.0'], env);
    expect(status).not.toBe(0);
    expect(stderr).toContain('stale .bak-flip backup');
    // Refusal precedes ALL writes: package.json, lock, and toolkit.lock
    // untouched; the stale backup itself preserved.
    expect(readPkg(dir).dependencies?.[DEP]?.startsWith('file:')).toBe(true);
    expect(readFileSync(join(dir, 'toolkit.lock'), 'utf8')).toContain('phase-3-done');
    expect(readFileSync(join(dir, 'package.json.bak-flip'), 'utf8')).toBe('original-pkg');
  });
});
