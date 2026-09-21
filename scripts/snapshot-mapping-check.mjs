// F1b mapping check — the committed, offline-reproducible version of the
// snapshot README's "zero driver-error zeros" verification.
//
// The F1b runner-side class-token mapping has one contract: a driver failure
// whose cause is exactly `ai-sdk driver: [structured-output-miss]` is a MODEL
// outcome and MUST have a scored-miss row (outcome 0); every other driver
// failure is infrastructure and MUST have NO row (it is instead recorded in
// the run manifest's `absences[]`). Governed stops are neither: the case RAN
// and was deliberately cut off, so `budget-exhausted` and `aborted` MUST have
// an honest incomplete row and MUST NOT be absences; a `refuseCase`
// materialization refusal (`indeterminate` with any other detail) MUST have
// NO row, because the driver never ran. This script re-checks all of that
// directly from the committed evidence — per-cell `journal/*.ndjson`
// (job-finished entries), `rows.jsonl`, and `run.json` — so the claim is
// verifiable after the CI artifacts expire, with no network and no
// re-dispatch.
//
// Usage:
//   node scripts/snapshot-mapping-check.mjs [root]
// `root` (default: reports/snapshots/2026-09-21-wb1) is any directory tree
// containing cells as `<...>/<model>/<driver>/<role>/<suite>/{table.json,
// rows.jsonl,run.json,journal/}` — the committed snapshot, or an unpacked
// eval artifact root (cells live under `<root>/eval/...`).
//
// Output: one line per cell plus a final `rows N, problems M`; exit 1 when M > 0.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const rootArg = process.argv[2] ?? join('reports', 'snapshots', '2026-09-21-wb1');
const ROOT = resolve(REPO_ROOT, rootArg);

/**
 * The mapping's exact-token predicate, mirroring runner/index.ts. The class
 * token is matched EXACTLY (`===`), so a longer token still fails; only the
 * separator after the closing bracket is a character class (any non-identifier
 * character, or end of string) rather than a literal space.
 */
function isStructuredOutputMiss(cause) {
  const m = /^ai-sdk driver: \[([a-z-]+)\](?:[^A-Za-z0-9-]|$)/.exec(String(cause ?? ''));
  return m !== null && m[1] === 'structured-output-miss';
}

/** A `refuseCase` materialization refusal: indeterminate, and NOT an abort. */
function isMaterializationRefusal(job) {
  return job.status === 'indeterminate' && !String(job.detail ?? '').startsWith('driver stopReason: aborted');
}

/** Every directory under `dir` that carries a run.json AND a rows.jsonl. */
function cellDirs(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    if (names.has('run.json') && names.has('rows.jsonl')) out.push(d);
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory() && e.name !== 'journal') walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * job-finished entries of a cell's NDJSON journal(s), in file order, plus the
 * journal health: a missing journal dir, a journal with zero job-finished
 * entries, or an unparseable NDJSON line is evidence the check could not read
 * — all scored as problems by the caller (a vacuous pass must not be possible).
 */
function journalFinished(cellDir) {
  const journalDir = join(cellDir, 'journal');
  let files = [];
  try {
    files = readdirSync(journalDir).filter((f) => f.endsWith('.ndjson')).sort();
  } catch {
    return { jobs: [], unparseable: 0, journalPresent: false };
  }
  const out = [];
  let unparseable = 0;
  for (const file of files) {
    for (const line of readFileSync(join(journalDir, file), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        unparseable += 1;
        continue;
      }
      if (ev.type === 'job-finished') {
        out.push({
          case: ev.jobId,
          status: ev.result?.status,
          error: ev.result?.error,
          detail: ev.result?.detail,
        });
      }
    }
  }
  return { jobs: out, unparseable, journalPresent: files.length > 0 };
}

const lines = [];
let totalRows = 0;
let problems = 0;

for (const cellDir of cellDirs(ROOT)) {
  const rel = relative(ROOT, cellDir) || '.';
  const rows = readFileSync(join(cellDir, 'rows.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
  const rowsByCase = new Map(rows.map((r) => [r.case, r]));
  const manifest = JSON.parse(readFileSync(join(cellDir, 'run.json'), 'utf8'));
  const absenceCases = new Set((manifest.runs ?? []).flatMap((r) => (r.absences ?? []).map((a) => a.case)));
  const { jobs: finished, unparseable, journalPresent } = journalFinished(cellDir);

  const misses = finished.filter((f) => f.status === 'failed' && isStructuredOutputMiss(f.error));
  const otherFailures = finished.filter((f) => f.status === 'failed' && !isStructuredOutputMiss(f.error));
  const governorStops = finished.filter((f) => f.status === 'budget-exhausted' || (f.status === 'indeterminate' && !isMaterializationRefusal(f)));
  const refusals = finished.filter((f) => isMaterializationRefusal(f));
  const oks = finished.filter((f) => f.status === 'ok');

  let cellProblems = 0;
  const problem = (msg) => {
    lines.push(`PROBLEM ${rel}: ${msg}`);
    cellProblems += 1;
  };

  // Evidence must be readable: a missing journal / zero job-finished entries /
  // an unparseable NDJSON line is a problem, never a silent vacuous pass.
  if (!journalPresent) problem('no journal/*.ndjson file — the mapping cannot be verified');
  if (finished.length === 0) problem('journal has zero job-finished entries — the mapping cannot be verified');
  if (unparseable > 0) problem(`${unparseable} unparseable NDJSON line(s) in the journal`);

  for (const f of oks) {
    if (!rowsByCase.has(f.case)) problem(`ok job '${f.case}' has NO row`);
  }
  for (const f of misses) {
    const row = rowsByCase.get(f.case);
    if (row === undefined) {
      problem(`structured-output-miss '${f.case}' has NO row`);
    } else if (row.outcome?.score !== 0 || row.outcome?.passed !== 0) {
      problem(`structured-output-miss '${f.case}' row is not a zero (score ${row.outcome?.score}, passed ${row.outcome?.passed})`);
    }
  }
  for (const f of otherFailures) {
    if (rowsByCase.has(f.case)) problem(`non-miss failure '${f.case}' HAS a row`);
    if (!absenceCases.has(f.case)) problem(`non-miss failure '${f.case}' is not in run.json absences[]`);
  }
  for (const f of governorStops) {
    if (!rowsByCase.has(f.case)) problem(`governed stop '${f.case}' (${f.status}) has NO row`);
    if (absenceCases.has(f.case)) problem(`governed stop '${f.case}' (${f.status}) is in run.json absences[]`);
  }
  for (const f of refusals) {
    if (rowsByCase.has(f.case)) problem(`materialization refusal '${f.case}' HAS a row`);
  }
  for (const c of absenceCases) {
    if (rowsByCase.has(c)) problem(`absence '${c}' HAS a row`);
  }

  totalRows += rows.length;
  problems += cellProblems;
  const statuses = finished.reduce((acc, f) => {
    acc[f.status] = (acc[f.status] ?? 0) + 1;
    return acc;
  }, {});
  lines.push(
    `${rel} rows=${rows.length} ` +
      `jobs=${JSON.stringify(statuses)} misses=${misses.length} ` +
      `non-miss-failures=${otherFailures.length} governor-stops=${governorStops.length} ` +
      `refusals=${refusals.length} absences=${absenceCases.size} ` +
      `problems=${cellProblems}`,
  );
}

lines.push(`rows ${totalRows}, problems ${problems}`);
process.stdout.write(lines.join('\n') + '\n');
process.exit(problems > 0 ? 1 : 0);
