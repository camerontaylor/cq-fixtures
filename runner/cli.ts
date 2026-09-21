// CLI wiring for the eval runner: flag parsing, driver construction, output
// writing, and the I1 exit-code discipline — 0 clean; 1 a case scored zero,
// the run was budget-gated, or a post-load run/validation error; 2 usage
// error or suite load/validation failure (the suite.yml workflow hard-fails
// its rc>=2 branch). Invoked via runner/index.ts.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AcpDriver,
  AiSdkDriver,
  ClaudeAgentDriver,
  defaultRoutingTable,
  SubprocessDriver,
  type Driver,
} from '@camerontaylor/cq-toolkit';
import { z } from 'zod';
import { PREFLIGHT_PROBE_RESERVE_TOKENS, runSuite, type PreflightProbe } from './index.ts';
import { perSuiteTokenCap } from './budget.ts';
import type { ComparisonTable, ResultRow, SuiteRole } from './aggregate.ts';
import { loadSuite, suiteVariant, type Suite } from './suite.ts';
import { publishArtifacts, writeRunManifest, type CaseArtifact, type RunManifestEntry } from './persist.ts';
import { regrade } from './regrade.ts';
import { DEFAULT_CHECK_TIMEOUT_MS } from './score/fixerWorker.ts';
import { FakeDriver } from './fake-driver.ts';
// DD-4: the fixer-worker's structured-output shape — the classifier's
// verdict schema is mirrored locally below, the fixer's lives on the
// dimensions module it is graded against, so both probes target one source
// of truth.
import { FIXER_OUTPUT_SCHEMA } from './dimensions/schemaCompliance.ts';

const LANES = new Set(['ai-sdk', 'claude-agent', 'subprocess', 'acp']);
// --driver values: the schema-blind fake plus the toolkit's four real lanes
// (derived from the LANES set above so the two lists stay synchronized).
type DriverKind = 'fake' | 'ai-sdk' | 'claude-agent' | 'subprocess' | 'acp';
const DRIVERS = new Set<string>(['fake', ...LANES]);
// ADR-0001 eval axes (the per-cell constraint in
// schema/comparison-table.schema.json): axis 1 — models vary on the ai-sdk
// driver; axis 2 — drivers vary on the fixed GLM served id. A paid ai-sdk
// run labeled as another lane is the same misattribution, so --driver
// ai-sdk always pairs with --driver-name ai-sdk (fake runs with an explicit
// lane label stay legal — that is the smoke story).
const FIXED_GLM_SERVED_ID = 'glm-5.3-flash';
const USAGE =
  'usage: node --experimental-strip-types runner/index.ts --suite <dir> [--suite <dir> …] ' +
  '--driver fake|ai-sdk|claude-agent|subprocess|acp --model <served-id> --provider <handle> [--driver-name <ai-sdk|claude-agent|subprocess|acp>] ' +
  '(--driver-name is required with --driver fake — a fake run must name the lane it stands in for) ' +
  '[--max-usd <n>] [--max-tokens <n>] [--max-tokens-per-case <n>] [--check-timeout-ms <n>] [--journal <dir>] [--out <dir>] [--probe-record <path>] [--suite-sha <sha>]\n' +
  `axes: --model ${FIXED_GLM_SERVED_ID} unless --driver-name ai-sdk (ADR-0001)\n` +
  "caps: --max-tokens caps ONE suite run (each runSuite owns its governor); --max-tokens-per-case is multiplied by that suite's case count (WB-1.6) — pass one, never both\n" +
  'exits: 0 clean; 1 a case scored zero / run budget-gated / post-load error; 2 usage, suite load, or missing-credential failure\n' +
  'subcommand: regrade --from <out> [--rejudge] [--check-timeout-ms <n>] re-aggregates a finished run (no re-dispatch)';

export class UsageError extends Error {}

