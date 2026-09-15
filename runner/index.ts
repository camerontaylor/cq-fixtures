// Thin-custom eval runner over the toolkit's own ops — the R7 null hypothesis
// (plan §3.2). It dogfoods the toolkit's public surface only: the Driver seam
// for execution, BudgetGovernor for the run's USD/token caps, openRunLog for
// the NDJSON journal, and the price map for DD-9 cost derivation. The driver
// is INJECTED: adding a case or swapping lanes requires no runner change.
//
// Honesty rules enforced here (I9): every DISPATCHED case yields exactly one
// row; a case the governor refuses (budget) yields NO row — refusing to
// fabricate a zero for work that never ran — and shows up only in the
// journal's run-finished stoppedEarly/earlyStopReason and the result's
// gatedByBudget flag. costUSD comes only from the toolkit price map or is
// null (DD-9); the row's model is the OBSERVED served id when the driver
// reports one.

import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  type ToolkitToolName,
  type Usage,
  type WorkerResult,
} from '@camerontaylor/cq-toolkit';
import { aggregate, type ComparisonTable, type ResultRow } from './aggregate.ts';
import { scoreFixerWorker, type ScoreOutcome } from './score/fixerWorker.ts';
import { scoreReviewClassifier } from './score/reviewClassifier.ts';
import { isFixerCase, loadSuite } from './suite.ts';

// Public library surface: the suite loader rides along with the runner.
export { isFixerCase, loadSuite, type Suite, type SuiteCase } from './suite.ts';

