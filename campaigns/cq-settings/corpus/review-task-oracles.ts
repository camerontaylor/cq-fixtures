import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { executeProtectedJudgeChild } from '../../../runner/boundary/judge-child.ts';
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

export function verifyReviewOracleDependencies(
  dependencies: readonly { readonly path: string; readonly sha256: string }[],
  corpusRoot: URL,
): void {
  for (const dependency of dependencies) {
    const actual = createHash('sha256').update(readFileSync(new URL(dependency.path, corpusRoot))).digest('hex');
    if (actual !== dependency.sha256) throw new Error(`review oracle dependency changed: ${dependency.path}`);
  }
}
