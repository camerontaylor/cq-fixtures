// CLI wiring for the eval runner: flag parsing, driver construction, output
// writing, and the I1 exit-code discipline (0 clean, 1 any case scored 0 or
// validation failure, 2 usage error). Invoked via runner/index.ts.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AiSdkDriver, type Driver } from '@camerontaylor/cq-toolkit';
import { runSuite } from './index.ts';
import type { ComparisonTable, ResultRow } from './aggregate.ts';
import { FakeDriver } from './fake-driver.ts';

const LANES = new Set(['ai-sdk', 'claude-agent', 'subprocess', 'acp']);
const USAGE =
  'usage: node --experimental-strip-types runner/index.ts --suite <dir> [--suite <dir> …] ' +
  '--driver fake|ai-sdk --model <served-id> --provider <handle> [--driver-name <ai-sdk|claude-agent|subprocess|acp>] ' +
  '[--max-usd <n>] [--max-tokens <n>] [--wall-clock-ms <n>] [--journal <dir>] [--out <dir>]';

export class UsageError extends Error {}

function nextValue(argv: readonly string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined) throw new UsageError(`flag ${flag} requires a value\n${USAGE}`);
  return v;
}

interface CliOptions {
  suites: string[];
  driver: 'fake' | 'ai-sdk';
  model: string;
  provider: string;
  maxUsd: number;
  maxTokens?: number;
  wallClockMs?: number;
  journal?: string;
  out?: string;
  driverName: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const o: CliOptions = { suites: [], driver: 'fake', model: '', provider: '', maxUsd: 1, driverName: '' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    switch (flag) {
      case '--suite': o.suites.push(nextValue(argv, i, flag)); i++; break;
      case '--driver': {
        const v = nextValue(argv, i, flag);
        if (v !== 'fake' && v !== 'ai-sdk') throw new UsageError(`--driver must be fake|ai-sdk, got '${v}'`);
        o.driver = v; i++; break;
      }
      case '--model': o.model = nextValue(argv, i, flag); i++; break;
      case '--provider': o.provider = nextValue(argv, i, flag); i++; break;
      case '--driver-name': o.driverName = nextValue(argv, i, flag); i++; break;
      case '--journal': o.journal = nextValue(argv, i, flag); i++; break;
      case '--out': o.out = nextValue(argv, i, flag); i++; break;
      case '--max-usd': case '--max-tokens': case '--wall-clock-ms': {
        const n = Number(nextValue(argv, i, flag));
        if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number`);
        if (flag === '--max-usd') o.maxUsd = n;
        else if (flag === '--max-tokens') o.maxTokens = n;
        else o.wallClockMs = n;
        i++; break;
      }
      default: throw new UsageError(`unknown flag '${flag}'\n${USAGE}`);
    }
  }
  if (o.suites.length === 0 || o.model === '' || o.provider === '') {
    throw new UsageError(`--suite, --model and --provider are required\n${USAGE}`);
  }
  o.driverName = o.driverName === '' ? o.driver : o.driverName;
  if (!LANES.has(o.driverName)) {
    throw new UsageError(`--driver-name '${o.driverName}' is not a toolkit lane (${[...LANES].join('|')}) — pass one so rows validate`);
  }
  return o;
}

async function main(argv: readonly string[]): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) { console.error(e.message); return 2; }
    throw e;
  }
  // ai-sdk constructs minimally (all AiSdkDriverOptions optional; production
  // defaults). It is never the default: --driver picks explicitly.
  const driver: Driver = opts.driver === 'ai-sdk' ? new AiSdkDriver() : new FakeDriver();
  const rows: ResultRow[] = [];
  const tables: ComparisonTable[] = [];
  let anyFailed = false;
  for (const suiteDir of opts.suites) {
    const result = await runSuite({
      suiteDir, driver,
      model: opts.model, provider: opts.provider, maxUsd: opts.maxUsd,
      maxTokens: opts.maxTokens, wallClockMs: opts.wallClockMs,
      journalPath: opts.journal, driverName: opts.driverName,
    });
    rows.push(...result.rows);
    tables.push(...result.tables);
    const passed = result.rows.reduce((n, r) => n + r.outcome.passed, 0);
    const total = result.rows.reduce((n, r) => n + r.outcome.total, 0);
    if (result.rows.some((r) => r.outcome.passed === 0)) anyFailed = true;
    // A budget-gated run did not complete: never report it as clean (the
    // gated cases are also visible on the run-finished journal event).
    if (result.gatedByBudget) anyFailed = true;
    const runSuffix = result.rows[0] !== undefined ? `, run ${result.rows[0].runId}` : '';
    const suiteName = result.rows[0]?.suite ?? suiteDir;
    console.log(`suite ${suiteName}: ${passed}/${total} probes passed across ${result.rows.length} case(s)${runSuffix}`);
  }
  if (opts.out !== undefined) {
    mkdirSync(opts.out, { recursive: true });
    const seenRoles = new Set<string>();
    for (const t of tables) {
      if (seenRoles.has(t.role)) {
        throw new Error(`two suites share role '${t.role}'; <role>.table.json would collide — run one suite per role per invocation`);
      }
      seenRoles.add(t.role);
      writeFileSync(join(opts.out, `${t.role}.table.json`), JSON.stringify(t, null, 2) + '\n');
    }
    writeFileSync(join(opts.out, 'rows.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : ''));
    console.log(`wrote ${opts.out}/rows.jsonl and ${seenRoles.size} table(s)`);
  }
  return anyFailed ? 1 : 0;
}

/** Process entry: sets the exit code, never throws past the CLI boundary. */
export async function cliMain(argv: readonly string[]): Promise<void> {
  try {
    process.exitCode = await main(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
