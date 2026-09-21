import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('the script carries both immutable pin paths: refs/tags for tags, raw SHA for commits', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toContain('git fetch -q --depth 1 origin "refs/tags/$TAG"');
    expect(text).toContain('git fetch -q --depth 1 origin "$TAG"');
    expect(text).toContain('git checkout -q FETCH_HEAD');
  });

  it('a branch-only pin fails loudly (the lock must pin an immutable tag or SHA)', () => {
    // A hermetic local remote with a branch named `main` and no matching
    // tag: the tag-path fetch targets refs/tags/main, which does not exist,
    // so packaging must fail before any build. `git clone --branch` would
    // have accepted the branch — that is the regression this guards.
    const repo = join(root, 'remote');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'README.md'), 'probe\n');
    execFileSync('git', ['-C', repo, 'add', 'README.md']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
    execFileSync('git', ['-C', repo, 'tag', 'sometag']);
    expect(() =>
      execFileSync('bash', [SCRIPT], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, TOOLKIT_LOCK: writeLock('main\n'), TOOLKIT_REPO_URL: `file://${repo}` },
      }),
    ).toThrow();
  });

  it('packs a pinned commit SHA hermetically (file:// remote, copied script root)', () => {
    // A minimal local toolkit: package.json + lockfile so `npm ci` and
    // `npm run build` succeed with zero deps, then the SHA path must check
    // the commit out and pack it. The script is COPIED to a temp root so its
    // REPO_ROOT/vendor/ never touches the real repo.
    const remote = join(root, 'sha-remote');
    execFileSync('git', ['init', '-q', '-b', 'main', remote]);
    writeFileSync(join(remote, 'package.json'), JSON.stringify({ name: '@camerontaylor/cq-toolkit', version: '1.0.1', scripts: { build: 'true' } }));
    writeFileSync(join(remote, 'package-lock.json'), JSON.stringify({ name: '@camerontaylor/cq-toolkit', version: '1.0.1', lockfileVersion: 3, requires: true, packages: { '': { name: '@camerontaylor/cq-toolkit', version: '1.0.1' } } }));
    execFileSync('git', ['-C', remote, 'add', '-A']);
    execFileSync('git', ['-C', remote, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
    const sha = execFileSync('git', ['-C', remote, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const scriptRoot = join(root, 'script-root');
    mkdirSync(join(scriptRoot, 'scripts'), { recursive: true });
    const copied = join(scriptRoot, 'scripts', 'pack-toolkit.sh');
    writeFileSync(copied, readFileSync(SCRIPT));
    const lock = join(root, 'sha-toolkit.lock');
    writeFileSync(lock, `${sha}\n`);

    const out = execFileSync('bash', [copied], {
      encoding: 'utf8',
      env: { ...process.env, TOOLKIT_LOCK: lock, TOOLKIT_REPO_URL: `file://${remote}` },
    });
    expect(out).toContain(`(pin: ${sha})`);
    expect(existsSync(join(scriptRoot, 'vendor', 'cq-toolkit-1.0.1.tgz'))).toBe(true);
  }, 60_000);
});
