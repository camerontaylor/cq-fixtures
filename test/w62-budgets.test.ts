import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import { computeCostUSD, type Driver, type OpInvocation, type WorkerResult } from '@camerontaylor/cq-toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { d9PerCaseUsd, D9_PER_CASE_USD, perSuiteUsdCap } from '../runner/budget.ts';
import { aggregate, isAtCoverageParity, type ComparisonTableCell, type ResultRow } from '../runner/aggregate.ts';
import { runSuite, type RunSuiteOptions } from '../runner/index.ts';
import { FakeDriver } from '../runner/fake-driver.ts';
import { cliMain } from '../runner/cli.ts';

// W6.2 (plan §6.2): per-case USD budgets on the accepted D9 envelope's caps,
// fail closed when a cell maps to no cap; the run budget's gated cases
// recorded as explicit budget-stop absences (never silent no-rows); the
// expectedCases/coverage columns that make coverage parity mechanical
// (RS-9 §1.3). All synthetic: FakeDriver and in-test stand-in drivers only.

const ajvRow = JSON.parse(readFileSync(new URL('../schema/result-row.schema.json', import.meta.url), 'utf8')) as object;
const ajvTable = JSON.parse(
  readFileSync(new URL('../schema/comparison-table.schema.json', import.meta.url), 'utf8'),
) as object;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cq-fixture-w62-'));
  // J3 payload injection: runSuite reads a classifier case's fixture from
  // repoRoot (the tmp dir here), so the payload must exist on disk now.
  writeFileSync(
    join(root, 'thread.json'),
    JSON.stringify({
      id: 1,
      path: 'src/example.ts',
      line: 1,
      resolved: false,
      comments: [{ author: 'tester', body: 'example remark', createdAt: '2026-09-25T00:00:00Z', isReply: false }],
    }),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSuite(dirName: string, suite: object): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'suite.json'), JSON.stringify(suite, null, 2) + '\n');
  return dir;
}

function reviewCase(id: string, expected: string): object {
  return {
    id,
    // runSuite tests pass repoRoot: root (above), where beforeEach wrote
    // thread.json. The cliMain tests resolve fixtures against the REAL repo
    // (cliMain exposes no repoRoot override), so they override this with a
    // real repo fixture — same reason cli.test.ts names thread-01.json.
    fixture: 'thread.json',
    task: { prompt: 'Classify the review thread.' },
    probe: { kind: 'expected-verdict', expected },
  };
}

/** A classifier case whose fixture exists in the real repo (for cliMain runs). */
function repoReviewCase(id: string, expected: string): object {
  return { ...reviewCase(id, expected), fixture: 'fixtures/threads/thread-01.json' };
}

function reviewSuite(dirName: string, name: string, cases: object[]): string {
  return writeSuite(dirName, {
    name,
    role: 'review-classifier',
    servedModel: 'glm-5.3-flash',
    provenance: { origin: 'hand-seeded' },
    cases,
  });
}

function opts(suiteDir: string, over: Partial<RunSuiteOptions> = {}): RunSuiteOptions {
  return {
    suiteDir,
    driver: new FakeDriver(),
    // Priced pair: the fake's 120 tokens/case have a real modeled cost, so a
    // small enough maxUsdPerCase gates the run's tail honestly.
    model: 'glm-5.3-flash',
    provider: 'zai',
    repoRoot: root,
    ...over,
  };
}

