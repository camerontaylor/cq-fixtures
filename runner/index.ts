// Thin-custom eval runner over the toolkit's own ops — the R7 null hypothesis
// (plan §3.2). It dogfoods the toolkit's public surface only: the Driver seam
// for execution, BudgetGovernor for the run's USD/token caps, openRunLog for
// the NDJSON journal, and the price map for DD-9 cost derivation. The driver
// is INJECTED: adding a case or swapping lanes requires no runner change.
//
// Honesty rules enforced here (I9): every case yields exactly one row — a
// budget-refused case is an honest zero, never skipped and never fabricated;
// costUSD comes only from the toolkit price map or is null (DD-9); the row's
// model is the OBSERVED served id when the driver reports one.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import {
  BudgetGovernor,
  computeCostUSD,
  governorConfig,
  hashInputs,
  openRunLog,
  type Budget,
  type Driver,
  type JournalEvent,
  type OpInvocation,
  type OpResult,
  type RunLog,
  type Usage,
  type WorkerResult,
} from '@camerontaylor/cq-toolkit';
import { aggregate, type ComparisonTable, type ResultRow } from './aggregate.ts';
import { scoreFixerWorker, type ScoreOutcome } from './score/fixerWorker.ts';
import { scoreReviewClassifier } from './score/reviewClassifier.ts';
import { isFixerCase, loadSuite } from './suite.ts';

// Public library surface: the suite loader rides along with the runner.
export { isFixerCase, loadSuite, type Suite, type SuiteCase } from './suite.ts';

// Schema validation of OUTPUTS (rows/tables) — nothing leaves runSuite
// unvalidated. Same Ajv setup as test/schema.test.ts.
const ajv = ajvFormats(new Ajv2020({ allErrors: true }));
const validateRow = ajv.compile(
  JSON.parse(readFileSync(new URL('../schema/result-row.schema.json', import.meta.url), 'utf8')) as object,
);
const validateTable = ajv.compile(
  JSON.parse(readFileSync(new URL('../schema/comparison-table.schema.json', import.meta.url), 'utf8')) as object,
);

export interface RunSuiteOptions {
  suiteDir: string;
  driver: Driver;
  model: string;
  provider: string;
  maxUsd: number;
  maxTokens?: number;
  wallClockMs?: number;
  /** Directory for the toolkit NDJSON journal; omitted = no persistence. */
  journalPath?: string;
  /** Repo root fixture/check paths resolve against. Defaults to this repo. */
  repoRoot?: string;
  /** Row driver label — must be a toolkit lane (row schema enum). */
  driverName?: string;
}

export interface RunSuiteResult {
  rows: ResultRow[];
  tables: ComparisonTable[];
  /** True when the run's budget gated undispatched cases (honest stop). */
  gatedByBudget: boolean;
}

const DEFAULT_REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function zeroOutcome(): { score: 0; passed: 0; total: 1 } {
  return { score: 0, passed: 0, total: 1 };
}

function tokensOf(usage: Usage): ResultRow['tokens'] {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
  };
}

