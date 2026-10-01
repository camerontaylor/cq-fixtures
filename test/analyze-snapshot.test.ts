import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeSnapshot } from '../scripts/analyze-snapshot.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cq-w65-analyze-'));
  dirs.push(dir);
  for (const model of ['baseline', 'candidate']) {
    const cell = join(dir, model, 'ai-sdk');
    mkdirSync(cell, { recursive: true });
    const runs = [1, 2, 3].map((repeat) => ({
      role: 'review-classifier', suite: 'micro', model, driver: 'ai-sdk', variant: 'default',
      toolkitLock: '1.1.0', suiteSha: 'abcdef0', runId: `${model}-${repeat}`, repeat, repeatCount: 3,
    }));
    writeFileSync(join(cell, 'run.json'), JSON.stringify({ runs }));
    const rows = runs.flatMap(({ repeat, runId }) => ['a', 'b', 'c'].map((caseId) => ({
      role: 'review-classifier', suite: 'micro', case: caseId, model, driver: 'ai-sdk', repeat, repeatCount: 3,
      outcome: { score: model === 'candidate' ? 1 : 0, passed: model === 'candidate' ? 1 : 0, total: 1 },
      expectedCases: 3, costUSD: 0, wallTimeMs: 1, tokens: { input: 0, output: 0 },
      runId, timestamp: '2026-09-30T00:00:00Z',
    })));
    writeFileSync(join(cell, 'rows.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  }
  return dir;
}

describe('snapshot comparison analysis', () => {
  it('combines matching cells and emits paired, schema-valid comparisons', () => {
    const result = analyzeSnapshot(fixture());
    expect(result.cellCount).toBe(2);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].comparisons?.[0]).toMatchObject({ cases: 3, repeatsPerCase: 3, coverageParity: true, interpretation: 'signal' });
  });

  it('rejects mixed provenance before calculating comparisons', () => {
    const dir = fixture();
    const path = join(dir, 'candidate', 'ai-sdk', 'run.json');
    const { runs } = JSON.parse(readFileSync(path, 'utf8'));
    for (const run of runs) run.toolkitLock = 'other';
    writeFileSync(path, JSON.stringify({ runs }));
    expect(() => analyzeSnapshot(dir)).toThrow(/mixed toolkit provenance/);
  });

  it('groups multiple suites in each matrix cell and matches rows to their own manifest run', () => {
    const dir = fixture();
    for (const model of ['baseline', 'candidate']) {
      const cell = join(dir, model, 'ai-sdk');
      const manifestPath = join(cell, 'run.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const extraRuns = manifest.runs.map((run: Record<string, unknown>) => ({ ...run, role: 'fixer-worker', suite: 'fixer-micro', runId: `${run.runId}-fixer` }));
      manifest.runs.push(...extraRuns);
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const rowsPath = join(cell, 'rows.jsonl');
      const rows = readFileSync(rowsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const extraRows = rows.map((row) => ({ ...row, role: 'fixer-worker', suite: 'fixer-micro', runId: `${row.runId}-fixer` }));
      writeFileSync(rowsPath, [...rows, ...extraRows].map((row) => JSON.stringify(row)).join('\n') + '\n');
    }
    const result = analyzeSnapshot(dir);
    expect(result.tables.map((table: { role: string }) => table.role).sort()).toEqual(['fixer-worker', 'review-classifier']);
    expect(result.tables.every((table: { cells: unknown[] }) => table.cells.length === 2)).toBe(true);
  });

  it('keeps a suite name containing path separators inside the analysis output', () => {
    const dir = fixture();
    for (const model of ['baseline', 'candidate']) {
      const cell = join(dir, model, 'ai-sdk');
      const manifestPath = join(cell, 'run.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      for (const run of manifest.runs) run.suite = '../escape';
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const rowsPath = join(cell, 'rows.jsonl');
      const rows = readFileSync(rowsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      for (const row of rows) row.suite = '../escape';
      writeFileSync(rowsPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    }
    const out = join(dir, 'analysis');
    execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/analyze-snapshot.mjs', '--from', dir, '--out', out]);
    const files = readdirSync(out);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^review-classifier-hashed-[0-9a-f]{64}\.comparisons\.json$/);
    expect(JSON.parse(readFileSync(join(out, files[0]!), 'utf8')).suite).toBe('../escape');
  });

  it('preserves usable cells when another cell has no scored rows', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'candidate', 'ai-sdk', 'rows.jsonl'), '');
    const result = analyzeSnapshot(dir);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].cells).toHaveLength(1);
    expect(result.tables[0].comparisons).toBeUndefined();
  });

  it('ignores preserved ordinary same-day cells when replaying a dated pilot snapshot', () => {
    const dir = fixture();
    const ordinary = join(dir, 'older-lane', 'subprocess');
    mkdirSync(ordinary, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, 'baseline', 'ai-sdk', 'run.json'), 'utf8'));
    for (const run of manifest.runs) { delete run.repeat; delete run.repeatCount; }
    writeFileSync(join(ordinary, 'run.json'), JSON.stringify(manifest));
    const rows = readFileSync(join(dir, 'baseline', 'ai-sdk', 'rows.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    for (const row of rows) { delete row.repeat; delete row.repeatCount; }
    writeFileSync(join(ordinary, 'rows.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    expect(analyzeSnapshot(dir).cellCount).toBe(2);
  });

  it('uses published version and registry integrity after toolkit.lock is removed', () => {
    const dir = fixture();
    for (const model of ['baseline', 'candidate']) {
      const path = join(dir, model, 'ai-sdk', 'run.json');
      const { runs } = JSON.parse(readFileSync(path, 'utf8'));
      for (const run of runs) {
        run.toolkitLock = null;
        run.toolkitPackage = { version: '1.1.0', integrity: 'sha512-example' };
      }
      writeFileSync(path, JSON.stringify({ runs }));
    }
    expect(analyzeSnapshot(dir).toolkitVersion).toBe('npm:1.1.0@sha512-example');
  });
});
