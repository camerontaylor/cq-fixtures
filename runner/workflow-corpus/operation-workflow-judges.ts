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
for (let i = 0; i < values.length; i++) if (m.campaignLabel(values[i]) !== expected[i]) process.exitCode = 1;`;
    execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: repoRoot, stdio: 'pipe', timeout: 5_000, maxBuffer: 64 * 1024,
    });
  } catch (error) {
    failures.push(`merge candidate check failed: ${error instanceof Error ? error.message : String(error)}`);
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
export function judgeAnalysisRemediationProposal(value: unknown): WorkflowOracleReport {
  const failures: string[] = [];
  const output = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const summary = typeof output.summary === 'string' ? output.summary : '';
  const patch = typeof output.patch === 'string' ? output.patch : '';
  const describesFix = /empty|non-empty|blank/i.test(summary) && /reject|trim|empty|non-empty|blank/i.test(patch);
  if (!describesFix) failures.push('proposal does not describe and encode empty-setting validation');
  if (!patch.includes('src/settings.ts') && !patch.includes('validate')) failures.push('proposal does not anchor its change to settings validation');
  const identity = OPERATION_WORKFLOW_IDENTITIES.analyze;
  return { ...identity, passed: failures.length === 0, failures };
}

/** Checks both live ratchet behavior and monotonicity of candidate baseline edits. */
export function judgeRatchetOutcomes(input: {
  readonly tightened: string;
  readonly regressed: string;
  readonly tighteningDiff: string;
  readonly looseningDiff: string;
}): WorkflowOracleReport {
  const failures: string[] = [];
  if (input.tightened !== 'pass') failures.push('a lower error count did not pass the lower-is-better ratchet');
  if (input.regressed !== 'fail') failures.push('a higher error count did not fail the lower-is-better ratchet');
  if (!input.tighteningDiff.includes('ok: true')) failures.push('tightening baseline diff was not accepted');
  if (!input.looseningDiff.includes('ok: false')) failures.push('loosening baseline diff was not rejected');
  const identity = OPERATION_WORKFLOW_IDENTITIES.ratchet;
  return { ...identity, passed: failures.length === 0, failures };
}
