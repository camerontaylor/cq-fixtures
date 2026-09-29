// PK14 / D22 + D77: the runtime entry point of the correction-aware report
// PRODUCER.
//
//   node --experimental-strip-types runner/reporting/produce-correction-report.ts \
//     --as-of 2026-09-29T00:00:00Z \
//     --corpus-root <research-20260929-cq-settings-execution> \
//     --run cq-s5-final-20260929-19 \
//     --rows cq-s5-final-20260929-19=<dir>/rows.jsonl \
//     --original cq-s5-final-20260929-19=<dir>/original-projection.json \
//     --scope run21-g1-contract-audit="final-container Codex"=actual \
//     --adapter-terminal-cause unknown --adapter-operational-status interrupted \
//     --out <dir>
//
// This is the non-test caller the independent PK14 acceptance found missing:
// it reads the pinned manifest from disk, re-verifies every pin, resolves the
// private artifacts a correction names from explicitly named roots, consumes
// each run's report, re-aggregates the derived rows through the unchanged
// aggregate lane, and writes its output EXCLUSIVELY — a run can never
// overwrite the historical evidence it reports on.
//
// Exit codes follow the runner's convention:
//
//   0  the report was produced. A WITHHELD claim is a produced report: a
//      withheld rate is not a failure of the producer, and it is never printed
//      as a zero. Use --require-publishable to turn an unpublishable report
//      into a non-zero exit.
//   1  the producer could not produce a report (unreadable evidence, malformed
//      originals). Nothing is written.
//   2  usage error.
//
// It reads no clock: --as-of is required. It runs no model, contacts no
// provider, publishes nothing, and merges nothing.

import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { produceCorrectionAwareReport, ProducerError, type ProducerRunInput } from './producer.ts';
import type { RouteView } from './status-view.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_MANIFEST = fileURLToPath(new URL('./corrections.manifest.json', import.meta.url));

const USAGE = `usage: produce-correction-report --as-of <rfc3339> [--manifest <path>] [--repo-root <dir>]
       [--corpus-root <dir>] [--evidence-root <dir>]... --run <runId>...
       [--rows <runId>=<rows.jsonl>]... [--original <runId>=<projection.json>]...
       [--scope <entryId>=<route>=<actual|shared-condition|development>]...
       [--adapter-terminal-cause <v> --adapter-operational-status <v>]
       [--out <dir>] [--require-publishable]

  --as-of      Required. The board's timestamp comes from cited records or from
               this instant; the wall clock is never read.
  --corpus-root Root for corpus-pinned records. Omit it and every corpus record
               is UNRESOLVED, which is reported, never assumed to match.
  --evidence-root
               A directory holding the private artifacts a correction names.
               Without one, run19's six private native artifacts are
               unresolvable and the corrected rate is WITHHELD — not 0.
  --adapter-*  The caller-supplied lifecycle mapping for legacy records. Omit
               both and a legacy record's retracted projections are withheld
               rather than left at their historic values.
  --out        Directory for the produced report. Writes are exclusive.`;

class UsageError extends Error {}

