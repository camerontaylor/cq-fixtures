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

import { spawnSync } from 'node:child_process';
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
import { scoreSchemaCompliance } from './dimensions/schemaCompliance.ts';
import type { CaseArtifact } from './persist.ts';
import { scoreFixerWorker, FIXER_PROBE_COUNT } from './score/fixerWorker.ts';
import { scoreReviewClassifier } from './score/reviewClassifier.ts';
import { isFixerCase, loadSuite, suiteVariant } from './suite.ts';

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

// Review-debt #14: the ACP auth preflight probe (suite.yml `ACP headless
// auth preflight`) performs a real — tiny — model request BEFORE the runner
// starts, so its spend used to sit outside the --max-tokens governor and the
// NDJSON journal with no usage recorded anywhere. The probe's exact usage is
// unmeasurable (it exits on the first agent chunk), so the runner accounts
// it as a labeled CONSERVATIVE RESERVATION: admitted through the same
// governor (observeUsage rolls the token cap — a reserve larger than the
// remaining cap gates the run instead of spending off-books) and journaled
// as a job-started/job-finished pair whose ok value says `reservation` in
// plain text, never a measurement. No row is emitted for the probe — rows
// exist only for dispatched suite cases (I9), and a probe row would corrupt
// the comparison tables.

/** Job identity for the pre-runner auth probe in the governor and journal. */
export const PREFLIGHT_PROBE_JOB_ID = 'acp-preflight-probe';
const PREFLIGHT_PROBE_OP = 'acp-preflight';

/**
 * Token ceiling charged for one pre-runner auth probe. The live probe moves
 * ~a dozen tokens; the reserve is deliberately two orders of magnitude above
 * that (~1% of the 200000-token cell cap) — measurement is impossible by
 * construction (first-chunk exit), so the reservation over-counts and the
 * journal value labels it a reservation, never an observation.
 */
export const PREFLIGHT_PROBE_RESERVE_TOKENS = 2000;

/** Facts the workflow preflight records for one auth-OK probe (ACP-PROBE.json). */
export interface PreflightProbe {
  /** ISO-8601 timestamp of the auth-OK reply. */
  at: string;
  /** Length in characters of the fixed probe prompt the preflight sent. */
  promptChars: number;
  /** Length in characters of the first agent reply chunk received. */
  replyChars: number;
  /** First 200 characters of that reply chunk (bounded journal payload). */
  replyPreview: string;
}

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
  /**
   * Pre-runner auth probe facts (review-debt #14). When present, the probe
   * is admitted through the run's governor and journaled with the run —
   * its conservative token reservation counts against maxTokens — instead
   * of spending off-books before the runner starts. Absent = no probe ran
   * (every non-acp invocation); the run is unchanged.
   */
  preflightProbe?: PreflightProbe;
  /** Repo root fixture/check paths resolve against. Defaults to this repo. */
  repoRoot?: string;
  /** Row driver label — must be a toolkit lane (row schema enum). */
  driverName?: string;
}

/** F1b (WB-1): a driver failure caused by something other than the model's
 * structured output — classified from the driver-reported cause token. It
 * publishes NO row (a loud dispatch-only absence, never a fabricated zero). */
export interface DriverAbsence {
  case: string;
  role: string;
  cause: string;
}

export interface RunSuiteResult {
  rows: ResultRow[];
  tables: ComparisonTable[];
  /** True when the run's budget gated undispatched cases (honest stop). */
  gatedByBudget: boolean;
  /** Per-case diagnostics: probe failures, scorer complaints, and
   * materialization failures — everything stderr also carries. */
  diagnostics: string[];
  /** Cases whose fixture could not be materialized (infrastructure — the
   * driver never ran for them). Callers must hard-fail, not warn. */
  materializationFailures: number;
  /** Structured per-case lines for every materialization-class refusal
   * (round 3): fixer copy failure, classifier read failure, and classifier
   * payload parse failure — each prefixed with its case id so the CLI's X2
   * block lists affected cases without re-matching prose. */
  materializationDiagnostics: string[];
  /** F6 (WB-5.2a): the raw per-case prediction artifacts (fixer patches +
   * structured outputs) a caller persists — bounded and denylist-scanned by
   * `publishArtifacts` at emit time. */
  artifacts: CaseArtifact[];
  /** F1b (WB-1): non-model driver causes classified as dispatch-only
   * absences — those cases published NO row (infrastructure, never a
   * fabricated zero). The scored-miss class (`structured-output-miss`) is a
   * MODEL outcome and rides `rows` as a real zero instead. */
  absences: DriverAbsence[];
  /** The run identity generated for this invocation. Set even when `rows` is
   * empty: a suite whose every case is a dispatch-only absence still ran and
   * must record its identity (the journal's `runId` and the manifest entry's
   * `runId`), never a `'unknown'` placeholder. */
  runId: string;
}

