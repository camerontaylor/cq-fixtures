import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { executeProtectedJudgeChild } from '../../../runner/boundary/judge-child.js';
import { withProtectedCandidateSnapshot } from './protected-candidate-snapshot.js';

export const MERGE_ORIGIN_CONTRACT = {
  id: 'merge-origin-precedence-01',
  sourceId: 'cq-settings.merge-origin-precedence-seed.v1',
  baselineId: 'cq-settings.merge-origin-precedence.baseline.v1',
  oracleId: 'cq-settings.merge-origin-precedence.oracle.v1',
  substrateFamily: 'merge-source-precedence-v1',
  module: 'settings/origin-precedence.mjs',
  exportName: 'resolveCampaignSetting',
  requests: [
    ['https://env.example.test', 'https://file.example.test', 'https://builtin.example.test'],
    [null, 'https://file.example.test', 'https://builtin.example.test'],
    [null, null, 'https://builtin.example.test'],
  ],
  expected: [
    'https://env.example.test',
    'https://file.example.test',
    'https://builtin.example.test',
  ],
  allowedPaths: ['branch-intentions/feature.md', 'branch-intentions/main.md', 'settings/origin-precedence.mjs'],
} as const;

export const FLEET_TEST_UNIT_CONTRACT = {
  id: 'fleet-test-unit-repair-01',
  sourceId: 'cq-settings.fleet-test-unit-seed.v1',
  baselineId: 'cq-settings.fleet-test-unit.baseline.v1',
  oracleId: 'cq-settings.fleet-test-unit.oracle.v1',
  substrateFamily: 'fleet-test-helper-contract-v1',
  module: 'packages/settings/normalize-work-item.mjs',
  exportName: 'normalizeWorkItem',
  requests: [
    [null],
    [],
    [{ id: 'task-1', title: 'Repair setting' }],
    ['malformed'],
  ],
  expected: [
    { status: 'empty', value: '' },
    { status: 'empty', value: '' },
    { status: 'ready', value: { id: 'task-1', title: 'Repair setting' } },
    { status: 'invalid' },
  ],
  allowedPaths: [
    'packages/settings/normalize-work-item.mjs',
    'packages/settings/test/normalize-work-item.test.mjs',
  ],
} as const;

export interface IntegrationSemanticReport {
  readonly passed: boolean;
  readonly sourceId: string;
  readonly baselineId: string;
  readonly oracleId: string;
  readonly failures: readonly string[];
}

function equalJSON(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => equalJSON(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return equalJSON(leftKeys, rightKeys) && leftKeys.every((key) => equalJSON(leftRecord[key], rightRecord[key]));
}

export function judgeMergeOriginValues(actual: unknown): IntegrationSemanticReport {
  const failures: string[] = [];
  const values = MERGE_ORIGIN_CONTRACT.expected;
  if (!Array.isArray(actual) || actual.length !== values.length) {
    failures.push('candidate result count did not match the host precedence vectors');
  } else {
    values.forEach((expected, index) => {
      if (actual[index] !== expected) failures.push(`precedence vector ${index} returned the wrong source value`);
    });
  }
  return { ...MERGE_ORIGIN_CONTRACT, passed: failures.length === 0, failures };
}

export async function judgeMergeOriginCandidate(candidateRoot: string): Promise<IntegrationSemanticReport> {
  try {
    return await withProtectedCandidateSnapshot(candidateRoot, [MERGE_ORIGIN_CONTRACT.module], async (safeRoot) => {
    const result = await executeProtectedJudgeChild({
      candidateRoot: safeRoot,
      module: MERGE_ORIGIN_CONTRACT.module,
      exportName: MERGE_ORIGIN_CONTRACT.exportName,
      requests: MERGE_ORIGIN_CONTRACT.requests.map((request) => [...request]),
      timeoutMs: 5_000,
    });
    if (result.exitCode !== 0 || result.timedOut || !result.containerAbsentVerified) {
      return { ...judgeMergeOriginValues(null), failures: ['protected candidate execution did not complete cleanly'] };
    }
    return judgeMergeOriginValues(JSON.parse(result.stdout.toString('utf8')) as unknown);
    });
  } catch {
    return { ...judgeMergeOriginValues(null), failures: ['protected candidate execution unavailable'] };
  }
}

export function judgeFleetUnitValues(actual: unknown): IntegrationSemanticReport {
  const failures: string[] = [];
  const expected = FLEET_TEST_UNIT_CONTRACT.expected;
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    failures.push('candidate result count did not match the host helper vectors');
  } else {
    expected.forEach((value, index) => {
      if (!equalJSON(actual[index], value)) failures.push(`helper vector ${index} returned the wrong contract value`);
    });
  }
  return {
    passed: failures.length === 0,
    sourceId: FLEET_TEST_UNIT_CONTRACT.sourceId,
    baselineId: FLEET_TEST_UNIT_CONTRACT.baselineId,
    oracleId: FLEET_TEST_UNIT_CONTRACT.oracleId,
    failures,
  };
}

