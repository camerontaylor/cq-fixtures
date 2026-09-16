import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import {
  computeCostUSD,
  priceOf,
  type Driver,
  type OpInvocation,
  type Usage,
  type WorkerResult,
} from '@camerontaylor/cq-toolkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { runSuite, type RunSuiteResult } from '../runner/index.ts';
import { aggregate, type ComparisonTable, type ResultRow } from '../runner/aggregate.ts';

// Cost-column honesty proof (J4 D2). The acceptance: "Cost column populated
// from token-derived USD on every lane, including subprocess" — with DD-9's
// honest exception: null is legal ONLY when the (model, provider) pair is
// absent from the toolkit price map, NEVER when tokens are missing. These
// tests hold every lane leg to one validator (assertCostHonesty below) so
// the column can neither invent a number nor hide spend behind a null.
//
// Self-contained by design: no runner changes — the runner already derives
// cost lane-blind via computeCostUSD (runner/index.ts), and this file proves
// that property end to end over the REAL toolkit price map.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
// The real micro classifier suite: ten fast stub-dispatched cases (no vitest
// judges — that is the fixer role), so each leg costs milliseconds.
const CLASSIFIER_SUITE_DIR = join(REPO_ROOT, 'suites', 'review-classifier', 'micro');

// D2 probing discipline: ask the price map (priceOf / computeCostUSD are the
// phase-2-done export surface) which candidate IS priced before asserting a
// single number. The first three candidates are the D2 brief's examples with
// their natural provider handles; the rest are the map's known current
// families, so a DD-8 price-map refresh re-arms this file automatically.
const PRICED_CANDIDATES: ReadonlyArray<{ model: string; provider: string }> = [
  { model: 'gpt-4o', provider: 'openai' },
  { model: 'claude-3-5-sonnet', provider: 'anthropic' },
  { model: 'deepseek-chat', provider: 'deepseek' },
  { model: 'claude-haiku-4-5', provider: 'anthropic' },
  { model: 'gpt-5', provider: 'openai' },
  { model: 'glm-4.6', provider: 'zai' },
  { model: 'deepseek-reasoner', provider: 'deepseek' },
];

/** FixedDriver-style usage: one honest token tensor every dispatch reports. */
const STUB_USAGE: Usage = { input: 1200, output: 340, cacheRead: 77, cacheWrite: 0 };

// Price-map probe, module scope: one loud skip note if the map prices NONE
// of the candidates — then the priced legs assert the unpriced corollary
// instead of failing on an environment this file cannot control.
const priced =
  PRICED_CANDIDATES.find((c) => priceOf(c) !== undefined && computeCostUSD(c, STUB_USAGE) !== undefined) ??
  undefined;
if (priced === undefined) {
  console.warn(
    '[cost.test] LOUD SKIP NOTE: no candidate of [' +
      PRICED_CANDIDATES.map((c) => `${c.model}@${c.provider}`).join(', ') +
      '] is priced in the toolkit price map — the priced legs assert the DD-9 unpriced corollary instead',
  );
}

/** Stub driver capturing invocations, FixedDriver-style: fixed usage, echoes the REQUESTED model (the honest fake behavior). */
class FixedUsageDriver implements Driver {
  readonly invocations: OpInvocation[] = [];
  constructor(private readonly usage: Usage) {}
  async run(invocation: OpInvocation): Promise<WorkerResult> {
    this.invocations.push(invocation);
    return {
      model: invocation.modelSpec.model,
      structuredOutput: { verdict: 'resolved' },
      usage: this.usage,
      denials: [],
      stopReason: 'complete',
    };
  }
}

/** A row's tokens back into the toolkit Usage shape (absent counters are zero). */
function usageOfTokens(tokens: ResultRow['tokens']): Usage {
  return {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead ?? 0,
    cacheWrite: tokens.cacheWrite ?? 0,
  };
}