const DEFAULT_REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// F6 (WB-5.2a): the persisted fixer patch is a `git diff` of the materialized
// workspace against its pristine copy. Git is initialized in the workspace and
// the pristine state committed BEFORE the driver runs, so a later `git diff
// --cached HEAD` is exactly "what the worker changed". These config overrides
// keep the baseline commit identity-free and locale-independent; the eval job
// excises the repo's .git but the git BINARY is still present.
const GIT_COMMON = [
  '-c', 'user.email=cq-fixtures@localhost',
  '-c', 'user.name=cq-fixtures',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false',
];

/** Commit the materialized workspace's pristine state so a later diff is vs pristine. */
function gitBaseline(workspace: string): boolean {
  const run = (args: string[]) => spawnSync('git', ['-C', workspace, ...GIT_COMMON, ...args], { encoding: 'utf8' });
  return run(['init', '-q']).status === 0 && run(['add', '-A']).status === 0
    && run(['commit', '-q', '-m', 'pristine']).status === 0;
}

/** `git diff`-style patch of the workspace vs its pristine baseline (undefined on failure). */
function gitPatch(workspace: string): string | undefined {
  const run = (args: string[]) => spawnSync('git', ['-C', workspace, ...GIT_COMMON, ...args], { encoding: 'utf8' });
  if (run(['add', '-A']).status !== 0) return undefined;
  // Explicit a/ b/ prefixes so the published patch is a standard git diff
  // regardless of the operator's git config (diff.mnemonicPrefix produces
  // c/ i/ w/ o/ prefixes). --no-ext-diff keeps an installed diff.external
  // from hijacking the output; apply strips one path component, so a/ b/ is
  // the format regrade re-applies cleanly.
  const res = run([
    'diff', '--cached', '--no-color', '--no-ext-diff',
    '--src-prefix=a/', '--dst-prefix=b/', 'HEAD',
  ]);
  return res.status === 0 ? res.stdout : undefined;
}

// DD-4: a fixer-worker case configures TWO scoring probes (FIXER_PROBE_COUNT,
// shared with the offline regrade path). Every other role configures one.

function zeroOutcome(total: number): { score: 0; passed: 0; total: number } {
  return { score: 0, passed: 0, total };
}

/**
 * Bound + redact a driver-reported cause before it reaches the journal.
 *
 * Defense in depth over the toolkit's own bound/redaction (cq-toolkit
 * error-text.ts): a redaction gap in any driver must not persist a secret
 * into the journal artifact and onward to the snapshots branch. Truncates to
 * 500 chars (the toolkit's bound) and masks common credential shapes.
 */
