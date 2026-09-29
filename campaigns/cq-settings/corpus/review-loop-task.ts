import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeFixReviewItem,
  type Driver,
  type FixReviewItemInput,
  type FixReviewItemResult,
  type ModelSpec,
  type OpResult,
} from '@camerontaylor/cq-toolkit';

export const REVIEW_LOOP_TASK_ID = 'review-loop-label-limit-02' as const;
export const REVIEW_LOOP_SOURCE_ID = 'cq-settings.settings-module-seed.v2' as const;
export const REVIEW_LOOP_BASELINE_ID = 'cq-settings.label-length-defect.baseline.v2' as const;
export const REVIEW_LOOP_ORACLE_ID = 'cq-settings.label-length-unicode.oracle.v2' as const;

/** A worker-visible repair task; it intentionally contains no judge data. */
export interface ReviewLoopRepairTask {
  readonly id: typeof REVIEW_LOOP_TASK_ID;
  readonly sourceId: typeof REVIEW_LOOP_SOURCE_ID;
  readonly baselineId: typeof REVIEW_LOOP_BASELINE_ID;
  readonly oracleId: typeof REVIEW_LOOP_ORACLE_ID;
  readonly substrateFamily: 'campaign-settings-module-v2';
  readonly worktreePath: string;
  readonly baselineCommit: string;
  readonly modelSpec: ModelSpec;
  readonly operationInput: FixReviewItemInput;
  cleanup(): Promise<void>;
}

const INITIAL_SETTINGS_SOURCE = `export function isValidCampaignLabel(label) {
  return typeof label === 'string' && label.trim().length > 0;
}
`;

const DISPLAY_SOURCE = `export function displayCampaignLabel(label) {
  return label;
}
`;

const PUBLIC_TEST_SOURCE = `import assert from 'node:assert/strict';
import { isValidCampaignLabel } from '../settings/module.js';
import { displayCampaignLabel } from '../settings/display.js';

assert.equal(isValidCampaignLabel(''), false);
assert.equal(isValidCampaignLabel('   '), false);
assert.equal(isValidCampaignLabel('Campaign A'), true);
assert.equal(isValidCampaignLabel('x'.repeat(41)), false);
assert.equal(displayCampaignLabel('  Campaign A  '), '  Campaign A  ');
`;

/**
 * Materialize a fresh, real Git repository for the review-fix operation.
 * Only task context and visible regression tests are placed in the worktree.
 */
export async function createReviewLoopRepairTask(
  modelSpec: ModelSpec,
  parentDirectory = tmpdir(),
): Promise<ReviewLoopRepairTask> {
  const taskRoot = await mkdtemp(join(parentDirectory, 'cq-review-task-'));
  const worktreePath = join(taskRoot, 'repo');
  await mkdir(join(worktreePath, 'settings'), { recursive: true });
  await mkdir(join(worktreePath, 'test'), { recursive: true });
  await writeFile(join(worktreePath, 'package.json'), JSON.stringify({
    name: 'local-campaign-settings-task',
    private: true,
    type: 'module',
    scripts: { test: 'node test/public-settings.test.mjs' },
  }, null, 2) + '\n');
  await writeFile(join(worktreePath, 'settings/module.js'), INITIAL_SETTINGS_SOURCE);
  await writeFile(join(worktreePath, 'settings/display.js'), DISPLAY_SOURCE);
  await writeFile(join(worktreePath, 'test/public-settings.test.mjs'), PUBLIC_TEST_SOURCE);

  const git = (args: string[]): string => execFileSync('git', args, {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'CQ Local Corpus']);
  git(['config', 'user.email', 'cq-local-corpus@example.invalid']);
  git(['add', 'package.json', 'settings/module.js', 'settings/display.js', 'test/public-settings.test.mjs']);
  git(['commit', '-q', '-m', 'Seed campaign label validation defect']);
  const baselineCommit = git(['rev-parse', 'HEAD']);

  const operationInput: FixReviewItemInput = {
    repo: 'local/cq-settings',
    pr: 1,
    item: {
      id: 'review-local-label-length',
      path: 'settings/module.js',
      line: 2,
      body: 'Campaign labels are limited to 40 Unicode code points after trimming. Reject longer labels. Preserve the original label for display; do not change settings/display.js.',
      comments: [],
    },
    worktree: { path: worktreePath, branch: 'review/fix-label-limit' },
    driver: { ...modelSpec },
  };

  return {
    id: REVIEW_LOOP_TASK_ID,
    sourceId: REVIEW_LOOP_SOURCE_ID,
    baselineId: REVIEW_LOOP_BASELINE_ID,
    oracleId: REVIEW_LOOP_ORACLE_ID,
    substrateFamily: 'campaign-settings-module-v2',
    worktreePath,
    baselineCommit,
    modelSpec: { ...modelSpec },
    operationInput,
    async cleanup() {
      await rm(taskRoot, { recursive: true, force: true });
    },
  };
}

/** Dispatch the task through the selected toolkit's exported review op. */
export function executeReviewLoopRepairTask(
  task: ReviewLoopRepairTask,
  driver: Driver,
): Promise<OpResult<FixReviewItemResult>> {
  return makeFixReviewItem({ driver })(task.operationInput);
}
