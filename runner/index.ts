// Thin-custom eval runner over the toolkit's own ops — the R7 null hypothesis
// (plan §3.2). It dogfoods the toolkit's public surface only: the Driver seam
// for execution, BudgetGovernor for the run's USD/token caps, openRunLog for
// the NDJSON journal, and the price map for DD-9 cost derivation. The driver
// is INJECTED: adding a case or swapping lanes requires no runner change.
//
// Honesty rules enforced here (I9): every DISPATCHED case yields exactly one
// row; a case the governor refuses (budget) yields NO row — refusing to
// fabricate a zero for work that never ran — and since W6.2 it is also
// recorded as an EXPLICIT budget-stop absence (never a silent no-row): the
// result's absences[] carries it, the manifest lists it, and coverage columns
// expose the gap. A DISPATCHED case the driver stops on its (per-case)
// budget keeps its honest incomplete row, marked with stopCause 'budget'.
// costUSD comes only from the toolkit price map or is null (DD-9); the row's
// model is the OBSERVED served id when the driver reports one.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  SessionStore,
  type JournalEvent,
  type OpInvocation,
  type OpResult,
  type RunLog,
  type ToolkitToolName,
  type Usage,
  type WorkerResult,
} from '@camerontaylor/cq-toolkit';
import { aggregate, type ComparisonTable, type ResultRow } from './aggregate.ts';
import { nativeGovernorUsage, perSuiteUsdCap } from './budget.ts';
import { answerKeyCase, findSentinel, type AnswerKey, type SentinelSource } from './answerKey.ts';
import { scoreSchemaCompliance } from './dimensions/schemaCompliance.ts';
import type { CaseArtifact } from './persist.ts';
import { scoreFixerWorker, FIXER_PROBE_COUNT } from './score/fixerWorker.ts';
import { scoreReviewClassifier } from './score/reviewClassifier.ts';
import { isFixerCase, loadSuite, suiteVariant } from './suite.ts';
import { ArtifactStore, sha256, type ImmutableArtifactRef } from './artifacts/index.ts';
import { findDenylistMatch, loadDenylistRules } from './denylist.ts';
import { canonicalJson, judgeManifestHash, suiteTaskId, type ExperimentContext, type JudgeDependencyManifest, type TaskOutcome, type TaskOutcomeJudgement } from './experiment.ts';
import { campaignUsage, sanitizeNativeObservation, unavailableObservation, type InvocationIdentity, type NativeObservation, type ObservedDriver } from './native/observation.ts';

// Public library surface: the suite loader rides along with the runner.
export { isFixerCase, loadSuite, type Suite, type SuiteCase } from './suite.ts';

// The toolkit harness tool surface (ToolkitToolName = read | edit | run): a
// fixer-worker dispatches with this allowlist in workspace-write mode, since
// a worker that cannot edit files or run a check cannot fix anything.
const FIXER_TOOL_NAMES: readonly ToolkitToolName[] = ['read', 'edit', 'run'];

/**
 * The drivers' default SessionStore location.  A driver receives only a
 * sessionRef from the runner, so its own default store must be the same
 * store the runner writes; putting records in the materialized workspace
 * silently makes every real driver fail with an unknown-session error.
 * Keep this beside the harness scratch root, never inside a model-visible
 * workspace (the store is the authoritative binding record).
 */
export const SESSION_STORE_DIR = join(tmpdir(), 'cq-harness', 'sessions');

/** Remove abandoned evidence left by a crashed/timed-out process. */
function sweepStaleSessionRecords(now = Date.now()): void {
  const maxAgeMs = 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = readdirSync(SESSION_STORE_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl') && !entry.endsWith('.cq-cli-session')) continue;
    const path = join(SESSION_STORE_DIR, entry);
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { force: true });
    } catch {
      // A concurrent cleanup is harmless; never turn evidence sweeping into a run failure.
    }
  }
}

// Schema validation of OUTPUTS (rows/tables) — nothing leaves runSuite
// unvalidated. Same Ajv setup as test/schema.test.ts.
const ajv = ajvFormats(new Ajv2020({ allErrors: true }));
const validateRow = ajv.compile(
  JSON.parse(readFileSync(new URL('../schema/result-row.schema.json', import.meta.url), 'utf8')) as object,
);
const validateTable = ajv.compile(
  JSON.parse(readFileSync(new URL('../schema/comparison-table.schema.json', import.meta.url), 'utf8')) as object,
);

function validateJudgeManifest(repoRoot: string, manifest: JudgeDependencyManifest): string {
  if (manifest.sourcePin.trim() === '' || manifest.dependencies.length === 0) {
    throw new Error('campaign judge manifest must pin its source and list dependencies');
  }
  const seen = new Set<string>();
  for (const dependency of manifest.dependencies) {
    if (isAbsolute(dependency.path) || dependency.path.split(/[\\/]/).includes('..') || seen.has(dependency.path)) {
      throw new Error(`campaign judge dependency has an unsafe or duplicate path: ${dependency.path}`);
    }
    seen.add(dependency.path);
    const path = resolve(repoRoot, dependency.path);
    const rel = relative(resolve(repoRoot), path);
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('campaign judge dependency escaped repo root');
    const actualPath = realpathSync(path);
    const actualRel = relative(realpathSync(repoRoot), actualPath);
    if (actualRel === '..' || actualRel.startsWith(`..${sep}`)) throw new Error('campaign judge dependency escaped repo root through symlink');
    const actualHash = sha256(readFileSync(actualPath));
    if (!/^[a-f0-9]{64}$/.test(dependency.sha256) || actualHash !== dependency.sha256) {
      throw new Error(`campaign judge dependency hash mismatch: ${dependency.path}`);
    }
  }
  return judgeManifestHash(manifest);
}

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
  /**
   * W6.2: per-case USD budget (D9 default or explicit --max-usd-per-case,
   * resolved by the CLI). Binds at BOTH grains: each invocation's
   * `budget.maxUsd` (driver-enforced stop on the lanes that honor
   * Budget.maxUsd — claude-agent, subprocess) and the run governor's
   * cumulative cap, perSuiteUsdCap(this × that suite's case count) — the
   * enforcement that also covers the lanes whose driver ignores maxUsd
   * (ai-sdk, acp). When the cumulative cap trips, further cases are refused
   * admission: NO row each, but an explicit `budget-stop` absence (never a
   * silent no-row). Mutually exclusive with maxUsd at the CLI; at the
   * library grain maxUsdPerCase wins the invocation budget and REPLACES the
   * governor's USD cap with perSuiteUsdCap (their sum-of-cases bound), and
   * a case whose derived cost exceeds its own share is recorded
   * post-hoc (stopCause 'budget' + an absence) because the lanes that
   * ignore Budget.maxUsd (ai-sdk, acp) have no per-case driver stop. */
  maxUsdPerCase?: number;
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
  /**
   * W6.3: the eval root's runner-only answer key. Supplies the stripped
   * suite's expected verdicts and label-sidecar flags (runner/answerKey.ts);
   * absent = the suite carries its own answers (repo-local runs and tests).
   */
  answerKey?: AnswerKey;
  /**
   * W6.3 dynamic sentinel (RS-9 §4.3 D): strings whose appearance in a
   * case's worker output, error, tool denials, session transcript, patch or
   * workspace proves the worker reached outside its workspace. Such a case
   * publishes no row (a `sentinel-contamination` absence) and is listed in
   * `contaminations`. Empty/absent = the check is off.
   */
  sentinelNeedles?: readonly string[];
  /** Campaign assignment context; omitted for legacy-only runs. */
  experiment?: ExperimentContext;
  /** Host-only check environment derived from the materialized workspace's immutable baseline. */
  hostCheckScoringEnvironment?: (workspacePath: string, pinnedBaselineCommit: string) => Readonly<Record<string, string>>;
  /** Immutable observation root. Defaults to the runner's private temp artifact store. */
  artifactRoot?: string;
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
  /** W6.3: cases whose worker surfaces carried an eval-root sentinel (also in `absences`). */
  contaminations: Array<{ case: string; where: string }>;
  /** The run identity generated for this invocation. Set even when `rows` is
   * empty: a suite whose every case is a dispatch-only absence still ran and
   * must record its identity (the journal's `runId` and the manifest entry's
   * `runId`), never a `'unknown'` placeholder. */
  runId: string;
  /** Persisted native observations, including observations from thrown transports. */
  observations: Array<{ observation: NativeObservation; artifact: ImmutableArtifactRef }>;
  /** New immutable judgements, each pinned to its exact candidate and judge. */
  judgements: ImmutableArtifactRef[];
}

