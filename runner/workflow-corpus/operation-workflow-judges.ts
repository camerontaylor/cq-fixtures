import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

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

/** Independent behavior/scope check for a locally committed conflict repair. */
export function judgeMergeConflictWorkspace(repoRoot: string, baselineCommit: string): WorkflowOracleReport {
  const failures: string[] = [];
  try {
    const head = git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    if (head === baselineCommit) failures.push('candidate did not create a new commit');
    if (git(repoRoot, ['merge-base', '--is-ancestor', baselineCommit, 'HEAD']) === '') {
      // `git merge-base --is-ancestor` normally has empty stdout; successful exit is the assertion.
    }
    const changed = git(repoRoot, ['diff', '--name-only', `${baselineCommit}..HEAD`, '--']).trim().split('\n').filter(Boolean).sort();
    if (JSON.stringify(changed) !== JSON.stringify(['src/settings.mjs'])) failures.push(`unexpected candidate paths: ${changed.join(',')}`);
    const moduleUrl = pathToFileURL(join(repoRoot, 'src/settings.mjs')).href;
    const probe = `const m = await import(${JSON.stringify(moduleUrl)} + '?judge=' + Date.now());
const values = [null, 7, '', '  ', '😀'.repeat(40), '😀'.repeat(41), 'x'.repeat(39)];
const expected = ['', '', '', '', '😀'.repeat(40), '', 'x'.repeat(39)];
const actual = values.map((value) => m.campaignLabel(value));
if (actual.some((value, index) => value !== expected[index])) {
  console.error(JSON.stringify({ actual, expected }));
  process.exitCode = 1;
}`;
    execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: repoRoot, stdio: 'pipe', timeout: 5_000, maxBuffer: 64 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const stderr = error !== null && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '').trim()
      : '';
    failures.push(`merge candidate check failed: ${detail}${stderr.length > 0 ? `; stderr: ${stderr}` : ''}`);
  }
  const identity = OPERATION_WORKFLOW_IDENTITIES.merge;
  return { ...identity, passed: failures.length === 0, failures };
}

/** Host oracle for deepest-owner selection from the captured Git change set. */
export function judgeFleetSweepPlan(
  report: { readonly units?: readonly { readonly package: string; readonly files: readonly string[] }[] },
  changedPaths: readonly string[],
): WorkflowOracleReport {
  const failures: string[] = [];
  const expected = ['packages/core/test/settings.test.ts'];
  if (JSON.stringify([...changedPaths].sort()) !== JSON.stringify(expected)) failures.push('pinned changed-file substrate drifted');
  const units = report.units ?? [];
  if (units.length !== 1 || units[0]?.package !== 'core-tests' || JSON.stringify(units[0]?.files) !== JSON.stringify(expected)) {
    failures.push('sweep plan did not choose the deepest package owner for the changed test');
  }
  const identity = OPERATION_WORKFLOW_IDENTITIES.fleet;
  return { ...identity, passed: failures.length === 0, failures };
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
export function judgeAnalysisRemediationProposal(
  value: unknown,
  contract: AnalysisBehaviorContract = EMPTY_SETTING_CONTRACT,
): WorkflowOracleReport {
  const failures: string[] = [];
  const output = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const summary = typeof output.summary === 'string' ? output.summary : '';
  const patch = typeof output.patch === 'string' ? output.patch : '';
  const candidateSource = typeof output.candidateSource === 'string' ? output.candidateSource : '';
  if (summary.trim().length === 0 || patch.trim().length === 0) failures.push('proposal must explain and locate its remediation');
  if (!patch.includes('src/settings.ts') && !patch.includes('validate')) failures.push('proposal does not anchor its change to settings validation');
  if (candidateSource.length === 0 || candidateSource.length > 32 * 1024) {
    failures.push('proposal candidate source is missing or exceeds the host judge limit');
  } else {
    const examples = JSON.stringify(contract.examples);
    const probe = `const source = Buffer.from(process.env.CQ_REMEDIATION_SOURCE ?? '', 'base64').toString('utf8');
const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const check = typeof module.isValidSetting === 'function' ? module.isValidSetting : null;
const cases = ${examples};
if (!check || cases.some(({ input, expected }) => check(input) !== expected)) process.exitCode = 1;`;
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
        env: { ...process.env, CQ_REMEDIATION_SOURCE: Buffer.from(candidateSource).toString('base64') },
        stdio: 'pipe', timeout: 5_000, maxBuffer: 64 * 1024,
      });
    } catch (error) {
      failures.push(`remediation candidate failed bounded behavior checks: ${error instanceof Error ? error.message : String(error)}`);
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