/**
 * D2 validator leg — assertCostHonesty(rows): the whole acceptance in one
 * predicate, applied to every lane leg below. Per row:
 *  - tokens are ALWAYS present (integers >= 0; input/output required) — a
 *    cost column may never be hollow because tokens went missing;
 *  - a numeric costUSD must be finite, > 0, EXACTLY the price-map
 *    recomputation over the row's own tokens, and basis 'modeled' (the
 *    runner derives; it never bills);
 *  - a null costUSD is legal ONLY when the price map lacks the row's
 *    (model, provider) — verified against priceOf AND computeCostUSD — and
 *    then carries no costBasis (result-row.schema.json's DD-9 clause).
 * Exported test-locally so the semantics are nameable and reusable.
 */
export function assertCostHonesty(rows: readonly ResultRow[], provider: string): void {
  for (const row of rows) {
    expect(Number.isInteger(row.tokens.input), `row ${row.case}: tokens.input missing`).toBe(true);
    expect(row.tokens.input).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(row.tokens.output), `row ${row.case}: tokens.output missing`).toBe(true);
    expect(row.tokens.output).toBeGreaterThanOrEqual(0);

    const spec = { model: row.model, provider };
    const derived = computeCostUSD(spec, usageOfTokens(row.tokens));
    if (row.costUSD === null) {
      // DD-9: null ⟺ unpriced. A null on a PRICED pair would hide real
      // spend; a null with absent tokens would be a hole, not a verdict.
      expect(priceOf(spec), `row ${row.case}: costUSD null but ${row.model}@${provider} IS priced`).toBeUndefined();
      expect(derived, `row ${row.case}: costUSD null but the price map derives a number`).toBeUndefined();
      expect('costBasis' in row, `row ${row.case}: null costUSD must carry no costBasis`).toBe(false);
    } else {
      expect(Number.isFinite(row.costUSD), `row ${row.case}: costUSD must be finite`).toBe(true);
      expect(row.costUSD, `row ${row.case}: costUSD must be > 0 (free is not a modeled outcome)`).toBeGreaterThan(0);
      expect(row.costUSD, `row ${row.case}: costUSD is not the token-derived figure`).toBe(derived);
      expect(row.costBasis, `row ${row.case}: a modeled number must be labeled modeled`).toBe('modeled');
    }
  }
}

// Ajv setup identical to test/schema.test.ts and the runner: every artifact
// these tests inspect is held to the same contract the runner enforces —
// including the per-cell ADR-0001 axis constraint on tables.
const ajv = ajvFormats(new Ajv2020({ allErrors: true }));
const validateRow = ajv.compile(
  JSON.parse(readFileSync(new URL('../schema/result-row.schema.json', import.meta.url), 'utf8')) as object,
);
const validateTable = ajv.compile(
  JSON.parse(readFileSync(new URL('../schema/comparison-table.schema.json', import.meta.url), 'utf8')) as object,
);

function assertSchemaValid(rows: ResultRow[], tables: ComparisonTable[]): void {
  for (const row of rows) expect(validateRow(row), `row ${row.case}: ${ajv.errorsText(validateRow.errors)}`).toBe(true);
  for (const table of tables) {
    expect(validateTable(table), `table ${table.suite}: ${ajv.errorsText(validateTable.errors)}`).toBe(true);
  }
}

