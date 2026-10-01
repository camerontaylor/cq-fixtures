import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writePilotSnapshotHeader } from '../scripts/write-pilot-snapshot-header.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('writes a dated published-0.2 header from the landed pilot manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'cq-pilot-header-'));
  roots.push(root);
  const evalRoot = join(root, 'eval');
  const snapshotDir = join(root, '2026-10-01');
  const cell = join(evalRoot, 'glm-5.3-flash', 'ai-sdk', 'fixer-worker', 'micro');
  mkdirSync(cell, { recursive: true });
  mkdirSync(snapshotDir);
  expect(writePilotSnapshotHeader(evalRoot, snapshotDir, '123')).toBe(false);
  writeFileSync(join(cell, 'run.json'), JSON.stringify({ runs: [{
    toolkitLock: null,
    toolkitPackage: { version: '0.2.0', integrity: 'sha512-test' },
    suiteSha: 'abc123',
  }] }));
  expect(writePilotSnapshotHeader(evalRoot, snapshotDir, '123')).toBe(true);
  const header = readFileSync(join(snapshotDir, 'README.md'), 'utf8');
  expect(header).toContain('toolkit.lock: npm:0.2.0@sha512-test');
  expect(header).toContain('suite-sha: abc123');
  expect(header).toContain('snapshot-date: 2026-10-01');
  expect(header).toContain('run-id: 123');
});
