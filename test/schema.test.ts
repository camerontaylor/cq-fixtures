import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020';
import ajvFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

// Schema contract for the three JSON Schemas in schema/ (plan §8 field list,
// ADR-0001 eval axes, served-id decision 2026-09-14, DD-9 null cost).
// ajv-formats registers "date-time", so format: "date-time" is enforced.
const ajv = ajvFormats(new Ajv2020({ allErrors: true }));

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(new URL(`../schema/${name}`, import.meta.url), 'utf8')) as object;
}

const rowSchema = ajv.compile(loadSchema('result-row.schema.json'));
const tableSchema = ajv.compile(loadSchema('comparison-table.schema.json'));
const suiteSchema = ajv.compile(loadSchema('suite.schema.json'));

interface RowSample {
  role: string;
  suite: string;
  model: string;
  driver: string;
  outcome: { score: number; passed: number; total: number };
  // Optional in the sample type so tests can `delete` these to check rejection.
  costUSD?: number | null;
  costBasis?: string;
  wallTimeMs: number;
  tokens: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
  };
  runId: string;
  timestamp: string;
  // Optional at schema grain (not in required); typed here so the acceptance
  // test can pass it through validRow's overrides.
  case?: string;
  // F4 additive-optional fields: per-probe observed outcomes + the
  // suspicious-benign flag. Old rows omit both by design.
  probes?: Array<{ kind: string; expected: string; observed: string | null; passed: boolean }>;
  suspiciousBenign?: boolean;
  // P5: historical fixer-run evidence marker; fixer-worker only.
  invalid?: string;
  // F6 additive-optional field: the prompt/tool-surface bundle id. Old rows
  // (and default-posture rows) omit it by design.
  variant?: string;
}

function validRow(overrides: Partial<RowSample> = {}): RowSample {
  return {
    role: 'fixer-worker',
    suite: 'seeded-null-guard',
    model: 'glm-5.3-flash',
    driver: 'ai-sdk',
    outcome: { score: 0.75, passed: 3, total: 4 },
    costUSD: 0.0123,
    costBasis: 'billed',
    wallTimeMs: 42_000,
    tokens: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0, reasoning: 96 },
    runId: 'run-2026-09-15-a',
    timestamp: '2026-09-15T00:00:00Z',
    ...overrides,
  };
}