export function boundDriverCause(cause: string, max = 500): string {
  const redacted = cause
    .replace(/\b(sk|pk|ghp|gho|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer [redacted]')
    .replace(
      /\b([A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi,
      '$1=[redacted]',
    );
  return redacted.length <= max ? redacted : `${redacted.slice(0, max)}…[truncated]`;
}

/** The ai-sdk driver's model-outcome class token (cq-toolkit #210/#212). */
const STRUCTURED_OUTPUT_MISS_TOKEN = 'structured-output-miss';

/**
 * True iff `cause` begins with the ai-sdk class-token form
 * `ai-sdk driver: [<token>]` and `<token>` is EXACTLY `structured-output-miss`.
 *
 * The toolkit guarantees every ai-sdk `error` verdict's `WorkerResult.error`
 * starts with that form, so the class token is consumed from position zero:
 * a longer token (`[structured-output-miss-extra]`), a mid-message mention of
 * the phrase, or another lane's cause is false — no substring drift.
 */
export function isStructuredOutputMissCause(cause: string): boolean {
  const m = /^ai-sdk driver: \[([a-z-]+)\](?:\s|$)/.exec(cause);
  return m !== null && m[1] === STRUCTURED_OUTPUT_MISS_TOKEN;
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

// F4: resolve the fixture-side adjudication sidecar for a classifier case.
// The label.json lives beside the thread payload (`<fixture>.json` ->
// `<fixture>.label.json`) and carries the adjudicated fp_flag; the runner
// reads ONLY that flag — concern group and adjudication records stay in the
// file for the label-drift CI check, never in rows. A missing or unparseable
// sidecar is NOT silent (r1-F3): the caller surfaces it as a case diagnostic
// so a damaged sidecar undercounts fpN/fpRate loudly instead of invisibly —
// micro suites carry no labels, so their runs note the omission per case.
// This helper never throws past its caller. 'unflagged' covers only a
// present sidecar whose fp_flag is the recognized value 'none'; 'invalid'
// covers parsed JSON whose fp_flag is missing or unrecognized (e.g. {} or
// a typo — CodeRabbit bot thread T2). Validity beyond the flag read stays
// the drift check's job, but an invalid sidecar is diagnosed like absent and
// unparseable rather than silently treated as unflagged. The row omits
// suspiciousBenign for every status but 'flagged'.
type SidecarFlag = 'flagged' | 'absent' | 'unparseable' | 'unflagged' | 'invalid';
function suspiciousBenignFlag(repoRoot: string, fixture: string): SidecarFlag {
  if (!fixture.endsWith('.json')) return 'unflagged';
  let raw: string;
  try {
    raw = readFileSync(join(repoRoot, `${fixture.slice(0, -'.json'.length)}.label.json`), 'utf8');
  } catch {
    return 'absent';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unparseable';
  }
  if (typeof parsed !== 'object' || parsed === null) return 'invalid';
  const flag = (parsed as { fp_flag?: unknown }).fp_flag;
  if (flag === 'suspicious-benign') return 'flagged';
  if (flag === 'none') return 'unflagged';
  return 'invalid';
}

export async function runSuite(opts: RunSuiteOptions): Promise<RunSuiteResult> {
  const suite = loadSuite(opts.suiteDir);
  const variant = suiteVariant(suite);
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

  // Review-debt #14: fold the pre-runner probe into THIS run's governor and
  // journal (see the constant's comment). Each suite invocation owns its own
  // governor and journal, so a multi-suite process charges the reservation
  // against every suite run's cap — conservative in the same direction on
  // each. The admission also advances the dispatch count, so a resumed run
  // replaying this journal keeps the same attempt ordinals.
  if (opts.preflightProbe !== undefined) {
    const probe = opts.preflightProbe;
    const probeAdmission = governor.admit(PREFLIGHT_PROBE_JOB_ID);
    if (probeAdmission.decision === 'reject') {
      // Unreachable on a fresh governor (no dispatch quota configured, and
      // the budget cannot have tripped before the first observation) — fail
      // loud rather than journal a probe the governor refused.
      throw new Error(`pre-runner probe refused admission: ${probeAdmission.reason}`);
    }
    await append({
      type: 'job-started', runId, at: now(),
      jobId: PREFLIGHT_PROBE_JOB_ID, op: PREFLIGHT_PROBE_OP, attempt: probeAdmission.attempt,
    });
    const probeUsage: Usage = {
      input: PREFLIGHT_PROBE_RESERVE_TOKENS, output: 0, cacheRead: 0, cacheWrite: 0,
    };
    // Tokens only, never observeResult: the probe's cost is as unmeasurable
    // as its tokens, and cells run token-cap-only (DD-9) — observeResult's
    // unpriced-under-maxUsd trip would fail a USD-capped probe run before
    // any case dispatches. A --max-usd run with a probe behaves exactly like
    // one without (cases still trip fail-closed on unpriced usage); the
    // probe itself adds no USD evidence either way.
    governor.observeUsage(PREFLIGHT_PROBE_JOB_ID, probeUsage);
    await append({
      type: 'job-finished', runId, at: now(),
      jobId: PREFLIGHT_PROBE_JOB_ID, opId: PREFLIGHT_PROBE_OP,
      inputsHash: hashInputs(PREFLIGHT_PROBE_OP, { promptChars: probe.promptChars, replyChars: probe.replyChars }),
      result: {
        status: 'ok',
        value: {
          probe: 'acp-auth-preflight',
          accounting: 'conservative-reservation-tokens (not measured — the probe exits on the first agent chunk)',
          reservedTokens: PREFLIGHT_PROBE_RESERVE_TOKENS,
          promptChars: probe.promptChars,
          replyChars: probe.replyChars,
          replyPreview: probe.replyPreview,
          at: probe.at,
        },
      },
      usage: probeUsage,
    });
  }

  const rows: ResultRow[] = [];
  const artifacts: CaseArtifact[] = [];
  const absences: DriverAbsence[] = [];
  const caseDiagnostics: string[] = [];
  const materializationDiagnostics: string[] = [];
  let materializationFailures = 0;
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

    // Shared refusal for the guarded infrastructure steps below (T2
    // taxonomy, structured per round 3): the same honest shape for every
    // infrastructure-class failure — journal indeterminate, stderr, BOTH
    // diagnostics channels (the per-case `diagnostics` stream and the
    // structured materialization list the CLI's X2 block prints directly),
    // a materializationFailures increment, and NO row.
    const refuseCase = async (detail: string): Promise<void> => {
      await append({
        type: 'job-finished', runId, at: now(), jobId: c.id, opId: suite.role,
        inputsHash: hashInputs(suite.role, { caseId: c.id, fixture: c.fixture, task: c.task }),
        result: { status: 'indeterminate', detail },
      });
      console.error(`  case ${c.id}: not scored — ${detail}`);
      caseDiagnostics.push(`case ${c.id}: ${detail}`);
      materializationDiagnostics.push(`case ${c.id}: ${detail}`);
      materializationFailures += 1;
    };

    // T2: fixture preparation is its own guarded step BEFORE the scored
    // path — for BOTH roles, because both are infrastructure the driver
    // never sees: a fixture that cannot be COPIED (fixer workspace) or READ
    // (review-classifier payload injection) must not be misclassified as a
    // driver error and emit a scored failed row — that would fabricate an
    // eval outcome for work that never ran. The honest taxonomy: NO row
    // (rows exist only for cases that ran, like budget-refused cases), a
    // job-finished:indeterminate journal event, a stderr + diagnostics
    // entry, and a materializationFailures increment.
    let workspace: string | undefined;
    let payload: string | undefined;
    if (isFixerCase(c)) {
      try {
        workspace = mkdtempSync(join(tmpdir(), 'cq-fixture-'));
        // verbatimSymlinks copies relative symlinks RELATIVE (their stored
        // target is preserved byte-for-byte), so a fixture's in-repo link
        // resolves inside the workspace copy. The default dereferences
        // relative links into ABSOLUTE paths at the pristine fixture —
        // a copied workspace would silently read the untouched original.
        cpSync(join(repoRoot, c.fixture), workspace, { recursive: true, verbatimSymlinks: true });
        // F6 (WB-5.2a): baseline the pristine copy so the persisted patch is
        // exactly the worker's diff. A baseline failure is NOT fatal — the
        // case still runs and scores — but the patch is then unavailable, and
        // that is recorded rather than silently lost.
        if (!gitBaseline(workspace)) {
          const detail = `case ${c.id}: git baseline failed — patch not persisted`;
          caseDiagnostics.push(detail);
          console.error(`  ${detail}`);
        }
      } catch (e) {
        if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
        await refuseCase(`fixture materialization failed for '${c.fixture}': ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
    } else {
      // The classifier's prompt carries the payload's CONTENT (J3/D3), so
      // the fixture file is read here — before any invocation exists — with
      // the same honesty shape as the fixer materialization guard above
      // (cycle-2 CLI review): the read failure is infrastructure, not an
      // eval outcome.
      try {
        payload = readFileSync(join(repoRoot, c.fixture), 'utf8');
      } catch (e) {
        await refuseCase(`fixture read failed for '${c.fixture}': ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      // Round 3 (FIX 5): a payload that READS but does not PARSE is the
      // same infrastructure class — the classifier can never see a usable
      // task, so dispatching it would only manufacture a scored-0 row from
      // an unparseable input.
      try {
        JSON.parse(payload);
      } catch (e) {
        await refuseCase(`thread payload is not valid JSON for '${c.fixture}': ${e instanceof Error ? e.message : String(e)}`);
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
          // Review-classifier: tools-none / read-only — the classifier cannot
          // open files itself, so the thread payload's CONTENT rides in the
          // prompt (J3/D3, 2026-09-16): instruction first, then the fixture
          // file verbatim (utf8). The read already succeeded in the guarded
          // infrastructure step above — a failed read never reaches dispatch
          // (cycle-2 CLI review) — so `payload` is always the file's content
          // here. Fixer prompts stay unchanged: the workspace path already
          // rides in them above.
          invocation = {
            prompt: `${c.task.prompt}\n\nThread payload (fixture ${c.fixture}):\n${payload}`,
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

      // F6 (WB-5.2a): capture the worker's diff BEFORE the check probe runs —
      // the judge mutates the workspace (restores pristine tests, scrubs
      // planted configs), so a post-scoring diff would be post-judge state,
      // not the worker's prediction. undefined = git unavailable or failed.
      const fixerPatch =
        isFixerCase(c) && workspace !== undefined && worker !== undefined ? gitPatch(workspace) : undefined;

      let outcome: { score: number; passed: number; total: number };
      let journalResult: OpResult<unknown>;
      let diagnostics: string | undefined;
      // F4: classifier-only row fields, set in the review-classifier branch
      // below; fixer rows and every zero path leave them unset, so those
      // rows keep their exact pre-F4 shape.
      let rowProbes: ResultRow['probes'];
      let sidecarFlag: SidecarFlag | undefined;
      // F1b: set false on a non-model driver failure, so neither a row nor a
      // prediction artifact is fabricated for infrastructure.
      let emitRow = true;
      // DD-4: the probe ceiling holds even on the zero paths below — a case
      // configures its probes up front, so a worker that never produced a
      // gradeable result failed every one of them (passed 0 of the full
      // ceiling) rather than a truncated count.
      const probeCount = isFixerCase(c) ? FIXER_PROBE_COUNT : 1;
      if (worker === undefined) {
        outcome = zeroOutcome(probeCount);
        // Same bound/redaction as the stopReason:error path — a driver that
        // THROWS must not persist an unbounded or secret-bearing message.
        const thrownCause = boundDriverCause(String(thrown));
        journalResult = { status: 'failed', error: thrownCause };
        diagnostics = `driver threw: ${thrownCause}`;
        // A thrown driver produced no `WorkerResult` and no class token — the
        // ultimate missing cause — so it is infrastructure, not a model
        // outcome: NO row (I9), recorded as a loud absence like every other
        // non-model cause. (The pre-dispatch missing-credential throw is
        // handled earlier and aborts the run entirely.)
        emitRow = false;
        absences.push({ case: c.id, role: suite.role, cause: thrownCause });
      } else if (worker.stopReason === 'budget') {
        outcome = zeroOutcome(probeCount); // honest budget-exhausted: no fabricated credit
        journalResult = { status: 'budget-exhausted' };
        diagnostics = 'driver stopped on budget';
      } else if (worker.stopReason === 'error') {
        // Post-v1.0.0 toolkit (cq-toolkit #206/#210/#212, pinned 1.0.1)
        // carries the driver's own cause in `WorkerResult.error` (bounded and
        // secret-redacted by the toolkit) with a class token as its second
        // component. Consume that token to separate a MODEL outcome from
        // infrastructure:
        //   [structured-output-miss] — the model emitted unparseable
        //     structured output. That is a model outcome, so the case
        //     publishes an honest DD-4 scored-miss row (outcome 0, passed 0,
        //     the configured probe ceiling) — a real zero in the tables.
        //   anything else ([endpoint-timeout], [provider-error], a missing
        //     cause, an unknown cause) — infrastructure. NO row is published,
        //     so a driver failure never masquerades as a model score (I9);
        //     the absence is recorded for the caller and the journal keeps
        //     the cause verbatim.
        const cause =
          worker.error !== undefined && worker.error.trim() !== ''
            ? boundDriverCause(worker.error)
            : 'driver stopReason: error (driver reported no cause)';
        journalResult = { status: 'failed', error: cause };
        diagnostics = cause;
        if (!isStructuredOutputMissCause(cause)) {
          emitRow = false;
          absences.push({ case: c.id, role: suite.role, cause });
        }
        // Either way the worker produced no gradeable result, so every
        // configured probe failed (passed 0 of the full ceiling).
        outcome = zeroOutcome(probeCount);
      } else if (worker.stopReason === 'aborted') {
        outcome = zeroOutcome(probeCount);
        journalResult = { status: 'indeterminate', detail: 'driver stopReason: aborted' };
        diagnostics = 'driver stopReason: aborted';
      } else if (isFixerCase(c)) {
        // A fixer case scores TWO probes (DD-4: the worker declares its own
        // verdict; the runner grades whether the model could hold the json
        // shape it was asked for).
        // Probe 1 — check-rerun, as today: the workspace is always set on
        // the fixer path (materialized above, before the driver ran) — it is
        // what the probe grades. The probe ceiling is checkTimeoutMs, an
        // independent knob from the run's budget caps.
        const check = scoreFixerWorker(c, worker, repoRoot, workspace as string, opts.checkTimeoutMs);
        // Probe 2 — schema compliance (runner/dimensions/schemaCompliance.ts):
        // grades ONLY the structuredOutput's shape discipline, never the
        // fix's content, so the check's sweep-agnostic contract is intact.
        const schema = scoreSchemaCompliance(worker);
        const passed = check.passed + schema.passed;
        outcome = { score: passed / FIXER_PROBE_COUNT, passed, total: FIXER_PROBE_COUNT };
        journalResult = { status: 'ok', value: outcome };
        // Both probes' complaints surface; the CLI prints the first line.
        const complaints = [check.diagnostics, schema.diagnostics].filter((d): d is string => d !== undefined);
        diagnostics = complaints.length > 0 ? complaints.join('\n') : undefined;
      } else {
        const s = scoreReviewClassifier(c, worker);
        outcome = { score: s.score, passed: s.passed, total: s.total };
        journalResult = { status: 'ok', value: outcome };
        diagnostics = s.diagnostics;
        // F4: capture the observed verdict per case into the row's probes[]
        // so the confusion matrix, macro-F1, and FP rate are computable from
        // rows.jsonl — the outcome triple alone cannot supply them.
        rowProbes = [{ kind: 'expected-verdict', expected: c.probe.expected, observed: s.observed ?? null, passed: s.passed === 1 }];
        sidecarFlag = suspiciousBenignFlag(repoRoot, c.fixture);
        // r1-F3: a damaged sidecar is a case diagnostic (row shape
        // unchanged) — silent omission would undercount fpN/fpRate with
        // zero signal on any run the drift gate does not cover.
        if (sidecarFlag === 'absent' || sidecarFlag === 'unparseable' || sidecarFlag === 'invalid') {
          const why =
            sidecarFlag === 'invalid'
              ? 'invalid content (fp_flag missing or outside none|suspicious-benign)'
              : sidecarFlag;
          caseDiagnostics.push(
            `case ${c.id}: label sidecar '${c.fixture.slice(0, -'.json'.length)}.label.json' ${why} — suspiciousBenign flag omitted`,
          );
        }
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
      if (emitRow) rows.push({
        role: suite.role, suite: suite.name, case: c.id, model, driver: driverName,
        // F6/CQ-4: only a non-default variant rides the row, so the default
        // posture (and every pre-F6 row) keeps its exact shape.
        ...(variant !== 'default' ? { variant } : {}),
        outcome, costUSD: cost ?? null,
        ...(cost !== undefined ? { costBasis: 'modeled' as const } : {}),
        ...(rowProbes !== undefined ? { probes: rowProbes } : {}),
        ...(sidecarFlag === 'flagged' ? { suspiciousBenign: true } : {}),
        wallTimeMs, tokens: tokensOf(usage), runId, timestamp: now(),
      });
      // F6 (WB-5.2a): persist the prediction. Only a DISPATCHED case has one
      // (worker !== undefined); the raw artifact is size-bounded and
      // denylist-scanned at emit time by publishArtifacts. A fixer's patch is
      // the workspace-vs-pristine diff (the answer to re-judge); a
      // classifier's output is its raw structured output. The fixer's
      // structuredOutput is persisted too (the DD-4 schema-compliance probe's
      // input) so `regrade --rejudge` can re-run BOTH probes offline.
      if (emitRow && worker !== undefined) {
        if (isFixerCase(c)) {
          if (workspace !== undefined) {
            if (fixerPatch !== undefined) {
              artifacts.push({ case: c.id, kind: 'patch', content: fixerPatch });
            } else {
              const detail = `case ${c.id}: patch unavailable (git diff failed) — prediction not persisted`;
              caseDiagnostics.push(detail);
              console.error(`  ${detail}`);
            }
          }
          if (worker.structuredOutput !== undefined) {
            artifacts.push({ case: c.id, kind: 'output', content: JSON.stringify(worker.structuredOutput, null, 2) + '\n' });
          }
        } else {
          artifacts.push({
            case: c.id,
            kind: 'output',
            content: JSON.stringify(worker.structuredOutput ?? null, null, 2) + '\n',
          });
        }
      }
      if (emitRow) {
        console.error(`  case ${c.id}: score ${outcome.score}${diagnostics !== undefined ? ` — ${diagnostics.split('\n')[0]}` : ''}`);
      } else {
        console.error(`  case ${c.id}: not published — driver error (dispatch-only absence): ${diagnostics?.split('\n')[0] ?? ''}`);
      }
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
  return {
    rows,
    tables,
    gatedByBudget,
    diagnostics: caseDiagnostics,
    materializationFailures,
    materializationDiagnostics,
    artifacts,
    absences,
    runId,
  };
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
