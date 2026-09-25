// Per-role aggregation of result rows into comparison tables
// (schema/comparison-table.schema.json). Pure: rows in, tables out — no I/O.

export type SuiteRole = 'fixer-worker' | 'review-classifier';

/**
 * The classifier's five verdicts — the expected-verdict vocabulary mirrored
 * from schema/suite.schema.json (the toolkit does not export it).
 */
export type Verdict = 'actionable' | 'responded' | 'resolved' | 'blocked' | 'skip';

/** Iteration order for the verdict vocabulary (stable cell output). */
const VERDICTS: readonly Verdict[] = ['actionable', 'responded', 'resolved', 'blocked', 'skip'];

function isVerdict(s: string): s is Verdict {
  return (VERDICTS as readonly string[]).includes(s);
}

/** Mirror of schema/result-row.schema.json (the fields the runner emits). */
export interface ResultRow {
  role: SuiteRole;
  suite: string;
  case?: string;
  model: string;
  driver: string;
  outcome: { score: number; passed: number; total: number };
  /**
   * F4: per-probe observed outcomes — review-classifier rows carry one
   * entry per scoring probe ({kind: 'expected-verdict', expected, observed,
   * passed}) so the confusion matrix is computable from rows.jsonl. Fixer
   * rows and all pre-F4 rows omit it.
   */
  probes?: Array<{ kind: string; expected: string; observed: string | null; passed: boolean }>;
  /**
   * F4: true when the case's fixture-side label.json carries fp_flag
   * 'suspicious-benign'. Absent otherwise — absence means unflagged.
   */
  suspiciousBenign?: boolean;
  /** P5: historical evidence marked invalid rather than deleted. */
  invalid?: 'workspace-unbound';
  /**
   * F6/CQ-4: the prompt/tool-surface bundle id of the suite this row ran
   * under. Absent for the default posture (and on all pre-F6 rows).
   */
  variant?: string;
  /**
   * W6.2: the declared case count of the suite this row ran, carried by
   * EVERY row so coverage parity is computable from rows.jsonl alone — the
   * budget-gated undispatched cases have no rows by design (I9), so the
   * coverage denominator must ride the rows that did run. Absent on all
   * pre-W6.2 rows (old snapshots re-aggregate to their original tables).
   */
  expectedCases?: number;
  /**
   * W6.2: why this row is incomplete evidence — 'budget' when the driver
   * stopped the case on its budget. The case RAN (the row is an honest
   * incomplete outcome, never fabricated), but it does not count as covered:
   * a budget stop breaks coverage parity (RS-9 §1.3). Absent = the row is
   * the case's complete evidence.
   */
  stopCause?: 'budget';
  costUSD: number | null;
  costBasis?: 'modeled' | 'billed';
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
}

