/** Validate the committed pin shape before any task factory reads dependency bytes. */
export const OPERATION_ORACLE_IDS = [
  'cq-settings.analysis-remediation.oracle.v1',
  'cq-settings.analysis-unicode-remediation.oracle.v1',
  'cq-settings.analysis-safe-integer-setting.oracle.v1',
  'cq-settings.analysis-origin-policy.oracle.v1',
  'cq-settings.ratchet-monotonicity.oracle.v1',
  'cq-settings.ratchet-coverage-monotonicity.oracle.v1',
  'cq-settings.review-role-scope.oracle.v1',
  'cq-settings.review-label-nfc.oracle.v1',
] as const;

export const OPERATION_ORACLE_PATHS = [
  'campaigns/cq-settings/corpus/operation-task-oracles.ts',
  'campaigns/cq-settings/corpus/operation-tasks.ts',
  'campaigns/cq-settings/corpus/protected-candidate-snapshot.ts',
  'campaigns/cq-settings/corpus/review-loop-task.ts',
  'campaigns/cq-settings/corpus/review-task-oracles.ts',
  'runner/boundary/broker-toolchain.ts',
  'runner/boundary/codex-final-profile.ts',
  'runner/boundary/container-prepare.ts',
  'runner/boundary/container.ts',
  'runner/boundary/docker-control.ts',
  'runner/boundary/egress-broker.ts',
  'runner/boundary/evidence/fallback/judge-ownership-source-closure.public.json',
  'runner/boundary/judge-child.ts',
  'runner/boundary/judge-ownership.ts',
  'runner/boundary/lifecycle-evidence.ts',
  'runner/boundary/namespace-acl.sh',
  'runner/boundary/subscription-auth.ts',
  'runner/boundary/task-session.ts',
  'runner/boundary/task-staging.ts',
  'runner/boundary/task-tree.ts',
  'runner/boundary/volume-io.mjs',
  'runner/workflow-corpus/operation-workflow-judges.ts',
  'runner/boundary/assignment-supervisor-owner.ts',
  'runner/boundary/g2-daemon-contract.ts',
  'campaigns/cq-settings/corpus/integration-task-oracles.ts',
  'campaigns/cq-settings/corpus/oracle-pin-contract.ts',
] as const;

export function validateOraclePinManifest(
  value: unknown,
  expected: { readonly kind: 'operation' | 'integration'; readonly ids: readonly string[]; readonly paths: readonly string[] },
): { readonly dependencies: readonly { readonly path: string; readonly sha256: string }[] } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`pinned ${expected.kind} oracle manifest is malformed`);
  }
  const record = value as Record<string, unknown>;
  const idKey = expected.kind === 'operation' ? 'taskOracleIds' : 'oracleIds';
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['dependencies', idKey, 'manifestVersion'].sort())
      || record.manifestVersion !== 1
      || !Array.isArray(record[idKey])
      || JSON.stringify(record[idKey]) !== JSON.stringify(expected.ids)
      || !Array.isArray(record.dependencies)
      || record.dependencies.length !== expected.paths.length) {
    throw new Error(`pinned ${expected.kind} oracle manifest contract changed`);
  }
  for (const [index, dependency] of record.dependencies.entries()) {
    if (dependency === null || typeof dependency !== 'object' || Array.isArray(dependency)) {
      throw new Error(`pinned ${expected.kind} oracle dependency is malformed at ${index}`);
    }
    const entry = dependency as Record<string, unknown>;
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['path', 'sha256'])
        || entry.path !== expected.paths[index]
        || typeof entry.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`pinned ${expected.kind} oracle dependency inventory changed at ${index}`);
    }
  }
  return record as { readonly dependencies: readonly { readonly path: string; readonly sha256: string }[] };
}
