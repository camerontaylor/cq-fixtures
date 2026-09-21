// F6 (WB-5.2b): regrade WITHOUT re-dispatch. `regrade --from <out>` re-reads
// the run's persisted rows.jsonl and re-aggregates the tables — the same
// aggregate() the live runner uses, so a regrade reproduces the tables
// byte-identically (the original table's generatedAt is preserved: a regrade
// is not a new run). `--rejudge` additionally re-runs the LOCAL judge over
// the persisted prediction — a fixer patch is re-applied to a pristine
// fixture and the check probe re-run, a classifier's persisted structured
// output is re-scored — so a judge or metric change can be applied to
// already-recorded evidence without spending a token.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import type { WorkerResult } from '@camerontaylor/cq-toolkit';
import { aggregate, type ComparisonTable, type ResultRow } from './aggregate.ts';
import { scoreSchemaCompliance } from './dimensions/schemaCompliance.ts';
import { DEFAULT_CHECK_TIMEOUT_MS, FIXER_PROBE_COUNT, scoreFixerWorker } from './score/fixerWorker.ts';
import { scoreReviewClassifier } from './score/reviewClassifier.ts';
import { isFixerCase, loadSuite, type Suite, type SuiteCase } from './suite.ts';
import { isSafeCaseSegment, isTruncated, type RunManifestEntry } from './persist.ts';

const DEFAULT_REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// F6: a regrade overwrites the run's rows/tables, so it validates every
// parsed row against the SAME schema the live runner emits before touching
// anything (a malformed rows.jsonl must fail loud, never be re-aggregated
// into a misleading overwrite).
const ajv = ajvFormats(new Ajv2020({ allErrors: true }));
const validateRow = ajv.compile(
  JSON.parse(readFileSync(new URL('../schema/result-row.schema.json', import.meta.url), 'utf8')) as object,
);

export interface RegradeOptions {
  /** The run's out dir (holds rows.jsonl, and — with rejudge — run.json + patches/ + outputs/). */
  from: string;
  /** Re-run the local judge over persisted predictions instead of only re-aggregating. */
  rejudge?: boolean;
  /** Repo root fixture/check paths resolve against. Defaults to this repo. */
  repoRoot?: string;
  /** Ceiling for one re-judged check-probe execution (default: scorer's 60_000). */
  checkTimeoutMs?: number;
}

export interface RegradeResult {
  rows: ResultRow[];
  tables: ComparisonTable[];
  /** Rows whose outcome came from a persisted prediction instead of the recorded row. */
  rejudged: number;
  /** Re-judged rows whose outcome differs from the recorded one (the point of --rejudge). */
  changed: number;
  diagnostics: string[];
}

