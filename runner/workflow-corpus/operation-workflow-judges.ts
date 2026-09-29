import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { executeProtectedJudgeChild } from '../boundary/judge-child.ts';
import { SAFE_GIT_CONFIG } from '../boundary/task-tree.ts';

export const OPERATION_WORKFLOW_IDENTITIES = {
  merge: { sourceId: 'cq-settings.merge-worktree-seed.v1', baselineId: 'cq-settings.merge-conflict.baseline.v1', oracleId: 'cq-settings.merge-label-limit.oracle.v1' },
  fleet: { sourceId: 'cq-settings.fleet-nested-package-seed.v1', baselineId: 'cq-settings.fleet-dirty-test.baseline.v1', oracleId: 'cq-settings.fleet-deepest-owner.oracle.v1' },
  testFix: { sourceId: 'cq-settings.testfix-scope-seed.v1', baselineId: 'cq-settings.testfix-broad-scope.baseline.v1', oracleId: 'cq-settings.testfix-scope-risk.oracle.v1' },
  analyze: { sourceId: 'cq-settings.analysis-setting-failures.v1', baselineId: 'cq-settings.analysis-duplicate-errors.baseline.v1', oracleId: 'cq-settings.analysis-remediation.oracle.v1' },
  ratchet: { sourceId: 'cq-settings.ratchet-metric-seed.v1', baselineId: 'cq-settings.ratchet-captured-metric.baseline.v1', oracleId: 'cq-settings.ratchet-monotonicity.oracle.v1' },
} as const;