/** Mirror of one schema/comparison-table.schema.json cell. */
export interface ComparisonTableCell {
  model: string;
  driver: string;
  /** F6/CQ-4: prompt/tool-surface bundle id; omitted for the default posture. */
  variant?: string;
  runs: number;
  passed: number;
  total: number;
  score: number;
  /**
   * P5: historical evidence marker. Present when at least one contributing
   * row is invalid; scores are retained unchanged but must not be published as
   * a valid model result.
   */
  invalid?: 'workspace-unbound';
  /**
   * F4: per-verdict confusion counts, present on classifier cells only
   * (cells whose rows carry expected-verdict probes). Exactly the five
   * verdict keys; predicted buckets hold in-vocabulary observed verdicts
   * only. Fixer cells and all pre-F4 tables omit it.
   */
  byVerdict?: Record<Verdict, { expected: number; correct: number; predicted: Partial<Record<Verdict, number>> }>;
  /** F4: mean of the five per-verdict F1 scores; absent wherever byVerdict is absent. */
  macroF1?: number;
  /**
   * W6.2: coverage columns, emitted together whenever the cell's rows carry
   * `expectedCases` (absent on all pre-W6.2 tables, so old tables keep their
   * exact shape). `expectedCases` is the suite's declared case count — the
   * denominator includes cases the run budget gated before dispatch, which
   * have no rows. `coveredCases` counts the DISTINCT case ids whose row is
   * complete evidence (a `stopCause: 'budget'` row does not count — RS-9
   * §1.3: a budget stop breaks coverage parity). `coverage` is the fraction
   * coveredCases/expectedCases; a comparison between cells is at coverage
   * parity only when BOTH sides sit at 1 (see isAtCoverageParity).
   */
  expectedCases?: number;
  /** W6.2: distinct cases with complete-evidence rows; emitted with expectedCases/coverage. */
  coveredCases?: number;
  /** W6.2: coveredCases/expectedCases; emitted with the other two columns. */
  coverage?: number;
  /**
   * W6.2: contributing rows stopped on the case budget (`stopCause:
   * 'budget'`) — the cause column's cell-grain tally. Omitted when zero, so
   * clean cells keep their shape.
   */
  budgetStops?: number;
  /**
   * F4: fraction of the cell's suspicious-benign rows scored wrong.
   * Omitted with fpN when the subset is empty.
   */
  fpRate?: number;
  /** F4: denominator of fpRate — the suspicious-benign row count. Omitted when zero. */
  fpN?: number;
  /**
   * F6 (WB-5.2c): Wilson score interval for the cell's score at 95%
   * confidence, emitted only when the cell's probe total n >= WILSON_MIN_N.
   * Absent on old tables and on small-n cells.
   */
  scoreCI?: { lower: number; upper: number; confidence: number };
  costUSD: number | null;
  costBasis?: 'billed' | 'modeled';
  wallTimeMs: number;
  tokens: ResultRow['tokens'];
}

/** Mirror of schema/comparison-table.schema.json (one table per role). */
export interface ComparisonTable {
  role: SuiteRole;
  suite: string;
  generatedAt: string;
  cells: ComparisonTableCell[];
}

interface CellAccumulator {
  model: string;
  driver: string;
  /** F6/CQ-4: the cell's resolved variant id (default posture when the rows omit it). */
  variant: string;
  runs: number;
  passed: number;
  total: number;
  /** P5: preserve the historical validity marker on the comparison cell. */
  invalid?: 'workspace-unbound';
  /** Per-row costUSD; null marks a DD-9 subscription row. */
  costs: Array<number | null>;
  bases: Array<'billed' | 'modeled'>;
  wallTimeMs: number;
  tokens: Required<ResultRow['tokens']>;
  hasCacheRead: boolean;
  hasCacheWrite: boolean;
  hasReasoning: boolean;
  /** F4: classifier probe entries across the cell's rows (expected-verdict kind only). */
  classifierProbes: Array<{ expected: string; observed: string | null; passed: boolean }>;
  /** F4: suspicious-benign subset tallies (rows flagged AND carrying a classifier probe). */
  fpTotal: number;
  fpWrong: number;
  /** W6.2: the suite's declared case count from the rows (conflicting values = malformed rows). */
  expectedCases?: number;
  /** W6.2: distinct case ids whose rows are complete evidence (budget stops excluded). */
  covered: Set<string>;
  /** W6.2: contributing rows stopped on the case budget. */
  budgetStops: number;
}

/** Cost sums are rounded to 6 decimals — finer precision is price-map noise. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** F6 (WB-5.2c): the n >= 30 floor below which a Wilson interval is not emitted. */
export const WILSON_MIN_N = 30;
/** 95% two-sided normal quantile for the Wilson score interval. */
export const WILSON_Z_95 = 1.959963984540054;

/**
 * F6 (WB-5.2c): Wilson score interval for passed/total at the given z,
 * clamped to [0,1]. n = 0 returns {0,0} (unreachable for a cell: total >=
 * runs >= 1). The Wilson interval is used over the normal approximation
 * because scores sit near 0 or 1 at small n, where the normal interval is
 * wrong (it can exceed [0,1]).
 */
