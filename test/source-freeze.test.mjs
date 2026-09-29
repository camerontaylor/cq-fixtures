import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePrivateRuntime, verifyCleanPreparationSource } from '../runner/boundary/prepare-final-g1-runtime.mjs';

test('source freeze rejects tracked/untracked changes and HEAD drift before preparation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cq-source-freeze-'));
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@invalid');
    writeFileSync(join(root, 'source.txt'), 'frozen\n');
    git('add', 'source.txt');
    git('commit', '-qm', 'baseline');
    const head = git('rev-parse', 'HEAD');
    const index = readFileSync(join(root, '.git/index'));
    assert.equal(verifyCleanPreparationSource(root, head), head);
    assert.deepEqual(readFileSync(join(root, '.git/index')), index);
    writeFileSync(join(root, '.conflicts'), 'recoverable audit\n');
    assert.throws(() => verifyCleanPreparationSource(root, head), /source is dirty/);
    // This root contains no runtime dependencies. Dirty rejection must precede
    // imports, task creation, auth context and Docker construction.
    await assert.rejects(preparePrivateRuntime(root, 'source-freeze-test'), /source is dirty/);
    assert.equal(readFileSync(join(root, '.conflicts'), 'utf8'), 'recoverable audit\n');
    rmSync(join(root, '.conflicts'));
    writeFileSync(join(root, 'source.txt'), 'changed\n');
    assert.throws(() => verifyCleanPreparationSource(root, head), /source is dirty/);
    git('add', 'source.txt');
    assert.throws(() => verifyCleanPreparationSource(root, head), /source is dirty/);
    git('commit', '-qm', 'successor');
    assert.throws(() => verifyCleanPreparationSource(root, head), /HEAD changed/);
    assert.equal(verifyCleanPreparationSource(root), git('rev-parse', 'HEAD'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
