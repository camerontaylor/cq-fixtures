import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { executeProtectedJudgeChild } from '../../../runner/boundary/judge-child.ts';
import { judgeLocalCandidateIdentity } from './integration-task-oracles.ts';
import { withProtectedCandidateSnapshot } from './protected-candidate-snapshot.ts';

export const REVIEW_TASK_CONTRACTS = {
  roleScope: {
    id: 'review-role-scope-01',
    sourceId: 'cq-settings.review-role-scope-seed.v1',
    baselineId: 'cq-settings.review-role-scope.baseline.v1',
    oracleId: 'cq-settings.review-role-scope.oracle.v1',
    substrateFamily: 'campaign-role-permission-v1',
    module: 'settings/review-permissions.mjs',
    exportName: 'canEditCampaign',
    /** Only this task-owned source path may change; the public test and display module may not. */
    allowedPaths: ['settings/review-permissions.mjs'],
    requests: [
      ['owner-1', 'owner-1', 'owner', []],
      ['admin-1', 'owner-1', 'admin', ['campaign:edit']],
      ['outsider-1', 'owner-1', 'user', ['campaign:edit']],
      [null, 'owner-1', 'admin', ['campaign:edit']],
    ],
    expected: [true, true, false, false],
  },
  labelNfc: {
    id: 'review-label-nfc-01',
    sourceId: 'cq-settings.review-label-nfc-seed.v1',
    baselineId: 'cq-settings.review-label-nfc.baseline.v1',
    oracleId: 'cq-settings.review-label-nfc.oracle.v1',
    substrateFamily: 'campaign-label-canonicalization-v1',
    module: 'settings/campaign-labels.mjs',
    exportName: 'sameCampaignLabel',
    /** Only this task-owned source path may change; display.js must keep its original bytes. */
    allowedPaths: ['settings/campaign-labels.mjs'],
    requests: [
      ['Café', 'Cafe\u0301'],
      ['café', 'cafe'],
      ['  Cafe\u0301 ', 'Café'],
      ['', ''],
      ['Campaign A', 'Campaign A'],
    ],
    expected: [true, false, true, false, true],
    displayModule: 'settings/display.mjs',
    displayExportName: 'displayCampaignLabel',
    displayRequests: [['Cafe\u0301'], ['  Cafe\u0301 ']],
    displayExpected: ['Cafe\u0301', '  Cafe\u0301 '],
  },
} as const;

export type ReviewTaskVariant = keyof typeof REVIEW_TASK_CONTRACTS;

export interface ReviewSemanticReport {
  readonly passed: boolean;
  readonly sourceId: string;
  readonly baselineId: string;
  readonly oracleId: string;
  readonly failures: readonly string[];
  readonly candidatePatchSha256?: string;
}

/** Grade already observed return values. This function never imports candidate code. */
export function judgeReviewTaskValues(
  variant: ReviewTaskVariant,
  actual: unknown,
): ReviewSemanticReport {
  const contract = REVIEW_TASK_CONTRACTS[variant];
  const failures: string[] = [];
  if (!Array.isArray(actual) || actual.length !== contract.expected.length) {
    failures.push('candidate result count did not match the host vector count');
  } else {
    contract.expected.forEach((expected, index) => {
      if (actual[index] !== expected) failures.push(`behavior vector ${index} returned the wrong value`);
    });
  }
  return {
    passed: failures.length === 0,
    sourceId: contract.sourceId,
    baselineId: contract.baselineId,
    oracleId: contract.oracleId,
    failures,
  };
}

/** The candidate stdout remains private. Reports contain host booleans only. */
export async function judgeReviewTaskCandidate(
  variant: ReviewTaskVariant,
  candidateRoot: string,
): Promise<ReviewSemanticReport> {
  const contract = REVIEW_TASK_CONTRACTS[variant];
  try {
    const contractModules = variant === 'labelNfc'
      ? [contract.module, REVIEW_TASK_CONTRACTS.labelNfc.displayModule]
      : [contract.module];
    return await withProtectedCandidateSnapshot(candidateRoot, contractModules, async (safeRoot) => {
    const result = await executeProtectedJudgeChild({
      candidateRoot: safeRoot,
      module: contract.module,
      exportName: contract.exportName,
      requests: contract.requests.map((request) => [...request]),
      timeoutMs: 5_000,
    });
    if (result.exitCode !== 0 || result.timedOut || !result.containerAbsentVerified) {
      return { ...judgeReviewTaskValues(variant, null), failures: ['protected candidate execution did not complete cleanly'] };
    }
    const actual: unknown = JSON.parse(result.stdout.toString('utf8'));
    const behavior = judgeReviewTaskValues(variant, actual);
    if (variant !== 'labelNfc') return behavior;
    const displayContract = REVIEW_TASK_CONTRACTS.labelNfc;
    const display = await executeProtectedJudgeChild({
      candidateRoot: safeRoot,
      module: displayContract.displayModule,
      exportName: displayContract.displayExportName,
      requests: displayContract.displayRequests.map((request) => [...request]),
      timeoutMs: 5_000,
    });
    if (display.exitCode !== 0 || display.timedOut || !display.containerAbsentVerified) {
      return { ...behavior, passed: false, failures: [...behavior.failures, 'protected display preservation check did not complete cleanly'] };
    }
    const displayed: unknown = JSON.parse(display.stdout.toString('utf8'));
    const displayFailures = Array.isArray(displayed)
      && displayed.length === displayContract.displayExpected.length
      && displayContract.displayExpected.every((value, index) => displayed[index] === value)
      ? []
      : ['display output did not preserve original Unicode bytes'];
    return { ...behavior, passed: behavior.passed && displayFailures.length === 0, failures: [...behavior.failures, ...displayFailures] };
    });
  } catch {
    return { ...judgeReviewTaskValues(variant, null), failures: ['protected candidate execution unavailable'] };
  }
}