describe('result-row schema (plan §8 field list)', () => {
  it('accepts a fully-populated result row', () => {
    expect(rowSchema(validRow({ role: 'review-classifier', driver: 'acp' }))).toBe(true);
  });

  it('accepts a row carrying the optional case id linking back to its scored case', () => {
    expect(rowSchema(validRow({ case: 'case-1' }))).toBe(true);
  });

  it('accepts a subscription-lane row whose costUSD is null (DD-9)', () => {
    const row = validRow({ costUSD: null });
    delete row.costBasis;
    expect(rowSchema(row)).toBe(true);
  });

  it('rejects a row pairing a null costUSD with a costBasis — basis is only defined for non-null cost', () => {
    expect(rowSchema(validRow({ costUSD: null, costBasis: 'billed' }))).toBe(false);
  });

  it('accepts a row pairing a numeric costUSD with its costBasis', () => {
    expect(rowSchema(validRow({ costUSD: 0.01, costBasis: 'billed' }))).toBe(true);
  });

  it('rejects billed accounting without a finite non-negative numeric costUSD', () => {
    expect(rowSchema(validRow({ costUSD: null, costBasis: 'billed' }))).toBe(false);
    expect(rowSchema(validRow({ costUSD: -0.01, costBasis: 'billed' }))).toBe(false);
  });

  it('rejects modeled accounting paired with a null costUSD', () => {
    expect(rowSchema(validRow({ costUSD: null, costBasis: 'modeled' }))).toBe(false);
  });

  it('rejects a row whose timestamp is not a valid RFC 3339 date-time', () => {
    expect(rowSchema(validRow({ timestamp: 'not-a-date' }))).toBe(false);
  });

  it('accepts a row with a valid RFC 3339 date-time timestamp', () => {
    expect(rowSchema(validRow({ timestamp: '2026-09-15T12:34:56Z' }))).toBe(true);
  });

  it('rejects a row with costUSD removed — the field is required even when null', () => {
    const row = validRow();
    delete row.costUSD;
    expect(rowSchema(row)).toBe(false);
  });

  it('rejects a row with an unknown driver enum value', () => {
    expect(rowSchema(validRow({ driver: 'cursor-cli' }))).toBe(false);
  });

  it('rejects a row with outcome.score = 1.5', () => {
    const row = validRow({ outcome: { score: 1.5, passed: 6, total: 4 } });
    expect(rowSchema(row)).toBe(false);
  });

  it('accepts a classifier row carrying probes[] with the observed verdict + the suspicious-benign flag (F4)', () => {
    expect(rowSchema(validRow({
      role: 'review-classifier',
      outcome: { score: 0, passed: 0, total: 1 },
      case: 'bv-01',
      probes: [{ kind: 'expected-verdict', expected: 'skip', observed: 'actionable', passed: false }],
      suspiciousBenign: true,
    }))).toBe(true);
  });

  it('accepts a row whose probe observed is null (missing/unparseable verdict is a miss, never a match)', () => {
    expect(rowSchema(validRow({
      role: 'review-classifier',
      outcome: { score: 0, passed: 0, total: 1 },
      probes: [{ kind: 'expected-verdict', expected: 'resolved', observed: null, passed: false }],
    }))).toBe(true);
  });

  it('rejects a probes[] entry missing passed', () => {
    const row = validRow();
    (row as { probes?: unknown }).probes = [{ kind: 'expected-verdict', expected: 'skip', observed: null }];
    expect(rowSchema(row)).toBe(false);
  });

  it('rejects a probes[] entry missing observed (CodeRabbit cycle-1: required matches the TS contract)', () => {
    const row = validRow();
    (row as { probes?: unknown }).probes = [{ kind: 'expected-verdict', expected: 'skip', passed: false }];
    expect(rowSchema(row)).toBe(false);
  });

  it('rejects a probes[] entry with an undeclared key (probes are closed)', () => {
    const row = validRow();
    (row as { probes?: unknown }).probes = [
      { kind: 'expected-verdict', expected: 'skip', observed: 'skip', passed: true, notes: 'extra' },
    ];
    expect(rowSchema(row)).toBe(false);
  });

  it('rejects a probes[] entry with a non-vocabulary kind (CodeRabbit bot T3: typos must not silently leave the metrics)', () => {
    const row = validRow();
    (row as { probes?: unknown }).probes = [{ kind: 'check-rerun', expected: 'skip', observed: 'skip', passed: true }];
    expect(rowSchema(row)).toBe(false);
  });

  it('rejects a probes[] entry with a non-vocabulary expected verdict (CodeRabbit bot T3)', () => {
    const row = validRow();
    (row as { probes?: unknown }).probes = [{ kind: 'expected-verdict', expected: 'maybe', observed: 'skip', passed: false }];
    expect(rowSchema(row)).toBe(false);
  });

  it('accepts a probes[] entry with an out-of-vocabulary observed (OOV observations are intentionally preserved)', () => {
    expect(rowSchema(validRow({
      role: 'review-classifier',
      outcome: { score: 0, passed: 0, total: 1 },
      probes: [{ kind: 'expected-verdict', expected: 'skip', observed: 'maybe', passed: false }],
    }))).toBe(true);
  });

  it('accepts workspace-unbound only on a fixer-worker row', () => {
    expect(rowSchema(validRow({ invalid: 'workspace-unbound' }))).toBe(true);
    expect(rowSchema(validRow({
      role: 'review-classifier',
      invalid: 'workspace-unbound',
    }))).toBe(false);
  });

  it('accepts a row carrying a non-default suite variant (F6/CQ-4)', () => {
    expect(rowSchema(validRow({ variant: 'minimal-tools' }))).toBe(true);
  });

  it('rejects a row variant that is not a path-safe slug (F6)', () => {
    expect(rowSchema(validRow({ variant: 'a/b' }))).toBe(false);
  });
});

