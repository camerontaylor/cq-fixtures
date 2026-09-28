import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FixerSuiteCase, Suite } from '../suite.ts';
import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
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
  /** Wrap the runner's injected Driver to pin the actual copied-workspace baseline before dispatch. */
  wrapDriver(driver: Driver): Driver;
  pinnedBaselineCommit(workspacePath: string): string | undefined;
  pinnedCandidateCommit(workspacePath: string): string | undefined;
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
  const baselinePinDirectory = join(root, 'host-baseline-pins');
  const baselinePins = new Map<string, string>();
  const candidatePins = new Map<string, string>();
  const baselineRefNamespace = `refs/cq-corpus/${randomUUID()}`;
  await mkdir(suiteDir, { recursive: true });
  await mkdir(join(fixturePath, 'src'), { recursive: true });
  await mkdir(join(fixturePath, 'test'), { recursive: true });
  await mkdir(dirname(checkPath), { recursive: true });
  await mkdir(baselinePinDirectory, { recursive: true });
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
  const checkSource = `import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { judgeReviewLoopWorkspace } from ${JSON.stringify(judgeUrl)};
const workspacePath = resolve(process.cwd());
const workspaceKey = createHash('sha256').update(workspacePath).digest('hex');
const pinPath = ${JSON.stringify(baselinePinDirectory)} + '/' + workspaceKey + '.json';
const pin = JSON.parse(await readFile(pinPath, 'utf8'));
if (pin.workspacePath !== workspacePath || !/^[a-f0-9]{40}$/.test(pin.baselineCommit)) {
  throw new Error('immutable runSuite baseline pin is missing or mismatched');
}
const report = await judgeReviewLoopWorkspace(process.cwd(), {
  baselineRef: pin.baselineCommit,
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
    wrapDriver(driver: Driver): Driver {
      return {
        async run(invocation: OpInvocation): Promise<WorkerResult> {
          const workspacePath = invocation.prompt.match(/^workspace: (.+)$/m)?.[1];
          if (workspacePath === undefined) throw new Error('runSuite invocation omitted workspace path');
          const workspace = resolve(workspacePath);
          const baselineCommit = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
            cwd: workspace,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trim();
          if (!/^[a-f0-9]{40}$/.test(baselineCommit)) {
            throw new Error('runSuite workspace did not expose a full pristine baseline commit');
          }
          const workspaceKey = createHash('sha256').update(workspace).digest('hex');
          const refName = `${baselineRefNamespace}/baseline-${workspaceKey}`;
          execFileSync('git', ['update-ref', refName, baselineCommit], {
            cwd: workspace,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          const pinPath = join(baselinePinDirectory, `${workspaceKey}.json`);
          const pinContents = `${JSON.stringify({
            workspacePath: workspace,
            baselineCommit,
            baselineRef: refName,
            sourceId: REVIEW_LOOP_SOURCE_ID,
            baselineId: REVIEW_LOOP_BASELINE_ID,
            oracleId: REVIEW_LOOP_ORACLE_ID,
          })}\n`;
          await writeFile(pinPath, pinContents, { flag: 'wx' });
          baselinePins.set(workspace, baselineCommit);
          let result: WorkerResult | undefined;
          let thrown: unknown;
          try {
            result = await driver.run(invocation);
          } catch (error) {
            thrown = error;
          }

          // Preserve the model-created commit under a host-namespaced ref,
          // then restore the runner's original HEAD while leaving its working
          // tree intact. runSuite's existing patch capture diffs against HEAD;
          // this keeps a valid model commit and makes that patch regradeable.
          let candidateCommit: string | null = null;
          try {
            candidateCommit = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
              cwd: workspace,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            }).trim();
            if (candidateCommit !== baselineCommit) {
              const candidateRef = `${baselineRefNamespace}/candidate-${workspaceKey}`;
              execFileSync('git', ['update-ref', candidateRef, candidateCommit], {
                cwd: workspace,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
              execFileSync('git', ['reset', '--mixed', baselineCommit], {
                cwd: workspace,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
              candidatePins.set(workspace, candidateCommit);
            }
            await writeFile(pinPath, `${JSON.stringify({
              workspacePath: workspace,
              baselineCommit,
              baselineRef: refName,
              candidateCommit,
              sourceId: REVIEW_LOOP_SOURCE_ID,
              baselineId: REVIEW_LOOP_BASELINE_ID,
              oracleId: REVIEW_LOOP_ORACLE_ID,
            })}\n`);
          } catch (captureError) {
            if (thrown === undefined) thrown = captureError;
          }
          if (thrown !== undefined) throw thrown;
          if (result === undefined) throw new Error('wrapped Driver returned no WorkerResult');
          return result;
        },
      };
    },
    pinnedBaselineCommit(workspacePath: string): string | undefined {
      return baselinePins.get(resolve(workspacePath));
    },
    pinnedCandidateCommit(workspacePath: string): string | undefined {
      return candidatePins.get(resolve(workspacePath));
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
