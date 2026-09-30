import { describe, expect, it } from 'vitest';
import { aggregate, type ResultRow } from '../runner/aggregate.ts';

function row(model: string, caseId: string, repeat: number, score: number, expectedCases = 3): ResultRow {
  return {
    role: 'review-classifier', suite: 'micro', case: caseId, model, driver: 'ai-sdk', repeat, repeatCount: 3,
    outcome: { score, passed: score, total: 1 }, expectedCases,
    costUSD: 0, wallTimeMs: 1, tokens: { input: 0, output: 0 },
    runId: `${model}-${caseId}-${repeat}`, timestamp: '2026-09-30T00:00:00Z',
  };
}

describe('W6.5 paired case-clustered comparisons', () => {
  it('pairs case means across repeats and reports clustered noise band and MDE', () => {
    const rows: ResultRow[] = [];
    for (const id of ['a', 'b', 'c']) for (const repeat of [1, 2, 3]) {
      rows.push(row('baseline', id, repeat, 0));
      rows.push(row('candidate', id, repeat, id === 'a' ? 1 : 0));
    }
    const comparison = aggregate(rows)[0]!.comparisons![0]!;
    expect(comparison.cases).toBe(3);
    expect(comparison.repeatsPerCase).toBe(3);
    expect(comparison.delta).toBeCloseTo(1 / 3);
    expect(comparison.standardError).toBeCloseTo(1 / 3);
    expect(comparison.minimumDetectableEffect).toBeGreaterThan(comparison.noiseBand);
    expect(comparison.interpretation).toBe('not-distinguishable');
    expect(comparison.coverageParity).toBe(true);
  });

  it('labels incomplete coverage descriptive even when the observed delta exceeds noise', () => {
    const rows: ResultRow[] = [];
    for (const id of ['a', 'b']) for (const repeat of [1, 2, 3]) {
      rows.push(row('baseline', id, repeat, 0));
      rows.push(row('candidate', id, repeat, 1));
    }
    const comparison = aggregate(rows)[0]!.comparisons![0]!;
    expect(comparison.noiseBand).toBe(0);
    expect(comparison.coverageParity).toBe(false);
    expect(comparison.interpretation).toBe('descriptive');
  });

  it('leaves historical single-run tables without comparisons', () => {
    expect(aggregate([row('baseline', 'a', 1, 1), row('candidate', 'a', 1, 1)]
      .map(({ repeatCount, ...r }) => r))[0])
      .not.toHaveProperty('comparisons');
  });

  it('uses fixer check-rerun rather than the two-probe composite', () => {
    const rows: ResultRow[] = [];
    for (const id of ['a', 'b', 'c']) for (const repeat of [1, 2, 3]) {
      for (const [model, check] of [['baseline', false], ['candidate', true]] as const) {
        rows.push({ ...row(model, id, repeat, 1), role: 'fixer-worker',
          outcome: { score: 0.5, passed: 1, total: 2 },
          probes: [{ kind: 'check-rerun', expected: 'pass', observed: check ? 'pass' : 'fail', passed: check }] });
      }
    }
    const table = aggregate(rows)[0]!;
    expect(table.comparisons![0]!.delta).toBe(1);
    expect(table.cells.every((cell) => cell.scoreCI === undefined && cell.caseScoreCI !== undefined)).toBe(true);
  });

  it('treats a missing repeat as below parity even when each case has a complete row', () => {
    const rows: ResultRow[] = [];
    for (const id of ['a', 'b', 'c']) for (const repeat of [1, 2, 3]) {
      rows.push(row('baseline', id, repeat, 0));
      if (!(id === 'c' && repeat === 3)) rows.push(row('candidate', id, repeat, 1));
    }
    const comparison = aggregate(rows)[0]!.comparisons![0]!;
    expect(comparison.coverageParity).toBe(false);
    expect(comparison.interpretation).toBe('descriptive');
  });

  it('labels a fully missing third repeat descriptive using the declared repeat count', () => {
    const rows: ResultRow[] = [];
    for (const id of ['a', 'b', 'c']) for (const repeat of [1, 2]) {
      rows.push(row('baseline', id, repeat, 0));
      rows.push(row('candidate', id, repeat, 1));
    }
    const comparison = aggregate(rows)[0]!.comparisons![0]!;
    expect(comparison.repeatsPerCase).toBe(2);
    expect(comparison.coverageParity).toBe(false);
    expect(comparison.interpretation).toBe('descriptive');
  });
});