export function wilsonInterval(
  passed: number,
  total: number,
  z: number = WILSON_Z_95,
): { lower: number; upper: number } {
  if (total <= 0) return { lower: 0, upper: 0 };
  const n = total;
  const phat = passed / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom;
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

/**
 * F4: build a classifier cell's confusion matrix and macro-F1 from its
 * probe entries. Every cell carries all five verdict keys, even with zero
 * expected rows (that verdict's F1 is then 0). Correctness is computed as
 * observed === expected, not from the row's passed flag, so the matrix is
 * self-consistent with its own inputs. A null or out-of-vocabulary observed
 * verdict is a miss with no predicted bucket: it increments the expected
 * count (a false negative) without crediting any prediction (no false
 * positive anywhere). A probe whose EXPECTED value is outside the
 * vocabulary cannot be bucketed and is skipped — unreachable via runSuite
 * (the suite schema constrains expected), but aggregate() is pure and
 * callable with hand-built rows. Per-verdict F1 = 2TP/(2TP+FP+FN), 0 when
 * the denominator is 0; macroF1 is the mean of the five.
 */
function buildVerdictStats(
  probes: ReadonlyArray<{ expected: string; observed: string | null; passed: boolean }>,
): { byVerdict: NonNullable<ComparisonTableCell['byVerdict']>; macroF1: number } {
  const byVerdict = {} as NonNullable<ComparisonTableCell['byVerdict']>;
  for (const v of VERDICTS) byVerdict[v] = { expected: 0, correct: 0, predicted: {} };
  const predictedAs: Record<Verdict, number> = { actionable: 0, responded: 0, resolved: 0, blocked: 0, skip: 0 };
  for (const p of probes) {
    if (!isVerdict(p.expected)) continue;
    byVerdict[p.expected].expected += 1;
    if (p.observed === p.expected) byVerdict[p.expected].correct += 1;
    if (p.observed !== null && isVerdict(p.observed)) {
      predictedAs[p.observed] += 1;
      const bucket = byVerdict[p.expected].predicted;
      bucket[p.observed] = (bucket[p.observed] ?? 0) + 1;
    }
  }
  let f1Sum = 0;
  for (const v of VERDICTS) {
    const tp = byVerdict[v].correct;
    const fp = predictedAs[v] - tp;
    const fn = byVerdict[v].expected - tp;
    const denom = 2 * tp + fp + fn;
    f1Sum += denom === 0 ? 0 : (2 * tp) / denom;
  }
  return { byVerdict, macroF1: f1Sum / VERDICTS.length };
}

/**
 * W6.2 (RS-9 §1.3): the mechanical coverage-parity check a comparison must
 * pass before it may be labelled anything stronger than *descriptive* —
 * both cells sit at coverage 1, i.e. every expected case published complete
 * evidence on BOTH sides. A cell without the coverage columns (a pre-W6.2
 * table) cannot claim parity: unknown coverage is reported as below parity,
 * never assumed equal. Case-SET identity (two cells each covering n but
 * DIFFERENT cases) is checked by pairing rows.jsonl case ids — the table's
 * counts stay losslessly recoverable from the rows.
 */
export function isAtCoverageParity(a: ComparisonTableCell, b: ComparisonTableCell): boolean {
  return a.coverage !== undefined && b.coverage !== undefined && a.coverage === 1 && b.coverage === 1;
}

/**
 * Aggregate rows into one table per role present in the rows. A role with no
 * rows yields no table; runSuite synthesizes an empty-but-valid table
 * (cells: [], schema-legal) for a requested suite role that produced zero
 * rows — the empty-suite form.
 */
export function aggregate(rows: readonly ResultRow[]): ComparisonTable[] {
  const byRole = new Map<SuiteRole, ResultRow[]>();
  for (const row of rows) {
    if (row.role === 'review-classifier' && row.invalid !== undefined) {
      throw new Error(`aggregate: review-classifier row ${row.runId}/${row.case ?? '(no case)'} carries fixer-only invalid marker '${row.invalid}'`);
    }
    const bucket = byRole.get(row.role) ?? [];
    bucket.push(row);
    byRole.set(row.role, bucket);
  }
  const tables: ComparisonTable[] = [];
  for (const [role, roleRows] of byRole) tables.push(aggregateRole(role, roleRows));
  return tables;
}

function aggregateRole(role: SuiteRole, rows: readonly ResultRow[]): ComparisonTable {
  const suite = rows[0]!.suite;
  for (const row of rows) {
    if (row.suite !== suite) {
      throw new Error(
        `aggregate: rows for role '${role}' span suites '${suite}' and '${row.suite}' — aggregate one suite at a time`,
      );
    }
  }
  const cells = new Map<string, CellAccumulator>();
  for (const row of rows) {
    // F6/CQ-4: the variant is part of the cell identity — two variants of one
    // suite on the same (model, driver) must land as DISTINCT cells, never
    // collide. Absent variant = the default posture.
    const key = `${row.model}\n${row.driver}\n${row.variant ?? 'default'}`;
    let acc = cells.get(key);
    if (acc === undefined) {
      acc = {
        model: row.model,
        driver: row.driver,
        variant: row.variant ?? 'default',
        runs: 0,
        passed: 0,
        total: 0,
        costs: [],
        bases: [],
        wallTimeMs: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        hasCacheRead: false,
        hasCacheWrite: false,
        hasReasoning: false,
        classifierProbes: [],
        fpTotal: 0,
        fpWrong: 0,
        covered: new Set<string>(),
        budgetStops: 0,
      };
      cells.set(key, acc);
    }
    acc.runs += 1;
    if (row.invalid !== undefined) acc.invalid = row.invalid;
    acc.passed += row.outcome.passed;
    acc.total += row.outcome.total;
    // W6.2: fold the coverage inputs. Every row of a suite carries the same
    // expectedCases (it is the suite's declared case count), so a conflict
    // means the rows themselves are malformed — throw rather than emit a
    // table with an arbitrary denominator. A budget-stopped row is real
    // evidence of a partial run but NOT coverage: the case's evidence is
    // incomplete (RS-9 §1.3 puts budget stops on the parity-breaking list
    // beside absences and timeouts).
    if (row.expectedCases !== undefined) {
      if (acc.expectedCases !== undefined && acc.expectedCases !== row.expectedCases) {
        throw new Error(
          `aggregate: rows for role '${role}' carry conflicting expectedCases ` +
            `${acc.expectedCases} and ${row.expectedCases} — coverage needs one suite-wide denominator`,
        );
      }
      acc.expectedCases = row.expectedCases;
    }
    if (row.stopCause === 'budget') acc.budgetStops += 1;
    else if (row.case !== undefined) acc.covered.add(row.case);
    // F4: fold classifier probes into the cell's verdict tallies. A row may
    // carry several probes; each expected-verdict entry counts once in the
    // confusion. The fp subset is per ROW, not per probe (CodeRabbit bot
    // thread T1): a flagged row counts once in fpTotal however many probes
    // it carries, and is fpWrong once iff ANY of its classifier probes
    // observed actionable. runSuite emits exactly one entry per classifier
    // row, so the row-once rule only binds schema-valid rows from elsewhere.
    if (row.probes !== undefined) {
      let flaggedRowSawActionable = false;
      let flaggedRowHasProbe = false;
      for (const p of row.probes) {
        if (p.kind !== 'expected-verdict') continue;
        acc.classifierProbes.push({ expected: p.expected, observed: p.observed ?? null, passed: p.passed });
        if (row.suspiciousBenign === true) {
          flaggedRowHasProbe = true;
          // FP-rate-on-suspicious-benign means "the model cried wolf":
          // only an observed actionable on a benign case is a false
          // positive. Any other miss (wrong non-actionable verdict, or a
          // null observed from an unparseable answer) is a miss, not an FP.
          if (p.observed === 'actionable') flaggedRowSawActionable = true;
        }
      }
      if (row.suspiciousBenign === true && flaggedRowHasProbe) {
        acc.fpTotal += 1;
        if (flaggedRowSawActionable) acc.fpWrong += 1;
      }
    }
    acc.costs.push(row.costUSD);
    if (row.costBasis !== undefined) acc.bases.push(row.costBasis);
    acc.wallTimeMs += row.wallTimeMs;
    acc.tokens.input += row.tokens.input;
    acc.tokens.output += row.tokens.output;
    if (row.tokens.cacheRead !== undefined) {
      acc.hasCacheRead = true;
      acc.tokens.cacheRead += row.tokens.cacheRead;
    }
    if (row.tokens.cacheWrite !== undefined) {
      acc.hasCacheWrite = true;
      acc.tokens.cacheWrite += row.tokens.cacheWrite;
    }
    if (row.tokens.reasoning !== undefined) {
      acc.hasReasoning = true;
      acc.tokens.reasoning += row.tokens.reasoning;
    }
  }
  const out: ComparisonTableCell[] = [];
  for (const acc of cells.values()) {
    // Issue #4 semantic enforcement: these invariants failing means the rows
    // themselves are malformed — throw rather than emit a lying table.
    if (acc.total < acc.runs || acc.passed > acc.total) {
      throw new Error(
        `aggregate: semantic invariant violated for cell ${acc.model}/${acc.driver}` +
          `${acc.variant !== 'default' ? `/variant ${acc.variant}` : ''} ` +
          `(runs=${acc.runs}, passed=${acc.passed}, total=${acc.total})`,
      );
    }
    // DD-9: sum cost only when EVERY contributing row is numeric — one null
    // (subscription lane) forces the cell to null, never a partial sum.
    const costUSD = acc.costs.every((c) => typeof c === 'number')
      ? round6(acc.costs.reduce((sum, c) => sum + (c ?? 0), 0))
      : null;
    const allBilled = acc.bases.length === acc.costs.length && acc.bases.every((b) => b === 'billed');
    const costBasis =
      costUSD === null ? undefined : allBilled ? ('billed' as const) : acc.bases.includes('modeled') ? ('modeled' as const) : undefined;
    // F4: classifier cells (≥1 expected-verdict probe) gain the confusion
    // matrix, macro-F1, and — when the suspicious-benign subset is non-empty
    // — the FP rate. Fixer cells skip this block, so their cells keep the
    // exact pre-F4 shape.
    const verdictStats = acc.classifierProbes.length > 0 ? buildVerdictStats(acc.classifierProbes) : undefined;
    out.push({
      model: acc.model,
      driver: acc.driver,
      ...(acc.variant !== 'default' ? { variant: acc.variant } : {}),
      runs: acc.runs,
      passed: acc.passed,
      total: acc.total,
      score: acc.passed / acc.total, // exact division; total >= runs >= 1
      ...(acc.invalid !== undefined ? { invalid: acc.invalid } : {}),
      costUSD,
      ...(costBasis !== undefined ? { costBasis } : {}),
      ...(verdictStats !== undefined ? { byVerdict: verdictStats.byVerdict, macroF1: verdictStats.macroF1 } : {}),
      // W6.2: the coverage triple rides together whenever the rows declare
      // expectedCases; pre-W6.2 rows (old snapshots) yield neither, so a
      // regrade of committed evidence reproduces its tables byte-identically.
      ...(acc.expectedCases !== undefined
        ? {
            expectedCases: acc.expectedCases,
            coveredCases: acc.covered.size,
            coverage: acc.covered.size / acc.expectedCases,
          }
        : {}),
      ...(acc.budgetStops > 0 ? { budgetStops: acc.budgetStops } : {}),
      ...(acc.fpTotal > 0 ? { fpRate: acc.fpWrong / acc.fpTotal, fpN: acc.fpTotal } : {}),
      ...(acc.total >= WILSON_MIN_N
        ? { scoreCI: { ...wilsonInterval(acc.passed, acc.total), confidence: 0.95 } }
        : {}),
      wallTimeMs: acc.wallTimeMs,
      tokens: {
        input: acc.tokens.input,
        output: acc.tokens.output,
        ...(acc.hasCacheRead ? { cacheRead: acc.tokens.cacheRead } : {}),
        ...(acc.hasCacheWrite ? { cacheWrite: acc.tokens.cacheWrite } : {}),
        ...(acc.hasReasoning ? { reasoning: acc.tokens.reasoning } : {}),
      },
    });
  }
  return { role, suite, generatedAt: new Date().toISOString(), cells: out };
}