describe('comparison-table schema (ADR-0001 axes)', () => {
  function validTable() {
    return {
      role: 'fixer-worker',
      suite: 'seeded-null-guard',
      generatedAt: '2026-09-15T00:00:00Z',
      cells: [
        {
          // Axis 1: models vary on the ai-sdk driver.
          model: 'glm-5.3-flash',
          driver: 'ai-sdk',
          runs: 4,
          passed: 3,
          total: 4,
          score: 0.75,
          costUSD: 0.0492,
          costBasis: 'modeled',
          wallTimeMs: 168_000,
          tokens: { input: 4800, output: 1360, reasoning: 384 },
        },
        {
          // Axis 1 varies models on the ai-sdk driver: a second served id.
          model: 'deepseek-chat',
          driver: 'ai-sdk',
          runs: 2,
          passed: 1,
          total: 2,
          score: 0.5,
          costUSD: 0.0042,
          costBasis: 'modeled',
          wallTimeMs: 63_000,
          tokens: { input: 2500, output: 660 },
        },
        {
          // Axis 2: drivers vary on the fixed GLM served id.
          model: 'glm-5.3-flash',
          driver: 'claude-agent',
          runs: 4,
          passed: 2,
          total: 4,
          score: 0.5,
          costUSD: null,
          wallTimeMs: 152_000,
          tokens: { input: 5200, output: 1100 },
        },
      ],
    };
  }

  it('accepts a table with one cell per axis (ai-sdk cell + fixed-GLM driver cell)', () => {
    expect(tableSchema(validTable())).toBe(true);
  });

  it('accepts workspace-unbound on a fixer cell but rejects it on a classifier cell', () => {
    const fixer = validTable();
    (fixer.cells[0] as Record<string, unknown>)['invalid'] = 'workspace-unbound';
    expect(tableSchema(fixer)).toBe(true);

    const classifier = validTable();
    classifier.role = 'review-classifier';
    (classifier.cells[0] as Record<string, unknown>)['invalid'] = 'workspace-unbound';
    expect(tableSchema(classifier)).toBe(false);
  });

  it('rejects a cell whose aggregate score exceeds 1', () => {
    const table = validTable();
    table.cells[0]!.score = 1.25;
    expect(tableSchema(table)).toBe(false);
  });

  it('rejects a cell with total 0 — rows require outcome.total >= 1, so 0 is degenerate', () => {
    const table = validTable();
    table.cells[0]!.passed = 0;
    table.cells[0]!.total = 0;
    table.cells[0]!.score = 0;
    expect(tableSchema(table)).toBe(false);
  });

  it('rejects a cell missing costUSD — absent cost is not distinguishable from a DD-9 null', () => {
    const table = validTable();
    delete (table.cells[0] as { costUSD?: number | null }).costUSD;
    expect(tableSchema(table)).toBe(false);
  });

  it('accepts a cell whose costUSD is an explicit DD-9 null', () => {
    const table = validTable();
    const cell = table.cells[0] as { costUSD?: number | null; costBasis?: string };
    cell.costUSD = null;
    delete cell.costBasis;
    expect(tableSchema(table)).toBe(true);
  });

  it('rejects a cell missing its summed tokens', () => {
    const table = validTable();
    delete (table.cells[0] as { tokens?: unknown }).tokens;
    expect(tableSchema(table)).toBe(false);
  });

  it('rejects a table whose generatedAt is not a real date-time (month 13, day 99)', () => {
    const table = validTable();
    table.generatedAt = '2026-13-99T00:00:00Z';
    expect(tableSchema(table)).toBe(false);
  });

  it('accepts a table with a valid RFC 3339 generatedAt', () => {
    const table = validTable();
    table.generatedAt = '2026-09-15T12:34:56Z';
    expect(tableSchema(table)).toBe(true);
  });

  it('rejects an out-of-matrix cell: a non-ai-sdk driver carrying a non-GLM model', () => {
    const table = validTable();
    table.cells = [
      {
        model: 'deepseek-chat',
        driver: 'subprocess',
        runs: 2,
        passed: 1,
        total: 2,
        score: 0.5,
        costUSD: null,
        wallTimeMs: 61_000,
        tokens: { input: 2400, output: 620 },
      },
    ];
    expect(tableSchema(table)).toBe(false);
  });

  it('accepts an axis-2 cell: the fixed GLM served id on the acp driver', () => {
    const table = validTable();
    table.cells = [
      {
        model: 'glm-5.3-flash',
        driver: 'acp',
        runs: 2,
        passed: 2,
        total: 2,
        score: 1,
        costUSD: null,
        wallTimeMs: 58_000,
        tokens: { input: 2100, output: 540 },
      },
    ];
    expect(tableSchema(table)).toBe(true);
  });

  it('still accepts an axis-1 cell: a non-GLM model on the ai-sdk driver', () => {
    const table = validTable();
    table.cells = [
      {
        model: 'deepseek-chat',
        driver: 'ai-sdk',
        runs: 2,
        passed: 1,
        total: 2,
        score: 0.5,
        costUSD: 0.0042,
        costBasis: 'modeled',
        wallTimeMs: 63_000,
        tokens: { input: 2500, output: 660 },
      },
    ];
    expect(tableSchema(table)).toBe(true);
  });

  it('accepts an empty cells array — an empty suite yields an empty-but-valid table (J2)', () => {
    const table = validTable();
    table.cells = [];
    expect(tableSchema(table)).toBe(true);
  });

  it('accepts a classifier cell with byVerdict/macroF1/fpRate/fpN (F4)', () => {
    const table = validTable();
    const cell = table.cells[0] as Record<string, unknown>;
    cell['byVerdict'] = {
      actionable: { expected: 2, correct: 1, predicted: { actionable: 1 } },
      responded: { expected: 1, correct: 1, predicted: { responded: 1 } },
      resolved: { expected: 1, correct: 0, predicted: {} },
      blocked: { expected: 1, correct: 1, predicted: { blocked: 1 } },
      skip: { expected: 1, correct: 0, predicted: { actionable: 1 } },
    };
    cell['macroF1'] = 0.5;
    cell['fpRate'] = 0.5;
    cell['fpN'] = 2;
    expect(tableSchema(table)).toBe(true);
  });

  it('rejects a byVerdict with only four verdict keys (exactly five required)', () => {
    const table = validTable();
    const cell = table.cells[0] as Record<string, unknown>;
    cell['byVerdict'] = {
      actionable: { expected: 2, correct: 1, predicted: { actionable: 1 } },
      responded: { expected: 1, correct: 1, predicted: { responded: 1 } },
      resolved: { expected: 1, correct: 0, predicted: {} },
      blocked: { expected: 1, correct: 1, predicted: { blocked: 1 } },
    };
    cell['macroF1'] = 0.5;
    expect(tableSchema(table)).toBe(false);
  });

  it('rejects a byVerdict entry with an out-of-vocabulary predicted key', () => {
    const table = validTable();
    const cell = table.cells[0] as Record<string, unknown>;
    cell['byVerdict'] = {
      actionable: { expected: 1, correct: 0, predicted: { maybe: 1 } },
      responded: { expected: 0, correct: 0, predicted: {} },
      resolved: { expected: 0, correct: 0, predicted: {} },
      blocked: { expected: 0, correct: 0, predicted: {} },
      skip: { expected: 0, correct: 0, predicted: {} },
    };
    expect(tableSchema(table)).toBe(false);
  });

  it('rejects metric pairs split apart (CodeRabbit cycle-1: byVerdict<->macroF1, fpRate<->fpN travel together)', () => {
    const table = validTable();
    const cell = table.cells[0] as Record<string, unknown>;
    cell['byVerdict'] = {
      actionable: { expected: 1, correct: 1, predicted: { actionable: 1 } },
      responded: { expected: 0, correct: 0, predicted: {} },
      resolved: { expected: 0, correct: 0, predicted: {} },
      blocked: { expected: 0, correct: 0, predicted: {} },
      skip: { expected: 0, correct: 0, predicted: {} },
    };
    expect(tableSchema(table)).toBe(false); // byVerdict without macroF1
    cell['macroF1'] = 0.2;
    expect(tableSchema(table)).toBe(true);
    delete cell['byVerdict'];
    expect(tableSchema(table)).toBe(false); // macroF1 without byVerdict
    delete cell['macroF1'];
    cell['fpRate'] = 0.5;
    expect(tableSchema(table)).toBe(false); // fpRate without fpN
    cell['fpN'] = 2;
    expect(tableSchema(table)).toBe(true);
    delete cell['fpRate'];
    expect(tableSchema(table)).toBe(false); // fpN without fpRate
  });

  it('rejects fpRate 1.5 and macroF1 above 1', () => {
    const table = validTable();
    const cell = table.cells[0] as Record<string, unknown>;
    cell['fpRate'] = 1.5;
    cell['fpN'] = 2;
    expect(tableSchema(table)).toBe(false);
    cell['fpRate'] = 0.5;
    cell['macroF1'] = 1.25;
    expect(tableSchema(table)).toBe(false);
  });

  it('accepts a cell carrying a non-default suite variant (F6/CQ-4)', () => {
    const table = validTable();
    (table.cells[0] as Record<string, unknown>)['variant'] = 'minimal-tools';
    expect(tableSchema(table)).toBe(true);
  });

  it('rejects a cell variant that is not a path-safe slug (F6)', () => {
    const table = validTable();
    (table.cells[0] as Record<string, unknown>)['variant'] = 'a/b';
    expect(tableSchema(table)).toBe(false);
  });

  it('accepts a cell carrying the Wilson scoreCI (F6/WB-5.2c)', () => {
    const table = validTable();
    (table.cells[0] as Record<string, unknown>)['scoreCI'] = { lower: 0.52, upper: 0.83, confidence: 0.95 };
    expect(tableSchema(table)).toBe(true);
  });

  it('rejects a scoreCI missing confidence or out of [0,1] (F6)', () => {
    const table = validTable();
    (table.cells[0] as Record<string, unknown>)['scoreCI'] = { lower: 0.52, upper: 0.83 };
    expect(tableSchema(table)).toBe(false);
    (table.cells[0] as Record<string, unknown>)['scoreCI'] = { lower: -0.1, upper: 1.4, confidence: 0.95 };
    expect(tableSchema(table)).toBe(false);
    (table.cells[0] as Record<string, unknown>)['scoreCI'] = { lower: 0.52, upper: 0.83, confidence: 0.95, method: 'wilson' };
    expect(tableSchema(table)).toBe(false);
  });
});

