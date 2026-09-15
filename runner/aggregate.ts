// Per-role aggregation of result rows into comparison tables
// (schema/comparison-table.schema.json). Pure: rows in, tables out — no I/O.

export type SuiteRole = 'fixer-worker' | 'review-classifier';

/** Mirror of schema/result-row.schema.json (the fields the runner emits). */
export interface ResultRow {
  role: SuiteRole;
  suite: string;
  case?: string;
  model: string;
  driver: string;
  outcome: { score: number; passed: number; total: number };
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
  runs: number;
  passed: number;
  total: number;
  score: number;
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
  runs: number;
  passed: number;
  total: number;
  /** Per-row costUSD; null marks a DD-9 subscription row. */
  costs: Array<number | null>;
  bases: Array<'billed' | 'modeled'>;
  wallTimeMs: number;
  tokens: Required<ResultRow['tokens']>;
  hasCacheRead: boolean;
  hasCacheWrite: boolean;
  hasReasoning: boolean;
}

/** Cost sums are rounded to 6 decimals — finer precision is price-map noise. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
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
    const key = `${row.model}\n${row.driver}`;
    let acc = cells.get(key);
    if (acc === undefined) {
      acc = {
        model: row.model,
        driver: row.driver,
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
      };
      cells.set(key, acc);
    }
    acc.runs += 1;
    acc.passed += row.outcome.passed;
    acc.total += row.outcome.total;
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
        `aggregate: semantic invariant violated for cell ${acc.model}/${acc.driver} ` +
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
    out.push({
      model: acc.model,
      driver: acc.driver,
      runs: acc.runs,
      passed: acc.passed,
      total: acc.total,
      score: acc.passed / acc.total, // exact division; total >= runs >= 1
      costUSD,
      ...(costBasis !== undefined ? { costBasis } : {}),
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