export interface WorkflowOracleReport {
  readonly passed: boolean;
  readonly sourceId: string;
  readonly baselineId: string;
  readonly oracleId: string;
  readonly failures: readonly string[];
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Execute only candidate code in the protected namespace; stdout stays private and untrusted. */
async function protectedCandidateResults(
  candidateSource: string,
  module: string,
  exportName: string,
  requests: unknown[][],
): Promise<unknown[] | null> {
  let candidateRoot: string | undefined;
  try {
    // Isolate only the candidate module in a fresh safe Git root. This avoids
    // copying task-local Git config, prompts, and parent-side expected values.
    candidateRoot = await mkdtemp(join(tmpdir(), 'cq-protected-candidate-'));
    const candidatePath = join(candidateRoot, module);
    await mkdir(dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, candidateSource, { flag: 'wx', mode: 0o600 });
    execFileSync('git', ['init', '-q'], { cwd: candidateRoot, stdio: 'ignore' });
    await writeFile(join(candidateRoot, '.git/config'), SAFE_GIT_CONFIG, { mode: 0o600 });
    execFileSync('git', ['add', module], { cwd: candidateRoot, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=CQ Protected Judge', '-c', 'user.email=cq-protected-judge@example.invalid', 'commit', '-q', '-m', 'Candidate snapshot'], { cwd: candidateRoot, stdio: 'ignore' });
    const result = await executeProtectedJudgeChild({ candidateRoot, module, exportName, requests, timeoutMs: 5_000 });
    if (result.scope !== 'protected-candidate-execution' || !result.containerAbsentVerified || result.timedOut || result.exitCode !== 0) return null;
    const output: unknown = JSON.parse(result.stdout.toString('utf8'));
    return Array.isArray(output) && output.length === requests.length ? output : null;
  } catch {
    // Do not place untrusted stdout or executor diagnostics into report/model-visible text.
    return null;
  } finally {
    if (candidateRoot !== undefined) await rm(candidateRoot, { recursive: true, force: true });
  }
}

/** Independent behavior/scope check for a locally committed conflict repair. */
export interface MergeConflictContract {
  readonly sourceId: string;
  readonly baselineId: string;
  readonly oracleId: string;
  readonly examples: readonly { readonly input: unknown; readonly expected: string }[];
}

const DEFAULT_MERGE_CONTRACT: MergeConflictContract = {
  ...OPERATION_WORKFLOW_IDENTITIES.merge,
  examples: [
    { input: null, expected: '' }, { input: 7, expected: '' }, { input: '', expected: '' },
    { input: '  ', expected: '' }, { input: '😀'.repeat(40), expected: '😀'.repeat(40) },
    { input: '😀'.repeat(41), expected: '' }, { input: 'x'.repeat(39), expected: 'x'.repeat(39) },
  ],
};

export async function judgeMergeConflictWorkspace(
  repoRoot: string,
  baselineCommit: string,
  contract: MergeConflictContract = DEFAULT_MERGE_CONTRACT,
): Promise<WorkflowOracleReport> {
  const failures: string[] = [];
  try {
    const head = git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    if (head === baselineCommit) failures.push('candidate did not create a new commit');
    if (git(repoRoot, ['merge-base', '--is-ancestor', baselineCommit, 'HEAD']) === '') {
      // `git merge-base --is-ancestor` normally has empty stdout; successful exit is the assertion.
    }
    const changed = git(repoRoot, ['diff', '--name-only', `${baselineCommit}..HEAD`, '--']).trim().split('\n').filter(Boolean).sort();
    if (JSON.stringify(changed) !== JSON.stringify(['src/settings.mjs'])) failures.push(`unexpected candidate paths: ${changed.join(',')}`);
    const candidateSource = await readFile(join(repoRoot, 'src/settings.mjs'), 'utf8');
    const actual = await protectedCandidateResults(candidateSource, 'src/settings.mjs', 'campaignLabel', contract.examples.map(({ input }) => [input]));
    if (actual === null) failures.push('protected merge candidate probe failed or returned an invalid bounded result');
    else if (contract.examples.some(({ expected }, index) => actual[index] !== expected)) failures.push('merge candidate failed an independent behavior case');
  } catch {
    failures.push('merge candidate identity or protected behavior check failed');
  }
  const identity = contract;
  return { ...identity, passed: failures.length === 0, failures };
}

/** Host oracle for deepest-owner selection from the captured Git change set. */
export function judgeFleetSweepPlan(
  report: { readonly units?: readonly { readonly package: string; readonly files: readonly string[] }[] },
  changedPaths: readonly string[],
  contract: {
    readonly sourceId: string;
    readonly baselineId: string;
    readonly oracleId: string;
    readonly expectedPackage: string;
    readonly expectedPaths: readonly string[];
  } = { ...OPERATION_WORKFLOW_IDENTITIES.fleet, expectedPackage: 'core-tests', expectedPaths: ['packages/core/test/settings.test.ts'] },
): WorkflowOracleReport {
  const failures: string[] = [];
  const expected = [...contract.expectedPaths].sort();
  if (JSON.stringify([...changedPaths].sort()) !== JSON.stringify(expected)) failures.push('pinned changed-file substrate drifted');
  const units = report.units ?? [];
  if (units.length !== 1 || units[0]?.package !== contract.expectedPackage || JSON.stringify([...(units[0]?.files ?? [])].sort()) !== JSON.stringify(expected)) {
    failures.push('sweep plan did not choose the deepest package owner for the changed test');
  }
  return { sourceId: contract.sourceId, baselineId: contract.baselineId, oracleId: contract.oracleId, passed: failures.length === 0, failures };
}

/** Detects the selected test-fix builder's current package-wide staging leak. */
export function judgeTestFixScopePlan(serializedPlan: string): WorkflowOracleReport {
  const failures: string[] = [];
  const expectedRisk = serializedPlan.includes('^packages/settings/');
  if (!expectedRisk) failures.push('the pinned broad-scope fault was not reproduced');
  if (!serializedPlan.includes('test/settings.test.ts')) failures.push('test-fix plan lost its test-file task');
  if (!serializedPlan.includes('src/settings.ts')) failures.push('test-fix plan no longer exposes the product-source scope leak');
  // passed means the host check independently surfaced the unsafe plan so an executor can refuse it.
  const identity = OPERATION_WORKFLOW_IDENTITIES.testFix;
  return { ...identity, passed: failures.length === 0, failures };
}

/** Independent semantic check for a remediation proposal that addresses the clustered defect. */
export interface AnalysisBehaviorContract {
  readonly sourceId: string;
  readonly baselineId: string;
  readonly oracleId: string;
  readonly examples: readonly { readonly input: unknown; readonly expected: boolean }[];
}

const EMPTY_SETTING_CONTRACT: AnalysisBehaviorContract = {
  ...OPERATION_WORKFLOW_IDENTITIES.analyze,
  examples: [
    { input: '', expected: false },
    { input: '   ', expected: false },
    { input: 'setting', expected: true },
    { input: null, expected: false },
  ],
};

const LABEL_LENGTH_CONTRACT: AnalysisBehaviorContract = {
  sourceId: 'cq-settings.analysis-unicode-label-seed.v1',
  baselineId: 'cq-settings.analysis-unicode-limit.baseline.v1',
  oracleId: 'cq-settings.analysis-unicode-remediation.oracle.v1',
  examples: [
    { input: 'A'.repeat(40), expected: true },
    { input: '😀'.repeat(40), expected: true },
    { input: '😀'.repeat(41), expected: false },
    { input: '  Campaign  ', expected: true },
    { input: '', expected: false },
  ],
};

/** Independently probes proposed source behavior; multiple valid implementations pass. */
export async function judgeAnalysisRemediationProposal(
  value: unknown,
  contract: AnalysisBehaviorContract = EMPTY_SETTING_CONTRACT,
): Promise<WorkflowOracleReport> {
  const failures: string[] = [];
  const output = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const summary = typeof output.summary === 'string' ? output.summary : '';
  const patch = typeof output.patch === 'string' ? output.patch : '';
  const candidateSource = typeof output.candidateSource === 'string' ? output.candidateSource : '';
  if (summary.trim().length === 0 || patch.trim().length === 0) failures.push('proposal must explain and locate its remediation');
  if (!patch.includes('src/settings.ts') && !patch.includes('validate')) failures.push('proposal does not anchor its change to settings validation');
  if (candidateSource.length === 0 || candidateSource.length > 32 * 1024) {
    failures.push('proposal candidate source is missing or exceeds the bounded judge limit');
  } else {
    try {
      const actual = await protectedCandidateResults(candidateSource, 'candidate.mjs', 'isValidSetting', contract.examples.map(({ input }) => [input]));
      if (actual === null) failures.push('protected remediation probe failed or returned an invalid bounded result');
      else if (contract.examples.some(({ expected }, index) => actual[index] !== expected)) failures.push('remediation candidate failed an independent behavior case');
    } catch {
      failures.push('protected remediation candidate snapshot could not be evaluated');
    }
  }
  return { sourceId: contract.sourceId, baselineId: contract.baselineId, oracleId: contract.oracleId, passed: failures.length === 0, failures };
}

export const ANALYSIS_REMEDIATION_CONTRACTS = {
  emptySetting: EMPTY_SETTING_CONTRACT,
  unicodeLabelLength: LABEL_LENGTH_CONTRACT,
} as const;

/** Checks both live ratchet behavior and monotonicity of candidate baseline edits. */
export function judgeRatchetOutcomes(input: {
  readonly tightened: string;
  readonly regressed: string;
  readonly tighteningAccepted: boolean;
  readonly looseningAccepted: boolean;
  readonly direction?: 'lower-is-better' | 'higher-is-better';
  readonly sourceId?: string;
  readonly baselineId?: string;
  readonly oracleId?: string;
  readonly initialValue?: number;
  readonly improvedValue?: number;
  readonly regressedValue?: number;
}): WorkflowOracleReport {
  const failures: string[] = [];
  const direction = input.direction ?? 'lower-is-better';
  if (input.tightened !== 'pass') failures.push(`an improving metric did not pass the ${direction} ratchet`);
  if (input.regressed !== 'fail') failures.push(`a regressing metric did not fail the ${direction} ratchet`);
  if (!input.tighteningAccepted) failures.push('tightening baseline diff was not accepted');
  if (input.looseningAccepted) failures.push('loosening baseline diff was accepted');
  if (input.initialValue !== undefined && input.improvedValue !== undefined && input.regressedValue !== undefined) {
    const valuesMatchDirection = direction === 'lower-is-better'
      ? input.improvedValue < input.initialValue && input.regressedValue > input.initialValue
      : input.improvedValue > input.initialValue && input.regressedValue < input.initialValue;
    if (!valuesMatchDirection) failures.push(`task values do not represent improvement and regression for ${direction}`);
  }
  const identity = {
    ...OPERATION_WORKFLOW_IDENTITIES.ratchet,
    ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
    ...(input.baselineId === undefined ? {} : { baselineId: input.baselineId }),
    ...(input.oracleId === undefined ? {} : { oracleId: input.oracleId }),
  };
  return { ...identity, passed: failures.length === 0, failures };
}
