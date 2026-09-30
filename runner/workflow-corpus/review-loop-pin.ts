import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pin includes every host module that defines this task's identity and semantics.
 *
 * Closure provenance: this list is the transitive *runtime* import closure of the
 * host-side review judge. `assignment-supervisor-owner.ts` and
 * `g2-daemon-contract.ts` were missing: both are value-imported by pinned
 * boundary modules (`codex-final-profile.ts`, `container-prepare.ts`,
 * `container.ts`, `docker-control.ts`, `judge-child.ts`, `judge-ownership.ts`),
 * and `g2-daemon-contract.ts` binds the dedicated daemon identity the protected
 * child asserts. `integration-task-oracles.ts` is reached because the review
 * expansion oracle now delegates its scope/ancestry fact to
 * `judgeLocalCandidateIdentity`.
 *
 * Deliberately NOT pinned: `runner/boundary/assignment-supervisor.ts`, which is
 * reached only through an `import type` edge and is therefore compile-time only.
 */
export const REVIEW_LOOP_ORACLE_DEPENDENCIES = [
  'runner/workflow-corpus/review-loop-judge.ts',
  'runner/workflow-corpus/review-loop-pin.ts',
  'campaigns/cq-settings/corpus/review-loop-task.ts',
  'campaigns/cq-settings/corpus/oracle-pin-contract.ts',
  'campaigns/cq-settings/corpus/review-task-oracles.ts',
  'campaigns/cq-settings/corpus/integration-task-oracles.ts',
  'campaigns/cq-settings/corpus/protected-candidate-snapshot.ts',
  'campaigns/cq-settings/corpus/operation-oracle-pins.json',
  'runner/boundary/evidence/fallback/judge-ownership-source-closure.public.json',
  'runner/boundary/assignment-supervisor-owner.ts',
  'runner/boundary/broker-toolchain.ts',
  'runner/boundary/codex-final-profile.ts',
  'runner/boundary/container-prepare.ts',
  'runner/boundary/container.ts',
  'runner/boundary/docker-control.ts',
  'runner/boundary/egress-broker.ts',
  'runner/boundary/g2-daemon-contract.ts',
  'runner/boundary/judge-child.ts',
  'runner/boundary/judge-ownership.ts',
  'runner/boundary/lifecycle-evidence.ts',
  'runner/boundary/namespace-acl.sh',
  'runner/boundary/subscription-auth.ts',
  'runner/boundary/task-session.ts',
  'runner/boundary/task-staging.ts',
  'runner/boundary/task-tree.ts',
  'runner/boundary/volume-io.mjs',
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
