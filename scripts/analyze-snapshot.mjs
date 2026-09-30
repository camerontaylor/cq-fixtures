// W6.5: consolidate separately dispatched matrix cells into paired evidence.
// Usage: node scripts/analyze-snapshot.mjs --from <snapshot-dir> --out <dir>
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate } from '../runner/aggregate.ts';


function cellsBelow(dir) {
  const out = [];
  const walk = (path) => {
    const names = readdirSync(path, { withFileTypes: true });
    if (names.some((n) => n.name === 'run.json') && names.some((n) => n.name === 'rows.jsonl')) out.push(path);
    else for (const n of names) if (n.isDirectory()) walk(join(path, n.name));
  };
  walk(dir);
  return out.sort();
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`);
  return value;
}

export function analyzeSnapshot(from) {
  const dirs = cellsBelow(from);
  if (dirs.length < 2) throw new Error(`${from}: need at least two matrix cells`);
  const rows = [];
  let toolkitLock;
  let suiteSha;
  const seen = new Set();
  for (const dir of dirs) {
    const label = relative(from, dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    if (!Array.isArray(manifest.runs) || manifest.runs.length === 0) throw new Error(`${label}: expected run manifest entries`);
    const run = manifest.runs[0];
    for (const entry of manifest.runs) {
      if (entry.role !== run.role || entry.suite !== run.suite || entry.model !== run.model ||
          entry.driver !== run.driver || entry.variant !== run.variant ||
          entry.toolkitLock !== run.toolkitLock || entry.suiteSha !== run.suiteSha) {
        throw new Error(`${label}: mixed run identity or provenance within cell`);
      }
    }
    const lock = requiredString(run.toolkitLock, `${label}: toolkitLock`);
    const sha = requiredString(run.suiteSha, `${label}: suiteSha`);
    if (toolkitLock !== undefined && toolkitLock !== lock) throw new Error(`${label}: mixed toolkitLock`);
    if (suiteSha !== undefined && suiteSha !== sha) throw new Error(`${label}: mixed suiteSha`);
    toolkitLock = lock;
    suiteSha = sha;
    const model = requiredString(run.model, `${label}: model`);
    const driver = requiredString(run.driver, `${label}: driver`);
    const role = requiredString(run.role, `${label}: role`);
    const suite = requiredString(run.suite, `${label}: suite`);
    const identity = [role, suite, model, driver, run.variant ?? 'default'].join('\n');
    if (seen.has(identity)) throw new Error(`${label}: duplicate served model/driver/variant cell ${identity.replaceAll('\n', '/')}`);
    seen.add(identity);
    const lines = readFileSync(join(dir, 'rows.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) throw new Error(`${label}: empty cell has no paired evidence`);
    for (const [i, line] of lines.entries()) {
      const row = JSON.parse(line);
      if (typeof row !== 'object' || row === null || !Number.isInteger(row.repeat) || !Number.isInteger(row.repeatCount) ||
          typeof row.case !== 'string' || typeof row.outcome?.score !== 'number') {
        throw new Error(`${label}: row ${i + 1} is missing repeat or score evidence`);
      }
      if (row.role !== role || row.suite !== suite || row.model !== model || row.driver !== driver ||
          (row.variant ?? 'default') !== (run.variant ?? 'default')) {
        throw new Error(`${label}: row ${i + 1} mismatches manifest served model version or cell identity`);
      }
      if (row.repeat === undefined) throw new Error(`${label}: row ${i + 1} lacks W6.5 repeat ordinal`);
      if (!manifest.runs.some((entry) => entry.runId === row.runId && entry.repeat === row.repeat)) {
        throw new Error(`${label}: row ${i + 1} has no matching runId/repeat manifest entry`);
      }
      rows.push(row);
    }
  }
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.role}\n${row.suite}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const tables = [...groups.values()].flatMap((suiteRows) => aggregate(suiteRows));
  return { toolkitLock, suiteSha, cellCount: dirs.length, tables };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--from' || args[2] !== '--out') {
    console.error('usage: node scripts/analyze-snapshot.mjs --from <snapshot-dir> --out <dir>');
    process.exitCode = 2;
  } else {
    try {
      const result = analyzeSnapshot(args[1]);
      mkdirSync(args[3], { recursive: true });
      for (const table of result.tables) {
        writeFileSync(join(args[3], `${table.role}-${table.suite}.comparisons.json`), JSON.stringify(table, null, 2) + '\n');
      }
      console.log(`analyzed ${result.cellCount} cells at toolkit.lock ${result.toolkitLock}, suite SHA ${result.suiteSha}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
}