/** The fake's per-case modeled cost (the denominator the gating test divides). */
function fakeCaseCost(): number {
  const cost = computeCostUSD(
    { model: 'glm-5.3-flash', provider: 'zai' },
    { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
  );
  expect(cost, 'glm-5.3-flash must stay priced (the F1 price-map pin) — the gating test derives its cap from it').toBeDefined();
  return cost as number;
}

const ajv = ajvFormats(new Ajv2020({ allErrors: true }));
const validateRow = ajv.compile(ajvRow);
const validateTable = ajv.compile(ajvTable);

function assertSchemaValid(rows: ResultRow[], tables: unknown[]): void {
  for (const row of rows) expect(validateRow(row), `row ${row.case}: ${ajv.errorsText(validateRow.errors)}`).toBe(true);
  for (const table of tables) expect(validateTable(table), `table: ${ajv.errorsText(validateTable.errors)}`).toBe(true);
}

describe('d9PerCaseUsd (the accepted D9 envelope, RS-9 @ dfe66be)', () => {
  it('maps exactly the accepted cells: 0.05 ai-sdk flash, 0.10 claude-agent/subprocess/acp GLM, 1.00 frontier', () => {
    expect(d9PerCaseUsd('ai-sdk', 'glm-5.3-flash')).toBe(0.05);
    expect(d9PerCaseUsd('ai-sdk', 'deepseek-flash')).toBe(0.05);
    expect(d9PerCaseUsd('claude-agent', 'glm-5.3-flash')).toBe(0.1);
    expect(d9PerCaseUsd('subprocess', 'glm-5.3-flash')).toBe(0.1);
    expect(d9PerCaseUsd('acp', 'glm-5.3-flash')).toBe(0.1);
    // The frontier ceiling reference (RS-9 §0.4). The CLI's ADR-0001 axis
    // guard still refuses the model on a non-ai-sdk lane today; the entry
    // documents the envelope for when the axis opens.
    expect(d9PerCaseUsd('claude-agent', 'claude-opus-5-5')).toBe(1.0);
  });

  it('returns undefined for unmapped cells — the caller must fail closed, never guess a cap', () => {
    // The retired pre-2026-09-18 request id was never an envelope cell.
    expect(d9PerCaseUsd('ai-sdk', 'deepseek-chat')).toBeUndefined();
    expect(d9PerCaseUsd('ai-sdk', 'claude-opus-5-5')).toBeUndefined();
    expect(d9PerCaseUsd('subprocess', 'deepseek-flash')).toBeUndefined();
    expect(d9PerCaseUsd('telepathy', 'glm-5.3-flash')).toBeUndefined();
  });

  it('matches whole keys only — no substring or case drift', () => {
    expect(d9PerCaseUsd('ai-sdk', 'glm-5.3-flash-x')).toBeUndefined();
    expect(d9PerCaseUsd('ai-sdk/', 'glm-5.3-flash')).toBeUndefined();
    expect(Object.keys(D9_PER_CASE_USD)).toHaveLength(6);
  });
});

describe('perSuiteUsdCap (the USD mirror of WB-1.6)', () => {
  it('multiplies the per-case budget by the case count and kills float epsilon', () => {
    // 0.05 * 40 is 2.0000000000000004 in IEEE-754 — the recorded cap must be
    // the cap the governor compares against, exactly.
    expect(perSuiteUsdCap(0.05, 40)).toBe(2);
    expect(perSuiteUsdCap(0.1, 5)).toBe(0.5);
    expect(perSuiteUsdCap(1, 3)).toBe(3);
  });

  it('accepts an empty suite (0 cases → 0 cap) and never trips on zero usage', () => {
    expect(perSuiteUsdCap(0.05, 0)).toBe(0);
  });

  it('throws on non-finite, negative, or fractional inputs (fail loud, never fail open)', () => {
    expect(() => perSuiteUsdCap(Number.NaN, 1)).toThrow(RangeError);
    expect(() => perSuiteUsdCap(Number.POSITIVE_INFINITY, 1)).toThrow(RangeError);
    expect(() => perSuiteUsdCap(-0.05, 1)).toThrow(RangeError);
    expect(() => perSuiteUsdCap(0.05, 1.5)).toThrow(RangeError);
    expect(() => perSuiteUsdCap(0.05, -1)).toThrow(RangeError);
  });
});

describe('budget-gated undispatched cases are explicit absences (never silent no-rows)', () => {
  it('records each gated case in absences[] with a budget-stop cause while the dispatched tail keeps its rows', async () => {
    const dir = reviewSuite('gate-suite', 'gate-suite', [
      reviewCase('g-1', 'resolved'),
      reviewCase('g-2', 'resolved'),
      reviewCase('g-3', 'resolved'),
    ]);
    // Cap each case at a quarter of its real cost: the summed run cap (half
    // a case's cost) trips on the FIRST observation, so g-2 and g-3 are
    // refused admission — the honest tail-gating shape W6.2 records.
    const perCase = fakeCaseCost() / 4;
    const result = await runSuite(opts(dir, { maxUsdPerCase: perCase }));

    expect(result.gatedByBudget).toBe(true);
    expect(result.rows.map((r) => r.case)).toEqual(['g-1']);
    expect(result.absences).toHaveLength(2);
    expect(result.absences.map((a) => a.case)).toEqual(['g-2', 'g-3']);
    for (const a of result.absences) {
      expect(a.role).toBe('review-classifier');
      expect(a.cause).toMatch(/^budget-stop: /);
    }
    // The denominator rides the rows: the run's cells know the suite
    // expected 3 cases even though 2 never produced rows.
    expect(result.rows[0]?.expectedCases).toBe(3);
    expect(result.tables[0]?.cells).toEqual([
      expect.objectContaining({
        runs: 1,
        expectedCases: 3,
        coveredCases: 1,
        coverage: 1 / 3,
      }),
    ]);
    expect(result.tables[0]?.cells[0]?.budgetStops).toBeUndefined();
    assertSchemaValid(result.rows, result.tables);
  }, 15_000);
});

describe('a dispatched case stopped on its per-case budget keeps an honest row with the cause column', () => {
  /** Records the invocations it saw, then stops every case on the budget. */
  function budgetStopDriver(invocations: OpInvocation[]): Driver {
    return {
      async run(invocation: OpInvocation): Promise<WorkerResult> {
        invocations.push(invocation);
        return {
          model: invocation.modelSpec.model,
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'budget',
        };
      },
    };
  }

  it('the row stays (stopCause budget), the cell counts budgetStops, and coverage excludes it', async () => {
    const invocations: OpInvocation[] = [];
    const dir = reviewSuite('stop-suite', 'stop-suite', [reviewCase('s-1', 'resolved'), reviewCase('s-2', 'resolved')]);
    const result = await runSuite(opts(dir, { driver: budgetStopDriver(invocations), maxUsdPerCase: 0.05 }));

    // The per-case budget rode the invocation grain (the lanes whose driver
    // honors Budget.maxUsd stop on exactly this).
    expect(invocations).toHaveLength(2);
    for (const inv of invocations) expect(inv.budget.maxUsd).toBe(0.05);

    // Both cases RAN and both rows are honest incomplete outcomes — never
    // fabricated completions, never absences.
    expect(result.gatedByBudget).toBe(false);
    expect(result.absences).toEqual([]);
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.stopCause).toBe('budget');
      expect(row.outcome).toEqual({ score: 0, passed: 0, total: 1 });
      expect(row.expectedCases).toBe(2);
    }
    expect(result.tables[0]?.cells).toEqual([
      expect.objectContaining({
        runs: 2,
        expectedCases: 2,
        coveredCases: 0,
        coverage: 0,
        budgetStops: 2,
      }),
    ]);
    assertSchemaValid(result.rows, result.tables);
  }, 15_000);

  it('a mixed run: the complete case covers, the stopped case only counts in budgetStops', async () => {
    const dir = reviewSuite('mixed-suite', 'mixed-suite', [reviewCase('m-1', 'resolved'), reviewCase('m-2', 'resolved')]);
    let first = true;
    const driver: Driver = {
      async run(): Promise<WorkerResult> {
        const stop = !first;
        first = false;
        return stop
          ? { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, denials: [], stopReason: 'budget' }
          : { model: 'glm-5.3-flash', structuredOutput: { verdict: 'resolved' }, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, denials: [], stopReason: 'complete' };
      },
    };
    const result = await runSuite(opts(dir, { driver, maxUsdPerCase: 0.05 }));
    expect(result.rows.map((r) => r.stopCause)).toEqual([undefined, 'budget']);
    expect(result.tables[0]?.cells).toEqual([
      expect.objectContaining({ runs: 2, expectedCases: 2, coveredCases: 1, coverage: 0.5, budgetStops: 1 }),
    ]);
    assertSchemaValid(result.rows, result.tables);
  }, 15_000);
});

