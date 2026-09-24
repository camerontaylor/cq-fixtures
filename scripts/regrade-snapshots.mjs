// Deterministically enrich and re-aggregate the committed WB-1 snapshot.
//
// This is deliberately an offline data replay, not an evaluation. It reads
// only the snapshot's rows/manifests/journals plus the suite and fixture
// sidecars recorded at each manifest's suiteSha. It then calls the runner's
// normal regrade/aggregate path for tables; no driver, model, network, or live
// check is constructed.
//
// Usage (check, never writes):
//   node --experimental-strip-types scripts/regrade-snapshots.mjs --check reports/snapshots/2026-09-21-wb1
// Apply the same transformation in place by omitting --check.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { regrade } from '../runner/regrade.ts';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHECK = process.argv.includes('--check');
const rootArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
if (rootArg === undefined) {
  throw new Error('usage: node --experimental-strip-types scripts/regrade-snapshots.mjs [--check] reports/snapshots/2026-09-21-wb1');
}
const ROOT = resolve(REPO_ROOT, rootArg);

/** Committed cells carry both rows and a run manifest; partial cells fail closed. */
function cells(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === 'journal') continue;
    const hasRun = existsSync(join(path, 'run.json'));
    const hasRows = existsSync(join(path, 'rows.jsonl'));
    if (hasRun && hasRows) found.push(path);
    else if (hasRun || hasRows) {
      const missing = hasRun ? 'rows.jsonl' : 'run.json';
      throw new Error(`${path}: incomplete snapshot cell — missing ${missing}`);
    } else found.push(...cells(path));
  }
  return found.sort();
}