export async function runSuite(opts: RunSuiteOptions): Promise<RunSuiteResult> {
  const suite = loadSuite(opts.suiteDir);
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT;
  const driverName = opts.driverName ?? 'ai-sdk';
  const runId = randomUUID();
  const now = () => new Date().toISOString();
  const log: RunLog | undefined = opts.journalPath === undefined ? undefined : openRunLog(opts.journalPath);
  const append = async (event: JournalEvent): Promise<void> => {
    if (log !== undefined) await log.append(runId, event);
  };

  const budget: Budget = { maxUsd: opts.maxUsd };
  if (opts.maxTokens !== undefined) budget.maxTokens = opts.maxTokens;
  if (opts.wallClockMs !== undefined) budget.wallClockMs = opts.wallClockMs;

  // The toolkit governor owns the run's caps: the admission gate runs per
  // case, then usage/cost observation — which trips the cap fail-loud (an
  // unpriced model under maxUsd trips rather than running unbounded, the
  // exact failure DD-9 exists to prevent). Tripping gates ADMISSION only: an
  // in-flight case's outcome stays real evidence.
  const governor = new BudgetGovernor(
    governorConfig(
      { concurrency: 1, stopOnError: false, maxUsd: opts.maxUsd, ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}) },
      {},
    ),
  );

  await append({ type: 'run-started', runId, at: now(), planId: suite.name });

  const rows: ResultRow[] = [];
  let gatedByBudget = false;
  for (const c of suite.cases) {
    const admission = governor.admit(c.id);
    if (admission.decision === 'reject') {
      // Never dispatched: NO row (rows exist only for work actually
      // dispatched — a fabricated zero would claim a verdict that never ran)
      // and NO journal events (the toolkit's convention: missing job ids ARE
      // the not-dispatched list). The honest stop is recorded on the
      // run-finished event and the gatedByBudget result flag; a fully
      // refused suite yields an empty-but-valid table.
      gatedByBudget = true;
      console.error(`  case ${c.id}: not dispatched — run budget exhausted (${admission.reason})`);
      continue;
    }
    const invocation: OpInvocation = {
      prompt: c.task.prompt,
      modelSpec: { model: opts.model, provider: opts.provider },
      toolPolicy: { allow: [], mode: 'none' },
      sandboxPolicy: { level: 'read-only' },
      budget,
    };
    await append({ type: 'job-started', runId, at: now(), jobId: c.id, op: suite.role, attempt: admission.attempt });

    const startedMs = Date.now();
    let worker: WorkerResult | undefined;
    let thrown: unknown;
    try {
      worker = await opts.driver.run(invocation);
    } catch (e) {
      thrown = e;
    }
    const wallTimeMs = Math.max(0, Date.now() - startedMs);

    const usage: Usage = worker?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    // Observed served id wins (the served-id decision); the requested id is
    // the fallback a lane that cannot observe it leaves us.
    const model = worker?.model ?? opts.model;
    // DD-9: cost is derived ONLY via the toolkit price map over usage —
    // never invented; null when the (observed) model has no price. The
    // driver's own costUSD is not used: the runner owns derivation.
    const cost = computeCostUSD({ model, provider: opts.provider }, usage);
    governor.observeResult(c.id, { usage, costUSD: cost });

    let outcome: { score: number; passed: number; total: number };
    let journalResult: OpResult<unknown>;
    let diagnostics: string | undefined;
    if (worker === undefined) {
      outcome = zeroOutcome();
      journalResult = { status: 'failed', error: String(thrown) };
      diagnostics = `driver threw: ${String(thrown)}`;
    } else if (worker.stopReason === 'budget') {
      outcome = zeroOutcome(); // honest budget-exhausted: no fabricated credit
      journalResult = { status: 'budget-exhausted' };
      diagnostics = 'driver stopped on budget';
    } else if (worker.stopReason === 'error') {
      outcome = zeroOutcome();
      journalResult = { status: 'failed', error: 'driver stopReason: error' };
      diagnostics = 'driver stopReason: error';
    } else if (worker.stopReason === 'aborted') {
      outcome = zeroOutcome();
      journalResult = { status: 'indeterminate', detail: 'driver stopReason: aborted' };
      diagnostics = 'driver stopReason: aborted';
    } else {
      const s: ScoreOutcome = isFixerCase(c)
        ? scoreFixerWorker(c, worker, repoRoot)
        : scoreReviewClassifier(c, worker);
      outcome = { score: s.score, passed: s.passed, total: s.total };
      journalResult = { status: 'ok', value: outcome };
      diagnostics = s.diagnostics;
    }
    await append({
      type: 'job-finished', runId, at: now(), jobId: c.id, opId: suite.role,
      inputsHash: hashInputs(suite.role, invocation),
      result: journalResult,
      ...(worker !== undefined ? { usage } : {}),
    });
    rows.push({
      role: suite.role, suite: suite.name, case: c.id, model, driver: driverName,
      outcome, costUSD: cost ?? null,
      ...(cost !== undefined ? { costBasis: 'modeled' as const } : {}),
      wallTimeMs, tokens: tokensOf(usage), runId, timestamp: now(),
    });
    console.error(`  case ${c.id}: score ${outcome.score}${diagnostics !== undefined ? ` — ${diagnostics.split('\n')[0]}` : ''}`);
  }
  await append({
    type: 'run-finished', runId, at: now(), stoppedEarly: gatedByBudget,
    ...(gatedByBudget ? { earlyStopReason: 'budget' as const } : {}),
  });

  const tables = aggregate(rows);
  if (rows.length === 0) {
    // Empty-but-valid: one empty-cells table per requested suite role so
    // callers still get a table for an empty suite or a fully refused run
    // (schema/comparison-table.schema.json allows cells: [] since slice 3).
    tables.push({ role: suite.role, suite: suite.name, generatedAt: now(), cells: [] });
  }
  // Contract: nothing leaves this function without schema validation.
  for (const row of rows) {
    // Capture the label before the call: ajv's ValidateFunction doubles as a
    // type predicate, so `row` narrows to never inside the failure branch.
    const caseId = row.case;
    if (!validateRow(row)) {
      throw new Error(`result row for case '${caseId}' failed schema validation: ${ajv.errorsText(validateRow.errors)}`);
    }
  }
  for (const table of tables) {
    const role = table.role;
    if (!validateTable(table)) {
      throw new Error(`comparison table for role '${role}' failed schema validation: ${ajv.errorsText(validateTable.errors)}`);
    }
  }
  return { rows, tables, gatedByBudget };
}

// --- CLI entry: node --experimental-strip-types runner/index.ts [flags]
// The flag parser and process wiring live in cli.ts; this file owns the
// library. The direct-invocation guard keeps library imports side-effect
// free, and the import is deliberately NOT awaited: a top-level await here
// would deadlock the cli.ts -> index.ts static import (unsettled-TLA), while
// a pending .then keeps the event loop alive through the whole run.

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  import('./cli.ts').then(
    ({ cliMain }) => cliMain(process.argv.slice(2)),
    (e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; },
  );
}
