// CLI wiring for the eval runner: flag parsing, driver construction, output
// writing, and the I1 exit-code discipline — 0 clean; 1 a case scored zero,
// the run was budget-gated, or a post-load run/validation error; 2 usage
// error or suite load/validation failure (the suite.yml workflow hard-fails
// its rc>=2 branch). Invoked via runner/index.ts.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AiSdkDriver, type Driver } from '@camerontaylor/cq-toolkit';
import { z } from 'zod';
import { runSuite } from './index.ts';
import type { ComparisonTable, ResultRow } from './aggregate.ts';
import { loadSuite, type Suite } from './suite.ts';
import { FakeDriver } from './fake-driver.ts';

const LANES = new Set(['ai-sdk', 'claude-agent', 'subprocess', 'acp']);
const USAGE =
  'usage: node --experimental-strip-types runner/index.ts --suite <dir> [--suite <dir> …] ' +
  '--driver fake|ai-sdk --model <served-id> --provider <handle> [--driver-name <ai-sdk|claude-agent|subprocess|acp>] ' +
  '[--max-usd <n>] [--max-tokens <n>] [--wall-clock-ms <n>] [--check-timeout-ms <n>] [--journal <dir>] [--out <dir>]\n' +
  'exits: 0 clean; 1 a case scored zero / run budget-gated / post-load error; 2 usage or suite load failure';

export class UsageError extends Error {}

// Real-lane review-classifier runs NEED structured output: without a schema
// the ai-sdk lane never produces structuredOutput.verdict and every
// classifier case scores 0 regardless of model behavior. The vocabulary is
// mirrored locally (classifyThreads is not on the toolkit's export surface;
// enum-identical to schema/suite.schema.json).
const VERDICT_OUTPUT_SCHEMA = z.object({
  verdict: z.enum(['actionable', 'responded', 'resolved', 'blocked', 'skip']),
});

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
  maxUsd?: number;
  maxTokens?: number;
  wallClockMs?: number;
  checkTimeoutMs: number;
  journal?: string;
  out?: string;
  driverName: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  // No cap default-injection: absent --max-usd/--max-tokens/--wall-clock-ms
  // mean ABSENT caps, so a token-only cap can bind an unpriced lane (DD-9).
  const o: CliOptions = { suites: [], driver: 'fake', model: '', provider: '', checkTimeoutMs: 60_000, driverName: '' };
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
      case '--max-usd': case '--max-tokens': case '--wall-clock-ms': case '--check-timeout-ms': {
        const n = Number(nextValue(argv, i, flag));
        if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number`);
        if (flag === '--max-usd') o.maxUsd = n;
        else if (flag === '--max-tokens') o.maxTokens = n;
        else if (flag === '--wall-clock-ms') o.wallClockMs = n;
        else o.checkTimeoutMs = n;
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
  // Suites load BEFORE driver construction: load/validation failures map to
  // exit 2 (hard-fail in the workflow), and the loaded roles decide whether
  // the ai-sdk lane needs a verdict output schema.
  let suites: Suite[];
  try {
    suites = opts.suites.map((d) => loadSuite(d));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return 2;
  }
  // ai-sdk constructs minimally for fixer-only runs; a review-classifier run
  // gets the verdict output schema so the lane can produce
  // structuredOutput.verdict at all. It is never the default: --driver picks
  // explicitly.
  const driver: Driver = opts.driver === 'ai-sdk'
    ? new AiSdkDriver(
        suites.some((s) => s.role === 'review-classifier') ? { outputSchema: VERDICT_OUTPUT_SCHEMA } : undefined,
      )
    : new FakeDriver();
  const rows: ResultRow[] = [];
  const tables: ComparisonTable[] = [];
  let anyFailed = false;
  try {
    for (const suiteDir of opts.suites) {
      const result = await runSuite({
        suiteDir, driver,
        model: opts.model, provider: opts.provider,
        maxUsd: opts.maxUsd, maxTokens: opts.maxTokens, wallClockMs: opts.wallClockMs,
        checkTimeoutMs: opts.checkTimeoutMs,
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
  } catch (e) {
    // Errors after suites loaded (row/table validation, output writing):
    // post-load failures stay exit 1, not the hard-fail exit 2.
    console.error(e instanceof Error ? e.message : e);
    return 1;
  }
  return anyFailed ? 1 : 0;
}

/** Process entry: returns the exit code, never throws past the CLI boundary. */
export async function cliMain(argv: readonly string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return 1;
  }
}