describe('suite schema (ws-j item 3)', () => {
  function validFixerSuite() {
    return {
      name: 'seeded-null-guard',
      role: 'fixer-worker',
      servedModel: 'glm-5.3-flash',
      provenance: { origin: 'hand-seeded' },
      cases: [
        {
          id: 'null-guard-001',
          fixture: 'fixtures/null-guard-repo',
          task: {
            prompt: 'Fix the failing null-guard regression without changing public behavior.',
            notes: 'Fault seeded in src/guard.ts.',
          },
          probe: { kind: 'check-rerun', check: 'fixtures/null-guard-repo/checks/regression.mjs' },
        },
      ],
    };
  }

  function validClassifierSuite() {
    return {
      name: 'thread-verdicts',
      role: 'review-classifier',
      provenance: { origin: 'hand-labeled' },
      cases: [
        {
          id: 'thread-001',
          fixture: 'fixtures/threads/thread-001.json',
          task: { prompt: 'Classify the review thread using the toolkit verdict vocabulary.' },
          probe: { kind: 'expected-verdict', expected: 'actionable' },
        },
      ],
    };
  }

  it('accepts a fixer-worker suite with a check-rerun probe', () => {
    expect(suiteSchema(validFixerSuite())).toBe(true);
  });

  it('accepts a review-classifier suite with an expected-verdict probe', () => {
    expect(suiteSchema(validClassifierSuite())).toBe(true);
  });

  it('rejects a check-rerun probe missing its check path', () => {
    const suite = validFixerSuite();
    delete (suite.cases[0]!.probe as { check?: string }).check;
    expect(suiteSchema(suite)).toBe(false);
  });

  it('rejects an expected-verdict probe with a verdict outside the vocabulary', () => {
    const suite = validClassifierSuite();
    (suite.cases[0]!.probe as { expected: string }).expected = 'maybe';
    expect(suiteSchema(suite)).toBe(false);
  });

  it('rejects a case missing its fixture reference', () => {
    const suite = validClassifierSuite();
    const firstCase = suite.cases[0] as { fixture?: string };
    delete firstCase.fixture;
    expect(suiteSchema(suite)).toBe(false);
  });

  it('rejects a check-rerun probe that also carries an expected verdict — variants are exclusive', () => {
    const suite = validFixerSuite();
    (suite.cases[0]!.probe as { expected?: string }).expected = 'resolved';
    expect(suiteSchema(suite)).toBe(false);
  });

  it('rejects a suite missing its provenance marker', () => {
    const suite = validClassifierSuite();
    delete (suite as { provenance?: unknown }).provenance;
    expect(suiteSchema(suite)).toBe(false);
  });

  it('accepts a suite declaring a non-default variant (F6/CQ-4)', () => {
    const suite = validFixerSuite() as { variant?: string };
    suite.variant = 'minimal-tools';
    expect(suiteSchema(suite)).toBe(true);
  });

  it('rejects a suite variant that is not a path-safe slug (F6)', () => {
    const suite = validFixerSuite() as { variant?: string };
    suite.variant = 'a/b';
    expect(suiteSchema(suite)).toBe(false);
  });

  it('rejects an empty suite variant (minLength 1)', () => {
    const suite = validFixerSuite() as { variant?: string };
    suite.variant = '';
    expect(suiteSchema(suite)).toBe(false);
  });
});

