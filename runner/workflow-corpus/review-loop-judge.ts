import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REVIEW_LOOP_BASELINE_ID,
  REVIEW_LOOP_ORACLE_ID,
  REVIEW_LOOP_SOURCE_ID,
  REVIEW_LOOP_TASK_ID,
  type ReviewLoopRepairTask,
} from '../../campaigns/cq-settings/corpus/review-loop-task.ts';

export const REVIEW_LOOP_JUDGE_VERSION = REVIEW_LOOP_ORACLE_ID;
export const REVIEW_LOOP_MODULE_PROBE_TIMEOUT_MS = 5_000;
export const REVIEW_LOOP_VISIBLE_TEST_TIMEOUT_MS = 10_000;

export interface ReviewLoopWorkspaceOptions {
  readonly baselineRef: string;
  readonly sourceId: typeof REVIEW_LOOP_SOURCE_ID;
  readonly baselineId: typeof REVIEW_LOOP_BASELINE_ID;
  readonly oracleId: typeof REVIEW_LOOP_ORACLE_ID;
}

export interface ReviewLoopConformance {
  readonly passed: boolean;
  readonly behavior: { readonly passed: boolean; readonly failures: readonly string[] };
  readonly displayPreservation: { readonly passed: boolean; readonly failures: readonly string[] };
  readonly visibleTests: { readonly passed: boolean; readonly detail?: string };
  readonly sourceTestAllowlist: {
    readonly passed: boolean;
    readonly changedPaths: readonly string[];
    readonly unexpectedPaths: readonly string[];
  };
  /** SHA256 of this candidate's actual binary Git patch, never a reference solution hash. */
  readonly candidatePatchSha256: string | null;
}

export interface ReviewLoopCandidateIdentity {
  readonly passed: boolean;
  readonly taskId: typeof REVIEW_LOOP_TASK_ID;
  readonly sourceId: typeof REVIEW_LOOP_SOURCE_ID;
  readonly baselineId: typeof REVIEW_LOOP_BASELINE_ID;
  readonly oracleId: typeof REVIEW_LOOP_ORACLE_ID;
  readonly baselineCommit: string;
  readonly candidateCommit: string | null;
  readonly cleanGitCandidate: boolean;
  /** Identifies the captured candidate independently of whether it conforms. */
  readonly candidatePatchSha256: string | null;
  readonly failures: readonly string[];
}

export interface ReviewLoopJudgeReport {
  readonly passed: boolean;
  readonly identity: ReviewLoopCandidateIdentity;
  readonly conformance: ReviewLoopConformance;
}

const ALLOWED_CHANGED_PATHS = ['src/settings.mjs'] as const;
const BUGGY_BASELINE_SETTINGS = `export function isValidCampaignLabel(label) {
  return typeof label === 'string' && label.trim().length > 0;
}
`;
const EXPECTED_DISPLAY_SOURCE = `export function displayCampaignLabel(label) {
  return label;
}
`;
const EXPECTED_PACKAGE_SOURCE = `${JSON.stringify({
  name: 'local-campaign-settings-task',
  private: true,
  type: 'module',
  scripts: { test: 'node test/public-settings.test.mjs' },
}, null, 2)}\n`;
const EXPECTED_PUBLIC_TEST_SOURCE = `import assert from 'node:assert/strict';
import { isValidCampaignLabel } from '../src/settings.mjs';
import { displayCampaignLabel } from '../src/display.mjs';

assert.equal(isValidCampaignLabel(''), false);
assert.equal(isValidCampaignLabel('   '), false);
assert.equal(isValidCampaignLabel('Campaign A'), true);
assert.equal(isValidCampaignLabel('x'.repeat(41)), false);
assert.equal(displayCampaignLabel('  Campaign A  '), '  Campaign A  ');
`;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function readBaselineFile(worktreePath: string, baselineRef: string, path: string): string {
  return git(worktreePath, ['show', `${baselineRef}:${path}`]);
}

function sortedPaths(text: string): string[] {
  return [...new Set(text.split('\0').filter(Boolean))].sort();
}

function patchDigest(worktreePath: string, baselineRef: string): string | null {
  try {
    const patch = execFileSync('git', ['diff', '--binary', '--no-ext-diff', baselineRef, '--'], {
      cwd: worktreePath,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return createHash('sha256').update(patch).digest('hex');
  } catch {
    return null;
  }
}

function getChangedPaths(worktreePath: string, baselineRef: string): string[] {
  const tracked = git(worktreePath, ['diff', '--name-only', '-z', baselineRef, '--']);
  const untracked = git(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...sortedPaths(tracked), ...sortedPaths(untracked)])].sort();
}

