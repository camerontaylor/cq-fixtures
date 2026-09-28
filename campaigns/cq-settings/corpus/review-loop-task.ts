import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeFixReviewItem,
  type Driver,
  type FixReviewItemInput,
  type FixReviewItemResult,
  type OpResult,
} from '@camerontaylor/cq-toolkit';

/** A worker-visible repair task; it intentionally contains no judge data. */
export interface ReviewLoopRepairTask {
  readonly id: 'review-loop-label-limit-01';
  readonly substrateFamily: 'campaign-settings-module-v1';
  readonly worktreePath: string;
  readonly baselineCommit: string;
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
import { isValidCampaignLabel } from '../src/settings.mjs';
import { displayCampaignLabel } from '../src/display.mjs';

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
export async function createReviewLoopRepairTask(parentDirectory = tmpdir()): Promise<ReviewLoopRepairTask> {
  const taskRoot = await mkdtemp(join(parentDirectory, 'cq-review-task-'));
  const worktreePath = join(taskRoot, 'repo');
  await mkdir(join(worktreePath, 'src'), { recursive: true });
  await mkdir(join(worktreePath, 'test'), { recursive: true });
  await writeFile(join(worktreePath, 'package.json'), JSON.stringify({
    name: 'local-campaign-settings-task',
    private: true,
    type: 'module',
    scripts: { test: 'node test/public-settings.test.mjs' },
  }, null, 2) + '\n');
  await writeFile(join(worktreePath, 'src/settings.mjs'), INITIAL_SETTINGS_SOURCE);
  await writeFile(join(worktreePath, 'src/display.mjs'), DISPLAY_SOURCE);
  await writeFile(join(worktreePath, 'test/public-settings.test.mjs'), PUBLIC_TEST_SOURCE);

  const git = (args: string[]): string => execFileSync('git', args, {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'CQ Local Corpus']);
  git(['config', 'user.email', 'cq-local-corpus@example.invalid']);
  git(['add', 'package.json', 'src/settings.mjs', 'src/display.mjs', 'test/public-settings.test.mjs']);
  git(['commit', '-q', '-m', 'Seed campaign label validation defect']);
  const baselineCommit = git(['rev-parse', 'HEAD']);

  const operationInput: FixReviewItemInput = {
    repo: 'local/cq-settings',
    pr: 1,
    item: {
      id: 'review-local-label-length',
      path: 'src/settings.mjs',
      line: 2,
      body: 'Campaign labels are limited to 40 Unicode code points after trimming. Reject longer labels. Preserve the original label for display; do not change src/display.mjs.',
      comments: [],
    },
    worktree: { path: worktreePath, branch: 'review/fix-label-limit' },
    driver: { model: 'injected-review-driver', provider: 'fake' },
  };

  return {
    id: 'review-loop-label-limit-01',
    substrateFamily: 'campaign-settings-module-v1',
    worktreePath,
    baselineCommit,
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