/** One occurrence of a repeatable flag. */
function values(argv: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== flag) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} requires a value\n${USAGE}`);
    out.push(value);
    i += 1;
  }
  return out;
}

function value(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const found = argv[index + 1];
  if (found === undefined || found.startsWith('--')) throw new UsageError(`${flag} requires a value\n${USAGE}`);
  return found;
}

/** Parse `key=value`, refusing a malformed pair rather than guessing. */
function pair(flag: string, text: string): [string, string] {
  const index = text.indexOf('=');
  if (index <= 0 || index === text.length - 1) throw new UsageError(`${flag} expects <key>=<value>, got '${text}'\n${USAGE}`);
  return [text.slice(0, index), text.slice(index + 1)];
}

const LANES: readonly RouteView['lane'][] = ['actual', 'shared-condition', 'development'];

/** Parse argv into producer options. Throws UsageError, never a silent default. */
export function parseArgs(argv: readonly string[]): Parameters<typeof produceCorrectionAwareReport>[0] & { requirePublishable: boolean } {
  const known = new Set([
    '--as-of', '--manifest', '--repo-root', '--corpus-root', '--evidence-root', '--run', '--rows', '--original',
    '--scope', '--adapter-terminal-cause', '--adapter-operational-status', '--out', '--require-publishable',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--require-publishable') continue;
    if (!known.has(token)) throw new UsageError(`unknown flag '${token}'\n${USAGE}`);
    if (known.has(token)) i += 1;
  }

  const asOf = value(argv, '--as-of');
  if (asOf === undefined) throw new UsageError(`--as-of is required and is never inferred from a clock\n${USAGE}`);
  const runIds = values(argv, '--run');
  if (runIds.length === 0) throw new UsageError(`--run is required at least once\n${USAGE}`);

  const rows = new Map(values(argv, '--rows').map((text) => pair('--rows', text)));
  const originals = new Map(values(argv, '--original').map((text) => pair('--original', text)));
  const runs: ProducerRunInput[] = runIds.map((runId) => ({
    runId,
    ...(rows.has(runId) ? { rowsPath: rows.get(runId)! } : {}),
    ...(originals.has(runId) ? { originalPath: originals.get(runId)! } : {}),
  }));
  for (const runId of [...rows.keys(), ...originals.keys()]) {
    if (!runIds.includes(runId)) throw new UsageError(`--rows/--original name run '${runId}', which no --run declared`);
  }

  const scopes = values(argv, '--scope').map((text) => {
    const parts = text.split('=');
    if (parts.length !== 3) throw new UsageError(`--scope expects <entryId>=<route>=<lane>, got '${text}'\n${USAGE}`);
    const [entryId, route, lane] = parts as [string, string, string];
    if (!LANES.includes(lane as RouteView['lane'])) {
      throw new UsageError(`--scope lane must be one of ${LANES.join('|')}, got '${lane}'\n${USAGE}`);
    }
    return { entryId, route, lane: lane as RouteView['lane'] };
  });

  // The adapter is the caller's declaration, supplied whole or not at all. A
  // half-supplied mapping is a usage error, never a partially applied adapter.
  const terminalCause = value(argv, '--adapter-terminal-cause');
  const operationalStatus = value(argv, '--adapter-operational-status');
  if ((terminalCause === undefined) !== (operationalStatus === undefined)) {
    throw new UsageError('--adapter-terminal-cause and --adapter-operational-status must be supplied together\n' + USAGE);
  }

  return {
    manifestPath: value(argv, '--manifest') ?? DEFAULT_MANIFEST,
    repoRoot: value(argv, '--repo-root') ?? REPO_ROOT,
    corpusRoot: value(argv, '--corpus-root') === undefined ? null : value(argv, '--corpus-root')!,
    evidenceRoots: values(argv, '--evidence-root'),
    runs,
    asOf,
    scopes,
    ...(terminalCause !== undefined && operationalStatus !== undefined
      ? { adapter: { terminalCause, operationalStatus } }
      : {}),
    ...(value(argv, '--out') !== undefined ? { outDir: value(argv, '--out')! } : {}),
    requirePublishable: argv.includes('--require-publishable'),
  };
}

/**
 * Process entry: returns the exit code, never throws past the CLI boundary.
 *
 * Exported so a caller can drive the producer in-process, but the module's
 * direct-invocation guard below is what makes it a genuine runtime entry point
 * rather than a library that nothing calls.
 */
export function produceCorrectionReportMain(argv: readonly string[]): number {
  try {
    const options = parseArgs(argv);
    const requirePublishable = options.requirePublishable;
    const report = produceCorrectionAwareReport(options);

    // Print what was actually decided, in the vocabulary the contract uses.
    for (const check of report.manifest.unverified) {
      console.error(`pinned record ${check.id} is ${check.status}: ${check.detail}`);
    }
    for (const run of report.runs) {
      const rate = run.rateClaim.published
        ? `corrected completion rate ${String(run.rateClaim.value)}`
        : 'corrected completion rate WITHHELD (null, not 0)';
      console.log(
        `${run.runId}: selection=${run.state.selectionStatus} publishable=${run.publishable} ` +
          `historicRate=${run.state.historicCompletionRate === null ? 'null' : run.state.historicCompletionRate} ${rate} ` +
          `reaggregation=${run.reaggregation.status} rowsPreserved=${run.rowsPreserved.identical}`,
      );
      if (!run.rateClaim.published) console.error(`  ${run.runId}: ${run.rateClaim.reason}`);
      for (const field of run.state.withheld) {
        console.error(`  ${run.runId}: ${field.field} withheld (${field.reason}) — ${field.detail ?? 'no detail recorded'}`);
      }
    }
    for (const output of report.outputs) console.log(`wrote ${output.path} (sha256 ${output.sha256})`);

    if (requirePublishable && report.runs.some((run) => !run.publishable)) {
      console.error('--require-publishable: at least one run has no publishable corrected claim');
      return 1;
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      return 2;
    }
    if (e instanceof ProducerError) {
      console.error(e.message);
      return 1;
    }
    console.error(`produce-correction-report failure: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

// The same direct-invocation guard runner/index.ts uses: importing this module
// has no side effect, and running it as a script is the producer.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = produceCorrectionReportMain(process.argv.slice(2));
}