/** Parse the persisted NDJSON rows; a blank line is not a row. Every row is schema-validated. */
function readRows(from: string): ResultRow[] {
  const path = join(from, 'rows.jsonl');
  const raw = readFileSync(path, 'utf8');
  const rows: ResultRow[] = [];
  let line = 0;
  for (const text of raw.split('\n')) {
    line += 1;
    const t = text.trim();
    if (t === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch (e) {
      throw new Error(`regrade: ${path} line ${line} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!validateRow(parsed)) {
      throw new Error(`regrade: ${path} line ${line} failed result-row schema validation: ${ajv.errorsText(validateRow.errors)}`);
    }
    rows.push(parsed as ResultRow);
  }
  return rows;
}

/** Parse and shape-check the run manifest (written by the run-mode emit phase). */
function readManifest(from: string): RunManifestEntry[] {
  const path = join(from, 'run.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { runs?: unknown };
  if (!Array.isArray(parsed.runs)) {
    throw new Error(`regrade: ${path} has no runs[] manifest — --rejudge needs the run's suite identity`);
  }
  return parsed.runs.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    for (const k of ['role', 'suite', 'suiteDir', 'model', 'driver', 'variant', 'runId']) {
      if (typeof e[k] !== 'string' || (e[k] as string).length === 0) {
        throw new Error(`regrade: ${path} runs[${i}] has no valid '${k}' — --rejudge needs the run's suite identity`);
      }
    }
    return entry as RunManifestEntry;
  });
}

/** A persisted classifier/fixer structured output: `found` distinguishes an absent file from a JSON null. */
function readOutput(from: string, caseId: string): { found: boolean; value: unknown } {
  const path = join(from, 'outputs', `${caseId}.json`);
  if (!existsSync(path)) return { found: false, value: undefined };
  return { found: true, value: JSON.parse(readFileSync(path, 'utf8')) as unknown };
}

/** Re-run the classifier's local scorer over its persisted structured output. */
function rejudgeClassifier(
  from: string,
  suiteCase: Extract<SuiteCase, { probe: { kind: 'expected-verdict' } }>,
  caseId: string,
  diagnostics: string[],
): { outcome: ResultRow['outcome']; probes: ResultRow['probes'] } | undefined {
  if (!isSafeCaseSegment(caseId)) {
    diagnostics.push(`regrade: case ${caseId}: unsafe case id — recorded outcome kept`);
    return undefined;
  }
  const out = readOutput(from, caseId);
  if (!out.found) {
    diagnostics.push(`regrade: case ${caseId}: no persisted output — recorded outcome kept`);
    return undefined;
  }
  const s = scoreReviewClassifier(suiteCase, { structuredOutput: out.value } as WorkerResult);
  return {
    outcome: { score: s.score, passed: s.passed, total: s.total },
    probes: [{ kind: 'expected-verdict', expected: suiteCase.probe.expected, observed: s.observed ?? null, passed: s.passed === 1 }],
  };
}

/**
 * Re-run the fixer's TWO probes over the persisted prediction: materialize
 * the pristine fixture, apply the persisted patch, re-run the check probe,
 * and re-run the schema-compliance probe against the persisted structured
 * output. Any missing/truncated/inapplicable artifact leaves the recorded
 * outcome untouched with a diagnostic (never a throw — a damaged artifact
 * must not abort a regrade of the rest of the run).
 */
function rejudgeFixer(
  from: string,
  suiteCase: Extract<SuiteCase, { probe: { kind: 'check-rerun' } }>,
  caseId: string,
  repoRoot: string,
  timeoutMs: number,
  diagnostics: string[],
): { passed: number; total: number } | undefined {
  if (!isSafeCaseSegment(caseId)) {
    diagnostics.push(`regrade: case ${caseId}: unsafe case id — recorded outcome kept`);
    return undefined;
  }
  const patchPath = join(from, 'patches', `${caseId}.patch`);
  if (!existsSync(patchPath)) {
    diagnostics.push(`regrade: case ${caseId}: no persisted patch — recorded outcome kept`);
    return undefined;
  }
  const patch = readFileSync(patchPath, 'utf8');
  if (isTruncated(patch)) {
    diagnostics.push(`regrade: case ${caseId}: persisted patch is truncated — recorded outcome kept`);
    return undefined;
  }
  const stem = mkdtempSync(join(tmpdir(), 'cq-regrade-'));
  const workspace = join(stem, 'workspace');
  try {
    cpSync(join(repoRoot, suiteCase.fixture), workspace, { recursive: true, verbatimSymlinks: true });
    const patchFile = join(stem, 'change.patch');
    writeFileSync(patchFile, patch);
    const applied = spawnSync('git', ['-C', workspace, 'apply', '--whitespace=nowarn', patchFile], { encoding: 'utf8' });
    if (applied.status !== 0) {
      const why = (applied.stderr ?? '').trim() !== ''
        ? applied.stderr.trim()
        : applied.error !== undefined && applied.error !== null
          ? applied.error.message
          : `exit ${applied.status}`;
      diagnostics.push(`regrade: case ${caseId}: persisted patch did not apply (${why}) — recorded outcome kept`);
      return undefined;
    }
    const out = readOutput(from, caseId);
    const worker = { structuredOutput: out.found ? out.value : undefined } as WorkerResult;
    const check = scoreFixerWorker(suiteCase, worker, repoRoot, workspace, timeoutMs);
    const schema = scoreSchemaCompliance(worker);
    return { passed: check.passed + schema.passed, total: FIXER_PROBE_COUNT };
  } finally {
    rmSync(stem, { recursive: true, force: true });
  }
}

/**
 * Re-read a run's persisted rows and re-aggregate them (optionally re-judging
 * the persisted predictions first). Pure over the out dir's files — no
 * dispatch, no network, no toolkit driver construction.
 */
export function regrade(opts: RegradeOptions): RegradeResult {
  const from = opts.from;
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT;
  const timeoutMs = opts.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const diagnostics: string[] = [];
  const rows = readRows(from);
  let rejudged = 0;
  let changed = 0;

  if (opts.rejudge === true) {
    // One loaded suite per (role, suite) — loadSuite is the same schema +
    // semantic validation the live run used, so re-judging cannot drift from
    // what was dispatched.
    const suites = new Map<string, Suite>();
    for (const entry of readManifest(from)) {
      const key = `${entry.role}\n${entry.suite}`;
      // A manifest suiteDir is normally repo-root-relative (run mode records
      // it that way), but tolerate an absolute one from a hand-written
      // manifest rather than mangling it through join().
      if (!suites.has(key)) {
        const dir = isAbsolute(entry.suiteDir) ? entry.suiteDir : join(repoRoot, entry.suiteDir);
        suites.set(key, loadSuite(dir));
      }
    }
    for (const row of rows) {
      if (row.case === undefined) continue;
      const suite = suites.get(`${row.role}\n${row.suite}`);
      if (suite === undefined) {
        diagnostics.push(`regrade: case ${row.case}: no manifest entry for ${row.role}/${row.suite} — recorded outcome kept`);
        continue;
      }
      const suiteCase: SuiteCase | undefined = suite.cases.find((c) => c.id === row.case);
      if (suiteCase === undefined) {
        diagnostics.push(`regrade: case ${row.case}: not found in suite '${suite.name}' — recorded outcome kept`);
        continue;
      }
      const recorded = row.outcome;
      // A damaged artifact (corrupt output JSON, unreadable patch, missing
      // pristine fixture, git-apply spawn error) must keep the recorded
      // outcome with a diagnostic, never abort the regrade of the remaining
      // rows (the module contract). The rows.jsonl/run.json validation above
      // stays fail-loud — only per-case artifact handling is best-effort.
      try {
        if (isFixerCase(suiteCase)) {
          const r = rejudgeFixer(from, suiteCase, row.case, repoRoot, timeoutMs, diagnostics);
          if (r === undefined) continue;
          rejudged += 1;
          const outcome = { score: r.passed / r.total, passed: r.passed, total: r.total };
          if (outcome.passed !== recorded.passed || outcome.total !== recorded.total || outcome.score !== recorded.score) changed += 1;
          row.outcome = outcome;
        } else {
          const r = rejudgeClassifier(from, suiteCase, row.case, diagnostics);
          if (r === undefined) continue;
          rejudged += 1;
          const outcome = r.outcome;
          if (outcome.passed !== recorded.passed || outcome.total !== recorded.total || outcome.score !== recorded.score) changed += 1;
          row.outcome = outcome;
          row.probes = r.probes;
        }
      } catch (e) {
        diagnostics.push(
          `regrade: case ${row.case}: ${e instanceof Error ? e.message : String(e)} — recorded outcome kept`,
        );
      }
    }
  }

  const tables = aggregate(rows);
  // A regrade is not a new run: preserve the table's original generation time
  // so a plain regrade rewrites the table BYTE-IDENTICALLY. A table the out
  // dir does not already carry (a first aggregation) keeps the fresh stamp.
  for (const t of tables) {
    const prevPath = join(from, `${t.role}.table.json`);
    if (!existsSync(prevPath)) continue;
    try {
      const prev = JSON.parse(readFileSync(prevPath, 'utf8')) as { generatedAt?: unknown };
      if (typeof prev.generatedAt === 'string') t.generatedAt = prev.generatedAt;
    } catch {
      // A damaged previous table must not block the regrade: keep the fresh stamp.
    }
  }
  return { rows, tables, rejudged, changed, diagnostics };
}