// The toolkit harness tool surface (ToolkitToolName = read | edit | run): a
// fixer-worker dispatches with this allowlist in workspace-write mode, since
// a worker that cannot edit files or run a check cannot fix anything.
const FIXER_TOOL_NAMES: readonly ToolkitToolName[] = ['read', 'edit', 'run'];

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
  /** Run USD cap. OMIT on unpriced lanes: the governor fails closed on
   * unpriced usage under a USD cap, so a token-only cap must be able to bind
   * alone (DD-9). Absent flag = absent cap — no default injection. */
  maxUsd?: number;
  maxTokens?: number;
  /** Ceiling for one check-probe execution (default: scorer's 60_000). */
  checkTimeoutMs?: number;
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
  /** Per-case diagnostics: probe failures, scorer complaints, and
   * materialization failures — everything stderr also carries. */
  diagnostics: string[];
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

  // Absent caps stay absent: no default injection. A token-only cap must be
  // able to bind an unpriced lane (DD-9) — configuring a USD cap there would
  // make the governor fail closed after the first case.
  const budget: Budget = {};
  if (opts.maxUsd !== undefined) budget.maxUsd = opts.maxUsd;
  if (opts.maxTokens !== undefined) budget.maxTokens = opts.maxTokens;

  // The toolkit governor owns the run's caps: the admission gate runs per
  // case, then usage/cost observation — which trips the cap fail-loud (an
  // unpriced model under maxUsd trips rather than running unbounded, the
  // exact failure DD-9 exists to prevent). Tripping gates ADMISSION only: an
  // in-flight case's outcome stays real evidence.
  const governor = new BudgetGovernor(
    governorConfig(
      {
        concurrency: 1,
        stopOnError: false,
        ...(opts.maxUsd !== undefined ? { maxUsd: opts.maxUsd } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      },
      {},
    ),
  );

  await append({ type: 'run-started', runId, at: now(), planId: suite.name });

  const rows: ResultRow[] = [];
  const caseDiagnostics: string[] = [];
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
    await append({ type: 'job-started', runId, at: now(), jobId: c.id, op: suite.role, attempt: admission.attempt });

    // T2: materialization is its own guarded step BEFORE the scored path.
    // A fixture that cannot be copied is an infrastructure failure — the
    // driver never ran — so the case emits NO row (rows exist only for cases
    // that ran, like budget-refused cases), the journal records the honest
    // indeterminate finish, and the failure surfaces via stderr + the
    // result's diagnostics.
    let workspace: string | undefined;
    if (isFixerCase(c)) {
      try {
        workspace = mkdtempSync(join(tmpdir(), 'cq-fixture-'));
        // verbatimSymlinks copies relative symlinks RELATIVE (their stored
        // target is preserved byte-for-byte), so a fixture's in-repo link
        // resolves inside the workspace copy. The default dereferences
        // relative links into ABSOLUTE paths at the pristine fixture —
        // a copied workspace would silently read the untouched original.
        cpSync(join(repoRoot, c.fixture), workspace, { recursive: true, verbatimSymlinks: true });
      } catch (e) {
        if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
        const detail = `fixture materialization failed for '${c.fixture}': ${e instanceof Error ? e.message : String(e)}`;
        await append({
          type: 'job-finished', runId, at: now(), jobId: c.id, opId: suite.role,
          inputsHash: hashInputs(suite.role, { caseId: c.id, fixture: c.fixture, task: c.task }),
          result: { status: 'indeterminate', detail },
        });
        console.error(`  case ${c.id}: not scored — ${detail}`);
        caseDiagnostics.push(`case ${c.id}: ${detail}`);
        continue;
      }
    }

    const startedMs = Date.now();
    // The invocation is built per case because a fixer-worker case runs
    // against its OWN materialized workspace copy — the copy's absolute path
    // rides in the prompt and is therefore part of the journaled input hash.
    // W1: the whole dispatch/score/journal section sits in a try/finally so
    // a mid-case throw (journal append, scoring) can never leak the
    // materialized cq-fixture-* workspace into the OS temp dir.
    try {
      let invocation: OpInvocation | undefined;
      let worker: WorkerResult | undefined;
      let thrown: unknown;
      try {
        if (isFixerCase(c)) {
          invocation = {
            prompt: `${c.task.prompt}\nworkspace: ${workspace}`,
            modelSpec: { model: opts.model, provider: opts.provider },
            toolPolicy: { allow: [...FIXER_TOOL_NAMES], mode: 'allowlist' },
            sandboxPolicy: { level: 'workspace-write' },
            budget,
          };
        } else {
          // Review-classifier: tools-none / read-only. The fixture (thread
          // payload) is not wired into the prompt yet — payload content
          // injection is J3 scope.
          invocation = {
            prompt: c.task.prompt,
            modelSpec: { model: opts.model, provider: opts.provider },
            toolPolicy: { allow: [], mode: 'none' },
            sandboxPolicy: { level: 'read-only' },
            budget,
          };
        }
        worker = await opts.driver.run(invocation);
      } catch (e) {
        // A pre-dispatch missing-credential throw is infrastructure
        // configuration, NOT an eval outcome — scoring it 0 would publish
        // zeros-while-green. The toolkit's requireKey fails uniformly with
        // "provider '<p>' requires <ENV> in the environment", so the predicate
        // matches every provider lane, not just zai.
        if (e instanceof Error && /requires [A-Z0-9_]+_API_KEY in the environment/.test(e.message)) {
          await append({
            type: 'job-finished', runId, at: now(), jobId: c.id, opId: suite.role,
            inputsHash: hashInputs(suite.role, invocation ?? { caseId: c.id, fixture: c.fixture, task: c.task }),
            result: { status: 'indeterminate', detail: `aborted: ${e.message}` },
          });
          // W3: the run-level journal is deliberately left WITHOUT a
          // run-finished event on this abort path. The toolkit's journal
          // schema requires earlyStopReason: 'budget' whenever stoppedEarly
          // is true (its only early-stop value), which would be a false
          // claim for an error abort — and stoppedEarly: false would be a
          // lie of the opposite kind. A journal that ends after the
          // job-finished:indeterminate IS the honest record of an aborted
          // run: deriveJobStatuses folds it, and the missing run-finished
          // marks the run as never having completed. cliMain maps the
          // rethrown error to exit 2.
          throw e;
        }
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
          ? // The workspace is always set on the fixer path (materialized
            // above, before the driver ran) — it is what the probe grades.
            // The probe ceiling is checkTimeoutMs, an independent knob from
            // the run's budget caps.
            scoreFixerWorker(c, worker, repoRoot, workspace as string, opts.checkTimeoutMs)
          : scoreReviewClassifier(c, worker);
        outcome = { score: s.score, passed: s.passed, total: s.total };
        journalResult = { status: 'ok', value: outcome };
        diagnostics = s.diagnostics;
      }
      if (diagnostics !== undefined) caseDiagnostics.push(`case ${c.id}: ${diagnostics}`);
      await append({
        type: 'job-finished', runId, at: now(), jobId: c.id, opId: suite.role,
        // If materialization failed before an invocation existed, hash the case
        // facts so the journal still identifies WHAT failed to dispatch.
        inputsHash: hashInputs(suite.role, invocation ?? { caseId: c.id, fixture: c.fixture, task: c.task }),
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
    } finally {
      // The materialized workspace is the driver's scratch: graded against,
      // then removed — even when the case aborts mid-flight. The pristine
      // fixture under repoRoot is never touched.
      if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
    }
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
  return { rows, tables, gatedByBudget, diagnostics: caseDiagnostics };
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
    ({ cliMain }) => cliMain(process.argv.slice(2)).then((code) => { process.exitCode = code; }),
    (e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; },
  );
}