const DEFAULT_REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// F6 (WB-5.2a): the persisted fixer patch is a `git diff` of the materialized
// workspace against its pristine copy. Host-owned Git metadata is initialized
// outside the candidate-writable tree and the pristine state committed before
// dispatch, so capture can diff against that fixed commit even if the worker
// commits its own edits or replaces workspace Git files. The environment and
// attribute overrides keep candidate/global Git config from running helpers.
const GIT_COMMON = [
  '-c', 'user.email=cq-fixtures@localhost',
  '-c', 'user.name=cq-fixtures',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.fsmonitor=false',
];

interface GitBaseline {
  commit: string;
  tree: string;
  /** Host-owned Git metadata lives outside the model-writable workspace. */
  gitDir: string;
}

function gitEnvironment(gitDir: string, workspace: string): NodeJS.ProcessEnv {
  // Do not inherit ambient GIT_* overrides: callers or worker environments
  // must not redirect the metadata, index, config, or worktree for capture.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  env.GIT_DIR = gitDir;
  env.GIT_WORK_TREE = workspace;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = join(gitDir, 'empty-global-config');
  env.GIT_CONFIG_COUNT = '0';
  env.GIT_ATTR_NOSYSTEM = '1';
  env.GIT_OPTIONAL_LOCKS = '0';
  // Identical pristine trees must produce the same commit in the worker repo
  // and the private capture repo. Fixed commit dates make that identity stable.
  env.GIT_AUTHOR_DATE = '2000-01-01T00:00:00Z';
  env.GIT_COMMITTER_DATE = '2000-01-01T00:00:00Z';
  return env;
}

function workerGitEnvironment(privateGitDir: string): NodeJS.ProcessEnv {
  const env = gitEnvironment(privateGitDir, '');
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

function gitCaptureArgs(gitDir: string, workspace: string, args: string[]): string[] {
  return [
    '--git-dir', gitDir,
    '--work-tree', workspace,
    ...GIT_COMMON,
    '-c', `core.hooksPath=${join(gitDir, 'disabled-hooks')}`,
    '-c', `core.attributesFile=${join(gitDir, 'empty-global-attributes')}`,
    ...args,
  ];
}

/** Recreate trusted Git configuration and highest-priority attributes before capture. */
function prepareTrustedGitMetadata(gitDir: string): void {
  mkdirSync(join(gitDir, 'disabled-hooks'), { recursive: true });
  writeFileSync(join(gitDir, 'empty-global-config'), '');
  writeFileSync(join(gitDir, 'empty-global-attributes'), '');
  writeFileSync(join(gitDir, 'config'), [
    '[core]',
    '  repositoryformatversion = 0',
    '  filemode = true',
    '  bare = false',
    '  logallrefupdates = true',
    '  fsmonitor = false',
    `  hooksPath = ${join(gitDir, 'disabled-hooks')}`,
    `  attributesFile = ${join(gitDir, 'empty-global-attributes')}`,
    '',
  ].join('\n'));
  writeFileSync(join(gitDir, 'info', 'attributes'), '* -filter -text -eol\n');
  writeFileSync(join(gitDir, 'info', 'exclude'), '/.git/\nnode_modules/\n');
}

/** Commit the pristine workspace with host-owned metadata and retain immutable pins. */
function gitBaseline(workspace: string): GitBaseline | undefined {
  const gitDir = mkdtempSync(join(tmpdir(), 'cq-capture-git-'));
  const env = gitEnvironment(gitDir, workspace);
  const workerEnv = workerGitEnvironment(gitDir);
  const runCapture = (args: string[]) => spawnSync('git', args, { encoding: 'utf8', env });
  const runWorker = (args: string[]) => spawnSync('git', ['-C', workspace, ...GIT_COMMON,
    '-c', `core.hooksPath=${join(workspace, '.git', 'disabled-hooks')}`,
    '-c', `core.attributesFile=${join(gitDir, 'empty-global-attributes')}`,
    ...args], { encoding: 'utf8', env: workerEnv });
  let retained = false;
  try {
    // Remove any fixture-provided Git metadata, then copy the pristine source
    // into independent worker/capture object stores before dispatch.
    rmSync(join(workspace, '.git'), { recursive: true, force: true });
    if (runCapture(['init', '-q', gitDir]).status !== 0 ||
        runWorker(['init', '-q']).status !== 0) return undefined;

    prepareTrustedGitMetadata(gitDir);
    // The worker gets a standard .git directory inside its exported workspace.
    // Its metadata is safe during baseline creation and intentionally becomes
    // untrusted after dispatch; capture never consults it again.
    mkdirSync(join(workspace, '.git', 'disabled-hooks'), { recursive: true });
    writeFileSync(join(workspace, '.git', 'info', 'attributes'), '* -filter -text -eol\n');
    writeFileSync(join(workspace, '.git', 'info', 'exclude'), '/.git/\nnode_modules/\n');

    if (runWorker(['add', '-A']).status !== 0 ||
        runWorker(['commit', '-q', '-m', 'pristine']).status !== 0) return undefined;
    // Resolve both worker pins in one invocation, then copy only Git objects
    // and the immutable ref into the private capture repo. Config, hooks,
    // attributes, index, and worktree metadata are independently created.
    const pins = runWorker(['rev-parse', 'HEAD', 'HEAD^{tree}']);
    if (pins.status !== 0) return undefined;
    const [commit, tree] = pins.stdout.trim().split(/\s+/);
    if (commit === undefined || tree === undefined || !/^[a-f0-9]{40,64}$/.test(commit) || !/^[a-f0-9]{40,64}$/.test(tree)) {
      return undefined;
    }
    const headText = readFileSync(join(workspace, '.git', 'HEAD'), 'utf8');
    const headRef = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)\n?$/.exec(headText)?.[1];
    if (headRef === undefined || headRef.split('/').includes('..')) return undefined;
    const workerObjects = join(workspace, '.git', 'objects');
    const captureObjects = join(gitDir, 'objects');
    for (const entry of readdirSync(workerObjects)) {
      if (!/^[a-f0-9]{2}$/.test(entry) && entry !== 'pack') continue;
      cpSync(join(workerObjects, entry), join(captureObjects, entry), { recursive: true, force: true });
    }
    mkdirSync(join(gitDir, ...headRef.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(gitDir, headRef), `${commit}\n`);
    writeFileSync(join(gitDir, 'HEAD'), `ref: ${headRef}\n`);
    prepareTrustedGitMetadata(gitDir);
    const trustedPins = runCapture(gitCaptureArgs(gitDir, workspace, ['rev-parse', 'HEAD', 'HEAD^{tree}']));
    if (trustedPins.status !== 0 || trustedPins.stdout.trim().split(/\s+/).join(' ') !== `${commit} ${tree}`) return undefined;
    retained = true;
    return { commit, tree, gitDir };
  } finally {
    if (!retained) rmSync(gitDir, { recursive: true, force: true });
  }
}

/** Bound on one workspace file read by the sentinel scan (a huge file is skipped, not read). */
const SENTINEL_SCAN_MAX_BYTES = 5 * 1024 * 1024;

/** W6.3: every regular file a worker could have written into its workspace, as sentinel sources. */
function* workspaceSources(dir: string, workspace: string): Generator<SentinelSource> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (dir === workspace && entry === '.git') continue;
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* workspaceSources(path, workspace);
    else if (st.isFile() && st.size <= SENTINEL_SCAN_MAX_BYTES) {
      let text: string | undefined;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        text = undefined;
      }
      yield { where: `workspace file ${path.slice(workspace.length + 1)}`, text };
    } else if (st.isSymbolicLink()) {
      // A planted link is a reach attempt in itself: its target text is scanned.
      let target: string | undefined;
      try {
        target = readlinkSync(path);
      } catch {
        target = undefined;
      }
      yield { where: `workspace symlink ${path.slice(workspace.length + 1)}`, text: target };
    }
  }
}