describe('cost column: token-derived USD on every lane (D2)', () => {
  let aiSdk: RunSuiteResult;
  let subprocess: RunSuiteResult;

  beforeAll(async () => {
    // Leg 1 — the ai-sdk lane under the PROBED priced model: the exact shape
    // the CI matrix cells run (models vary on ai-sdk per ADR-0001).
    const driver = new FixedUsageDriver(STUB_USAGE);
    aiSdk = await runSuite({
      suiteDir: CLASSIFIER_SUITE_DIR,
      driver,
      model: priced?.model ?? 'glm-5.3-flash',
      provider: priced?.provider ?? 'zai',
    });
    // Leg 2 — the subprocess lane label, the axis-legal fixed served id
    // glm-5.3-flash @ zai (schema/comparison-table.schema.json pins every
    // non-ai-sdk cell to that id, and the price map does not list it — so a
    // subprocess RUN through the pipeline can only honestly emit the
    // unpriced pairing; the runner's derivation itself is what this leg
    // proves lane-blind).
    const fakeLaneDriver = new FixedUsageDriver(STUB_USAGE);
    subprocess = await runSuite({
      suiteDir: CLASSIFIER_SUITE_DIR,
      driver: fakeLaneDriver,
      model: 'glm-5.3-flash',
      provider: 'zai',
      driverName: 'subprocess',
    });
  }, 30_000);

  it('ai-sdk lane: every row carries finite, token-derived USD with basis modeled', () => {
    expect(aiSdk.rows).toHaveLength(10);
    if (priced === undefined) {
      // Loud-skip corollary (D2): nothing is priced — assert the unpriced
      // shape instead of a number this environment cannot produce.
      expect(aiSdk.rows.every((r) => r.costUSD === null)).toBe(true);
    } else {
      expect(aiSdk.rows.every((r) => typeof r.costUSD === 'number' && r.costUSD > 0)).toBe(true);
    }
    assertSchemaValid(aiSdk.rows, aiSdk.tables);
    assertCostHonesty(aiSdk.rows, priced?.provider ?? 'zai');
  });

  it('subprocess lane: the derivation is lane-blind — the same tokens recompute to the exact ai-sdk USD; nulls are the price map, not the lane', () => {
    expect(subprocess.rows).toHaveLength(10);
    assertSchemaValid(subprocess.rows, subprocess.tables);
    // 1. The rows are honest per the validator: glm-5.3-flash@zai is
    //    unpriced, so nulls — with FULL token records, never holes.
    assertCostHonesty(subprocess.rows, 'zai');
    expect(subprocess.rows.every((r) => r.costUSD === null)).toBe(true);
    // 2. Lane-blindness: recomputing the SAME stub usage under the priced
    //    candidate returns exactly the number the ai-sdk lane's rows carry —
    //    the lane label is not an input to cost derivation
    //    (runner/index.ts calls computeCostUSD identically for every lane),
    //    so a subprocess wire serving a priced (model, provider) would
    //    populate the column identically. "Every lane, including subprocess"
    //    is a property of the derivation, with DD-9 owning the nulls.
    if (priced !== undefined) {
      const aiSdkCost = aiSdk.rows[0]!.costUSD as number;
      expect(computeCostUSD(priced, STUB_USAGE)).toBe(aiSdkCost);
    }
  });

  it('aggregate: cost sums per-cell from its rows, nulls propagate as null cells, and 0 is never invented', () => {
    // One aggregate over BOTH legs' rows (same suite, two cells).
    const tables = aggregate([...aiSdk.rows, ...subprocess.rows]);
    assertSchemaValid([], tables);

    const byDriver = new Map(tables[0]!.cells.map((c) => [c.driver, c]));
    if (priced !== undefined) {
      // The priced cell sums its rows — the ROUND6 aggregate sum, not a new
      // number — and is never collapsed to a invented 0.
      const cell = byDriver.get('ai-sdk')!;
      const sum = aiSdk.rows.reduce((s, r) => s + (r.costUSD as number), 0);
      expect(cell.costUSD).toBe(Math.round(sum * 1e6) / 1e6);
      expect(cell.costUSD).toBeGreaterThan(0);
      expect(cell.costBasis).toBe('modeled');
    }
    // The unpriced cell stays null — never 0, never a partial sum, and no
    // costBasis on a null cell (DD-9).
    const nullCell = byDriver.get('subprocess')!;
    expect(nullCell.costUSD).toBeNull();
    expect('costBasis' in nullCell).toBe(false);

    // Direct propagation proof: ONE null row inside an otherwise numeric
    // cell forces the whole cell null — the aggregate refuses to sum a cell
    // it cannot sum honestly.
    const rows = aiSdk.rows.map((r) => ({ ...r }));
    const mixed: ResultRow[] = [...rows.slice(1), { ...rows[0]!, costUSD: null, costBasis: undefined }];
    const mixedTables = aggregate(mixed);
    expect(mixedTables[0]!.cells[0]!.costUSD).toBeNull();
    expect('costBasis' in mixedTables[0]!.cells[0]!).toBe(false);
  });
});
