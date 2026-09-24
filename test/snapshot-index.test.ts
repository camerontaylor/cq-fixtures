// F6 (WB-5.1/5.2b) snapshot-contract tests:
//  - every committed snapshot README records the toolkit.lock value AND the
//    suite's git SHA in its machine-read header (CQ-5 attribution);
//  - the committed snapshot index is current (regenerable, never hand-edited);
//  - `regrade --from` reproduces every committed 2026-09-18 table
//    BYTE-IDENTICALLY from that snapshot's rows.jsonl (the F6 acceptance).

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { cliMain } from '../runner/cli.ts';
// @ts-expect-error The snapshot-index generator is plain JavaScript without a declaration file.
import { snapshotCells } from '../scripts/snapshot-index.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOTS_ROOT = join(REPO_ROOT, 'reports', 'snapshots');
const SNAPSHOT_2026_09_18 = join(SNAPSHOTS_ROOT, '2026-09-18');

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function snapshotDirs(): string[] {
  return readdirSync(SNAPSHOTS_ROOT)
    .filter((name) => statSync(join(SNAPSHOTS_ROOT, name)).isDirectory())
    .sort();
}

function tableFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.table.json')) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

describe('snapshot README headers (F6/WB-5.1)', () => {
  it('every snapshot README records toolkit.lock and the suite git SHA', () => {
    const dirs = snapshotDirs();
    expect(dirs.length, 'at least one committed snapshot').toBeGreaterThan(0);
    for (const name of dirs) {
      const readme = readFileSync(join(SNAPSHOTS_ROOT, name, 'README.md'), 'utf8');
      expect(readme, `${name}/README.md must record toolkit.lock`).toMatch(/^toolkit\.lock:\s*\S/m);
      expect(readme, `${name}/README.md must record the suite SHA`).toMatch(/^suite-sha:\s*\S/m);
    }
  });
});

describe('snapshot index (F6/WB-5.1)', () => {
  it('only indexes the recognized fixer marker and rejects invalid markers on other cells', () => {
    const snapshotDir = mkdtempSync(join(tmpdir(), 'cq-snapshot-index-'));
    tempDirs.push(snapshotDir);
    const cell = (invalid?: unknown) => ({
      model: 'glm-5.3-flash',
      driver: 'ai-sdk',
      score: 1,
      passed: 1,
      total: 1,
      ...(invalid === undefined ? {} : { invalid }),
    });
    const classifierPath = join(snapshotDir, 'review-classifier.table.json');
    writeFileSync(classifierPath, JSON.stringify({
      role: 'review-classifier',
      suite: 'micro',
      cells: [cell('workspace-unbound')],
    }));
    expect(() => snapshotCells(snapshotDir)).toThrow(
      /review-classifier cell glm-5\.3-flash\/ai-sdk\/default carries fixer-only invalid marker workspace-unbound/,
    );

    rmSync(classifierPath);
    const fixerPath = join(snapshotDir, 'fixer-worker.table.json');
    writeFileSync(fixerPath, JSON.stringify({
      role: 'fixer-worker',
      suite: 'micro',
      cells: [cell('some-future-marker')],
    }));
    expect(() => snapshotCells(snapshotDir)).toThrow(
      /cell glm-5\.3-flash\/ai-sdk\/default carries unrecognized invalid marker some-future-marker/,
    );

    writeFileSync(fixerPath, JSON.stringify({
      role: 'fixer-worker',
      suite: 'micro',
      cells: [cell('workspace-unbound')],
    }));
    expect([...snapshotCells(snapshotDir).cells.values()][0]?.invalid).toBe('workspace-unbound');
  });

  it('the committed index is current and exposes historical cell validity', () => {
    expect(() =>
      execFileSync('node', ['scripts/snapshot-index.mjs', '--check'], { cwd: REPO_ROOT, encoding: 'utf8' }),
    ).not.toThrow();
    const index = readFileSync(join(SNAPSHOTS_ROOT, 'README.md'), 'utf8');
    expect(index).toContain('| old status | new status | old score | new score |');
    expect(index).toContain('| workspace-unbound | (absent) |');
    expect(index).toContain('| (absent) | workspace-unbound |');
    expect(index).toContain('| (invalid comparison) |');
    expect(index).toContain(
      '| review-classifier / micro | deepseek-flash | ai-sdk | default | valid | valid | 0.9000 | 1.0000 | +0.1000 | 10 | 10 |',
    );
    const invalidFixerDeltas = index.split('\n').filter(
      (line) => line.startsWith('| fixer-worker /') && line.includes('| workspace-unbound |'),
    );
    expect(invalidFixerDeltas.length).toBeGreaterThan(0);
    expect(invalidFixerDeltas.every((line) => line.includes('| (invalid comparison) |'))).toBe(true);
  });
});

describe('regrade reproduces the 2026-09-18 tables byte-identical (F6 acceptance)', () => {
  it('every committed table is re-aggregated to the same bytes from its rows.jsonl', async () => {
    const tables = tableFiles(SNAPSHOT_2026_09_18);
    expect(tables.length, 'the 2026-09-18 snapshot commits eight per-cell tables').toBe(8);
    for (const table of tables) {
      const suiteDir = dirname(table);
      const stem = mkdtempSync(join(tmpdir(), 'cq-snapshot-regrade-'));
      tempDirs.push(stem);
      const copy = join(stem, 'cell');
      cpSync(suiteDir, copy, { recursive: true });
      const rel = table.slice(SNAPSHOT_2026_09_18.length + 1);
      const copiedTable = join(copy, rel.split('/').pop()!);
      const before = readFileSync(copiedTable, 'utf8');
      await expect(cliMain(['regrade', '--from', copy])).resolves.toBe(0);
      expect(readFileSync(copiedTable, 'utf8'), `${rel} must regrade byte-identically`).toBe(before);
    }
  });
});