function checkBaselineIdentity(
  worktreePath: string,
  options: ReviewLoopWorkspaceOptions,
): string[] {
  const failures: string[] = [];
  if (
    options.sourceId !== REVIEW_LOOP_SOURCE_ID ||
    options.baselineId !== REVIEW_LOOP_BASELINE_ID ||
    options.oracleId !== REVIEW_LOOP_ORACLE_ID
  ) failures.push('task source, baseline, or oracle identity does not match the immutable review task IDs');
  try {
    if (readBaselineFile(worktreePath, options.baselineRef, 'src/settings.mjs') !== BUGGY_BASELINE_SETTINGS) {
      failures.push('referenced baseline source does not match the seeded label-length defect');
    }
    if (readBaselineFile(worktreePath, options.baselineRef, 'package.json') !== EXPECTED_PACKAGE_SOURCE) {
      failures.push('referenced baseline package manifest does not match the pinned task substrate');
    }
    if (readBaselineFile(worktreePath, options.baselineRef, 'src/display.mjs') !== EXPECTED_DISPLAY_SOURCE) {
      failures.push('referenced baseline display source does not match the pinned task substrate');
    }
    if (readBaselineFile(worktreePath, options.baselineRef, 'test/public-settings.test.mjs') !== EXPECTED_PUBLIC_TEST_SOURCE) {
      failures.push('referenced baseline visible tests do not match the pinned task substrate');
    }
  } catch (error) {
    failures.push(`could not read pinned task baseline: ${error instanceof Error ? error.message : String(error)}`);
  }
  return failures;
}

/**
 * Host-side semantic and scope oracle for either a committed candidate or a
 * runSuite workspace. It accepts any implementation satisfying the contract;
 * the patch digest records the candidate bytes without requiring a reference
 * implementation to match byte-for-byte.
 */
