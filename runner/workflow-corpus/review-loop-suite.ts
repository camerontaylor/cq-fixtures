import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FixerSuiteCase, Suite } from '../suite.ts';
import {
  REVIEW_LOOP_BASELINE_ID,
  REVIEW_LOOP_ORACLE_ID,
  REVIEW_LOOP_SOURCE_ID,
  type ReviewLoopRepairTask,
} from '../../campaigns/cq-settings/corpus/review-loop-task.ts';

export interface ReviewLoopRunSuiteBundle {
  readonly suite: Suite;
  readonly suiteDir: string;
  readonly repoRoot: string;
  readonly fixturePath: string;
  readonly modelSpec: ReviewLoopRepairTask['modelSpec'];
  cleanup(): Promise<void>;
}

/** Map the operation task's immutable identity/context into the existing typed fixer TaskSpec. */
export function toReviewLoopSuiteCase(task: ReviewLoopRepairTask): FixerSuiteCase {
  return {
    id: task.id,
    fixture: `fixtures/${task.id}`,
    task: {
      prompt: [
        task.operationInput.item.body,
        'Edit the supplied local repository to implement the review request.',
        'Keep the visible tests and unrelated source files unchanged.',
      ].join('\n\n'),
      notes: `source=${task.sourceId}; baseline=${task.baselineId}; oracle=${task.oracleId}`,
    },
    probe: { kind: 'check-rerun', check: 'workflow-oracles/review-loop-check.mjs' },
  };
}

function judgeModulePath(): string {
  const compiled = fileURLToPath(new URL('./review-loop-judge.js', import.meta.url));
  if (existsSync(compiled)) return compiled;
  return fileURLToPath(new URL('./review-loop-judge.ts', import.meta.url));
}

/**
 * Materialize a regular runSuite bundle: task files are copied under the
 * runner's fixture root, while its independent check remains in the host
 * bundle and outside the writable fixture copy.
 */
export async function createReviewLoopRunSuiteBundle(
  task: ReviewLoopRepairTask,
  parentDirectory = tmpdir(),
): Promise<ReviewLoopRunSuiteBundle> {
  const root = await mkdtemp(join(parentDirectory, 'cq-review-suite-'));
  const suiteDir = join(root, 'suite');
  const fixturePath = join(root, 'fixtures', task.id);
  const checkPath = join(root, 'workflow-oracles', 'review-loop-check.mjs');
  await mkdir(suiteDir, { recursive: true });
  await mkdir(join(fixturePath, 'src'), { recursive: true });
  await mkdir(join(fixturePath, 'test'), { recursive: true });
  await mkdir(dirname(checkPath), { recursive: true });
  for (const relativePath of [
    'package.json',
    'src/settings.mjs',
    'src/display.mjs',
    'test/public-settings.test.mjs',
  ]) {
    await copyFile(join(task.worktreePath, relativePath), join(fixturePath, relativePath));
  }

  const suite: Suite = {
    name: task.id,
    role: 'fixer-worker',
    servedModel: task.modelSpec.model,
    provenance: {
      origin: 'host-generated local Git repair task; no public benchmark content',
    },
    cases: [toReviewLoopSuiteCase(task)],
  };
  await writeFile(join(suiteDir, 'suite.json'), `${JSON.stringify(suite, null, 2)}\n`);

  const judgeUrl = pathToFileURL(judgeModulePath()).href;
  const checkSource = `import { judgeReviewLoopWorkspace } from ${JSON.stringify(judgeUrl)};
const report = await judgeReviewLoopWorkspace(process.cwd(), {
  baselineRef: 'HEAD',
  sourceId: ${JSON.stringify(REVIEW_LOOP_SOURCE_ID)},
  baselineId: ${JSON.stringify(REVIEW_LOOP_BASELINE_ID)},
  oracleId: ${JSON.stringify(REVIEW_LOOP_ORACLE_ID)},
});
if (!report.passed) {
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}
`;
  await writeFile(checkPath, checkSource);

  return {
    suite,
    suiteDir,
    repoRoot: root,
    fixturePath,
    modelSpec: { ...task.modelSpec },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