// Real-lane review-classifier runs NEED structured output: without a schema
// the ai-sdk lane never produces structuredOutput.verdict and every
// classifier case scores 0 regardless of model behavior. The vocabulary is
// mirrored locally (classifyThreads is not on the toolkit's export surface;
// enum-identical to schema/suite.schema.json).
const VERDICT_OUTPUT_SCHEMA = z.object({
  verdict: z.enum(['actionable', 'responded', 'resolved', 'blocked', 'skip']),
});

// Review-debt #14: the workflow's ACP auth preflight proves headless agent
// auth with a real (tiny) model request before the runner starts. Its record
// (reports/eval/ACP-PROBE.json) rides in here so the probe is admitted
// through the run's governor and journaled with the run instead of spending
// off-books. A missing or malformed record is a usage error (exit 2): the
// acp eval cell runs only after an auth-OK preflight, which always writes
// the record — an unaccounted probe must never silently run as ungoverned.
const PROBE_RECORD_SCHEMA = z.object({
  probe: z.literal('acp-auth-preflight'), // .strict(): unknown keys fail loud instead of dropping silently

  // ISO-8601: the record's timestamp rides into the journal verbatim, so a
  // non-datetime string would pollute the journal's time-ordered evidence.
  at: z.string().datetime(),
  promptChars: z.number().int().nonnegative(),
  replyChars: z.number().int().nonnegative(),
  // Bounded: the preview lands in the journal value on every suite run, so
  // an unbounded string would bloat the journal (the writer slices to 200;
  // the boundary re-enforces it for hand-written records).
  replyPreview: z.string().max(200),
}).strict();

// The subprocess lane runs the fixed axis-2 served id (see FIXED_GLM_SERVED_ID
// above), but the toolkit's default routing table predates the served-id
// decision (2026-09-14): its `zai` allowlist carries the GLM names the
// provider docs listed then, not the GLM coding wire's glm-5.3-flash — and
// `routeFor` refuses any model off the allowlist. The routingTable
// constructor option is the designed per-deployment override surface, so the
// subprocess lane rebuilds the default table with the served id appended.
function subprocessRoutingTable() {
  const table = defaultRoutingTable();
  const zai = table.endpoints['zai']!;
  return {
    ...table,
    endpoints: {
      ...table.endpoints,
      zai: { ...zai, models: [...zai.models, FIXED_GLM_SERVED_ID] },
    },
  };
}

// ACP harness argv: since ~0.43 the bare `zcode-acp-server` bin opens its
// interactive TUI — the editor-facing stdio ACP bridge is the `server`
// subcommand (probed 2026-09-19 at zcode-acp-server 0.43.3, engines
// node>=22). The toolkit's default endpoint argv (['zcode-acp-server'],
// probed at 0.37.3) is stale for 0.43.x, and the driver's explicit
// `command` argv wins over the endpoint table — so pass the whole argv.
const ACP_COMMAND = ['zcode-acp-server', 'server'] as const;

function nextValue(argv: readonly string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined) throw new UsageError(`flag ${flag} requires a value\n${USAGE}`);
  return v;
}

/** F6: the pinned toolkit.lock value, recorded in the run manifest (null when absent). */
function readToolkitLock(repoRoot: string): string | null {
  try {
    return readFileSync(join(repoRoot, 'toolkit.lock'), 'utf8').trim();
  } catch {
    return null;
  }
}

