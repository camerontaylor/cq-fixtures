// F1b mapping check — the committed, offline-reproducible version of the
// snapshot README's "zero driver-error zeros" verification.
//
// The F1b runner-side class-token mapping has one contract: a driver failure
// whose cause is exactly `ai-sdk driver: [structured-output-miss]` is a MODEL
// outcome and MUST have a scored-miss row; every other driver failure is
// infrastructure and MUST have NO row (it is instead recorded in the run
// manifest's `absences[]`). This script re-checks that contract directly from
// the committed evidence — per-cell `journal/*.ndjson` (job-finished entries),
// `rows.jsonl`, and `run.json` — so the claim is verifiable after the CI
// artifacts expire, with no network and no re-dispatch.
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

/** The mapping's exact-token predicate, mirroring runner/index.ts. */
function isStructuredOutputMiss(cause) {
  const m = /^ai-sdk driver: \[([a-z-]+)\](?:\s|$)/.exec(String(cause ?? ''));
  return m !== null && m[1] === 'structured-output-miss';
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

/** job-finished entries of a cell's NDJSON journal(s), in file order. */
function journalFinished(cellDir) {
  const journalDir = join(cellDir, 'journal');
  let files = [];
  try {
    files = readdirSync(journalDir).filter((f) => f.endsWith('.ndjson')).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    for (const line of readFileSync(join(journalDir, file), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === 'job-finished') {
        out.push({ case: ev.jobId, status: ev.result?.status, error: ev.result?.error });
      }
    }
  }
  return out;
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
  const rowCases = new Set(rows.map((r) => r.case));
  const manifest = JSON.parse(readFileSync(join(cellDir, 'run.json'), 'utf8'));
  const absenceCases = new Set((manifest.runs ?? []).flatMap((r) => (r.absences ?? []).map((a) => a.case)));
  const finished = journalFinished(cellDir);

  const misses = finished.filter((f) => f.status === 'failed' && isStructuredOutputMiss(f.error));
  const otherFailures = finished.filter((f) => f.status === 'failed' && !isStructuredOutputMiss(f.error));

  let cellProblems = 0;
  for (const f of misses) {
    if (!rowCases.has(f.case)) {
      lines.push(`PROBLEM ${rel}: structured-output-miss '${f.case}' has NO row`);
      cellProblems += 1;
    }
  }
  for (const f of otherFailures) {
    if (rowCases.has(f.case)) {
      lines.push(`PROBLEM ${rel}: non-miss failure '${f.case}' HAS a row`);
      cellProblems += 1;
    }
    if (!absenceCases.has(f.case)) {
      lines.push(`PROBLEM ${rel}: non-miss failure '${f.case}' is not in run.json absences[]`);
      cellProblems += 1;
    }
  }
  for (const c of absenceCases) {
    if (rowCases.has(c)) {
      lines.push(`PROBLEM ${rel}: absence '${c}' HAS a row`);
      cellProblems += 1;
    }
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
      `non-miss-failures=${otherFailures.length} absences=${absenceCases.size} ` +
      `problems=${cellProblems}`,
  );
}

lines.push(`rows ${totalRows}, problems ${problems}`);
process.stdout.write(lines.join('\n') + '\n');
process.exit(problems > 0 ? 1 : 0);
