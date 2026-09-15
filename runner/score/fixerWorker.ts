import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { WorkerResult } from '@camerontaylor/cq-toolkit';

/** One probe verdict: score pieces for a result row, plus failure diagnostics. */
export interface ScoreOutcome {
  score: number;
  passed: number;
  total: number;
  /** Why the probe failed or could not run — surfaced on stderr, never in rows. */
  diagnostics?: string;
}

/** Structural shape of a check-rerun case (suite.schema.json, narrowed by loadSuite). */
interface CheckRerunCase {
  fixture: string;
  probe: { kind: 'check-rerun'; check: string };
}

const OUTPUT_TAIL_CHARS = 2000;

function tail(s: string): string {
  const t = s.trim();
  return t.length > OUTPUT_TAIL_CHARS ? `…${t.slice(-OUTPUT_TAIL_CHARS)}` : t;
}

/**
 * Score a fixer-worker case by RE-RUNNING the seeded check probe with cwd set
 * to the case's fixture workspace. The worker's structured output does not
 * influence this probe on purpose: the whole contract is "does the check pass
 * on the workspace now" — sweep-agnostic, so the same probe grades a fixed
 * fixture, an untouched fixture, or a sweep artifact identically.
 *
 * A probe that cannot execute (missing check script, missing fixture dir,
 * spawn failure) scores 0 with the error captured in diagnostics — it never
 * throws, so one broken case cannot abort the run's remaining cases (I9).
 */
export function scoreFixerWorker(
  suiteCase: CheckRerunCase,
  _workerResult: WorkerResult,
  repoRoot: string,
): ScoreOutcome {
  if (suiteCase.probe.kind !== 'check-rerun') {
    // loadSuite's semantic layer already enforces the role↔probe pairing;
    // reaching here means a caller bypassed it. Fail loud (programming error).
    throw new Error(`scoreFixerWorker: probe kind must be 'check-rerun', got '${suiteCase.probe.kind}'`);
  }
  const fixtureAbs = join(repoRoot, suiteCase.fixture);
  const checkAbs = join(repoRoot, suiteCase.probe.check);
  const res = spawnSync('node', [checkAbs], { cwd: fixtureAbs, encoding: 'utf8' });
  if (res.error !== undefined && res.error !== null) {
    return {
      score: 0,
      passed: 0,
      total: 1,
      diagnostics: `check probe could not execute (${suiteCase.probe.check}): ${res.error.message}`,
    };
  }
  const passed = res.status === 0;
  if (passed) return { score: 1, passed: 1, total: 1 };
  const why =
    res.status === null
      ? `terminated by signal ${res.signal ?? 'unknown'}`
      : `exit code ${res.status}`;
  const output = [tail(res.stdout ?? ''), tail(res.stderr ?? '')].filter(Boolean).join('\n');
  return {
    score: 0,
    passed: 0,
    total: 1,
    diagnostics: `check probe failed (${why})${output ? `:\n${output}` : ''}`,
  };
}
