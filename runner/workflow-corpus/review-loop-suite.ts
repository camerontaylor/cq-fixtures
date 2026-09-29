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
import {
  createReviewLoopOraclePin,
  reviewLoopHostCheckEnvironment,
  type ReviewLoopOraclePin,
} from './review-loop-pin.ts';

export interface ReviewLoopRunSuiteBundle {
  readonly suite: Suite;
  readonly suiteDir: string;
  readonly repoRoot: string;
  readonly fixturePath: string;
  readonly modelSpec: ReviewLoopRepairTask['modelSpec'];
  readonly oraclePin: ReviewLoopOraclePin;
  /** Fields S1 must merge into the host-side check process environment. */
  hostCheckScoringEnvironment(workspacePath: string, pinnedBaselineCommit: string): Readonly<Record<string, string>>;
  /** Wrap the runner's injected Driver to pin the actual copied-workspace baseline before dispatch. */
  wrapDriver<T extends Driver>(driver: T): T;
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
  const denylistPath = join(root, 'policy', 'denylist', 'patterns.yml');
  const baselinePinDirectory = join(root, 'host-baseline-pins');
  const baselinePins = new Map<string, string>();
  const candidatePins = new Map<string, string>();
  const oraclePin = createReviewLoopOraclePin();
  const baselineRefNamespace = `refs/cq-corpus/${randomUUID()}`;
  await mkdir(suiteDir, { recursive: true });
  await mkdir(join(fixturePath, 'settings'), { recursive: true });
  await mkdir(join(fixturePath, 'test'), { recursive: true });
  await mkdir(dirname(checkPath), { recursive: true });
  await mkdir(dirname(denylistPath), { recursive: true });
  await mkdir(baselinePinDirectory, { recursive: true });
  await copyFile(fileURLToPath(new URL('../../policy/denylist/patterns.yml', import.meta.url)), denylistPath);
  for (const relativePath of [
    'package.json',
    'settings/module.js',
    'settings/display.js',
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
  const compiledPin = fileURLToPath(new URL('./review-loop-pin.js', import.meta.url));
  const pinModulePath = existsSync(compiledPin)
    ? compiledPin
    : fileURLToPath(new URL('./review-loop-pin.ts', import.meta.url));
  const pinUrl = pathToFileURL(pinModulePath).href;
  const checkSource = `import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { judgeReviewLoopWorkspace } from ${JSON.stringify(judgeUrl)};
import { createReviewLoopOraclePin } from ${JSON.stringify(pinUrl)};
const workspacePath = resolve(process.cwd());
const workspaceKey = createHash('sha256').update(workspacePath).digest('hex');
const pinPath = ${JSON.stringify(baselinePinDirectory)} + '/' + workspaceKey + '.json';
const pin = JSON.parse(await readFile(pinPath, 'utf8'));
const baselineCommit = process.env.CQ_REVIEW_LOOP_BASELINE_SHA ?? pin.baselineCommit;
const oraclePin = process.env.CQ_REVIEW_LOOP_ORACLE_PIN ?? pin.oraclePin?.sha256;
if (pin.workspacePath !== workspacePath || !/^[a-f0-9]{40}$/.test(baselineCommit) || baselineCommit !== pin.baselineCommit) {
  throw new Error('host-scoring baseline pin is missing or mismatched');
}
if (!/^[a-f0-9]{64}$/.test(oraclePin ?? '') || oraclePin !== pin.oraclePin?.sha256) {
  throw new Error('host-scoring oracle pin is missing or mismatched');
}
if (createReviewLoopOraclePin().sha256 !== oraclePin) {
  throw new Error('review-loop oracle dependencies changed after pinning');
}
const report = await judgeReviewLoopWorkspace(process.cwd(), {
  baselineRef: baselineCommit,
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
    oraclePin,
    hostCheckScoringEnvironment(workspacePath: string, pinnedBaselineCommit: string) {
      const capturedBaseline = baselinePins.get(resolve(workspacePath));
      if (capturedBaseline === undefined) throw new Error('runSuite has not captured this workspace baseline yet');
      if (capturedBaseline !== pinnedBaselineCommit) {
        throw new Error('runner and corpus workspace baseline pins do not match');
      }
      return reviewLoopHostCheckEnvironment({ baselineCommit: pinnedBaselineCommit, oraclePin: oraclePin.sha256 });
    },
    wrapDriver<T extends Driver>(driver: T): T {
      const run = async (invocation: OpInvocation): Promise<WorkerResult> => {
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
            oraclePin,
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

          // Preserve a host-namespaced reference to the candidate commit, but
          // leave the observed workspace's HEAD and index untouched. S1
          // captures and judges against its immutable workspaceBaseline.
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
              candidatePins.set(workspace, candidateCommit);
            }
            const headAfterCapture = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
              cwd: workspace,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            }).trim();
            if (headAfterCapture !== candidateCommit) {
              throw new Error('wrapped Driver changed candidate HEAD after dispatch');
            }
            await writeFile(pinPath, `${JSON.stringify({
              workspacePath: workspace,
              baselineCommit,
              baselineRef: refName,
              candidateCommit,
              sourceId: REVIEW_LOOP_SOURCE_ID,
              baselineId: REVIEW_LOOP_BASELINE_ID,
              oracleId: REVIEW_LOOP_ORACLE_ID,
              oraclePin,
            })}\n`);
          } catch (captureError) {
            if (thrown === undefined) thrown = captureError;
          }
          if (thrown !== undefined) throw thrown;
          if (result === undefined) throw new Error('wrapped Driver returned no WorkerResult');
          return result;
      };
      return new Proxy(driver, {
        get(target, property) {
          if (property === 'run') return run;
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
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