export async function judgeFleetUnitCandidate(candidateRoot: string): Promise<IntegrationSemanticReport> {
  try {
    return await withProtectedCandidateSnapshot(candidateRoot, [FLEET_TEST_UNIT_CONTRACT.module], async (safeRoot) => {
    const result = await executeProtectedJudgeChild({
      candidateRoot: safeRoot,
      module: FLEET_TEST_UNIT_CONTRACT.module,
      exportName: FLEET_TEST_UNIT_CONTRACT.exportName,
      requests: FLEET_TEST_UNIT_CONTRACT.requests.map((request) => [...request]),
      timeoutMs: 5_000,
    });
    if (result.exitCode !== 0 || result.timedOut || !result.containerAbsentVerified) {
      return { ...judgeFleetUnitValues(null), failures: ['protected candidate execution did not complete cleanly'] };
    }
    return judgeFleetUnitValues(JSON.parse(result.stdout.toString('utf8')) as unknown);
    });
  } catch {
    return { ...judgeFleetUnitValues(null), failures: ['protected candidate execution unavailable'] };
  }
}

/** Git identity/scope facts are checked on the host, separately from behavior. */
export function judgeLocalCandidateIdentity(input: {
  readonly repoRoot: string;
  readonly baselineCommit: string;
  readonly allowedPaths: readonly string[];
  readonly exactPaths?: boolean;
}): { readonly passed: boolean; readonly head: string; readonly patchSha256: string; readonly failures: readonly string[] } {
  const failures: string[] = [];
  try {
    const git = (args: string[]) => execFileSync('git', args, {
      cwd: input.repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim();
    const head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    execFileSync('git', ['merge-base', '--is-ancestor', input.baselineCommit, head], {
      cwd: input.repoRoot, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    const changed = git(['diff', '--name-only', `${input.baselineCommit}..${head}`, '--']).split('\n').filter(Boolean).sort();
    const allowed = [...input.allowedPaths].sort();
    const scopeMatches = input.exactPaths === false
      ? changed.length > 0 && changed.every((path) => allowed.includes(path))
      : equalJSON(changed, allowed);
    if (!scopeMatches) failures.push(input.exactPaths === false
      ? 'candidate changed paths outside its task allowlist or made no change'
      : 'candidate changed paths did not exactly match its task allowlist');
    if (!git(['status', '--porcelain', '--untracked-files=all']).trim().length) {
      // A clean tree is expected after a candidate commits its patch.
    } else failures.push('candidate worktree is not clean after its commit');
    const patch = execFileSync('git', ['diff', '--binary', `${input.baselineCommit}..${head}`, '--'], {
      cwd: input.repoRoot, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    return { passed: failures.length === 0, head, patchSha256: createHash('sha256').update(patch).digest('hex'), failures };
  } catch {
    return { passed: false, head: '', patchSha256: '', failures: ['candidate identity or scope could not be verified'] };
  }
}
