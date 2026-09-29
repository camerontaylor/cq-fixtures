import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pin includes every host module that defines this task's identity and semantics. */
export const REVIEW_LOOP_ORACLE_DEPENDENCIES = [
  'runner/workflow-corpus/review-loop-judge.ts',
  'runner/workflow-corpus/review-loop-pin.ts',
  'campaigns/cq-settings/corpus/review-loop-task.ts',
  'runner/boundary/judge-child.ts',
  'runner/boundary/task-tree.ts',
] as const;

export interface ReviewLoopOracleDependency {
  readonly path: (typeof REVIEW_LOOP_ORACLE_DEPENDENCIES)[number];
  readonly sha256: string;
}

export interface ReviewLoopOraclePin {
  readonly version: 2;
  readonly oracleId: string;
  readonly dependencies: readonly ReviewLoopOracleDependency[];
  readonly sha256: string;
}

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Content pin for the complete host-side semantic judge and its task constants. */
export function createReviewLoopOraclePin(repoRoot = REPO_ROOT): ReviewLoopOraclePin {
  const dependencies = REVIEW_LOOP_ORACLE_DEPENDENCIES.map((path) => ({
    path,
    sha256: createHash('sha256').update(readFileSync(join(repoRoot, path))).digest('hex'),
  }));
  const oracleId = 'cq-settings.label-length-unicode.oracle.v2';
  const canonical = JSON.stringify({ version: 2, oracleId, dependencies });
  return {
    version: 2,
    oracleId,
    dependencies,
    sha256: createHash('sha256').update(canonical).digest('hex'),
  };
}

/** Environment fields for the runner's host-only check scorer option. */
export function reviewLoopHostCheckEnvironment(
  pins: { readonly baselineCommit: string; readonly oraclePin: string },
): Readonly<Record<string, string>> {
  if (!/^[a-f0-9]{40}$/.test(pins.baselineCommit)) throw new Error('review-loop baseline pin must be a full Git SHA');
  if (!/^[a-f0-9]{64}$/.test(pins.oraclePin)) throw new Error('review-loop oracle pin must be a SHA256');
  return {
    CQ_REVIEW_LOOP_BASELINE_SHA: pins.baselineCommit,
    CQ_REVIEW_LOOP_ORACLE_PIN: pins.oraclePin,
  };
}