describe('coverage columns and parity (aggregate, W6.2)', () => {
  function row(over: Partial<ResultRow>): ResultRow {
    return {
      role: 'review-classifier',
      suite: 'cov-suite',
      case: 'c-1',
      model: 'glm-5.3-flash',
      driver: 'ai-sdk',
      outcome: { score: 1, passed: 1, total: 1 },
      costUSD: null,
      wallTimeMs: 1,
      tokens: { input: 1, output: 1 },
      runId: 'r',
      timestamp: '2026-09-25T00:00:00Z',
      ...over,
    };
  }

  it('cells carry expectedCases/coveredCases/coverage; a budget stop breaks coverage', () => {
    const tables = aggregate([
      row({ case: 'a', expectedCases: 3 }),
      row({ case: 'b', expectedCases: 3, stopCause: 'budget' }),
    ]);
    expect(tables[0]?.cells).toEqual([
      expect.objectContaining({
        expectedCases: 3,
        coveredCases: 1,
        coverage: 1 / 3,
        budgetStops: 1,
      }),
    ]);
  });

  it('pre-W6.2 rows (no expectedCases) aggregate to their original cell shape — old tables stay byte-compatible', () => {
    const tables = aggregate([row({ case: 'a' }), row({ case: 'b' })]);
    const cell = tables[0]?.cells[0] as ComparisonTableCell;
    expect(cell.expectedCases).toBeUndefined();
    expect(cell.coveredCases).toBeUndefined();
    expect(cell.coverage).toBeUndefined();
    expect(cell.budgetStops).toBeUndefined();
  });

  it('conflicting expectedCases across a cell is malformed input — throw, never an arbitrary denominator', () => {
    expect(() => aggregate([row({ case: 'a', expectedCases: 2 }), row({ case: 'b', expectedCases: 5 })]))
      .toThrow(/conflicting expectedCases/);
  });

  it('isAtCoverageParity: parity is both cells at coverage 1; unknown coverage is below parity, never assumed equal', () => {
    // The helper reads ONLY the coverage columns (a comparison view over
    // whole cells), so partial literals stand in for them here.
    const full = { coverage: 1 } as ComparisonTableCell;
    const partial = { coverage: 0.5 } as ComparisonTableCell;
    expect(isAtCoverageParity(full, full)).toBe(true);
    expect(isAtCoverageParity(full, partial)).toBe(false);
    // A pre-W6.2 cell carries no coverage columns — it cannot claim parity.
    expect(isAtCoverageParity({} as ComparisonTableCell, full)).toBe(false);
    expect(isAtCoverageParity({} as ComparisonTableCell, {} as ComparisonTableCell)).toBe(false);
  });
});

