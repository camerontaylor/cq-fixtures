import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    expect(() => analyzeSnapshot(dir)).toThrow(/mixed toolkitLock/);
  });
});