export async function judgeReviewLoopWorkspace(
  worktreePath: string,
  options: ReviewLoopWorkspaceOptions,
): Promise<ReviewLoopConformance> {
  const behaviorFailures: string[] = [];
  const displayFailures: string[] = [];
  const baselineFailures = checkBaselineIdentity(worktreePath, options);
  behaviorFailures.push(...baselineFailures);

  const cases: ReadonlyArray<{ label: unknown; expected: boolean; name: string }> = [
    { label: null, expected: false, name: 'non-string null' },
    { label: 7, expected: false, name: 'non-string number' },
    { label: '', expected: false, name: 'empty string' },
    { label: ' \t\n', expected: false, name: 'whitespace-only string' },
    { label: 'Campaign A', expected: true, name: 'ordinary valid label' },
    { label: '\u2003Campaign\u2003', expected: true, name: 'unicode-trimmed valid label' },
    { label: 'x'.repeat(40), expected: true, name: '40 ASCII code points' },
    { label: 'x'.repeat(41), expected: false, name: '41 ASCII code points' },
    { label: '😀'.repeat(40), expected: true, name: '40 astral Unicode code points' },
    { label: '😀'.repeat(41), expected: false, name: '41 astral Unicode code points' },
    { label: 'e\u0301'.repeat(20), expected: true, name: '40 combining-sequence code points' },
    { label: 'e\u0301'.repeat(21), expected: false, name: '42 combining-sequence code points' },
  ];
  const candidateSettingsUrl = pathToFileURL(join(worktreePath, 'src/settings.mjs')).href;
  const candidateDisplayUrl = pathToFileURL(join(worktreePath, 'src/display.mjs')).href;
  const moduleProbe = `
const behaviorFailures = [];
const displayFailures = [];
let settings;
let display;
try {
  const nonce = 'judge=' + Date.now() + '-' + Math.random();
  settings = await import(${JSON.stringify(candidateSettingsUrl)} + '?' + nonce);
  display = await import(${JSON.stringify(candidateDisplayUrl)} + '?' + nonce);
} catch (error) {
  behaviorFailures.push('candidate modules could not be loaded: ' + String(error?.message ?? error));
}
if (settings !== undefined) {
  for (const testCase of ${JSON.stringify(cases)}) {
    try {
      if (settings.isValidCampaignLabel(testCase.label) !== testCase.expected) behaviorFailures.push('semantic case failed: ' + testCase.name);
    } catch (error) {
      behaviorFailures.push('semantic case threw (' + testCase.name + '): ' + String(error?.message ?? error));
    }
  }
}
if (display !== undefined) {
  for (const label of ['  Campaign A  ', '\\u2003😀 label  ']) {
    try {
      if (display.displayCampaignLabel(label) !== label) displayFailures.push('display changed original label ' + JSON.stringify(label));
    } catch (error) {
      displayFailures.push('display threw for ' + JSON.stringify(label) + ': ' + String(error?.message ?? error));
    }
  }
}
process.stdout.write(JSON.stringify({ behaviorFailures, displayFailures }));
`;
  try {
    const probeOutput = execFileSync(process.execPath, ['--input-type=module', '-e', moduleProbe], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: REVIEW_LOOP_MODULE_PROBE_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    const probe = JSON.parse(probeOutput) as { behaviorFailures: string[]; displayFailures: string[] };
    behaviorFailures.push(...probe.behaviorFailures);
    displayFailures.push(...probe.displayFailures);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    behaviorFailures.push(`bounded candidate module probe failed: ${detail.slice(0, 500)}`);
  }

  let visibleTests: ReviewLoopConformance['visibleTests'];
  try {
    execFileSync(process.execPath, ['test/public-settings.test.mjs'], {
      cwd: worktreePath,
      stdio: 'pipe',
      timeout: REVIEW_LOOP_VISIBLE_TEST_TIMEOUT_MS,
    });
    visibleTests = { passed: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    visibleTests = { passed: false, detail: detail.slice(0, 500) };
  }

  let changedPaths: string[] = [];
  let unexpectedPaths: string[] = [];
  try {
    changedPaths = getChangedPaths(worktreePath, options.baselineRef);
    unexpectedPaths = changedPaths.filter((path) => !(ALLOWED_CHANGED_PATHS as readonly string[]).includes(path));
  } catch (error) {
    unexpectedPaths = [`git scope inspection failed: ${error instanceof Error ? error.message : String(error)}`];
  }
  const sourceTestAllowlist = {
    passed: changedPaths.length === 1 && changedPaths[0] === ALLOWED_CHANGED_PATHS[0] && unexpectedPaths.length === 0,
    changedPaths,
    unexpectedPaths,
  };

  const behavior = { passed: behaviorFailures.length === 0, failures: behaviorFailures };
  const displayPreservation = { passed: displayFailures.length === 0, failures: displayFailures };
  const candidatePatchSha256 = patchDigest(worktreePath, options.baselineRef);
  return {
    passed: behavior.passed && displayPreservation.passed && visibleTests.passed && sourceTestAllowlist.passed,
    behavior,
    displayPreservation,
    visibleTests,
    sourceTestAllowlist,
    candidatePatchSha256,
  };
}

/** Full task identity and correctness judgement for a committed operation candidate. */
export async function judgeReviewLoopRepairTask(task: ReviewLoopRepairTask): Promise<ReviewLoopJudgeReport> {
  const identityFailures: string[] = [];
  const candidateCommit = (() => {
    try {
      return git(task.worktreePath, ['rev-parse', 'HEAD']).trim();
    } catch {
      return null;
    }
  })();
  if (task.id !== REVIEW_LOOP_TASK_ID) identityFailures.push('task id differs from the immutable review task id');
  if (task.sourceId !== REVIEW_LOOP_SOURCE_ID) identityFailures.push('source id differs from the immutable review source id');
  if (task.baselineId !== REVIEW_LOOP_BASELINE_ID) identityFailures.push('baseline id differs from the immutable review baseline id');
  if (task.oracleId !== REVIEW_LOOP_ORACLE_ID) identityFailures.push('oracle id differs from the immutable review oracle id');
  if (candidateCommit === null || !/^[0-9a-f]{40}$/.test(candidateCommit)) {
    identityFailures.push('candidate HEAD is absent or is not a full Git commit identity');
  }
  if (candidateCommit === task.baselineCommit) identityFailures.push('candidate HEAD is still the pristine baseline');
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', task.baselineCommit, 'HEAD'], {
      cwd: task.worktreePath,
      stdio: 'ignore',
    });
  } catch {
    identityFailures.push('recorded baseline commit is not an ancestor of the candidate');
  }
  const cleanGitCandidate = (() => {
    try {
      return git(task.worktreePath, ['status', '--porcelain', '--untracked-files=all']).trim() === '';
    } catch {
      return false;
    }
  })();
  if (!cleanGitCandidate) identityFailures.push('candidate has uncommitted or untracked repository changes');
  const candidatePatchSha256 = patchDigest(task.worktreePath, task.baselineCommit);
  if (candidatePatchSha256 === null) identityFailures.push('candidate patch bytes could not be captured');

  const identity: ReviewLoopCandidateIdentity = {
    passed: identityFailures.length === 0,
    taskId: task.id,
    sourceId: task.sourceId,
    baselineId: task.baselineId,
    oracleId: task.oracleId,
    baselineCommit: task.baselineCommit,
    candidateCommit,
    cleanGitCandidate,
    candidatePatchSha256,
    failures: identityFailures,
  };
  const conformance = await judgeReviewLoopWorkspace(task.worktreePath, {
    baselineRef: task.baselineCommit,
    sourceId: task.sourceId,
    baselineId: task.baselineId,
    oracleId: task.oracleId,
  });
  return { passed: identity.passed && conformance.passed, identity, conformance };
}