describe('fail-closed per-case USD resolution at the CLI (W6.2)', () => {
  function cliArgs(suiteDir: string, driverName: string, model: string): string[] {
    return ['--suite', suiteDir, '--driver', 'fake', '--driver-name', driverName, '--model', model, '--provider', 'zai'];
  }

  it('a cell the D9 table does not map, with no explicit flag, exits 2 before any dispatch', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dir = reviewSuite('unmapped', 'unmapped', [repoReviewCase('u-1', 'resolved')]);
      // deepseek-chat: the retired request id was never an envelope cell.
      const code = await cliMain(cliArgs(dir, 'ai-sdk', 'deepseek-chat'));
      expect(code).toBe(2);
      const text = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(text).toMatch(/no D9 per-case USD budget maps the cell ai-sdk\/deepseek-chat/);
      expect(text).toMatch(/fail closed/);
      expect(text).toMatch(/--max-usd-per-case/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('an explicit --max-usd-per-case runs the unmapped cell and records basis explicit', async () => {
    // The suite pins the id it runs with (B3 would refuse a mismatch).
    const dir = writeSuite('explicit', {
      name: 'explicit',
      role: 'review-classifier',
      servedModel: 'deepseek-chat',
      provenance: { origin: 'hand-seeded' },
      cases: [repoReviewCase('e-1', 'resolved')],
    });
    const out = join(root, 'out-explicit');
    const code = await cliMain([...cliArgs(dir, 'ai-sdk', 'deepseek-chat'), '--max-usd-per-case', '0.5', '--out', out]);
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')) as { runs: Array<Record<string, unknown>> };
    expect(manifest.runs[0]?.expectedCases).toBe(1);
    expect(manifest.runs[0]?.maxUsdPerCase).toBe(0.5);
    expect(manifest.runs[0]?.maxUsdPerCaseBasis).toBe('explicit');
  }, 15_000);

  it('a mapped cell with no flag applies the D9 default and records basis d9-default', async () => {
    const dir = reviewSuite('d9', 'd9', [repoReviewCase('d-1', 'resolved')]);
    const out = join(root, 'out-d9');
    const code = await cliMain([...cliArgs(dir, 'subprocess', 'glm-5.3-flash'), '--out', out]);
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')) as { runs: Array<Record<string, unknown>> };
    expect(manifest.runs[0]?.maxUsdPerCase).toBe(0.1);
    expect(manifest.runs[0]?.maxUsdPerCaseBasis).toBe('d9-default');
    expect(manifest.runs[0]?.expectedCases).toBe(1);
    // The rows carry the same denominator, so coverage is computable from
    // rows.jsonl alone.
    const rows = (readFileSync(join(out, 'rows.jsonl'), 'utf8').trim().split('\n') ?? []).map(
      (l) => JSON.parse(l) as ResultRow,
    );
    expect(rows[0]?.expectedCases).toBe(1);
  }, 15_000);

  it('a legacy --max-usd alone keeps its exact pre-W6.2 semantics and records no per-case fields', async () => {
    const dir = reviewSuite('legacy-usd', 'legacy-usd', [repoReviewCase('l-1', 'resolved')]);
    const out = join(root, 'out-legacy');
    const code = await cliMain([...cliArgs(dir, 'ai-sdk', 'glm-5.3-flash'), '--max-usd', '5', '--out', out]);
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')) as { runs: Array<Record<string, unknown>> };
    expect(manifest.runs[0]?.maxUsdPerCase).toBeUndefined();
    expect(manifest.runs[0]?.maxUsdPerCaseBasis).toBeUndefined();
    expect(manifest.runs[0]?.expectedCases).toBe(1);
  }, 15_000);

  it('--max-usd and --max-usd-per-case are mutually exclusive (one dimension, two grains)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dir = reviewSuite('clash', 'clash', [repoReviewCase('x-1', 'resolved')]);
      const code = await cliMain([...cliArgs(dir, 'ai-sdk', 'glm-5.3-flash'), '--max-usd', '5', '--max-usd-per-case', '0.05']);
      expect(code).toBe(2);
      expect(errSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/mutually exclusive/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('--max-usd-per-case accepts fractional USD and refuses non-positive values', async () => {
    const dir = reviewSuite('frac', 'frac', [repoReviewCase('f-1', 'resolved')]);
    await expect(cliMain([...cliArgs(dir, 'ai-sdk', 'glm-5.3-flash'), '--max-usd-per-case', '0.05'])).resolves.toBe(0);
    await expect(cliMain([...cliArgs(dir, 'ai-sdk', 'glm-5.3-flash'), '--max-usd-per-case', '0'])).resolves.toBe(2);
    await expect(cliMain([...cliArgs(dir, 'ai-sdk', 'glm-5.3-flash'), '--max-usd-per-case', '-1'])).resolves.toBe(2);
  }, 15_000);
});