export function reviewCandidatePatchSha256(patch: Uint8Array): string {
  return createHash('sha256').update(patch).digest('hex');
}

export interface ReviewCandidateIdentityReport {
  readonly passed: boolean;
  readonly sourceId: string;
  readonly baselineId: string;
  readonly oracleId: string;
  readonly baselineCommit: string;
  readonly candidateCommit: string;
  readonly cleanGitCandidate: boolean;
  /** SHA256 of this candidate's actual binary Git patch, never a reference solution hash. */
  readonly candidatePatchSha256: string | null;
  readonly failures: readonly string[];
}

const CLEAN_GIT_ENVIRONMENT = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } as const;

/**
 * Host-only scope and identity facts for a review expansion candidate.
 * This never executes candidate code, so it stays exact even when the
 * protected judge child is unavailable.
 */
export function judgeReviewTaskCandidateIdentity(
  variant: ReviewTaskVariant,
  input: { readonly candidateRoot: string; readonly baselineCommit: string },
): ReviewCandidateIdentityReport {
  const contract = REVIEW_TASK_CONTRACTS[variant];
  const base: Omit<ReviewCandidateIdentityReport, 'passed' | 'candidateCommit' | 'cleanGitCandidate' | 'candidatePatchSha256' | 'failures'> = {
    sourceId: contract.sourceId,
    baselineId: contract.baselineId,
    oracleId: contract.oracleId,
    baselineCommit: input.baselineCommit,
  };
  if (!/^[0-9a-f]{40}$/.test(input.baselineCommit)) {
    return { ...base, passed: false, candidateCommit: '', cleanGitCandidate: false, candidatePatchSha256: null, failures: ['recorded baseline is not a full Git commit identity'] };
  }
  const git = (args: string[], encoding: 'utf8' | 'buffer' = 'utf8'): string =>
    execFileSync('git', args, {
      cwd: input.candidateRoot,
      encoding,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...CLEAN_GIT_ENVIRONMENT },
    }).toString().trim();
  let candidateCommit = '';
  let cleanGitCandidate = false;
  let candidatePatchSha256: string | null = null;
  const failures: string[] = [];
  try {
    candidateCommit = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!/^[0-9a-f]{40}$/.test(candidateCommit)) failures.push('candidate HEAD is absent or is not a full Git commit identity');
    if (candidateCommit === input.baselineCommit) failures.push('candidate HEAD is still the pristine baseline');
    cleanGitCandidate = git(['status', '--porcelain', '--untracked-files=all']) === '';
    if (!cleanGitCandidate) failures.push('candidate has uncommitted or untracked repository changes');
    const patch = execFileSync('git', ['diff', '--binary', `${input.baselineCommit}..HEAD`, '--'], {
      cwd: input.candidateRoot,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...CLEAN_GIT_ENVIRONMENT },
    });
    candidatePatchSha256 = reviewCandidatePatchSha256(patch);
    if (patch.byteLength === 0) failures.push('candidate patch bytes are empty');
  } catch (error) {
    failures.push(`candidate patch bytes could not be captured: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Scope and ancestry are delegated to the shared local identity oracle so the
  // review, merge and fleet families enforce one identical fact set.
  const identity = judgeLocalCandidateIdentity({
    repoRoot: input.candidateRoot,
    baselineCommit: input.baselineCommit,
    allowedPaths: [...contract.allowedPaths],
  });
  failures.push(...identity.failures);
  if (identity.patchSha256 !== '' && candidatePatchSha256 !== null && identity.patchSha256 !== candidatePatchSha256) {
    failures.push('candidate patch digest disagreed between the shared and review identity oracles');
  }
  return { ...base, passed: failures.length === 0, candidateCommit, cleanGitCandidate, candidatePatchSha256, failures };
}

export interface ReviewTaskSubmissionReport {
  readonly passed: boolean;
  readonly sourceId: string;
  readonly baselineId: string;
  readonly oracleId: string;
  readonly behavior: ReviewSemanticReport;
  readonly identity: ReviewCandidateIdentityReport;
  readonly candidatePatchSha256: string | null;
  readonly failures: readonly string[];
}

/**
 * Full independent judgement of one committed review expansion candidate:
 * behavior, scope, baseline ancestry and candidate identity stay separate facts
 * and a correct candidate is never defined by matching reference bytes.
 */
export async function judgeReviewTaskSubmission(
  variant: ReviewTaskVariant,
  input: { readonly candidateRoot: string; readonly baselineCommit: string },
): Promise<ReviewTaskSubmissionReport> {
  const behavior = await judgeReviewTaskCandidate(variant, input.candidateRoot);
  const identity = judgeReviewTaskCandidateIdentity(variant, input);
  const failures = [...behavior.failures, ...identity.failures];
  return {
    passed: behavior.passed && identity.passed,
    sourceId: REVIEW_TASK_CONTRACTS[variant].sourceId,
    baselineId: REVIEW_TASK_CONTRACTS[variant].baselineId,
    oracleId: REVIEW_TASK_CONTRACTS[variant].oracleId,
    behavior,
    identity,
    candidatePatchSha256: identity.candidatePatchSha256,
    failures,
  };
}

export function verifyReviewOracleDependencies(
  dependencies: readonly { readonly path: string; readonly sha256: string }[],
  corpusRoot: URL,
): void {
  for (const dependency of dependencies) {
    const actual = createHash('sha256').update(readFileSync(new URL(dependency.path, corpusRoot))).digest('hex');
    if (actual !== dependency.sha256) throw new Error(`review oracle dependency changed: ${dependency.path}`);
  }
}