interface CliOptions {
  suites: string[];
  driver: DriverKind;
  model: string;
  provider: string;
  maxUsd?: number;
  maxTokens?: number;
  maxTokensPerCase?: number;
  checkTimeoutMs: number;
  journal?: string;
  out?: string;
  probeRecord?: string;
  driverName: string;
  /** F6: the suite checkout's git SHA for the run manifest (falls back to $GITHUB_SHA). */
  suiteSha?: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  // No cap default-injection: absent --max-usd/--max-tokens mean ABSENT
  // caps, so a token-only cap can bind an unpriced lane (DD-9). --driver is
  // REQUIRED: a silent fake default would make synthetic rows
  // indistinguishable from real-lane rows.
  let driver: DriverKind | undefined;
  const suites: string[] = [];
  let model = '';
  let provider = '';
  let driverName = '';
  let maxUsd: number | undefined;
  let maxTokens: number | undefined;
  let maxTokensPerCase: number | undefined;
  let checkTimeoutMs = 60_000;
  let journal: string | undefined;
  let out: string | undefined;
  let probeRecord: string | undefined;
  let suiteSha: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    switch (flag) {
      case '--suite': suites.push(nextValue(argv, i, flag)); i++; break;
      case '--driver': {
        const v = nextValue(argv, i, flag);
        if (!DRIVERS.has(v)) {
          throw new UsageError(`--driver must be ${[...DRIVERS].join('|')}, got '${v}'`);
        }
        driver = v as DriverKind; i++; break;
      }
      case '--model': model = nextValue(argv, i, flag); i++; break;
      case '--provider': provider = nextValue(argv, i, flag); i++; break;
      case '--driver-name': driverName = nextValue(argv, i, flag); i++; break;
      case '--journal': journal = nextValue(argv, i, flag); i++; break;
      case '--out': out = nextValue(argv, i, flag); i++; break;
      case '--probe-record': probeRecord = nextValue(argv, i, flag); i++; break;
      case '--suite-sha': suiteSha = nextValue(argv, i, flag); i++; break;
      case '--max-usd': case '--max-tokens': case '--max-tokens-per-case': case '--check-timeout-ms': {
        const n = Number(nextValue(argv, i, flag));
        if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number`);
        // Token/time budgets are whole units: a fractional value would
        // round-trip into the governor unpredictably, and an unsafe integer
        // (1e308) overflows perSuiteTokenCap's product — fail loud at parse
        // time instead. --max-usd stays fractional (a USD cap may be 0.5).
        if (flag !== '--max-usd' && !Number.isSafeInteger(n)) {
          throw new UsageError(`${flag} must be a positive safe integer`);
        }
        if (flag === '--max-usd') maxUsd = n;
        else if (flag === '--max-tokens') maxTokens = n;
        else if (flag === '--max-tokens-per-case') maxTokensPerCase = n;
        else checkTimeoutMs = n;
        i++; break;
      }
      default: throw new UsageError(`unknown flag '${flag}'\n${USAGE}`);
    }
  }
  if (driver === undefined) {
    throw new UsageError(`--driver is required (${[...DRIVERS].join('|')})\n${USAGE}`);
  }
  if (suites.length === 0 || model === '' || provider === '') {
    throw new UsageError(`--suite, --model and --provider are required\n${USAGE}`);
  }
  driverName = driverName === '' ? driver : driverName;
  if (!LANES.has(driverName)) {
    throw new UsageError(`--driver-name '${driverName}' is not a toolkit lane (${[...LANES].join('|')}) — pass one so rows validate`);
  }
  // T1: a paid run labeled as another lane is a silent misattribution —
  // refuse it on EVERY real lane (the guard predates the lane openings and
  // covered only ai-sdk; a claude-agent run labeled ai-sdk misattributes the
  // same way). Fake runs with an explicit lane label stay legal (the smoke
  // story).
  if (driver !== 'fake' && driverName !== driver) {
    throw new UsageError(`--driver ${driver} with --driver-name '${driverName}' mislabels paid ${driver} results as another lane — drop --driver-name or use --driver fake`);
  }
  // ADR-0001 eval axes: fail at parse time, before any spend, rather than
  // after a full paid run misreported as an eval outcome.
  if (driverName !== 'ai-sdk' && model !== FIXED_GLM_SERVED_ID) {
    throw new UsageError(
      `--model '${model}' on lane '${driverName}' violates the ADR-0001 eval axes: ` +
        `models vary on the ai-sdk driver; drivers vary on the fixed served id '${FIXED_GLM_SERVED_ID}' ` +
        '(schema/comparison-table.schema.json)',
    );
  }
  // WB-1.6: the two caps are different denominations — silently preferring
  // one would hide an operator error (an absolute cap where a per-case
  // budget was meant, or the reverse).
  if (maxTokens !== undefined && maxTokensPerCase !== undefined) {
    throw new UsageError(
      "--max-tokens and --max-tokens-per-case are mutually exclusive: the first is an absolute per-suite-run cap, the second is multiplied by that suite's case count (WB-1.6) — pass one",
    );
  }
  return { suites, driver, model, provider, maxUsd, maxTokens, maxTokensPerCase, checkTimeoutMs, journal, out, probeRecord, driverName, suiteSha };
}

async function main(argv: readonly string[]): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) { console.error(e.message); return 2; }
    throw e;
  }
  // Suites load BEFORE driver construction: load/validation failures map to
  // exit 2 (hard-fail in the workflow), and the loaded roles decide which
  // output schema the ai-sdk lane requests (classifier → verdict vocabulary,
  // fixer → the DD-4 fixer verdict shape).
  let suites: Suite[];
  try {
    suites = opts.suites.map((d) => loadSuite(d));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return 2;
  }
  // B3: enforce suite.servedModel at the seam (served-id decision
  // 2026-09-14) — a mismatch means the operator is pointing the suite at a
  // wire that does not serve the pinned id; refuse before any dispatch
  // rather than misrecord rows.
  const mismatched = suites.find((s) => s.servedModel !== undefined && s.servedModel !== opts.model);
  if (mismatched !== undefined) {
    console.error(`suite '${mismatched.name}' pins servedModel '${mismatched.servedModel}' but --model is '${opts.model}' — point the run at the wire that serves the pinned id`);
    return 2;
  }
  // Review-debt #14: resolve the pre-runner probe record before ANY dispatch
  // burns spend — a missing or malformed record is exit 2 (usage), never a
  // silently ungoverned probe.
  let preflightProbe: PreflightProbe | undefined;
  if (opts.probeRecord !== undefined) {
    try {
      const parsed = PROBE_RECORD_SCHEMA.parse(JSON.parse(readFileSync(opts.probeRecord, 'utf8')) as unknown);
      preflightProbe = {
        at: parsed.at,
        promptChars: parsed.promptChars,
        replyChars: parsed.replyChars,
        replyPreview: parsed.replyPreview,
      };
    } catch (e) {
      console.error(
        `--probe-record '${opts.probeRecord}' is missing or invalid (the acp preflight must write ACP-PROBE.json on auth-OK): ${e instanceof Error ? e.message : String(e)}`,
      );
      return 2;
    }
  }
  // B4: same-role suites collide on <role>.table.json in the shared --out
  // dir — refuse here, before ANY dispatch burns spend.
  const seenRoles = new Set<SuiteRole>();
  for (const s of suites) {
    if (seenRoles.has(s.role)) {
      console.error(`two suites share role '${s.role}' (<role>.table.json would collide) — run one suite per role per invocation`);
      return 2;
    }
    seenRoles.add(s.role);
  }
  // One driver PER SUITE: a mixed invocation (fixer + classifier suites)
  // must not force one role's outputSchema onto the other — each suite's
  // role decides its own construction (F3/G6): every REAL lane requests
  // classifier → VERDICT_OUTPUT_SCHEMA, fixer → FIXER_OUTPUT_SCHEMA (DD-4).
  // FakeDriver is unchanged and stays schema-blind: it never emits the
  // fixer's {fixed, notes} shape, so a fake fixer row honestly fails the
  // schema-compliance probe.
  const rows: ResultRow[] = [];
  const tables: ComparisonTable[] = [];
  let anyFailed = false;
  let materializationFailures = 0;
  const materializationDiagnostics: string[] = [];
  // F6: the prediction artifacts + the run manifest published with the tables.
  const artifactList: CaseArtifact[] = [];
  const manifestEntries: RunManifestEntry[] = [];
  // repoRoot mirrors runner/index.ts's default (this file lives in runner/).
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  // F6: the suite checkout's git SHA rides into the manifest (the snapshot's
  // README header records it for CQ-5 attribution). $GITHUB_SHA is set for
  // every CI step; --suite-sha overrides it for local runs.
  const suiteSha = opts.suiteSha ?? process.env.GITHUB_SHA ?? null;
  // Run + score phase: a scored-zero or budget-gated result — or a failure
  // thrown here — is exit 1 (a benign eval outcome the workflow warns on).
  try {
    for (const [suiteDir, suite] of opts.suites.map((d, i) => [d, suites[i]!] as const)) {
      const outputSchema = suite.role === 'review-classifier' ? VERDICT_OUTPUT_SCHEMA : FIXER_OUTPUT_SCHEMA;
      const driver: Driver =
        opts.driver === 'ai-sdk' ? new AiSdkDriver({ outputSchema })
        : opts.driver === 'claude-agent' ? new ClaudeAgentDriver({ outputSchema })
        // Axis-2 subprocess run: the routing override (see
        // subprocessRoutingTable) admits the fixed served id.
        : opts.driver === 'subprocess' ? new SubprocessDriver({ outputSchema, routingTable: subprocessRoutingTable() })
        : opts.driver === 'acp' ? new AcpDriver({ outputSchema, command: ACP_COMMAND })
        : new FakeDriver();
      // Review-debt #14: every suite invocation in this process carries the
      // same probe — each run owns its own governor and journal, so each
      // cap conservatively covers the probe (see runner/index.ts).
      const result = await runSuite({
        suiteDir, driver,
        model: opts.model, provider: opts.provider,
        maxUsd: opts.maxUsd,
        // WB-1.6: allocate each suite its OWN cap (perCase × that suite's
        // case count), so a multi-suite invocation's allowance is
        // non-overlapping instead of each runSuite resetting to the
        // invocation total. The preflight probe's conservative reservation
        // is charged per suite run because each runSuite owns its own
        // governor and admits the probe into it (review-debt #14) — the
        // same conservative direction the runner documents.
        maxTokens:
          opts.maxTokensPerCase !== undefined
            ? perSuiteTokenCap(
                opts.maxTokensPerCase,
                suite.cases.length,
                preflightProbe !== undefined ? PREFLIGHT_PROBE_RESERVE_TOKENS : 0,
              )
            : opts.maxTokens,
        checkTimeoutMs: opts.checkTimeoutMs,
        journalPath: opts.journal, driverName: opts.driverName,
        preflightProbe,
      });
      rows.push(...result.rows);
      tables.push(...result.tables);
      // F6 (WB-5.2a/5.1): carry the predictions and the run identity forward
      // for the emit phase, where they are bounded, denylist-scanned, and
      // written beside the tables.
      artifactList.push(...result.artifacts);
      manifestEntries.push({
        role: suite.role,
        suite: suite.name,
        // F6: the manifest records a repo-root-relative suiteDir so regrade
        // can resolve it against its own --repo-root; a caller's absolute
        // --suite would otherwise be unusable there.
        suiteDir: relative(repoRoot, resolve(suiteDir)),
        model: opts.model,
        driver: opts.driverName,
        variant: suiteVariant(suite),
        toolkitLock: readToolkitLock(repoRoot),
        suiteSha,
        // F1b: the run identity the runner generated — used verbatim, so a
        // suite whose every case was a dispatch-only absence (zero rows)
        // still records its real runId instead of an 'unknown' placeholder.
        runId: result.runId,
        generatedAt: new Date().toISOString(),
        // F1b (WB-1): a non-model driver cause publishes NO row — record the
        // absence in the manifest so the workflow can warn loudly and drop a
        // dispatch-only marker instead of a fabricated zero. Only on a
        // non-empty list, so a clean run's run.json bytes are unchanged.
        ...(result.absences.length > 0
          ? { absences: result.absences.map((a) => ({ case: a.case, cause: a.cause })) }
          : {}),
      });
      // X2 inputs arrive STRUCTURED from the runner (round 3): the runner
      // classifies its own infrastructure refusals, so the CLI prints them
      // without re-matching diagnostics prose.
      materializationFailures += result.materializationFailures;
      materializationDiagnostics.push(...result.materializationDiagnostics);
      const passed = result.rows.reduce((n, r) => n + r.outcome.passed, 0);
      const total = result.rows.reduce((n, r) => n + r.outcome.total, 0);
      if (result.rows.some((r) => r.outcome.passed === 0)) anyFailed = true;
      // F1b (WB-1): a suite whose cases all became dispatch-only absences has
      // no rows, so the passed/total fold alone would report it clean. An
      // absence is never a clean run — it is a loud, non-zero outcome.
      for (const a of result.absences) {
        console.error(`  ${opts.model}@${opts.driverName} ${a.role} case ${a.case}: not published — ${a.cause}`);
      }
      if (result.absences.length > 0) anyFailed = true;
      // A budget-gated run did not complete: never report it as clean (the
      // gated cases are also visible on the run-finished journal event).
      if (result.gatedByBudget) anyFailed = true;
      // F1b: the run identity comes from the runner, not from the first row —
      // an all-absence suite has no rows but still has a run to name.
      const runSuffix = `, run ${result.runId}`;
      const suiteName = result.rows[0]?.suite ?? suiteDir;
      console.log(`suite ${suiteName}: ${passed}/${total} probes passed across ${result.rows.length} case(s)${runSuffix}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A pre-dispatch missing-credential throw is infrastructure (the secret
    // is absent), not an eval outcome — hard-fail so CI never publishes
    // zero tables while green. Name the env var the toolkit asked for.
    const envVar = message.match(/requires ([A-Z0-9_]+_API_KEY) in the environment/)?.[1];
    if (envVar !== undefined) {
      console.error(`required env ${envVar} missing (add this repo's Actions secret and map it onto the toolkit's ${envVar} env): ${message}`);
      return 2;
    }
    // Run-phase failures (row/table validation of a scored run) stay exit 1.
    console.error(message);
    return 1;
  }
  // X2: materialization failures are infrastructure — the driver never ran
  // for those cases — so they hard-fail (exit 2) with the count and the
  // affected case ids (already carried in the diagnostics), instead of a
  // benign scored-zero warning.
  if (materializationFailures > 0) {
    console.error(`${materializationFailures} case(s) failed fixture materialization (the driver never ran):`);
    for (const d of materializationDiagnostics) console.error(`  ${d}`);
    return 2;
  }
  // X1: report/emit phase — row/table validation of our own output, journal
  // I/O, out-dir creation, writeFileSync. Infrastructure errors here are
  // exit 2, never a benign scored-zero warning.
  try {
    if (opts.out !== undefined) {
      mkdirSync(opts.out, { recursive: true });
      // Same-role collisions were refused before any dispatch (see above).
      for (const t of tables) {
        writeFileSync(join(opts.out, `${t.role}.table.json`), JSON.stringify(t, null, 2) + '\n');
      }
      writeFileSync(join(opts.out, 'rows.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : ''));
      // F6 (WB-5.2a): persist the prediction + the run manifest. Each artifact
      // is size-bounded and denylist-scanned before it is written; a withheld
      // artifact is diagnosed, never silently dropped.
      const published = publishArtifacts(opts.out, artifactList, repoRoot);
      for (const d of published.diagnostics) console.error(`  ${d}`);
      writeRunManifest(opts.out, manifestEntries);
      console.log(`wrote ${opts.out}/rows.jsonl, ${tables.length} table(s), ${published.published.length} prediction artifact(s) and run.json`);
    }
  } catch (e) {
    console.error(`report/emit failure: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  return anyFailed ? 1 : 0;
}

/** F6 (WB-5.2b): `runner regrade --from <out>` usage. */
const REGRADE_USAGE =
  'usage: node --experimental-strip-types runner/index.ts regrade --from <out> [--rejudge] [--repo-root <dir>] [--check-timeout-ms <n>]\n' +
  'regrade re-reads <out>/rows.jsonl and re-aggregates the tables without re-dispatch, preserving the\n' +
  'original generatedAt so a plain regrade is byte-identical. --rejudge additionally re-runs the LOCAL\n' +
  'judge over the persisted predictions (<out>/patches/<case>.patch, <out>/outputs/<case>.json);\n' +
  '--repo-root (default: this repo) resolves the manifest\'s suiteDir and the cases\' fixture/check paths.\n' +
  'exits: 0 clean; 2 usage or I/O failure';

function parseRegradeArgs(argv: readonly string[]): { from: string; rejudge: boolean; checkTimeoutMs: number; repoRoot?: string } {
  let from = '';
  let rejudge = false;
  let checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS;
  let repoRoot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    switch (flag) {
      case '--from': from = nextValue(argv, i, flag); i++; break;
      case '--rejudge': rejudge = true; break;
      case '--repo-root': repoRoot = nextValue(argv, i, flag); i++; break;
      case '--check-timeout-ms': {
        const n = Number(nextValue(argv, i, flag));
        if (!Number.isFinite(n) || n <= 0 || !Number.isSafeInteger(n)) {
          throw new UsageError('--check-timeout-ms must be a positive safe integer');
        }
        checkTimeoutMs = n; i++; break;
      }
      default: throw new UsageError(`unknown flag '${flag}'\n${REGRADE_USAGE}`);
    }
  }
  if (from === '') throw new UsageError(`--from <out> is required\n${REGRADE_USAGE}`);
  return { from, rejudge, checkTimeoutMs, ...(repoRoot !== undefined ? { repoRoot } : {}) };
}

/**
 * F6 (WB-5.2b): regrade entry. Re-aggregates the out dir's rows.jsonl in
 * place (and re-judges persisted predictions with --rejudge), writing each
 * table back as `JSON.stringify(t, null, 2) + '\n'` — the exact formatting
 * the run-mode emit phase uses, so a plain regrade is byte-identical.
 */
function regradeMain(argv: readonly string[]): number {
  let opts: { from: string; rejudge: boolean; checkTimeoutMs: number; repoRoot?: string };
  try {
    opts = parseRegradeArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) { console.error(e.message); return 2; }
    throw e;
  }
  try {
    const result = regrade({
      from: opts.from,
      rejudge: opts.rejudge,
      checkTimeoutMs: opts.checkTimeoutMs,
      ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
    });
    for (const d of result.diagnostics) console.error(`  ${d}`);
    // --rejudge re-derived the rows from the persisted predictions; persist the
    // updated rows.jsonl (run-mode JSONL formatting) so the flipped outcome is
    // durable and a subsequent plain regrade replays the NEW rows. A plain
    // regrade leaves rows.jsonl untouched.
    if (opts.rejudge) {
      writeFileSync(
        join(opts.from, 'rows.jsonl'),
        result.rows.map((r) => JSON.stringify(r)).join('\n') + (result.rows.length > 0 ? '\n' : ''),
      );
    }
    for (const t of result.tables) {
      writeFileSync(join(opts.from, `${t.role}.table.json`), JSON.stringify(t, null, 2) + '\n');
    }
    console.log(
      `regrade ${opts.from}: ${result.rows.length} row(s), ${result.rejudged} re-judged, ` +
      `${result.changed} changed, ${result.tables.length} table(s)`,
    );
    return 0;
  } catch (e) {
    console.error(`regrade failure: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

/** Process entry: returns the exit code, never throws past the CLI boundary. */
export async function cliMain(argv: readonly string[]): Promise<number> {
  if (argv[0] === 'regrade') return regradeMain(argv.slice(1));
  try {
    return await main(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return 1;
  }
}