/** Read a store-side session file for the sentinel scan (undefined when absent). */
function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** `git diff`-style patch of the workspace vs its pristine baseline (undefined on failure). */
function gitPatch(workspace: string, baseline: GitBaseline): string | undefined {
  try {
    prepareTrustedGitMetadata(baseline.gitDir);
  } catch {
    return undefined;
  }
  const env = gitEnvironment(baseline.gitDir, workspace);
  const run = (args: string[]) => spawnSync('git', gitCaptureArgs(baseline.gitDir, workspace, args), { encoding: 'utf8', env });
  const pinnedTree = run(['rev-parse', `${baseline.commit}^{tree}`]);
  if (pinnedTree.status !== 0 || pinnedTree.stdout.trim() !== baseline.tree) return undefined;
  if (run(['add', '-A']).status !== 0) return undefined;
  // Explicit a/ b/ prefixes so the published patch is a standard git diff
  // regardless of the operator's git config (diff.mnemonicPrefix produces
  // c/ i/ w/ o/ prefixes). --no-ext-diff keeps an installed diff.external
  // from hijacking the output; apply strips one path component, so a/ b/ is
  // the format regrade re-applies cleanly.
  const res = run([
    'diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/', baseline.commit,
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
 * starts with that form, so the class token is consumed from position zero and
 * compared with `===` — a longer token (`[structured-output-miss-extra]`), a
 * mid-message mention of the phrase, or another lane's cause is false, so there
 * is no substring drift. In particular, do not infer a class from bare HTTP-
 * like numbers in the diagnostic (for example `position 502`): only the
 * explicit class token classifies the outcome. The separator AFTER the
 * closing bracket is any non-identifier character (or end of string): the
 * toolkit emits a space, but a comma, tab or newline must not flip a model
 * outcome into an infra absence.
 */
export function isStructuredOutputMissCause(cause: string): boolean {
  const m = /^ai-sdk driver: \[([a-z-]+)\](?:[^A-Za-z0-9-]|$)/.exec(cause);
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
function sidecarDiagnostic(caseId: string, fixture: string, sidecarFlag: SidecarFlag): string | undefined {
  if (sidecarFlag !== 'absent' && sidecarFlag !== 'unparseable' && sidecarFlag !== 'invalid') return undefined;
  const why =
    sidecarFlag === 'invalid'
      ? 'invalid content (fp_flag missing or outside none|suspicious-benign)'
      : sidecarFlag;
  return `case ${caseId}: label sidecar '${fixture.slice(0, -'.json'.length)}.label.json' ${why} — suspiciousBenign flag omitted`;
}
/** Exported for the eval-root builder's parity test (scripts/eval-root.mjs resolves the same status). */
export function suspiciousBenignFlag(repoRoot: string, fixture: string): SidecarFlag {
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
  const suite = loadSuite(opts.suiteDir, opts.answerKey);
  const observedDriver = opts.driver as Driver & Partial<ObservedDriver>;
  const nativeMode = typeof observedDriver.getObservation === 'function';
  if (nativeMode && opts.maxTokens !== undefined &&
      !(observedDriver.campaignBudgetCapabilities?.hardTokenCap === true &&
        observedDriver.campaignBudgetCapabilities.authoritativeTokenTotal === true)) {
    throw new Error('hard token cap unsupported: native driver must attest enforcement and authoritative tokenTotal');
  }
  if (opts.experiment !== undefined) {
    const mapped = opts.experiment.caseAssignments;
    if (suite.cases.length > 1 && mapped === undefined) {
      throw new Error('campaign runSuite with multiple cases requires experiment.caseAssignments keyed by case ID');
    }
    if (mapped !== undefined) {
      const caseIds = new Set(suite.cases.map((suiteCase) => suiteCase.id));
      const missing = [...caseIds].filter((caseId) => mapped[caseId] === undefined);
      const extra = Object.keys(mapped).filter((caseId) => !caseIds.has(caseId));
      if (missing.length > 0 || extra.length > 0) {
        throw new Error(`campaign assignment roster mismatch (missing: ${missing.join(',') || 'none'}; extra: ${extra.join(',') || 'none'})`);
      }
    }
  }
  const needles = opts.sentinelNeedles ?? [];
  // W6.3: an eval-root run resolves each classifier case's label sidecar
  // from the answer key (the sidecars are excised from the root, and the key
  // recorded the full repo's status at build time); a repo-local run reads it.
  const sidecarOf = (caseId: string, fixture: string): SidecarFlag =>
    opts.answerKey !== undefined
      ? (answerKeyCase(opts.answerKey, suite.role, suite.name, caseId)?.sidecar ?? 'absent')
      : suspiciousBenignFlag(repoRoot, fixture);
  const variant = suiteVariant(suite);
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT;
  const campaignTaskInputs = new Map<string, { substrateId: string; judgeManifest: JudgeDependencyManifest; manifestHash: string }>();
  if (opts.experiment !== undefined) {
    for (const suiteCase of suite.cases) {
      const mapped = opts.experiment.caseAssignments?.[suiteCase.id];
      const substrateId = mapped?.substrateId ?? opts.experiment.substrateId;
      const judgeManifest = mapped?.judgeManifest ?? opts.experiment.judgeManifest;
      if (substrateId.trim() === '') throw new Error(`campaign task '${suiteCase.id}' has an empty substrateId`);
      campaignTaskInputs.set(suiteCase.id, {
        substrateId, judgeManifest,
        manifestHash: validateJudgeManifest(repoRoot, judgeManifest),
      });
    }
  }
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
  // W6.2: the per-case USD budget REPLACES the invocation grain's maxUsd —
  // a case is bounded by ITS OWN budget, never by the run's total. The
  // run-level cap becomes the sum of the per-case bounds (the USD mirror of
  // WB-1.6), so a multi-case run cannot spend beyond its cases' combined
  // allowance and a case that overspends its share gates only the tail —
  // visibly, as budget-stop absences.
  const invocationBudget: Budget =
    opts.maxUsdPerCase !== undefined ? { ...budget, maxUsd: opts.maxUsdPerCase } : budget;
  const runUsdCap =
    opts.maxUsdPerCase !== undefined ? perSuiteUsdCap(opts.maxUsdPerCase, suite.cases.length) : opts.maxUsd;

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
        ...(runUsdCap !== undefined ? { maxUsd: runUsdCap } : {}),
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
  const observations: RunSuiteResult['observations'] = [];
  const judgements: ImmutableArtifactRef[] = [];
  const artifactStore = new ArtifactStore(opts.artifactRoot ?? join(tmpdir(), 'cq-harness', 'artifacts'));
  const absences: DriverAbsence[] = [];
  const contaminations: Array<{ case: string; where: string }> = [];
  const caseDiagnostics: string[] = [];
  const materializationDiagnostics: string[] = [];
  let materializationFailures = 0;
  let gatedByBudget = false;
  let nativeTokenSpent = opts.preflightProbe === undefined ? 0 : PREFLIGHT_PROBE_RESERVE_TOKENS;
  let nativeTokenBudgetBlocked = false;
  for (const c of suite.cases) {
    if (nativeMode && opts.maxTokens !== undefined && (nativeTokenBudgetBlocked || nativeTokenSpent >= opts.maxTokens)) {
      gatedByBudget = true;
      const cause = nativeTokenBudgetBlocked
        ? 'budget-stop: native authoritative tokenTotal unavailable; remaining hard-cap dispatch refused'
        : 'budget-stop: native authoritative tokenTotal reached the hard cap';
      absences.push({ case: c.id, role: suite.role, cause });
      console.error(`  case ${c.id}: not dispatched — ${cause}`);
      continue;
    }
    const admission = governor.admit(c.id);
    if (admission.decision === 'reject') {
      // Never dispatched: NO row (rows exist only for work actually
      // dispatched — a fabricated zero would claim a verdict that never ran)
      // and NO journal events (the toolkit's convention: missing job ids ARE
      // the not-dispatched list). W6.2: the stop is nevertheless an EXPLICIT
      // record, never a silent no-row — the case joins absences[] with a
      // `budget-stop:` cause (surfaced by the CLI and run.json beside the
      // other dispatch-only absences), and the honest stop stays on the
      // run-finished event and the gatedByBudget result flag. Coverage makes
      // the gap mechanical: the row-level expectedCases denominator counts
      // this case, so every cell of the run reports coverage < 1.
      gatedByBudget = true;
      const cause = `budget-stop: the run budget gate refused dispatch (${admission.reason})`;
      absences.push({ case: c.id, role: suite.role, cause });
      console.error(`  case ${c.id}: not dispatched — ${cause}`);
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
    let workspaceBaseline: GitBaseline | undefined;
    let sessionRef: string | undefined;
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
        workspaceBaseline = gitBaseline(workspace);
        if (workspaceBaseline === undefined) {
          const detail = `case ${c.id}: git baseline failed — patch not persisted`;
          caseDiagnostics.push(detail);
          console.error(`  ${detail}`);
        }
        // Bind the driver session to this exact materialized workspace. A
        // prompt-only workspace path is not an execution boundary: drivers
        // otherwise create their own temp cwd and the check grades an
        // untouched copy. SessionStore is the toolkit's explicit workspace
        // binding seam (I6), not a second source of truth.
        sweepStaleSessionRecords();
        const sessionStore = new SessionStore(SESSION_STORE_DIR);
        const session = await sessionStore.create(workspace);
        sessionRef = session.sessionId;
      } catch (e) {
        if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
        if (workspaceBaseline !== undefined) rmSync(workspaceBaseline.gitDir, { recursive: true, force: true });
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
      const perCaseAssignment = opts.experiment?.caseAssignments?.[c.id];
      const taskInput = campaignTaskInputs.get(c.id);
      const invocationIdentity: InvocationIdentity = {
        invocationId: randomUUID(),
        assignmentId: perCaseAssignment?.assignmentId ?? opts.experiment?.assignmentId ?? `assignment-${randomUUID()}`,
        stageId: perCaseAssignment?.stageId ?? opts.experiment?.stageId ?? 'stage-1',
        attemptId: perCaseAssignment?.attemptId ?? opts.experiment?.attemptId ?? randomUUID(),
      };
      const artifactContext: ExperimentContext = {
        campaignId: opts.experiment?.campaignId ?? 'ad-hoc-native',
        cohortId: opts.experiment?.cohortId ?? 'unassigned',
        experimentId: opts.experiment?.experimentId ?? 'unassigned',
        taskId: suiteTaskId(suite.name, taskInput?.substrateId ?? c.id),
        repeatId: opts.experiment?.repeatId ?? runId,
        assignmentId: invocationIdentity.assignmentId,
        stageId: invocationIdentity.stageId,
        attemptId: invocationIdentity.attemptId,
        track: opts.experiment?.track ?? 'unassigned',
        strategyId: opts.experiment?.strategyId ?? 'unassigned',
        settingsId: opts.experiment?.settingsId ?? 'unassigned',
        budgetId: opts.experiment?.budgetId ?? 'unassigned',
        profileId: opts.experiment?.profileId ?? 'unassigned',
        frozenWeight: opts.experiment?.frozenWeight ?? 1,
        substrateId: taskInput?.substrateId ?? c.id,
        judgeManifest: taskInput?.judgeManifest ?? { sourcePin: 'unassigned', dependencies: [] },
      };
      const baselineCommit = workspaceBaseline?.commit ?? null;
      const baselineTree = workspaceBaseline?.tree ?? null;
      let judgePin = taskInput === undefined ? undefined : sha256(canonicalJson({
        taskManifestHash: taskInput.manifestHash, baselineCommit, baselineTree,
      }));
      let hostCheckEnv: Readonly<Record<string, string>> | undefined;
      let nativeObservation: NativeObservation | undefined;
      try {
        if (isFixerCase(c)) {
          invocation = {
            prompt: `${c.task.prompt}\nworkspace: ${workspace}`,
            modelSpec: { model: opts.model, provider: opts.provider },
            toolPolicy: { allow: [...FIXER_TOOL_NAMES], mode: 'allowlist' },
            sandboxPolicy: { level: 'workspace-write' },
            budget: invocationBudget,
            ...(sessionRef !== undefined ? { sessionRef } : {}),
          };
        } else {
          // Review-classifier: tools-none / read-only — the classifier cannot
          // open files itself, so the thread payload's CONTENT rides in the
          // prompt (J3/D3, 2026-09-16): instruction first, then the fixture
          // file verbatim (utf8). The read already succeeded in the guarded
          // infrastructure step above — a failed read never reaches dispatch
          // (cycle-2 CLI review) — so `payload` is always the file's content
          // here. Fixer prompts stay unchanged: the workspace path already
          // rides in them above. W6.3 (RS-9 §4.3 C.12): the marker names no
          // fixture path — thread ids are ordinal and label-blocked, and the
          // path named the label sidecar beside it.
          invocation = {
            prompt: `${c.task.prompt}\n\nThread payload:\n${payload}`,
            modelSpec: { model: opts.model, provider: opts.provider },
            toolPolicy: { allow: [], mode: 'none' },
            sandboxPolicy: { level: 'read-only' },
            budget: invocationBudget,
          };
        }
        if (typeof observedDriver.getObservation === 'function') {
          if (typeof observedDriver.beginInvocation === 'function') {
            await observedDriver.beginInvocation(invocationIdentity);
          } else if (typeof observedDriver.setInvocationIdentity === 'function') {
            await observedDriver.setInvocationIdentity(invocationIdentity);
          } else {
            throw new Error('native observation driver must implement beginInvocation(identity) or setInvocationIdentity(identity)');
          }
        }
        const dispatchInvocation = nativeMode && opts.maxTokens !== undefined
          ? {
              ...invocation,
              budget: { ...(invocation.budget ?? {}), maxTokens: Math.max(0, opts.maxTokens - nativeTokenSpent) },
            }
          : invocation;
        worker = await opts.driver.run(dispatchInvocation);
      } catch (e) {
        // A pre-dispatch missing-credential throw is infrastructure
        // configuration, NOT an eval outcome — scoring it 0 would publish
        // zeros-while-green. The toolkit's requireKey fails uniformly with
        // "provider '<p>' requires <ENV> in the environment", so the predicate
        // matches every provider lane, not just zai.
        if (e instanceof Error && /requires [A-Z0-9_]+_API_KEY in the environment/.test(e.message) && !isFixerCase(c)) {
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
      // Capture the candidate before observation retrieval or any oracle
      // operation. Native bridges may fail while returning telemetry, and a
      // worker may commit its edit before throwing.
      const capturedPatch = isFixerCase(c) && workspace !== undefined && workspaceBaseline !== undefined
        ? gitPatch(workspace, workspaceBaseline)
        : undefined;
      const fixerPatch = capturedPatch === undefined || capturedPatch.length === 0 ? undefined : capturedPatch;
      if (thrown instanceof Error && /requires [A-Z0-9_]+_API_KEY in the environment/.test(thrown.message) && isFixerCase(c)) {
        if (fixerPatch === undefined) {
          await append({
            type: 'job-finished', runId, at: now(), jobId: c.id, opId: suite.role,
            inputsHash: hashInputs(suite.role, invocation ?? { caseId: c.id, fixture: c.fixture, task: c.task }),
            result: { status: 'indeterminate', detail: `aborted: ${thrown.message}` },
          });
          throw thrown;
        }
      }
      if (typeof observedDriver.getObservation === 'function') {
        try {
          nativeObservation = await observedDriver.getObservation(invocationIdentity.invocationId);
          if (nativeObservation !== undefined && nativeObservation.identity.invocationId !== invocationIdentity.invocationId) {
            throw new Error(`native observation identity mismatch for invocation ${invocationIdentity.invocationId}`);
          }
          if (nativeObservation === undefined) nativeObservation = unavailableObservation(invocationIdentity, opts.driverName ?? 'native', worker ?? null);
          if (worker === undefined && nativeObservation.workerResult !== null) worker = nativeObservation.workerResult;
        } catch (error) {
          const why = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          caseDiagnostics.push(`case ${c.id}: observation retrieval failed: ${boundDriverCause(why)}`);
          nativeObservation = unavailableObservation(invocationIdentity, opts.driverName ?? 'native', worker ?? null);
          nativeObservation.terminal.transportException = thrown !== undefined
            ? { name: thrown instanceof Error ? thrown.name : 'Error', message: boundDriverCause(String(thrown)) }
            : { name: error instanceof Error ? error.name : 'Error', message: boundDriverCause(why) };
          nativeObservation.terminal.cause = 'observation-retrieval-failure';
        }
      }
      const wallTimeMs = Math.max(0, Date.now() - startedMs);

      const measuredUsage = nativeObservation === undefined ? undefined : campaignUsage(nativeObservation);
      if (nativeMode && opts.maxTokens !== undefined) {
        const authoritativeTotal = measuredUsage?.tokenTotal ?? null;
        if (authoritativeTotal === null) nativeTokenBudgetBlocked = true;
        else nativeTokenSpent += authoritativeTotal;
      }
      const usage: Usage = worker?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      // Observed served id wins (the served-id decision); the requested id is
      // the fallback a lane that cannot observe it leaves us.
      const model = nativeMode
        ? nativeObservation?.model.observed.value ?? worker?.model ?? opts.model
        : worker?.model ?? opts.model;
      // DD-9: cost is derived ONLY via the toolkit price map over usage —
      // never invented; null when the (observed) model has no price. The
      // driver's own costUSD is not used: the runner owns derivation.
      const costUsage = nativeMode && nativeObservation !== undefined
        ? nativeGovernorUsage(nativeObservation)
        : undefined;
      const cost = nativeMode
        ? costUsage === undefined ? undefined : computeCostUSD({ model, provider: opts.provider }, costUsage)
        : computeCostUSD({ model, provider: opts.provider }, usage);
      // Native compatibility projections never enter the governor. Native
      // counters enter only when fully observed and explicitly disjoint;
      // unknown or overlapping counters never become zero or double-counted.
      if (!nativeMode) governor.observeResult(c.id, { usage, costUSD: cost });
      else if (costUsage !== undefined) governor.observeResult(c.id, { usage: costUsage, costUSD: cost });
      // W6.4: the per-case USD ceiling binds at the case grain ONLY on lanes
      // whose driver honours Budget.maxUsd (claude-agent, subprocess). The
      // ai-sdk and acp drivers ignore that field, so the run governor's
      // CUMULATIVE cap is the only bound they enforce — a single case could
      // therefore exceed its own D9 share while the run stayed under the
      // total. Detect that case-grain overrun here and RECORD it: the case's
      // evidence is incomplete for a comparison (its cost is outside the
      // envelope), so it joins the budget-stop cause column and the absence
      // list rather than passing silently as a covered case. The run is not
      // aborted — the tail keeps running under the cumulative cap, exactly
      // as a governor budget stop behaves.
      const perCaseOverrun =
        opts.maxUsdPerCase !== undefined && cost !== undefined && cost > opts.maxUsdPerCase;

      // F6 (WB-5.2a): capture the worker's diff BEFORE the check probe runs —
      // the judge mutates the workspace (restores pristine tests, scrubs
      // planted configs), so a post-scoring diff would be post-judge state,
      // not the worker's prediction. undefined = git unavailable or failed.
      if (nativeObservation !== undefined) {
        try {
          if (thrown !== undefined && nativeObservation.terminal.transportException === null) {
            nativeObservation.terminal.transportException = { name: thrown instanceof Error ? thrown.name : 'Error', message: boundDriverCause(String(thrown)) };
          }
          const rules = loadDenylistRules(repoRoot);
          let patchCaptureStatus = fixerPatch === undefined ? 'no-patch-or-capture-unavailable' : 'captured';
          if (fixerPatch !== undefined) {
            const match = findDenylistMatch(fixerPatch, 'candidate.patch', rules);
            if (match !== undefined) {
              patchCaptureStatus = `withheld:${match.id}`;
              nativeObservation.withheldArtifacts.push({ kind: 'candidate-patch', reason: `denylist:${match.id}`, sha256: sha256(fixerPatch) });
            }
            else {
              try { nativeObservation.artifacts.push({ kind: 'candidate-patch', ...artifactStore.write(artifactContext, 'candidate.patch', fixerPatch) }); }
              catch (error) {
                nativeObservation.withheldArtifacts.push({ kind: 'candidate-patch', reason: `persistence-failed:${boundDriverCause(error instanceof Error ? error.message : String(error))}`, sha256: sha256(fixerPatch) });
                caseDiagnostics.push(`case ${c.id}: candidate patch persistence failed: ${boundDriverCause(error instanceof Error ? error.message : String(error))}`);
              }
            }
          }
          if (worker?.structuredOutput !== undefined) {
            const output = `${JSON.stringify(worker.structuredOutput, null, 2)}\n`;
            const match = findDenylistMatch(output, 'worker-output.json', rules);
            if (match === undefined) {
              try { nativeObservation.artifacts.push({ kind: 'worker-output', ...artifactStore.write(artifactContext, 'worker-output.json', output) }); }
              catch (error) {
                nativeObservation.withheldArtifacts.push({ kind: 'worker-output', reason: `persistence-failed:${boundDriverCause(error instanceof Error ? error.message : String(error))}`, sha256: sha256(output) });
                caseDiagnostics.push(`case ${c.id}: worker output persistence failed: ${boundDriverCause(error instanceof Error ? error.message : String(error))}`);
              }
            }
            else nativeObservation.withheldArtifacts.push({ kind: 'worker-output', reason: `denylist:${match.id}`, sha256: sha256(output) });
          }
          nativeObservation.capture = {
            status: patchCaptureStatus,
            baselineCommit: workspaceBaseline?.commit ?? null,
            baselineTree: workspaceBaseline?.tree ?? null,
            patchSha256: fixerPatch === undefined ? null : sha256(fixerPatch),
            workspaceSha256: null,
          };
          const safeObservation = sanitizeNativeObservation(nativeObservation);
          const artifact = artifactStore.writeObservation(artifactContext, safeObservation);
          observations.push({ observation: safeObservation, artifact });
        } catch (error) {
          const why = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          caseDiagnostics.push(`case ${c.id}: evidence persistence failed: ${boundDriverCause(why)}`);
          try {
            const safeObservation = sanitizeNativeObservation(nativeObservation);
            const artifact = artifactStore.writeObservation(artifactContext, safeObservation);
            observations.push({ observation: safeObservation, artifact });
          } catch { /* Preserve scoring even when the evidence store itself is unavailable. */ }
        }
      }

      // W6.3 dynamic sentinel (RS-9 §4.3 D): before anything is scored, scan
      // every surface the worker produced — structured output, error, tool
      // denials, a driver throw, the patch, the store-side session transcript
      // and CLI sidecar, and every workspace file — for the eval root's
      // sentinel strings. This catches reach the static scan cannot model.
      const caseSources = function* (): Generator<SentinelSource> {
        if (worker !== undefined) {
          yield {
            where: 'structured output',
            text: worker.structuredOutput === undefined ? undefined : JSON.stringify(worker.structuredOutput),
          };
          yield { where: 'driver error', text: worker.error };
          yield { where: 'tool denials', text: JSON.stringify(worker.denials) };
        }
        if (thrown !== undefined) yield { where: 'driver throw', text: String(thrown) };
        yield { where: 'patch', text: fixerPatch };
        if (sessionRef !== undefined) {
          yield { where: 'session transcript', text: readIfPresent(join(SESSION_STORE_DIR, `${sessionRef}.jsonl`)) };
          yield { where: 'session sidecar', text: readIfPresent(join(SESSION_STORE_DIR, `${sessionRef}.cq-cli-session`)) };
        }
        if (workspace !== undefined) yield* workspaceSources(workspace, workspace);
      };
      const contaminatedAt = findSentinel(needles, caseSources());

      let outcome: { score: number; passed: number; total: number };
      let candidateCorrectness: boolean | null = null;
      let formatConformance: boolean | null = null;
      let assignedStrategySuccess: boolean | null = null;
      let taskJudgement: TaskOutcomeJudgement | undefined;
      let operationalStatus: NonNullable<ResultRow['outcomes']>['operationalStatus'] = 'operational-missingness';
      let journalResult: OpResult<unknown>;
      let diagnostics: string | undefined;
      // W6.2: the cause a dispatched case's row is incomplete (the row-level
      // cause column). Set only on a budget stop today; absent = complete.
      let stopCause: ResultRow['stopCause'];
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
      if (contaminatedAt !== undefined) {
        // W6.3: the worker reached outside its workspace, so its outcome is
        // evidence of nothing. NO row and NO persisted prediction (the
        // artifact would carry the sentinel onward) — a loud absence plus the
        // contamination list the CLI fails the run on.
        const cause = `sentinel-contamination: the ${contaminatedAt} carries an eval-root sentinel (the worker reached outside its workspace)`;
        outcome = zeroOutcome(probeCount);
        journalResult = { status: 'failed', error: cause };
        diagnostics = cause;
        emitRow = false;
        absences.push({ case: c.id, role: suite.role, cause });
        contaminations.push({ case: c.id, where: contaminatedAt });
      } else if (worker === undefined && !(isFixerCase(c) && fixerPatch !== undefined)) {
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
      } else if (worker?.stopReason === 'budget' && !isFixerCase(c) && worker.structuredOutput === undefined) {
        outcome = zeroOutcome(probeCount); // honest budget-exhausted: no fabricated credit
        candidateCorrectness = false;
        assignedStrategySuccess = false;
        operationalStatus = 'measured-failure';
        journalResult = { status: 'budget-exhausted' };
        diagnostics = 'driver stopped on budget';
        // W6.2: the row stays (the case ran — its partial spend and its
        // configured-but-failed probes are evidence), but the cause column
        // marks it incomplete so coverage parity sees the stop (the cell
        // counts it in budgetStops, not in coveredCases).
        stopCause = 'budget';
      } else if (worker?.stopReason === 'error' && !isFixerCase(c)) {
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
        } else if (!isFixerCase(c)) {
          // A scored-miss classifier row is still a scored row: retain the
          // expected verdict and represent the unparseable observation as a
          // null probe so confusion/FP metrics count the miss instead of
          // silently dropping it from the denominator.
          rowProbes = [{ kind: 'expected-verdict', expected: c.probe.expected, observed: null, passed: false }];
          sidecarFlag = sidecarOf(c.id, c.fixture);
          const sidecarProblem = sidecarDiagnostic(c.id, c.fixture, sidecarFlag);
          if (sidecarProblem !== undefined) caseDiagnostics.push(sidecarProblem);
        }
        // Either way the worker produced no gradeable result, so every
        // configured probe failed (passed 0 of the full ceiling).
        outcome = zeroOutcome(probeCount);
        if (isStructuredOutputMissCause(cause)) {
          candidateCorrectness = false;
          assignedStrategySuccess = false;
          operationalStatus = 'measured-failure';
        }
      } else if (worker?.stopReason === 'aborted' && !(isFixerCase(c) && fixerPatch !== undefined)) {
        outcome = zeroOutcome(probeCount);
        operationalStatus = 'interrupted';
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
        const structuredMiss = worker?.stopReason === 'error' && worker.error !== undefined && isStructuredOutputMissCause(boundDriverCause(worker.error));
        if (worker?.stopReason === 'error' && !structuredMiss && fixerPatch === undefined && thrown === undefined) {
          const cause = worker.error !== undefined ? boundDriverCause(worker.error) : 'fixer driver failed without recoverable candidate';
          outcome = zeroOutcome(probeCount);
          journalResult = { status: 'failed', error: cause };
          diagnostics = cause;
          emitRow = false;
          absences.push({ case: c.id, role: suite.role, cause });
        } else if (worker?.stopReason === 'aborted' && fixerPatch === undefined) {
          outcome = zeroOutcome(probeCount);
          journalResult = { status: 'indeterminate', detail: 'driver stopped before a recoverable candidate was captured' };
          diagnostics = 'driver cancelled before candidate capture';
          emitRow = false;
        } else {
        if (worker?.stopReason === 'budget') stopCause = 'budget';
        const scoringWorker: WorkerResult = worker ?? {
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, denials: [], stopReason: 'error',
        };
          let check: ReturnType<typeof scoreFixerWorker>;
          try {
            hostCheckEnv = workspaceBaseline?.commit === undefined
              ? undefined
              : opts.hostCheckScoringEnvironment?.(workspace as string, workspaceBaseline.commit);
            const hostBaselinePin = hostCheckEnv?.CQ_REVIEW_LOOP_BASELINE_SHA;
            if (hostBaselinePin !== undefined && hostBaselinePin !== workspaceBaseline?.commit) {
              throw new Error('host scoring baseline pin does not match the runner workspace baseline');
            }
            const hostOraclePin = hostCheckEnv?.CQ_REVIEW_LOOP_ORACLE_PIN;
            if (hostOraclePin !== undefined) {
              if (!/^[a-f0-9]{64}$/.test(hostOraclePin)) throw new Error('host scoring oracle pin must be a SHA256');
              judgePin = hostOraclePin;
            }
            check = scoreFixerWorker(
              c, scoringWorker, repoRoot, workspace as string, opts.checkTimeoutMs, workspaceBaseline?.commit, hostCheckEnv,
            );
          } catch (error) {
            const why = error instanceof Error ? error.message : String(error);
            caseDiagnostics.push(`host scoring setup failed: ${boundDriverCause(why)}`);
            check = {
              score: 0, passed: 0, total: 1, correctness: null, operationalStatus: 'judge-failure' as const,
              formatConformance: null, diagnostics: `host scoring setup failed: ${boundDriverCause(why)}`,
            };
          }
        // Probe 2 — schema compliance (runner/dimensions/schemaCompliance.ts):
        // grades ONLY the structuredOutput's shape discipline, never the
        // fix's content, so the check's sweep-agnostic contract is intact.
        const schema = scoreSchemaCompliance(scoringWorker);
        formatConformance = schema.passed === 1;
        candidateCorrectness = check.correctness ?? null;
        assignedStrategySuccess = check.correctness ?? null;
        operationalStatus = check.operationalStatus === 'judge-failure'
          ? 'judge-failure'
          : worker?.stopReason === 'aborted' ? 'interrupted'
          : thrown !== undefined ? 'measured-transport-failure'
          : check.correctness === true ? 'complete' : 'measured-failure';
        const passed = check.passed + schema.passed;
        outcome = { score: passed / FIXER_PROBE_COUNT, passed, total: FIXER_PROBE_COUNT };
        journalResult = worker?.stopReason === 'budget'
          ? { status: 'budget-exhausted' }
          : thrown === undefined ? { status: 'ok', value: outcome } : { status: 'failed', error: boundDriverCause(String(thrown)) };
        // Both probes' complaints surface; the CLI prints the first line.
        const complaints = [check.diagnostics, schema.diagnostics].filter((d): d is string => d !== undefined);
        diagnostics = [
          ...complaints,
          ...(thrown === undefined ? [] : [`driver threw after candidate capture: ${boundDriverCause(String(thrown))}`]),
        ].join('\n') || undefined;
        }
      } else {
        const s = scoreReviewClassifier(c, worker!);
        if (worker?.stopReason === 'budget') stopCause = 'budget';
        outcome = { score: s.score, passed: s.passed, total: s.total };
        formatConformance = s.formatConformance ?? null;
        candidateCorrectness = s.passed === 1;
        assignedStrategySuccess = s.passed === 1;
        operationalStatus = s.passed === 1 ? 'complete' : 'measured-failure';
        journalResult = { status: 'ok', value: outcome };
        diagnostics = s.diagnostics;
        // F4: capture the observed verdict per case into the row's probes[]
        // so the confusion matrix, macro-F1, and FP rate are computable from
        // rows.jsonl — the outcome triple alone cannot supply them.
        rowProbes = [{ kind: 'expected-verdict', expected: c.probe.expected, observed: s.observed ?? null, passed: s.passed === 1 }];
        sidecarFlag = sidecarOf(c.id, c.fixture);
        // r1-F3: a damaged sidecar is a case diagnostic (row shape
        // unchanged) — silent omission would undercount fpN/fpRate with
        // zero signal on any run the drift gate does not cover.
        const sidecarProblem = sidecarDiagnostic(c.id, c.fixture, sidecarFlag);
        if (sidecarProblem !== undefined) caseDiagnostics.push(sidecarProblem);
      }
      if (perCaseOverrun && stopCause === undefined) {
        stopCause = 'budget';
        const cause =
          `per-case budget exceeded: case ${c.id} spent $${cost!.toFixed(6)} against its ` +
          `$${opts.maxUsdPerCase} per-case ceiling — evidence recorded, coverage excluded (W6.4)`;
        diagnostics = diagnostics === undefined ? cause : `${diagnostics}\n${cause}`;
        absences.push({ case: c.id, role: suite.role, cause });
      }
      if (opts.experiment !== undefined && (fixerPatch !== undefined || worker?.structuredOutput !== undefined)) {
        const isFixer = isFixerCase(c);
        const candidateBytes = isFixer ? fixerPatch! : `${JSON.stringify(worker!.structuredOutput, null, 2)}\n`;
        const candidateSha256 = sha256(candidateBytes);
        const candidateName = isFixer ? 'candidate.patch' : 'candidate-output.json';
        const artifactKind = isFixer ? 'candidate-patch' : 'worker-output';
        let candidateRef = nativeObservation?.artifacts.find((artifact) => artifact.kind === artifactKind && artifact.sha256 === candidateSha256);
        if (candidateRef === undefined) {
          try {
            const match = findDenylistMatch(candidateBytes, candidateName, loadDenylistRules(repoRoot));
            if (match === undefined) candidateRef = { kind: artifactKind, ...artifactStore.write(artifactContext, candidateName, candidateBytes) };
            else caseDiagnostics.push(`case ${c.id}: candidate withheld by denylist rule ${match.id}`);
          } catch (error) {
            const why = error instanceof Error ? error.message : String(error);
            caseDiagnostics.push(`case ${c.id}: candidate persistence failed: ${boundDriverCause(why)}`);
          }
        }
        if (candidateRef !== undefined && judgePin !== undefined && /^[a-f0-9]{64}$/.test(judgePin)) {
          const judgementId = randomUUID();
          const judgement = {
            judgementId, version: 1, judgePin, candidateSha256,
            judgeManifest: taskInput!.judgeManifest, baselineCommit, baselineTree,
            candidateCorrectness, formatConformance, assignedStrategySuccess, operationalStatus,
          };
          const artifact = artifactStore.writeJudgement(artifactContext, judgementId, candidateSha256, judgePin, { ...judgement, outcome });
          judgements.push(artifact);
          taskJudgement = { ...judgement, artifact };
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
      const launchedBudgetStop = worker?.stopReason === 'budget';
      const hasCandidate = fixerPatch !== undefined || worker?.structuredOutput !== undefined;
      if (launchedBudgetStop) stopCause = 'budget';
      if (launchedBudgetStop && !hasCandidate) {
        candidateCorrectness = false;
        assignedStrategySuccess = false;
        if (operationalStatus !== 'judge-failure') operationalStatus = 'measured-failure';
      }
      const credentialFailure = thrown instanceof Error && /requires [A-Z0-9_]+_API_KEY in the environment/.test(thrown.message);
      const observedTerminal = nativeObservation?.terminal.cause;
      const execution: NonNullable<TaskOutcome['execution']> = {
        launched: launchedBudgetStop || worker?.stopReason === 'complete' ? true
          : credentialFailure ? false
            : thrown !== undefined ? null
              : worker !== undefined ? true : false,
        terminalCause: launchedBudgetStop ? 'budget-exhausted'
          : worker?.stopReason === 'complete' ? 'complete'
            : credentialFailure ? 'prelaunch-failure'
              : thrown !== undefined || nativeObservation?.terminal.transportException !== null && nativeObservation !== undefined
                ? 'transport-error'
                : observedTerminal === 'provider-cancelled' ? 'provider-cancelled'
                  : observedTerminal === 'operator-cancelled' || nativeObservation?.terminal.cancelled === true ? 'operator-cancelled'
                    : worker === undefined ? 'prelaunch-failure' : 'unknown',
        sourceInvocationIds: [invocationIdentity.invocationId],
      };
      const taskOutcome: TaskOutcome | undefined = opts.experiment === undefined ? undefined : {
        identity: {
          campaignId: artifactContext.campaignId, cohortId: artifactContext.cohortId,
          experimentId: artifactContext.experimentId, taskId: artifactContext.taskId,
          substrateId: artifactContext.substrateId, track: artifactContext.track, repeatId: artifactContext.repeatId,
          assignmentId: artifactContext.assignmentId, strategyId: artifactContext.strategyId,
          role: suite.role, budgetId: artifactContext.budgetId, frozenWeight: artifactContext.frozenWeight,
        },
        candidateCorrectness, formatConformance, assignedStrategySuccess, operationalStatus,
        execution,
        stages: [{
          stageId: invocationIdentity.stageId, attemptId: invocationIdentity.attemptId,
          invocationId: invocationIdentity.invocationId,
          artifacts: (nativeObservation?.artifacts ?? []).map(({ kind, path, sha256: digest }) => ({ kind, path, sha256: digest })),
          ...(observations.find((item) => item.observation.identity.invocationId === invocationIdentity.invocationId) !== undefined
            ? { observation: observations.find((item) => item.observation.identity.invocationId === invocationIdentity.invocationId)!.artifact }
            : {}),
        }],
        judgements: taskJudgement === undefined ? [] : [taskJudgement],
      };
      if (emitRow) rows.push({
        role: suite.role, suite: suite.name, case: c.id, model, driver: driverName,
        // F6/CQ-4: only a non-default variant rides the row, so the default
        // posture (and every pre-F6 row) keeps its exact shape.
        ...(variant !== 'default' ? { variant } : {}),
        // W6.2: every row carries the suite's declared case count (the
        // coverage denominator — budget-gated undispatched cases have no
        // rows, so it must ride the rows) and, on a budget-stopped case,
        // the cause its evidence is incomplete.
        expectedCases: suite.cases.length,
        ...(stopCause !== undefined ? { stopCause } : {}),
        outcome, costUSD: cost ?? null,
        ...(cost !== undefined ? { costBasis: 'modeled' as const } : {}),
        ...(rowProbes !== undefined ? { probes: rowProbes } : {}),
        ...(sidecarFlag === 'flagged' ? { suspiciousBenign: true } : {}),
        wallTimeMs,
        tokens: tokensOf(usage),
        ...(opts.experiment !== undefined ? { experiment: {
          campaignId: artifactContext.campaignId, cohortId: artifactContext.cohortId,
          experimentId: artifactContext.experimentId, taskId: artifactContext.taskId,
          repeatId: artifactContext.repeatId, assignmentId: artifactContext.assignmentId,
          stageId: artifactContext.stageId, attemptId: artifactContext.attemptId,
          track: artifactContext.track, strategyId: artifactContext.strategyId,
          settingsId: artifactContext.settingsId, budgetId: artifactContext.budgetId,
          profileId: artifactContext.profileId, frozenWeight: artifactContext.frozenWeight,
          substrateId: artifactContext.substrateId, judgePin: judgePin!,
        } } : {}),
        ...(taskOutcome !== undefined ? { taskOutcome } : {}),
        ...(nativeObservation !== undefined ? {
          observedUsage: measuredUsage!,
          modelIdentity: {
            configuredTarget: nativeObservation.model.configuredTarget,
            requestedModel: nativeObservation.model.requested.value,
            servedModel: nativeObservation.model.observed.value,
          },
          outcomes: { candidateCorrectness, formatConformance, assignedStrategySuccess, operationalStatus },
        } : opts.experiment !== undefined ? {
          outcomes: { candidateCorrectness, formatConformance, assignedStrategySuccess, operationalStatus },
        } : {}),
        runId, timestamp: now(),
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
        const why = contaminatedAt !== undefined ? 'sentinel contamination' : 'driver error (dispatch-only absence)';
        console.error(`  case ${c.id}: not published — ${why}: ${diagnostics?.split('\n')[0] ?? ''}`);
      }
    } finally {
      // The materialized workspace is the driver's scratch: graded against,
      // then removed — even when the case aborts mid-flight. The pristine
      // fixture under repoRoot is never touched.
      if (workspace !== undefined) {
        // The session store lives beside the scratch workspaces, so remove
        // the graded copy and the completed run's private transcript/sidecars
        // after grading. A shared store must not accumulate worker history.
        rmSync(workspace, { recursive: true, force: true });
        if (workspaceBaseline !== undefined) rmSync(workspaceBaseline.gitDir, { recursive: true, force: true });
        if (sessionRef !== undefined) {
          rmSync(join(SESSION_STORE_DIR, `${sessionRef}.jsonl`), { force: true });
          // claude-agent and subprocess write store-side sidecars; ACP's is
          // workspace-local and is removed with the workspace above.
          rmSync(join(SESSION_STORE_DIR, `${sessionRef}.cq-cli-session`), { force: true });
        }
      }
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
    contaminations,
    runId,
    observations,
    judgements,
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