/** Return journal evidence for the manifest run, keyed by case id. */
function journalEvidence(cell, runId) {
  const structuredOutputMisses = new Set();
  const nonModelFailures = new Map();
  const completedJobs = new Map();
  const journal = join(cell, 'journal');
  for (const file of readdirSync(journal).filter((f) => f.endsWith('.ndjson')).sort()) {
    for (const line of readFileSync(join(journal, file), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const event = JSON.parse(line);
      if (event.type !== 'job-finished' || event.runId !== runId) continue;
      if (event.result?.status === 'ok') completedJobs.set(event.jobId, event.result.value);
      if (event.result?.status === 'failed') {
        const error = String(event.result.error ?? '');
        if (/^ai-sdk driver: \[structured-output-miss\](?:[^A-Za-z0-9-]|$)/.test(error)) {
          structuredOutputMisses.add(event.jobId);
        } else {
          // Endpoint/provider/driver failures are infrastructure outcomes and
          // must remain distinct from the model structured-output miss above.
          nonModelFailures.set(event.jobId, error);
        }
      }
    }
  }
  return { structuredOutputMisses, nonModelFailures, completedJobs };
}

function isClassifierZeroOutcome(value) {
  return typeof value === 'object'
    && value !== null
    && value.score === 0
    && value.passed === 0
    && value.total === 1;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const DAMAGED_SIDECARS = new Set(['absent', 'unparseable', 'invalid']);

// W0.9 audited these exact fixer run identities. Do not infer workspace
// binding from role alone: later, correctly-bound runs must remain valid.
const W0_9_WORKSPACE_UNBOUND_RUN_IDS = new Set([
  '9af6e20b-c65e-4f97-bca9-30ca7dd62886',
  'bf470e5c-bd08-400b-8d50-70f7ab50ac0e',
  'd3138344-f9ec-4c4b-aa4f-ea10cb190780',
  'f0eafe45-e98f-41b8-b262-3474a533158c',
  '26933e49-60a8-4d90-b64a-cbb81e2d347c',
  '571b640a-c633-45db-adcc-9966012035e5',
  '70f8633f-b55d-4165-bf34-87e84b6ce918',
  'e2734e9d-ac4d-4b6d-b353-f7799049bf05',
  '14ecd9b2-c723-4af2-9aae-ffa93ad62985',
  '36088a47-2fd6-4323-8d14-57edfa47f3dc',
  'a2e4cddb-2db7-4048-aa66-691d984ab491',
  'c8b1008d-7f75-4a18-b1f8-7362112aa833',
]);

function replayPath(value, description) {
  if (typeof value === 'string' && isAbsolute(value)) {
    if (process.env.CQ_REGRADE_ALLOW_TEST_ABSOLUTE_SUITE === '1') return value;
    throw new Error(
      `${description} must be a non-empty repo-relative path without '..'; absolute paths are allowed only for deterministic tests with CQ_REGRADE_ALLOW_TEST_ABSOLUTE_SUITE=1: ${String(value)}`,
    );
  }
  if (typeof value !== 'string' || value === '' || normalize(value).startsWith('..')) {
    throw new Error(`${description} must be a non-empty repo-relative path without '..': ${String(value)}`);
  }
  return value;
}

/** Read a file from an exact git revision. */
function gitShow(revision, path, description) {
  try {
    return execFileSync('git', ['show', `${revision}:${path}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`${description}: git show ${revision}:${path} failed: ${detail}`, { cause: error });
  }
}

function localRevisionExists(revision) {
  try {
    execFileSync('git', ['cat-file', '-e', `${revision}^{commit}`], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function loadSuite(entry, cell) {
  const suitePath = replayPath(
    isAbsolute(entry.suiteDir) ? resolve(entry.suiteDir, 'suite.json') : join(entry.suiteDir, 'suite.json'),
    `${cell}: run.json runs[0].suiteDir`,
  );
  const suiteSha = entry.suiteSha;
  if (suiteSha === null || suiteSha === undefined) {
    if (process.env.CQ_REGRADE_ALLOW_NULL_SUITE_SHA !== '1') {
      throw new Error(
        `${cell}: run.json runs[0].suiteSha must be a non-empty git revision; null is allowed only for deterministic tests with CQ_REGRADE_ALLOW_NULL_SUITE_SHA=1`,
      );
    }
    return {
      suite: JSON.parse(readFileSync(isAbsolute(suitePath) ? suitePath : join(REPO_ROOT, suitePath), 'utf8')),
      sidecarRevision: null,
    };
  }
  if (typeof suiteSha !== 'string' || suiteSha === '') {
    throw new Error(`${cell}: run.json runs[0].suiteSha must be a non-empty git revision`);
  }
  if (localRevisionExists(suiteSha)) {
    return {
      suite: JSON.parse(gitShow(suiteSha, suitePath, `${cell}: recorded suite`)),
      sidecarRevision: suiteSha,
    };
  }

  // Shallow CI checkouts retain the current commit but not necessarily the
  // historical suite commit. Keep the replay runnable without silently
  // changing provenance: report the fallback and read the committed checkout,
  // not a potentially dirty working tree.
  process.stderr.write(
    `WARNING: ${relative(REPO_ROOT, cell)}: recorded suite revision ${suiteSha} is unavailable locally; using checked-out committed suite and sidecars for offline replay\n`,
  );
  return {
    suite: JSON.parse(gitShow('HEAD', suitePath, `${cell}: checked-out suite fallback`)),
    sidecarRevision: 'HEAD',
  };
}

/** Read all label sidecars for a suite from the selected git revision. */
function recordedSidecars(suiteCases, suiteSha) {
  const result = new Map();
  const paths = [...new Set([...suiteCases.values()].map(({ fixture }) => {
    if (!fixture.endsWith('.json')) return undefined;
    return replayPath(
      fixture.slice(0, -'.json'.length) + '.label.json',
      'suite case fixture label sidecar',
    );
  }).filter((path) => path !== undefined))];
  if (suiteSha === null || suiteSha === undefined) {
    for (const path of paths) {
      try {
        result.set(path, readFileSync(isAbsolute(path) ? path : join(REPO_ROOT, path), 'utf8'));
      } catch {
        result.set(path, undefined);
      }
    }
    return result;
  }

  try {
    const batch = execFileSync('git', ['cat-file', '--batch'], {
      cwd: REPO_ROOT,
      input: `${paths.map((path) => `${suiteSha}:${path}`).join('\n')}\n`,
      maxBuffer: 10 * 1024 * 1024,
    });
    let offset = 0;
    for (const path of paths) {
      const headerEnd = batch.indexOf(0x0a, offset);
      if (headerEnd === -1) throw new Error(`truncated header for ${path}`);
      const header = batch.subarray(offset, headerEnd).toString('utf8');
      offset = headerEnd + 1;
      if (header.endsWith(' missing')) {
        result.set(path, undefined);
        continue;
      }
      const size = Number(header.slice(header.lastIndexOf(' ') + 1));
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid object header for ${path}: ${header}`);
      result.set(path, batch.subarray(offset, offset + size).toString('utf8'));
      offset += size;
      if (batch[offset] !== 0x0a) throw new Error(`missing object terminator for ${path}`);
      offset += 1;
    }
    return result;
  } catch (error) {
    throw new Error(`recorded suite label sidecars: git cat-file --batch at ${suiteSha} failed: ${error.stderr?.toString().trim() || error.message}`, { cause: error });
  }
}

/** Mirror the runner's five-state sidecar classification, including damaged states. */
function sidecarFlag(fixture, sidecars) {
  if (!fixture.endsWith('.json')) return 'unflagged';
  const path = replayPath(
    fixture.slice(0, -'.json'.length) + '.label.json',
    'suite case fixture label sidecar',
  );
  const raw = sidecars.get(path);
  if (raw === undefined) return 'absent';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unparseable';
  }
  if (typeof parsed !== 'object' || parsed === null) return 'invalid';
  if (parsed.fp_flag === 'suspicious-benign') return 'flagged';
  if (parsed.fp_flag === 'none') return 'unflagged';
  return 'invalid';
}

/** Use the runner's diagnostic wording so live and offline evidence agree. */
function sidecarDiagnostic(caseId, fixture, flag) {
  if (!DAMAGED_SIDECARS.has(flag)) return undefined;
  const why = flag === 'invalid'
    ? 'invalid content (fp_flag missing or outside none|suspicious-benign)'
    : flag;
  return `case ${caseId}: label sidecar '${fixture.slice(0, -'.json'.length)}.label.json' ${why} — suspiciousBenign flag omitted`;
}

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

const changedFiles = [];
const sidecarDiagnostics = [];
const discoveredCells = cells(ROOT);
if (discoveredCells.length === 0) throw new Error(`${ROOT}: no snapshot cells found (expected directories containing both run.json and rows.jsonl)`);
for (const cell of discoveredCells) {
  const originalRows = readJsonl(join(cell, 'rows.jsonl'));
  const rows = structuredClone(originalRows);
  const manifest = readJson(join(cell, 'run.json'));
  const entry = manifest.runs?.[0];
  if (entry === undefined) throw new Error(`${cell}: run.json has no runs[] entry`);
  const { suite, sidecarRevision } = loadSuite(entry, cell);
  for (const [field, suiteField] of [['suite', 'name'], ['role', 'role']]) {
    if (suite[suiteField] !== entry[field]) {
      throw new Error(
        `${cell}: run.json runs[0].${field} ${String(entry[field])} does not match recorded suite ${field} ${String(suite[suiteField])}`,
      );
    }
  }
  const suiteCases = new Map((suite.cases ?? []).map((c) => [c.id, c]));
  const journal = entry.role === 'review-classifier' ? journalEvidence(cell, entry.runId) : undefined;
  const misses = journal?.structuredOutputMisses ?? new Set();
  const nonModelFailures = journal?.nonModelFailures ?? new Map();
  const completedJobs = journal?.completedJobs ?? new Map();
  const sidecarFlags = new Map();
  const encounteredCaseIds = new Set();
  if (entry.role === 'review-classifier') {
    const sidecars = recordedSidecars(suiteCases, sidecarRevision);
    for (const [caseId, suiteCase] of suiteCases) {
      const flag = sidecarFlag(suiteCase.fixture, sidecars);
      sidecarFlags.set(caseId, flag);
      const diagnostic = sidecarDiagnostic(caseId, suiteCase.fixture, flag);
      if (diagnostic !== undefined) {
        sidecarDiagnostics.push(`${relative(REPO_ROOT, cell)}: ${diagnostic}`);
      }
    }
  }

  for (const row of rows) {
    if (row.runId !== entry.runId) {
      throw new Error(
        `${cell}: case ${String(row.case)} row runId ${String(row.runId)} does not match manifest entry runId ${String(entry.runId)}`,
      );
    }
    for (const field of ['role', 'suite', 'model', 'driver', 'variant']) {
      const actual = field === 'variant' && row.variant === undefined ? 'default' : row[field];
      if (actual !== entry[field]) {
        throw new Error(
          `${cell}: case ${String(row.case)} row ${field} ${String(actual)} does not match manifest entry ${field} ${String(entry[field])}`,
        );
      }
    }

    if (encounteredCaseIds.has(row.case)) {
      throw new Error(`${cell}: duplicate case ${String(row.case)} row`);
    }
    encounteredCaseIds.add(row.case);

    const suiteCase = suiteCases.get(row.case);
    if (suiteCase === undefined) throw new Error(`${cell}: case ${row.case} is not in ${entry.suiteDir}`);

    if (entry.role === 'fixer-worker'
      && row.invalid === 'workspace-unbound'
      && !W0_9_WORKSPACE_UNBOUND_RUN_IDS.has(entry.runId)) {
      throw new Error(
        `${cell}: case ${row.case} is pre-marked workspace-unbound, but manifest runId ${String(entry.runId)} is not in the audited W0.9 allowlist`,
      );
    }

    // The old snapshot omitted a probe only for model structured-output
    // misses. The committed journal is the source that distinguishes those
    // rows from a genuine driver absence; regrade semantics remain unchanged.
    // An already-recorded null/false miss is equally historical evidence and
    // must agree with that journal rather than pass validation unexamined.
    if (entry.role === 'review-classifier') {
      if (nonModelFailures.has(row.case)) {
        throw new Error(
          `${cell}: case ${row.case} has a non-model classifier journal failure (${String(nonModelFailures.get(row.case))}) but a row was published`,
        );
      }
      const nullObservation = row.probes?.some(
        (probe) => probe.kind === 'expected-verdict' && probe.observed === null,
      ) === true;
      if (nullObservation && row.probes?.some(
        (probe) => probe.kind === 'expected-verdict' && probe.observed === null && probe.passed !== false,
      ) === true) {
        throw new Error(`${cell}: case ${row.case} has a contradictory null/passed:true classifier probe`);
      }
      const hasCompletedZeroEvidence = isClassifierZeroOutcome(completedJobs.get(row.case));
      const hasJournalMissEvidence = misses.has(row.case) || hasCompletedZeroEvidence;
      const recordsNullMiss = row.probes?.some(
        (probe) => probe.kind === 'expected-verdict' && probe.observed === null && probe.passed === false,
      ) === true;
      const recordsRealObserved = row.probes?.some(
        (probe) => probe.kind === 'expected-verdict' && typeof probe.observed === 'string',
      ) === true;
      if (recordsNullMiss && !hasJournalMissEvidence) {
        throw new Error(`${cell}: case ${row.case} has a null/false classifier probe without journal structured-output-miss or matching completed zero-result evidence`);
      }
      if (misses.has(row.case) || (recordsNullMiss && hasCompletedZeroEvidence)) {
        const evidence = misses.has(row.case)
          ? 'journal structured-output-miss'
          : 'matching completed zero-result';
        if (misses.has(row.case) && row.probes === undefined) {
          row.probes = [{ kind: 'expected-verdict', expected: suiteCase.probe.expected, observed: null, passed: false }];
        }
        if (misses.has(row.case) && recordsRealObserved) {
          throw new Error(`${cell}: case ${row.case} has ${evidence} evidence but carries real observed classifier probes`);
        }
        const probe = row.probes?.length === 1 ? row.probes[0] : undefined;
        if (probe?.kind !== 'expected-verdict'
          || probe.expected !== suiteCase.probe.expected
          || probe.observed !== null
          || probe.passed !== false) {
          throw new Error(`${cell}: case ${row.case} has ${evidence} evidence but does not carry the exact expected-verdict null/false probe`);
        }
        if (!isClassifierZeroOutcome(row.outcome)) {
          throw new Error(`${cell}: case ${row.case} has ${evidence} evidence but does not carry the required zero outcome`);
        }
      }

      // Real observed probes are independently checked against the suite and,
      // when available, the completed job result. This runs after the legacy
      // null/miss checks above so all prior diagnostics remain strict and
      // unchanged.
      const stringObservedProbes = row.probes?.filter(
        (probe) => probe.kind === 'expected-verdict' && typeof probe.observed === 'string',
      ) ?? [];
      for (const probe of stringObservedProbes) {
        if (probe.expected !== suiteCase.probe.expected) {
          throw new Error(
            `${cell}: case ${row.case} classifier probe expected ${String(probe.expected)} does not match suite expected ${String(suiteCase.probe.expected)}`,
          );
        }
      }
      const completedOutcome = completedJobs.get(row.case);
      if (completedJobs.has(row.case)) {
        for (const probe of stringObservedProbes) {
          if (probe.passed !== (completedOutcome.passed === completedOutcome.total)) {
            throw new Error(
              `${cell}: case ${row.case} classifier probe passed=${String(probe.passed)} contradicts completed journal passed=${String(completedOutcome?.passed)}`,
            );
          }
        }
        if (!isDeepStrictEqual(row.outcome, completedOutcome)) {
          throw new Error(
            `${cell}: case ${row.case} outcome ${JSON.stringify(row.outcome)} contradicts completed journal outcome ${JSON.stringify(completedOutcome)}`,
          );
        }
      }
    }
    if (entry.role === 'review-classifier') {
      if (sidecarFlags.get(row.case) === 'flagged') row.suspiciousBenign = true;
      else delete row.suspiciousBenign;
    }
    // Only the audited W0.9 run identities had this historical limitation.
    // Keep their scores, but never invalidate a future/unrelated fixer run.
    if (entry.role === 'fixer-worker' && W0_9_WORKSPACE_UNBOUND_RUN_IDS.has(entry.runId)) {
      row.invalid = 'workspace-unbound';
    }
  }

  if (entry.role === 'review-classifier') {
    const rowCases = new Set(rows.map((row) => row.case));
    for (const caseId of misses) {
      if (!rowCases.has(caseId)) {
        throw new Error(`${cell}: journal structured-output-miss case ${caseId} is absent from rows.jsonl`);
      }
    }
  }

  const rowsPath = join(cell, 'rows.jsonl');
  const nextRows = jsonl(rows);
  // Number spelling in an already committed JSONL file is not a semantic
  // change. Avoid rewriting it; this keeps --check idempotent and preserves
  // the original evidence bytes when enrichment is already present.
  if (!isDeepStrictEqual(rows, originalRows)) {
    changedFiles.push(relative(REPO_ROOT, rowsPath));
    if (!CHECK) writeFileSync(rowsPath, nextRows);
  }

  // Reuse the runner's exact aggregate semantics. It reads the just-written
  // rows, validates them, and preserves each table's original generatedAt.
  const result = regrade({ from: cell, repoRoot: REPO_ROOT });
  for (const table of result.tables) {
    const tablePath = join(cell, `${table.role}.table.json`);
    const nextTable = JSON.stringify(table, null, 2) + '\n';
    if (readFileSync(tablePath, 'utf8') !== nextTable) {
      changedFiles.push(relative(REPO_ROOT, tablePath));
      if (!CHECK) writeFileSync(tablePath, nextTable);
    }
  }
}

function readJsonl(path) {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

sidecarDiagnostics.sort();
if (sidecarDiagnostics.length > 0) {
  process.stderr.write(`snapshot regrade label sidecar diagnostics (${sidecarDiagnostics.length}):\n${sidecarDiagnostics.join('\n')}\n`);
}
if (CHECK && changedFiles.length > 0) {
  process.stderr.write(`snapshot regrade is stale; changed files:\n${changedFiles.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`${CHECK ? 'checked' : 'regraded'} ${discoveredCells.length} snapshot cells (${changedFiles.length} file(s) changed)\n`);
