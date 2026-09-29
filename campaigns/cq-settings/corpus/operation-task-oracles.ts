/** Host-owned meanings for the two additional analyze/remediate tasks. */
export const ANALYSIS_TASK_CONTRACTS = {
  safeIntegerSetting: {
    id: 'analysis-safe-integer-setting-01',
    sourceId: 'cq-settings.analysis-safe-integer-setting-seed.v1',
    baselineId: 'cq-settings.analysis-safe-integer-setting.baseline.v1',
    oracleId: 'cq-settings.analysis-safe-integer-setting.oracle.v1',
    substrateFamily: 'numeric-setting-contract-v1',
    setting: 'maxParallelJobs',
    minimum: 1,
    maximum: 64,
    requiredConstraints: ['integer', 'safe-integer', 'range-1-through-64'] as const,
    vectors: [1, 64, 0, 65, 1.5, Number.MAX_SAFE_INTEGER + 1, '4', null] as const,
    expected: [true, true, false, false, false, false, false, false] as const,
  },
  originPolicy: {
    id: 'analysis-origin-policy-01',
    sourceId: 'cq-settings.analysis-origin-policy-seed.v1',
    baselineId: 'cq-settings.analysis-origin-policy.baseline.v1',
    oracleId: 'cq-settings.analysis-origin-policy.oracle.v1',
    substrateFamily: 'remote-origin-config-v1',
    setting: 'remoteOrigin',
    requiredConstraints: ['https-production', 'no-credentials', 'localhost-http-development'] as const,
    vectors: [
      'https://api.example.test/v1',
      'https://user:secret@api.example.test/v1',
      'http://api.example.test/v1',
      'not a URL',
      'http://localhost:4317/v1',
      'https://localhost:4317/v1',
    ] as const,
    expected: [true, false, false, false, true, true] as const,
  },
} as const;

export type AnalysisTaskContractName = keyof typeof ANALYSIS_TASK_CONTRACTS;

export interface ProposalMeaning {
  /** Structured domain identity, independent of prose or output formatting. */
  readonly setting?: unknown;
  /** Machine-readable constraints the proposal says its fix will enforce. */
  readonly constraints?: unknown;
  /** Whether invalid values are rejected by the setting validator. */
  readonly rejectsInvalidValues?: unknown;
  /** Whether the existing runtime value representation/display is preserved. */
  readonly preservesInputRepresentation?: unknown;
}

export interface AnalysisProposalReport {
  readonly passed: boolean;
  readonly sourceId: string;
  readonly baselineId: string;
  readonly oracleId: string;
  readonly failures: readonly string[];
}

/** Judge the proposal contract itself; it does not execute proposed source. */
export function judgeAnalysisProposalMeaning(
  variant: AnalysisTaskContractName,
  proposal: ProposalMeaning,
): AnalysisProposalReport {
  const contract = ANALYSIS_TASK_CONTRACTS[variant];
  const failures: string[] = [];
  if (proposal.setting !== contract.setting) failures.push('proposal targets a different setting');
  const constraints = Array.isArray(proposal.constraints)
    ? new Set(proposal.constraints.filter((value): value is string => typeof value === 'string'))
    : new Set<string>();
  for (const required of contract.requiredConstraints) {
    if (!constraints.has(required)) failures.push(`proposal omits required behavior: ${required}`);
  }
  if (proposal.rejectsInvalidValues !== true) failures.push('proposal does not reject invalid configuration values');
  if (proposal.preservesInputRepresentation !== true) failures.push('proposal does not preserve the original input representation');
  return {
    passed: failures.length === 0,
    sourceId: contract.sourceId,
    baselineId: contract.baselineId,
    oracleId: contract.oracleId,
    failures,
  };
}

/** Independent truth-table utility for pure host-side static checks. */
export function evaluateAnalysisTaskVectors(
  variant: AnalysisTaskContractName,
  actual: unknown,
): boolean {
  const expected: readonly boolean[] = ANALYSIS_TASK_CONTRACTS[variant].expected;
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((value, index) => actual[index] === value);
}