describe('F4 acceptance: committed 2026-09-18 snapshots still validate against the versioned schemas', () => {
  // The load-bearing half of F4 is additive-optional: every committed
  // snapshot (reports/snapshots/2026-09-18, tables only — the snapshot job
  // copies *.table.json) must validate against the NEW table schema, and an
  // old-shape row (the exact pre-F4 field set, no probes) must validate
  // against the NEW row schema.
  const snapDir = fileURLToPath(new URL('../reports/snapshots/2026-09-18', import.meta.url));

  it('every committed snapshot table validates against the NEW table schema and carries none of the F4 fields', () => {
    const files = (readdirSync(snapDir, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.table.json'));
    // Non-vacuous: the 2026-09-18 snapshot commits eight per-cell tables.
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const doc = JSON.parse(readFileSync(join(snapDir, f), 'utf8')) as {
        cells: Array<Record<string, unknown>>;
      };
      expect(tableSchema(doc), `${f}: ${ajv.errorsText(tableSchema.errors)}`).toBe(true);
      for (const cell of doc.cells) {
        for (const k of ['byVerdict', 'macroF1', 'fpRate', 'fpN', 'variant', 'scoreCI']) {
          expect(cell, `${f} cell carries pre-additive-absent key '${k}'`).not.toHaveProperty(k);
        }
      }
    }
  });

  it('an old-shape row (exact pre-F4 field set, no probes) validates against the NEW row schema', () => {
    const oldShape = validRow();
    expect(oldShape).not.toHaveProperty('probes');
    expect(oldShape).not.toHaveProperty('suspiciousBenign');
    expect(rowSchema(oldShape)).toBe(true);
  });
});
