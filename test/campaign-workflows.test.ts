import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildTestFixPlan,
  checkDiffMonotonicity,
  clusterErrorsOp,
  createCaptureBaseline,
  createCheckRatchet,
  makeAgenticRemediation,
  makePlanSweep,
  makeResolveConflictOp,
  registerAdapter,
  type Driver,
  type MergeEffects,
  type OpResult,
  type PlanSweepInput,
  type WorkerResult,
} from '@camerontaylor/cq-toolkit';
import { describe, expect, it } from 'vitest';
import { runSuite } from '../runner/index.ts';
import type { ExperimentContext } from '../runner/experiment.ts';
import { ObservedNativeDriver } from '../runner/native/observed-driver.ts';
import type { InvocationIdentity } from '../runner/native/observation.ts';
import {
  judgeReviewLoopRepairTask,
  judgeReviewLoopWorkspace,
} from '../runner/workflow-corpus/review-loop-judge.ts';
import { createReviewLoopRunSuiteBundle } from '../runner/workflow-corpus/review-loop-suite.ts';
import { createReviewLoopOraclePin } from '../runner/workflow-corpus/review-loop-pin.ts';
import {
  judgeAnalysisRemediationProposal,
  judgeFleetSweepPlan,
  judgeMergeConflictWorkspace,
  judgeRatchetOutcomes,
  judgeTestFixScopePlan,
} from '../runner/workflow-corpus/operation-workflow-judges.ts';
import {
  REVIEW_LOOP_BASELINE_ID,
  REVIEW_LOOP_ORACLE_ID,
  REVIEW_LOOP_SOURCE_ID,
  createReviewLoopRepairTask,
  executeReviewLoopRepairTask,
} from '../campaigns/cq-settings/corpus/review-loop-task.js';
import {
  ANALYSIS_TASKS,
  createAnalysisRemediationTask,
  createRatchetTask,
  executeAnalysisRemediationTask,
  executeRatchetTask,
} from '../campaigns/cq-settings/corpus/operation-tasks.js';
import { ANALYSIS_REMEDIATION_CONTRACTS } from '../runner/workflow-corpus/operation-workflow-judges.js';
import {
  createFleetSweepTask,
  createMergeConflictTask,
  executeFleetSweepTask,
  executeMergeConflictTask,
  judgeMergeConflictTask,
} from '../campaigns/cq-settings/corpus/integration-tasks.js';
import {
  REVIEW_TASK_CONTRACTS,
  judgeReviewTaskCandidate,
  judgeReviewTaskCandidateIdentity,
  judgeReviewTaskSubmission,
  judgeReviewTaskValues,
} from '../campaigns/cq-settings/corpus/review-task-oracles.js';
import {
  ANALYSIS_TASK_CONTRACTS,
  evaluateAnalysisTaskVectors,
  judgeAnalysisProposalMeaning,
} from '../campaigns/cq-settings/corpus/operation-task-oracles.js';
import {
  FLEET_TEST_UNIT_CONTRACT,
  MERGE_ORIGIN_CONTRACT,
  judgeFleetUnitCandidate,
  judgeFleetUnitValues,
  judgeLocalCandidateIdentity,
  judgeMergeOriginCandidate,
  judgeMergeOriginValues,
} from '../campaigns/cq-settings/corpus/integration-task-oracles.js';
import {
  createReviewLabelNfcTask,
  createReviewRoleScopeTask,
} from '../campaigns/cq-settings/corpus/review-loop-task.js';
import {
  createFleetTestUnitRepairTask,
  createMergeConflictTask as createIntegrationMergeTask,
  executeFleetTestUnitRepairTask,
  judgeFleetTestUnitRepairTask,
  judgeMergeOriginConflictTask,
} from '../campaigns/cq-settings/corpus/integration-tasks.js';

function expectOk<T>(result: OpResult<T>): T {
  if (result.status !== 'ok') {
    const detail = result.status === 'failed' ? result.error : result.status === 'needs-human' ? result.reason : '';
    throw new Error(`expected ok operation, got ${result.status}: ${detail}`);
  }
  return result.value;
}

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const completedWorker = (structuredOutput: unknown): WorkerResult => ({
  structuredOutput,
  usage: zeroUsage,
  denials: [],
  stopReason: 'complete',
});

const REFERENCE_SETTINGS_SOURCE = `export function isValidCampaignLabel(label) {
  if (typeof label !== 'string') return false;
  const normalized = label.trim();
  return normalized.length > 0 && [...normalized].length <= 40;
}
`;

type ReviewDriverMode = 'reference-patch' | 'no-op-claim' | 'bad-json-with-edits' | 'throw-with-edits';

const ALTERNATIVE_SETTINGS_SOURCE = `export function isValidCampaignLabel(label) {
  if (typeof label !== 'string') return false;
  const codePointCount = Array.from(label.trim()).length;
  return codePointCount >= 1 && codePointCount <= 40;
}
`;
const OFFLINE_REVIEW_ROUTE = { model: 'glm-5.3-flash', provider: 'fake' } as const;

function scriptedReviewDriver(
  task: Awaited<ReturnType<typeof createReviewLoopRepairTask>>,
  mode: ReviewDriverMode,
  candidateSource = REFERENCE_SETTINGS_SOURCE,
): Driver {
  return {
    async run(invocation) {
      let commits: string[] = ['f'.repeat(40)];
      if (mode !== 'no-op-claim') {
        await writeFile(join(task.worktreePath, 'settings/module.js'), candidateSource);
        execFileSync('git', ['add', 'settings/module.js'], { cwd: task.worktreePath });
        execFileSync('git', ['commit', '-q', '-m', `Candidate patch: ${mode}`], { cwd: task.worktreePath });
        commits = [execFileSync('git', ['rev-parse', 'HEAD'], { cwd: task.worktreePath, encoding: 'utf8' }).trim()];
      }
      if (mode === 'throw-with-edits') throw new Error('local driver transport ended after commit');
      const structuredOutput = mode === 'bad-json-with-edits'
        ? { changed: 'yes', summary: 'malformed fix contract', commits }
        : { changed: true, summary: 'Enforce the 40 code point campaign label limit.', commits };
      return {
        ...completedWorker(structuredOutput),
        model: invocation.modelSpec.model,
      };
    },
  };
}

function commitCandidate(task: Awaited<ReturnType<typeof createReviewLoopRepairTask>>, source: string): void {
  writeFileSync(join(task.worktreePath, 'settings/module.js'), source);
  execFileSync('git', ['add', 'settings/module.js'], { cwd: task.worktreePath });
  execFileSync('git', ['-c', 'user.name=CQ Corpus', '-c', 'user.email=corpus@example.invalid', 'commit', '-q', '-m', 'Apply local candidate patch'], { cwd: task.worktreePath });
}

describe('cq-settings bounded workflow corpus', () => {
  it('judges the original bug red and an exact committed repair green', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    try {
      const red = await judgeReviewLoopWorkspace(task.worktreePath, {
        baselineRef: task.baselineCommit,
        sourceId: task.sourceId,
        baselineId: task.baselineId,
        oracleId: task.oracleId,
      });
      expect(red.behavior.passed).toBe(false);
      expect(red.visibleTests.passed).toBe(false);
      const driver = scriptedReviewDriver(task, 'reference-patch');
      const operationResult = await executeReviewLoopRepairTask(task, driver);

      expect(expectOk(operationResult).changed).toBe(true);
      const green = await judgeReviewLoopRepairTask(task);
      expect(green.passed).toBe(true);
      expect(green.identity.passed).toBe(true);
      expect(green.conformance.passed).toBe(true);
      expect(green.identity.candidatePatchSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(green.conformance.sourceTestAllowlist.changedPaths).toEqual(['settings/module.js']);
    } finally {
      await task.cleanup();
    }
  }, 120_000);

  it('accepts a distinct correct implementation and records its actual patch bytes', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    try {
      commitCandidate(task, ALTERNATIVE_SETTINGS_SOURCE);
      const alternative = await judgeReviewLoopRepairTask(task);
      expect(alternative.passed).toBe(true);

      const reference = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
      try {
        commitCandidate(reference, REFERENCE_SETTINGS_SOURCE);
        const referenceReport = await judgeReviewLoopRepairTask(reference);
        expect(referenceReport.passed).toBe(true);
        expect(alternative.identity.candidatePatchSha256).not.toBe(referenceReport.identity.candidatePatchSha256);
      } finally {
        await reference.cleanup();
      }
    } finally {
      await task.cleanup();
    }
  }, 120_000);

  it('separates candidate cleanliness and identity from workspace conformance', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    try {
      commitCandidate(task, REFERENCE_SETTINGS_SOURCE);
      const committed = await judgeReviewLoopRepairTask(task);
      expect(committed.passed).toBe(true);

      await writeFile(join(task.worktreePath, 'settings/module.js'), ALTERNATIVE_SETTINGS_SOURCE);
      const dirty = await judgeReviewLoopRepairTask(task);
      expect(dirty.identity.passed).toBe(false);
      expect(dirty.identity.cleanGitCandidate).toBe(false);
      expect(dirty.conformance.passed).toBe(true);
      expect(dirty.identity.candidatePatchSha256).not.toBe(committed.identity.candidatePatchSha256);
    } finally {
      await task.cleanup();
    }
  }, 120_000);

  it('runs arbitrary candidate-module probes only through the protected judge child', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    try {
      await writeFile(join(task.worktreePath, 'settings/module.js'), 'while (true) {}\n');
      const report = await judgeReviewLoopWorkspace(task.worktreePath, {
        baselineRef: task.baselineCommit,
        sourceId: task.sourceId,
        baselineId: task.baselineId,
        oracleId: task.oracleId,
      });
      expect(report.passed).toBe(false);
      expect(report.behavior.failures.some((failure) => failure.includes('protected candidate module probe failed'))).toBe(true);
      expect(report.visibleTests.passed).toBe(false);
    } finally {
      await task.cleanup();
    }
  }, 30_000);

  it('adapts the typed operation task to runSuite with the task model route and host oracle', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    const bundle = await createReviewLoopRunSuiteBundle(task);
    let workerWorkspace = '';
    class LocalObservedDriver extends ObservedNativeDriver {
      readonly campaignBudgetCapabilities = { hardTokenCap: true, authoritativeTokenTotal: true };

      constructor() {
        super({
          configuredTarget: OFFLINE_REVIEW_ROUTE.model,
          transport: 'local-corpus-test',
          executable: process.execPath,
          executableVersion: process.version,
          profile: 'deterministic-fixture',
        });
      }

      protected async runObserved(invocation: Parameters<Driver['run']>[0], identity: InvocationIdentity) {
        const workspace = invocation.prompt.match(/^workspace: (.+)$/m)?.[1];
        if (!workspace) throw new Error('runSuite invocation omitted workspace path');
        workerWorkspace = workspace;
        await writeFile(join(workspace, 'settings/module.js'), ALTERNATIVE_SETTINGS_SOURCE);
        execFileSync('git', ['-C', workspace, 'add', 'settings/module.js']);
        execFileSync('git', [
          '-C', workspace,
          '-c', 'user.name=CQ Corpus',
          '-c', 'user.email=corpus@example.invalid',
          'commit', '-q', '-m', 'Model-created valid candidate commit',
        ]);
        const result: WorkerResult = {
          ...completedWorker({
            fixed: true,
            notes: 'Count Unicode code points after trimming while preserving display input.',
          }),
          model: invocation.modelSpec.model,
        };
        const observation = this.newObservation(identity, invocation, new Date().toISOString());
        observation.withheldArtifacts = [];
        observation.usage.tokenTotal.semantics = 'unknown';
        observation.capture.baselineCommit = null;
        this.finishObservation(observation, result);
        return result;
      }
    }
    const driver = new LocalObservedDriver();
    const wrappedDriver = bundle.wrapDriver(driver);
    try {
      const hostCheckPath = join(bundle.repoRoot, 'workflow-oracles/review-loop-check.mjs');
      const experiment: ExperimentContext = {
        campaignId: 'cq-settings-local-corpus',
        cohortId: 'native-wrapper-check',
        experimentId: 'review-loop-host-pin',
        taskId: task.id,
        repeatId: 'repeat-1',
        assignmentId: 'assignment-1',
        stageId: 'stage-1',
        attemptId: 'attempt-1',
        track: 'visible-calibration',
        strategyId: 'local-observed-driver',
        settingsId: 'settings-default',
        budgetId: 'budget-unbounded-local',
        profileId: 'deterministic-fixture',
        frozenWeight: 1,
        substrateId: task.id,
        judgeManifest: {
          sourcePin: bundle.oraclePin.sha256,
          dependencies: [{
            path: 'workflow-oracles/review-loop-check.mjs',
            sha256: createHash('sha256').update(readFileSync(hostCheckPath)).digest('hex'),
          }],
        },
      };
      expect(bundle.suite.cases[0]?.id).toBe(task.id);
      expect(bundle.suite.cases[0]?.task.notes).toContain(`source=${REVIEW_LOOP_SOURCE_ID}`);
      expect(bundle.suite.cases[0]?.task.notes).toContain(`baseline=${REVIEW_LOOP_BASELINE_ID}`);
      expect(bundle.suite.cases[0]?.task.notes).toContain(`oracle=${REVIEW_LOOP_ORACLE_ID}`);
      const result = await runSuite({
        suiteDir: bundle.suiteDir,
        repoRoot: bundle.repoRoot,
        driver: wrappedDriver,
        model: bundle.modelSpec.model,
        provider: bundle.modelSpec.provider,
        driverName: 'subprocess',
        checkTimeoutMs: 60_000,
        artifactRoot: join(bundle.repoRoot, 'artifacts'),
        experiment,
        hostCheckScoringEnvironment: bundle.hostCheckScoringEnvironment,
      });
      expect(result.materializationFailures).toBe(0);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ case: task.id, role: 'fixer-worker', model: 'glm-5.3-flash' });
      expect(result.rows[0]?.outcome).toMatchObject({ score: 1 });
      expect(result.tables).toHaveLength(1);
      expect(result.observations).toHaveLength(1);
      expect(result.observations[0]?.observation.transport).toBe('local-corpus-test');
      expect(result.observations[0]?.observation.identity.invocationId).toMatch(/^[a-f0-9-]{36}$/);
      expect(result.observations[0]?.observation.workerResult?.model).toBe(OFFLINE_REVIEW_ROUTE.model);
      expect(wrappedDriver.campaignBudgetCapabilities).toEqual({
        hardTokenCap: true,
        authoritativeTokenTotal: true,
      });
      const baselineCommit = bundle.pinnedBaselineCommit(workerWorkspace);
      const candidateCommit = bundle.pinnedCandidateCommit(workerWorkspace);
      expect(baselineCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(candidateCommit).toMatch(/^[a-f0-9]{40}$/);
      if (baselineCommit === undefined || candidateCommit === undefined) {
        throw new Error('runSuite adapter did not capture baseline and candidate commits');
      }
      expect(candidateCommit).not.toBe(baselineCommit);
      const taskOutcome = result.rows[0]?.taskOutcome;
      expect(taskOutcome?.judgements).toHaveLength(1);
      expect(taskOutcome?.judgements[0]).toMatchObject({
        judgePin: bundle.oraclePin.sha256,
        judgeManifest: experiment.judgeManifest,
        baselineCommit,
      });
      expect(bundle.oraclePin).toMatchObject({
        version: 2,
        oracleId: REVIEW_LOOP_ORACLE_ID,
        dependencies: expect.arrayContaining([
          expect.objectContaining({ path: 'runner/workflow-corpus/review-loop-judge.ts', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
          expect.objectContaining({ path: 'runner/workflow-corpus/review-loop-pin.ts', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
          expect.objectContaining({ path: 'campaigns/cq-settings/corpus/review-loop-task.ts', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
          expect.objectContaining({ path: 'runner/boundary/judge-child.ts', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        ]),
      });
      expect(bundle.oraclePin.sha256).toMatch(/^[a-f0-9]{64}$/);
      const committedOraclePin = JSON.parse(readFileSync(
        new URL('../campaigns/cq-settings/corpus/review-loop-oracle-pin.json', import.meta.url),
        'utf8',
      )) as typeof bundle.oraclePin;
      expect(bundle.oraclePin).toEqual(committedOraclePin);
      expect(bundle.hostCheckScoringEnvironment(workerWorkspace, baselineCommit)).toEqual({
        CQ_REVIEW_LOOP_BASELINE_SHA: baselineCommit,
        CQ_REVIEW_LOOP_ORACLE_PIN: bundle.oraclePin.sha256,
      });
      expect(result.artifacts.find((artifact) => artifact.kind === 'patch')?.content).toContain('Array.from');
    } finally {
      await bundle.cleanup();
      await task.cleanup();
    }
  }, 120_000);

  it('grades a claimed no-op as incorrect even when the operation contract says changed', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    try {
      const result = await executeReviewLoopRepairTask(task, scriptedReviewDriver(task, 'no-op-claim'));
      expect(expectOk(result)).toMatchObject({ changed: true, commits: ['f'.repeat(40)] });
      const report = await judgeReviewLoopRepairTask(task);
      expect(report.passed).toBe(false);
      expect(report.identity.passed).toBe(false);
      expect(report.conformance.behavior.passed).toBe(false);
    } finally {
      await task.cleanup();
    }
  }, 60_000);

  it('grades a correct committed patch independently when structured output is invalid', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    try {
      const result = await executeReviewLoopRepairTask(task, scriptedReviewDriver(task, 'bad-json-with-edits'));
      expect(result.status).toBe('failed');
      expect((await judgeReviewLoopRepairTask(task)).passed).toBe(true);
    } finally {
      await task.cleanup();
    }
  }, 60_000);

  it('grades a correct committed patch independently when the Driver throws after editing', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    try {
      const result = await executeReviewLoopRepairTask(task, scriptedReviewDriver(task, 'throw-with-edits'));
      expect(result.status).toBe('needs-human');
      expect((await judgeReviewLoopRepairTask(task)).passed).toBe(true);
    } finally {
      await task.cleanup();
    }
  }, 30_000);

  it('exposes the review task through its typed factory and injected Driver executor', async () => {
    const invocations: Parameters<Driver['run']>[0][] = [];
    const driver: Driver = {
      async run(invocation) {
        invocations.push(invocation);
        return { ...completedWorker({
          changed: true,
          summary: 'Repair the anchored setting validation.',
          commits: ['a'.repeat(40)],
        }), model: invocation.modelSpec.model };
      },
    };
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    try {
      const result = await executeReviewLoopRepairTask(task, driver);

      expect(expectOk(result).changed).toBe(true);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.prompt).toContain('settings/module.js');
      expect(invocations[0]?.prompt).toContain('40 Unicode code points');
      expect(invocations[0]?.sandboxPolicy).toEqual({ level: 'workspace-write' });
    } finally {
      await task.cleanup();
    }
  }, 30_000);

  it('runs conflict resolution against local effects and verifies the reported head movement', async () => {
    const taskRoot = await mkdtemp(join(tmpdir(), 'cq-merge-task-'));
    const repoRoot = join(taskRoot, 'repo');
    const settingsPath = join(repoRoot, 'src/settings.mjs');
    await mkdir(join(repoRoot, 'src'), { recursive: true });
    await writeFile(settingsPath, `export function campaignLabel(label) { return label.trim(); }\n`);
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['-c', 'user.name=CQ Corpus', '-c', 'user.email=corpus@example.invalid', 'add', '.'], { cwd: repoRoot });
    execFileSync('git', ['-c', 'user.name=CQ Corpus', '-c', 'user.email=corpus@example.invalid', 'commit', '-q', '-m', 'Seed conflict task'], { cwd: repoRoot });
    const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const replacement = `export function campaignLabel(label) {\n  if (typeof label !== 'string') return '';\n  const trimmed = label.trim();\n  if (trimmed.length === 0 || Array.from(trimmed).length > 40) return '';\n  return trimmed;\n}\n`;
    let validations = 0;
    let pushedCommit = '';
    const effects: MergeEffects = {
      async validateRef() {
        validations += 1;
        const sha = validations === 1 ? baseline : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
        return { ok: true, sha };
      },
      async fetchRef() { return { code: 0, stdout: '', stderr: '' }; },
      async readBaseRef() { return { ok: true, baseRefName: 'main' }; },
      async worktreePrepare() { return { path: repoRoot }; },
      async worktreeRemove() {},
      async mergePr() { return { code: 0, stdout: '', stderr: '' }; },
      async retargetBase() { return { code: 0, stdout: '', stderr: '' }; },
      async pushRef(_ref, fromPath) {
        pushedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fromPath, encoding: 'utf8' }).trim();
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const invocations: Parameters<Driver['run']>[0][] = [];
    const driver: Driver = {
      async run(invocation) {
        invocations.push(invocation);
        await writeFile(settingsPath, replacement);
        execFileSync('git', ['add', 'src/settings.mjs'], { cwd: repoRoot });
        execFileSync('git', ['-c', 'user.name=CQ Corpus', '-c', 'user.email=corpus@example.invalid', 'commit', '-q', '-m', 'Resolve settings conflict'], { cwd: repoRoot });
        return {
          ...completedWorker({ decision: 'acted', summary: 'Preserve trimmed labels and enforce the 40-character limit.' }),
          model: invocation.modelSpec.model,
        };
      },
    };
    try {
      const resolveConflict = makeResolveConflictOp({
        effects,
        driver,
        createSession: async () => 'local-session',
        loadPrompt: async () => 'PR {{pr}}; files {{conflictFiles}}; base {{baseBranch}}; tree {{worktree}}',
      });
      const result = await resolveConflict({
        pr: 17,
        repoRoot,
        headBranch: 'fix/settings',
        baseBranch: 'main',
        conflictFiles: ['src/settings.mjs'],
        modelSpec: { model: 'offline-conflict', provider: 'fake' },
      });

      expect(expectOk(result).decision).toBe('acted');
      const mergeReport = await judgeMergeConflictWorkspace(repoRoot, baseline);
      expect(mergeReport.failures, JSON.stringify(mergeReport)).toEqual([]);
      expect(mergeReport).toMatchObject({
        passed: true,
        sourceId: 'cq-settings.merge-worktree-seed.v1',
        baselineId: 'cq-settings.merge-conflict.baseline.v1',
        oracleId: 'cq-settings.merge-label-limit.oracle.v1',
      });
      expect(validations).toBe(2);
      expect(pushedCommit).not.toBe(baseline);
      expect(execFileSync('git', ['diff', '--name-only', baseline, 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('src/settings.mjs');
      const candidate = await import(`${pathToFileURL(settingsPath).href}?fresh=${Date.now()}`) as { campaignLabel(label: unknown): string };
      expect(candidate.campaignLabel('😀'.repeat(40))).toBe('😀'.repeat(40));
      expect(candidate.campaignLabel('😀'.repeat(41))).toBe('');
      expect(invocations[0]?.prompt).toContain('src/settings.mjs');
      expect(invocations[0]?.sandboxPolicy).toEqual({ level: 'none' });
    } finally {
      await rm(taskRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('plans a fleet sweep using changed-file evidence and nested package ownership', async () => {
    const taskRoot = await mkdtemp(join(tmpdir(), 'cq-fleet-task-'));
    const repoRoot = join(taskRoot, 'repo');
    await mkdir(join(repoRoot, 'packages/core/test'), { recursive: true });
    await mkdir(join(repoRoot, 'packages/cli'), { recursive: true });
    await writeFile(join(repoRoot, 'packages/core/test/settings.test.ts'), 'assert.equal(true, true);\n');
    await writeFile(join(repoRoot, 'packages/cli/index.ts'), 'export const cli = true;\n');
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['-c', 'user.name=CQ Corpus', '-c', 'user.email=corpus@example.invalid', 'add', '.'], { cwd: repoRoot });
    execFileSync('git', ['-c', 'user.name=CQ Corpus', '-c', 'user.email=corpus@example.invalid', 'commit', '-q', '-m', 'Fleet baseline'], { cwd: repoRoot });
    const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    await writeFile(join(repoRoot, 'packages/core/test/settings.test.ts'), 'assert.equal(false, false);\n');
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['-c', 'user.name=CQ Corpus', '-c', 'user.email=corpus@example.invalid', 'commit', '-q', '-m', 'Change settings test'], { cwd: repoRoot });
    const planner = makePlanSweep({
      changedFiles: async (base) => execFileSync('git', ['diff', '--name-status', `${base}..HEAD`], { cwd: repoRoot, encoding: 'utf8' })
        .trim().split('\n').filter(Boolean).map((line) => {
          const [status = '', path = ''] = line.split('\t');
          return { path, status, deleted: status === 'D', fixerTarget: true };
        }),
    });
    const input: PlanSweepInput = {
      repoRoot,
      packages: [
        { name: 'core', path: 'packages/core' },
        { name: 'core-tests', path: 'packages/core/test' },
        { name: 'cli', path: 'packages/cli' },
      ],
      selector: { mode: 'changed-vs-base', base: baseline },
      fixers: ['settings-fixer'],
    };
    try {
      const report = expectOk(await planner(input));
      const changedPaths = execFileSync('git', ['diff', '--name-only', `${baseline}..HEAD`], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim().split('\n').filter(Boolean);
      expect(judgeFleetSweepPlan(report, changedPaths).passed).toBe(true);

      expect(report.units).toEqual([{
        package: 'core-tests',
        fixer: 'settings-fixer',
        files: ['packages/core/test/settings.test.ts'],
      }]);
      expect(report.jobs).toHaveLength(1);
      expect(execFileSync('git', ['diff', '--quiet', baseline, 'HEAD', '--', 'packages/cli/index.ts'], { cwd: repoRoot }).toString()).toBe('');
    } finally {
      await rm(taskRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('builds the baseline test-fix phase with test-only scope', async () => {
    const taskRoot = await mkdtemp(join(tmpdir(), 'cq-test-fix-task-'));
    const repoRoot = join(taskRoot, 'repo');
    await mkdir(join(repoRoot, 'packages/settings/src'), { recursive: true });
    await mkdir(join(repoRoot, 'packages/settings/test'), { recursive: true });
    await writeFile(join(repoRoot, 'packages/settings/src/settings.ts'), 'export const defaultLabel = "campaign";\n');
    await writeFile(join(repoRoot, 'packages/settings/test/settings.test.ts'), 'assert.equal(defaultLabel, "campaign");\n');
    const config = {
      repoRoot,
      worktreesDir: join(taskRoot, 'worktrees'),
      runPrefix: 'cq/local-test-fix',
      base: 'campaign-base',
      packages: [{ name: 'settings', path: 'packages/settings' }],
      selector: { mode: 'workspace-all' as const },
      fixers: ['test-fix'],
      packageFiles: {
        settings: [
          'packages/settings/src/settings.ts',
          'packages/settings/test/settings.test.ts',
        ],
      },
    };
    try {
      const planner = makePlanSweep({ changedFiles: async () => [] });
      const phaseA = expectOk(await planner({
        repoRoot: config.repoRoot,
        packages: config.packages,
        selector: config.selector,
        fixers: config.fixers,
        packageFiles: config.packageFiles,
      }));
      const plan = buildTestFixPlan(config, phaseA);
      const serializedJobs = JSON.stringify(plan.jobs);

      expect(judgeTestFixScopePlan(serializedJobs)).toMatchObject({
        passed: true,
        oracleId: 'cq-settings.testfix-scope-risk.oracle.v1',
      });

      expect(plan.id).toBe('test-fix');
      expect(serializedJobs).toContain('test-fix');
      expect(serializedJobs).toContain('test/settings.test.ts');
      expect(serializedJobs).toContain('^packages/settings/');
      expect(serializedJobs).not.toContain('product-fix');
    } finally {
      await rm(taskRoot, { recursive: true, force: true });
    }
  });

  it('clusters analysis failures and requests a read-only remediation proposal', async () => {
    const failure = {
      file: 'src/settings.ts',
      line: 12,
      column: 4,
      ruleId: 'no-empty-setting',
      message: 'Setting must not be empty.',
      severity: 'error' as const,
    };
    const clustered = expectOk(await clusterErrorsOp({
      set: { tool: 'eslint', failures: [failure, { ...failure, line: 18 }], exitCode: 1 },
    }));
    expect(clustered.clusters).toHaveLength(1);
    expect(clustered.clusters[0]?.size).toBe(2);
    const invocations: Parameters<Driver['run']>[0][] = [];
    const driver: Driver = {
      async run(invocation) {
        invocations.push(invocation);
        return completedWorker({
          summary: 'Normalize empty campaign settings at the shared validation boundary.',
          patch: '--- a/src/settings.ts\n+++ b/src/settings.ts\n@@\n-empty\n+reject whitespace-only values',
          candidateSource: `export function isValidSetting(value) {
  if (typeof value !== 'string') return false;
  return value.trim().length > 0;
}
`,
        });
      },
    };
    const propose = makeAgenticRemediation(driver);
    const proposal = await propose({
      clusterId: clustered.clusters[0]!.id,
      cluster: clustered.clusters[0]!,
      modelSpec: { model: 'offline-analysis', provider: 'fake' },
    });

    expect(await judgeAnalysisRemediationProposal(expectOk(proposal).structuredOutput)).toMatchObject({
      passed: true,
      oracleId: 'cq-settings.analysis-remediation.oracle.v1',
    });

    expect(expectOk(proposal).structuredOutput).toMatchObject({
      summary: 'Normalize empty campaign settings at the shared validation boundary.',
      patch: expect.stringContaining('reject whitespace-only values'),
      candidateSource: expect.stringContaining('value.trim().length > 0'),
    });
    expect(invocations[0]?.toolPolicy).toEqual({ allow: [], mode: 'none' });
    expect(invocations[0]?.sandboxPolicy).toEqual({ level: 'read-only' });
  });

  it('captures and checks monotonic quality ratchets, and rejects a loosening diff', async () => {
    const metric = 'cq-corpus-count';
    registerAdapter({
      id: metric,
      direction: 'lower-is-better',
      extract(raw) {
        return typeof raw === 'number' ? { value: raw, unit: 'errors' } : null;
      },
    });
    let current = 2;
    const sources = new Map([["local", async () => current]]);
    const workspace = await mkdtemp(join(tmpdir(), 'cq-ratchet-corpus-'));
    try {
      await mkdir(join(workspace, 'packages'), { recursive: true });
      const capture = createCaptureBaseline(sources);
      expect((await capture({
        ws: workspace,
        target: 'settings',
        metric,
        sourceId: 'local',
        capturedAt: '2026-09-29T00:00:00.000Z',
      })).status).toBe('ok');
      const check = createCheckRatchet(sources);
      const input = { ws: workspace, target: 'settings', metric, sourceId: 'local' };
      current = 1;
      const tightened = expectOk(await check(input)).verdict;
      current = 3;
      const regressed = expectOk(await check(input)).verdict;
      const baselineDiff = (from: number, to: number) => [
        'diff --git a/baselines/settings.json b/baselines/settings.json',
        '--- a/baselines/settings.json',
        '+++ b/baselines/settings.json',
        '@@ -1,5 +1,5 @@',
        ' {',
        '   "target": "settings",',
        `-  "value": ${from},`,
        `+  "value": ${to},`,
        '   "metric": "cq-corpus-count",',
        '   "direction": "lower-is-better"',
        ' }',
      ].join('\n');
      const loosening = checkDiffMonotonicity(baselineDiff(2, 3));
      const tightening = checkDiffMonotonicity(baselineDiff(2, 1));
      expect(judgeRatchetOutcomes({
        tightened,
        regressed,
        tighteningAccepted: tightening.ok,
        looseningAccepted: loosening.ok,
      })).toMatchObject({ passed: true, oracleId: 'cq-settings.ratchet-monotonicity.oracle.v1' });
      expect(loosening).toMatchObject({ ok: false });
      expect(tightening).toMatchObject({ ok: true });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it('accepts a distinct behaviorally correct remediation implementation', async () => {
    const report = await judgeAnalysisRemediationProposal({
      summary: 'Reject blank settings at the shared validation boundary.',
      patch: 'update isValidSetting in src/settings.ts to reject trimmed empty text',
      candidateSource: `export function isValidSetting(value) {
  return typeof value === 'string' && [...value.trim()].length !== 0;
}
`,
    });
    expect(report).toMatchObject({ passed: true, oracleId: 'cq-settings.analysis-remediation.oracle.v1' });
  }, 60_000);

  it.each([
    {
      variant: 'whitespaceSetting' as const,
      source: `export function isValidSetting(value) { return typeof value === 'string' && value.trim().length > 0; }\n`,
      contract: ANALYSIS_REMEDIATION_CONTRACTS.emptySetting,
    },
    {
      variant: 'unicodeLabelLimit' as const,
      source: `export function isValidSetting(value) { return typeof value === 'string' && value.trim().length > 0 && [...value.trim()].length <= 40; }\n`,
      contract: ANALYSIS_REMEDIATION_CONTRACTS.unicodeLabelLength,
    },
  ])('executes independently judged analyze/remediate task $variant using the supplied route', async ({ variant, source, contract }) => {
    const modelSpec = { model: `offline-${variant}`, provider: 'fake' } as const;
    const task = await createAnalysisRemediationTask(variant, modelSpec);
    const invocations: Parameters<Driver['run']>[0][] = [];
    const driver: Driver = {
      async run(invocation) {
        invocations.push(invocation);
        return completedWorker({
          summary: 'Reject invalid campaign settings at the validation boundary.',
          patch: 'src/settings.ts: update isValidSetting to enforce the task validation rule',
          candidateSource: source,
        });
      },
    };
    try {
      expect(task.baselineCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(task.fixtureSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(task.oraclePin).toMatch(/^[a-f0-9]{64}$/);
      const result = await executeAnalysisRemediationTask(task, driver);
      expect(result.clusterCount).toBe(1);
      expect(result.clusterSize).toBe(2);
      expect(result.oracle).toMatchObject({
        passed: true,
        sourceId: ANALYSIS_TASKS[variant].sourceId,
        baselineId: ANALYSIS_TASKS[variant].baselineId,
        oracleId: ANALYSIS_TASKS[variant].oracleId,
      });
      expect(invocations[0]?.modelSpec).toEqual(modelSpec);
      expect(invocations[0]?.toolPolicy).toEqual({ allow: [], mode: 'none' });
      expect(invocations[0]?.sandboxPolicy).toEqual({ level: 'read-only' });
      const baseline = await judgeAnalysisRemediationProposal({
        summary: 'Keep existing source behavior.',
        patch: 'src/settings.ts: no-op',
        candidateSource: readFileSync(join(task.workspacePath, 'src/settings.ts'), 'utf8'),
      }, contract);
      expect(baseline.passed).toBe(false);
      const alternative = await judgeAnalysisRemediationProposal({
        summary: 'Validate after normalizing at the boundary.',
        patch: 'src/settings.ts: use a helper that checks normalized setting semantics',
        candidateSource: variant === 'whitespaceSetting'
          ? `export function isValidSetting(v) { if (typeof v !== 'string') return false; for (const c of v) if (!/\\s/u.test(c)) return true; return false; }`
          : `export function isValidSetting(v) { if (typeof v !== 'string') return false; let count = 0; for (const c of v.trim()) count += 1; return count > 0 && count <= 40; }`,
      }, contract);
      expect(alternative.passed).toBe(true);
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: task.workspacePath, encoding: 'utf8' })).toBe('');
    } finally {
      await task.cleanup();
    }
  }, 120_000);

  it.each(['lowerErrorCount', 'higherCoverage'] as const)(
    'runs captured-baseline/check/monotonicity exports for $variant with independent direction oracle', async (variant) => {
      const task = await createRatchetTask(variant);
      try {
        const report = await executeRatchetTask(task);
        expect(task.baselineCommit).toMatch(/^[a-f0-9]{40}$/);
        expect(task.oraclePin).toMatch(/^[a-f0-9]{64}$/);
        expect(report.oracle).toMatchObject({
          passed: true,
          sourceId: task.sourceId,
          baselineId: task.baselineId,
          oracleId: task.oracleId,
        });
        expect(report.tightened).toBe('pass');
        expect(report.regressed).toBe('fail');
        expect(report.tighteningAccepted).toBe(true);
        expect(report.looseningAccepted).toBe(false);
        expect(report.baselineValues.from).toBe(task.initialValue);
        if (task.direction === 'higher-is-better') {
          expect(task.improvedValue).toBeGreaterThan(task.initialValue);
          expect(task.regressedValue).toBeLessThan(task.initialValue);
        } else {
          expect(task.improvedValue).toBeLessThan(task.initialValue);
          expect(task.regressedValue).toBeGreaterThan(task.initialValue);
        }
      } finally {
        await task.cleanup();
      }
    },
    30_000,
  );

  it.each(['unicodeLabelLimit', 'reservedPrefix'] as const)(
    'runs the exported merge conflict operation for $variant and independently judges committed source', async (variant) => {
      const task = await createMergeConflictTask(variant, { model: `offline-${variant}`, provider: 'fake' });
      const source = variant === 'unicodeLabelLimit'
        ? `export function campaignLabel(v) { if (typeof v !== 'string') return ''; const s = v.trim(); return [...s].length > 0 && [...s].length <= 40 ? s : ''; }\n`
        : `export function campaignLabel(v) { if (typeof v !== 'string') return ''; const s = v.trim(); return s && !s.startsWith('sys:') ? s : ''; }\n`;
      const driver: Driver = {
        async run(invocation) {
          await writeFile(task.settingsPath, source);
          execFileSync('git', ['add', 'src/settings.mjs'], { cwd: task.repoRoot });
          execFileSync('git', ['commit', '-q', '-m', 'Resolve local settings conflict'], { cwd: task.repoRoot });
          return { ...completedWorker({ decision: 'acted', summary: 'Apply the conflict repair while retaining branch requirements.' }), model: invocation.modelSpec.model };
        },
      };
      try {
        expect((await judgeMergeConflictTask(task)).passed).toBe(false);
        expect(task.oraclePin).toMatch(/^[a-f0-9]{64}$/);
        const outcome = await executeMergeConflictTask(task, driver);
        expect(expectOk(outcome).decision).toBe('acted');
        const report = await judgeMergeConflictTask(task);
        expect(report).toMatchObject({ passed: true, sourceId: task.sourceId, baselineId: task.baselineId, oracleId: task.oracleId });
        expect(task.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await task.cleanup();
      }
    },
    90_000,
  );

  it.each(['nestedUnit', 'serviceLeaf'] as const)(
    'executes the exported fleet planner for the independent $variant package substrate', async (variant) => {
      const task = await createFleetSweepTask(variant);
      try {
        expect(task.baselineCommit).toMatch(/^[a-f0-9]{40}$/);
        expect(task.oraclePin).toMatch(/^[a-f0-9]{64}$/);
        const { report, oracle } = await executeFleetSweepTask(task);
        expect(oracle).toMatchObject({ passed: true, sourceId: task.sourceId, baselineId: task.baselineId, oracleId: task.oracleId });
        expect((report as { units: { package: string }[] }).units.map((unit) => unit.package)).toEqual([task.expectedPackage]);
      } finally {
        await task.cleanup();
      }
    },
    30_000,
  );
});

describe('six-task corpus expansion', () => {
  it('defines six distinct task, substrate, source, baseline, and oracle identities', () => {
    const contracts = [
      REVIEW_TASK_CONTRACTS.roleScope,
      REVIEW_TASK_CONTRACTS.labelNfc,
      ANALYSIS_TASK_CONTRACTS.safeIntegerSetting,
      ANALYSIS_TASK_CONTRACTS.originPolicy,
      MERGE_ORIGIN_CONTRACT,
      FLEET_TEST_UNIT_CONTRACT,
    ];
    for (const field of ['id', 'sourceId', 'baselineId', 'oracleId', 'substrateFamily'] as const) {
      expect(new Set(contracts.map((contract) => contract[field])).size).toBe(6);
    }
  });

  it('judges analysis proposal meaning without depending on prose formatting', () => {
    const integerProposal = judgeAnalysisProposalMeaning('safeIntegerSetting', {
      setting: 'maxParallelJobs',
      constraints: ['integer', 'safe-integer', 'range-1-through-64'],
      rejectsInvalidValues: true,
      preservesInputRepresentation: true,
    });
    expect(integerProposal.passed).toBe(true);
    expect(judgeAnalysisProposalMeaning('safeIntegerSetting', {
      setting: 'maxParallelJobs', constraints: ['integer'], rejectsInvalidValues: true, preservesInputRepresentation: true,
    }).passed).toBe(false);
    expect(ANALYSIS_TASK_CONTRACTS.safeIntegerSetting.expected).toEqual([true, true, false, false, false, false, false, false]);
    expect(ANALYSIS_TASK_CONTRACTS.originPolicy.expected).toEqual([true, false, false, false, true, true]);
  });

  it.each(['safeIntegerSetting', 'originPolicy'] as const)(
    'runs the existing analysis operation for the $variant task through an injected local Driver',
    async (variant) => {
      const modelSpec = { model: `offline-${variant}`, provider: 'fake' };
      const task = await createAnalysisRemediationTask(variant, modelSpec);
      const contract = ANALYSIS_TASK_CONTRACTS[variant];
      const invocations: Parameters<Driver['run']>[0][] = [];
      const driver: Driver = {
        async run(invocation) {
          invocations.push(invocation);
          return completedWorker({
            setting: contract.setting,
            constraints: [...contract.requiredConstraints],
            rejectsInvalidValues: true,
            preservesInputRepresentation: true,
          });
        },
      };
      try {
        const execution = await executeAnalysisRemediationTask(task, driver);
        expect(execution.oracle).toMatchObject({
          passed: true,
          sourceId: task.sourceId,
          baselineId: task.baselineId,
          oracleId: task.oracleId,
          failures: [],
        });
        expect(invocations).toHaveLength(1);
        expect(invocations[0]?.modelSpec).toEqual(modelSpec);
      } finally {
        await task.cleanup();
      }
    },
    30_000,
  );

  it('checks review, merge, and fleet behavior vectors with the task-owned truth tables', () => {
    expect(judgeReviewTaskValues('roleScope', [true, true, false, false]).passed).toBe(true);
    expect(judgeReviewTaskValues('roleScope', [true, false, false, false]).passed).toBe(false);
    expect(judgeReviewTaskValues('labelNfc', [true, false, true, false, true]).passed).toBe(true);
    expect(judgeMergeOriginValues([...MERGE_ORIGIN_CONTRACT.expected]).passed).toBe(true);
    expect(judgeMergeOriginValues(['file', 'file', 'builtin']).passed).toBe(false);
    expect(judgeFleetUnitValues([...FLEET_TEST_UNIT_CONTRACT.expected]).passed).toBe(true);
    expect(judgeFleetUnitValues([null, null, { status: 'ready', value: { id: 'task-1', title: 'Repair setting' } }, { status: 'invalid' }]).passed).toBe(false);
  });

  it('runs synthetic review, merge, and fleet candidates only through the protected child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cq-protected-corpus-candidate-'));
    try {
      await mkdir(join(root, 'settings'), { recursive: true });
      const rolePath = join(root, 'settings/review-permissions.mjs');
      await writeFile(rolePath, `export function canEditCampaign(actorId, ownerId, role, grants = []) { return typeof actorId === 'string' && actorId.length > 0 && (actorId === ownerId || (role === 'admin' && grants.includes('campaign:edit'))); }\n`);
      expect((await judgeReviewTaskCandidate('roleScope', root)).passed).toBe(true);
      await writeFile(rolePath, `export function canEditCampaign(actorId, ownerId) { return actorId === ownerId; }\n`);
      expect((await judgeReviewTaskCandidate('roleScope', root)).passed).toBe(false);

      const nfcPath = join(root, 'settings/campaign-labels.mjs');
      await writeFile(nfcPath, `export function sameCampaignLabel(a,b) { return typeof a === 'string' && typeof b === 'string' && a.trim() !== '' && b.trim() !== '' && a.trim().normalize('NFC') === b.trim().normalize('NFC'); }\n`);
      await writeFile(join(root, 'settings/display.mjs'), `export function displayCampaignLabel(value) { return value; }\n`);
      expect((await judgeReviewTaskCandidate('labelNfc', root)).passed).toBe(true);
      await writeFile(nfcPath, `export function sameCampaignLabel(a,b) { return typeof a === 'string' && typeof b === 'string' && a.trim() === b.trim(); }\n`);
      expect((await judgeReviewTaskCandidate('labelNfc', root)).passed).toBe(false);

      const mergePath = join(root, 'settings/origin-precedence.mjs');
      await writeFile(mergePath, `export function resolveCampaignSetting(env,file,builtin) { return file ?? builtin ?? env; }\n`);
      expect((await judgeMergeOriginCandidate(root)).passed).toBe(false);
      await writeFile(mergePath, `export function resolveCampaignSetting(env,file,builtin) { return env ?? file ?? builtin; }\n`);
      expect((await judgeMergeOriginCandidate(root)).passed).toBe(true);
      await writeFile(mergePath, `export function resolveCampaignSetting(env,file,builtin) { for (const value of [env,file,builtin]) if (value != null) return value; return null; }\n`);
      expect((await judgeMergeOriginCandidate(root)).passed).toBe(true);

      await mkdir(join(root, 'packages/settings'), { recursive: true });
      const fleetPath = join(root, FLEET_TEST_UNIT_CONTRACT.module);
      await writeFile(fleetPath, `export function normalizeWorkItem(value) { if (value == null) return null; return typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string' && typeof value.title === 'string' ? {status:'ready',value:{id:value.id,title:value.title}} : {status:'invalid'}; }\n`);
      expect((await judgeFleetUnitCandidate(root)).passed).toBe(false);
      await writeFile(fleetPath, `export function normalizeWorkItem(value) { if (value == null) return {status:'empty',value:''}; if (typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || typeof value.title !== 'string') return {status:'invalid'}; return {status:'ready',value:{id:value.id,title:value.title}}; }\n`);
      expect((await judgeFleetUnitCandidate(root)).passed).toBe(true);
      await writeFile(fleetPath, `export function normalizeWorkItem(value) { if (value === undefined || value === null) return {value:'',status:'empty'}; if (typeof value === 'object' && !Array.isArray(value) && 'id' in value && 'title' in value) return {value:{title:value.title,id:value.id},status:'ready'}; return {status:'invalid'}; }\n`);
      expect((await judgeFleetUnitCandidate(root)).passed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('materializes fresh seeded repositories with immutable baseline commits', async () => {
    const modelSpec = { model: 'offline-corpus-only', provider: 'fake' };
    const tasks = [
      await createReviewRoleScopeTask(modelSpec),
      await createReviewLabelNfcTask(modelSpec),
      await createAnalysisRemediationTask('safeIntegerSetting', modelSpec),
      await createAnalysisRemediationTask('originPolicy', modelSpec),
      await createIntegrationMergeTask('originPrecedence', modelSpec),
      await createFleetTestUnitRepairTask(),
    ];
    try {
      expect(new Set(tasks.map((task) => task.id)).size).toBe(6);
      expect(tasks.every((task) => /^[a-f0-9]{40}$/.test(task.baselineCommit))).toBe(true);
      expect(tasks.every((task) => /^[a-f0-9]{64}$/.test(task.oraclePin))).toBe(true);
    } finally {
      await Promise.all(tasks.map((task) => task.cleanup()));
    }
  }, 120_000);

  it('runs makeSweepUnitOp with local-only bindings and grades its committed worktree in the protected child', async () => {
    const task = await createFleetTestUnitRepairTask();
    const candidateSource = `export function normalizeWorkItem(value) { if (value == null) return {status:'empty',value:''}; if (typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || typeof value.title !== 'string') return {status:'invalid'}; return {status:'ready',value:{id:value.id,title:value.title}}; }\n`;
    const driver: Driver = {
      async run(invocation) {
        const worktreePath = invocation.prompt.match(/^worktree: (.+)$/m)?.[1];
        if (!worktreePath) throw new Error('local corpus prompt omitted the task worktree path');
        await writeFile(join(worktreePath, 'packages/settings/normalize-work-item.mjs'), candidateSource);
        return { ...completedWorker({ changed: true, summary: 'Return the documented empty result for missing and null input.' }), model: invocation.modelSpec.model };
      },
    };
    try {
      const operation = expectOk(await executeFleetTestUnitRepairTask(task, driver));
      expect(operation.package).toBe('settings');
      expect(operation.committed).toBe(true);
      const report = await judgeFleetTestUnitRepairTask(task, operation.worktree.path);
      expect(report).toMatchObject({ passed: true, sourceId: task.sourceId, baselineId: task.baselineId, oracleId: task.oracleId });
      expect(report.failures).toEqual([]);
    } finally {
      await task.cleanup();
    }
  }, 120_000);

  it('judges the merge task with behavior, branch-intent preservation, scope, and ancestry as separate facts', async () => {
    const task = await createIntegrationMergeTask('originPrecedence', { model: 'offline-merge', provider: 'fake' });
    try {
      expect((await judgeMergeOriginConflictTask(task)).passed).toBe(false);
      await writeFile(task.settingsPath, `export function resolveCampaignSetting(env,file,builtin) { return env ?? file ?? builtin; }\n`);
      execFileSync('git', ['add', 'settings/origin-precedence.mjs'], { cwd: task.repoRoot });
      execFileSync('git', ['commit', '-q', '-m', 'Resolve local origin precedence conflict'], { cwd: task.repoRoot });
      const report = await judgeMergeOriginConflictTask(task);
      expect(report).toMatchObject({ passed: true, failures: [] });
    } finally {
      await task.cleanup();
    }
  }, 120_000);
});

/**
 * PK11 attempt 2 (D19/D20/D67/D69).
 *
 * Every receipt in this block is host-side: no protected judge child, no
 * Docker daemon and no evaluation route is required, so each fact below is
 * exercised independently of the expansion-task factories. The reviewed pin
 * transaction enables materialization but does not prove executor triplets.
 * Nothing here widens an oracle:
 * the added facts are scope, identity and named-failure discrimination only.
 */
describe('PK11 successor evidence: scope, identity, adapter and oracle discrimination', () => {
  const gitIn = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  const commitAll = (cwd: string, message: string): string => {
    gitIn(cwd, ['add', '-A']);
    gitIn(cwd, ['-c', 'user.name=CQ Corpus', '-c', 'user.email=corpus@example.invalid', 'commit', '-q', '-m', message]);
    return gitIn(cwd, ['rev-parse', 'HEAD']);
  };

  /** A minimal seeded candidate repository; deliberately not a corpus task factory. */
  async function seedRepo(files: Record<string, string>): Promise<{ root: string; cleanup(): Promise<void> }> {
    const root = await mkdtemp(join(tmpdir(), 'cq-pk11-identity-'));
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    }
    gitIn(root, ['init', '-q']);
    gitIn(root, ['config', 'user.name', 'CQ Local Corpus']);
    gitIn(root, ['config', 'user.email', 'cq-local-corpus@example.invalid']);
    commitAll(root, 'Seed candidate substrate');
    return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
  }

  it('D19: rejects a review candidate that changes anything outside its single allowed source path', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    const head = (): string => gitIn(task.worktreePath, ['rev-parse', 'HEAD']);    const judge = () => judgeReviewLoopWorkspace(task.worktreePath, {
      baselineRef: task.baselineCommit,
      sourceId: task.sourceId,
      baselineId: task.baselineId,
      oracleId: task.oracleId,
    });
    try {
      // (1) correct in-scope repair stays green on the scope fact alone.
      commitCandidate(task, ALTERNATIVE_SETTINGS_SOURCE);
      const inScope = await judge();
      expect(inScope.sourceTestAllowlist.passed).toBe(true);
      expect(inScope.sourceTestAllowlist.changedPaths).toEqual(['settings/module.js']);
      expect(inScope.sourceTestAllowlist.unexpectedPaths).toEqual([]);

      // (2) an extra in-repo file alongside a correct repair turns the fact red.
      writeFileSync(join(task.worktreePath, 'settings/extra.js'), 'export const bypass = true;\n');
      const extraPath = await judge();
      expect(extraPath.sourceTestAllowlist.passed).toBe(false);
      expect(extraPath.sourceTestAllowlist.unexpectedPaths).toEqual(['settings/extra.js']);
      expect(extraPath.passed).toBe(false);

      // (3) rewriting the pinned display module instead of the task module is red.
      const display = readFileSync(join(task.worktreePath, 'settings/display.js'), 'utf8');
      writeFileSync(join(task.worktreePath, 'settings/display.js'), `${display}export const tampered = true;\n`);
      const tampered = await judge();
      expect(tampered.sourceTestAllowlist.passed).toBe(false);
      expect(tampered.sourceTestAllowlist.unexpectedPaths).toContain('settings/display.js');
      expect(tampered.displayPreservation.passed).toBe(false);

      // (4) a candidate that changed nothing is red on scope, not merely un-green.
      gitIn(task.worktreePath, ['checkout', '-q', '--', '.']);
      gitIn(task.worktreePath, ['clean', '-qfd']);
      gitIn(task.worktreePath, ['reset', '-q', '--hard', task.baselineCommit]);
      const noChange = await judge();
      expect(noChange.sourceTestAllowlist.passed).toBe(false);
      expect(noChange.sourceTestAllowlist.changedPaths).toEqual([]);
      expect(head()).toBe(task.baselineCommit);
    } finally {
      await task.cleanup();
    }
  }, 600_000);

  it('D20: runSuite adapter pins an immutable baseline and never moves candidate HEAD', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    const bundle = await createReviewLoopRunSuiteBundle(task);
    let workspace = '';
    const driver: Driver = {
      async run(invocation) {
        workspace = invocation.prompt.match(/^workspace: (.+)$/m)?.[1] ?? '';
        const root = resolve(workspace);
        const baselineBefore = gitIn(root, ['rev-parse', 'HEAD']);
        writeFileSync(join(root, 'settings/module.js'), ALTERNATIVE_SETTINGS_SOURCE);
        gitIn(root, ['add', 'settings/module.js']);
        const candidateCommit = commitAll(root, 'Candidate repair commit');
        return {
          ...completedWorker({ fixed: true, notes: 'local repair' }),
          model: invocation.modelSpec.model,
          // The wrapper must observe, not undo, this movement.
          ...(candidateCommit === baselineBefore ? {} : {}),
        };
      },
    };
    try {
      const before = gitIn(task.worktreePath, ['rev-parse', 'HEAD']);
      const wrapped = bundle.wrapDriver(driver);
      const result = await wrapped.run({
        prompt: `workspace: ${task.worktreePath}`,
        modelSpec: OFFLINE_REVIEW_ROUTE,
      } as unknown as Parameters<Driver['run']>[0]);
      expect(result.structuredOutput).toMatchObject({ fixed: true });

      const after = gitIn(task.worktreePath, ['rev-parse', 'HEAD']);
      expect(after).not.toBe(before);
      expect(bundle.pinnedBaselineCommit(task.worktreePath)).toBe(before);
      expect(bundle.pinnedCandidateCommit(task.worktreePath)).toBe(after);
      // The wrapper records host-namespaced refs; it must not reset candidate HEAD.
      expect(gitIn(task.worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      await task.cleanup();
    }
  }, 120_000);

  it('D20: runSuite adapter refuses to host-score an uncaptured workspace or a disagreeing baseline pin', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    const bundle = await createReviewLoopRunSuiteBundle(task);
    try {
      const uncaptured = await mkdtemp(join(tmpdir(), 'cq-pk11-uncaptured-'));
      try {
        expect(() => bundle.hostCheckScoringEnvironment(uncaptured, task.baselineCommit))
          .toThrow('runSuite has not captured this workspace baseline yet');
      } finally {
        await rm(uncaptured, { recursive: true, force: true });
      }
      const captured = bundle.pinnedBaselineCommit(task.worktreePath);
      expect(captured).toBeUndefined();
      expect(() => bundle.hostCheckScoringEnvironment(task.worktreePath, '0'.repeat(40)))
        .toThrow('runSuite has not captured this workspace baseline yet');
    } finally {
      await task.cleanup();
    }
  }, 120_000);

  it('D20: wrapped Driver error propagates after the candidate commit is still recorded', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    const bundle = await createReviewLoopRunSuiteBundle(task);
    const driver: Driver = {
      async run() {
        const root = task.worktreePath;
        writeFileSync(join(root, 'settings/module.js'), ALTERNATIVE_SETTINGS_SOURCE);
        gitIn(root, ['add', 'settings/module.js']);
        commitAll(root, 'Committed then failed');
        throw new Error('local driver transport ended after commit');
      },
    };
    try {
      const wrapped = bundle.wrapDriver(driver);
      await expect(wrapped.run({ prompt: `workspace: ${task.worktreePath}`, modelSpec: OFFLINE_REVIEW_ROUTE } as unknown as Parameters<Driver['run']>[0]))
        .rejects.toThrow('local driver transport ended after commit');
      // D20's core property: the commit survives a failed run and HEAD is untouched by the wrapper.
      expect(bundle.pinnedBaselineCommit(task.worktreePath)).toBe(task.baselineCommit);
      expect(bundle.pinnedCandidateCommit(task.worktreePath)).not.toBe(task.baselineCommit);
    } finally {
      await task.cleanup();
    }
  }, 120_000);

  it('D20: wrapped Driver rejects an invocation that carries no workspace path', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    const bundle = await createReviewLoopRunSuiteBundle(task);
    const driver: Driver = { async run() { throw new Error('unreachable'); } };
    try {
      const wrapped = bundle.wrapDriver(driver);
      await expect(wrapped.run({ prompt: 'no workspace here', modelSpec: OFFLINE_REVIEW_ROUTE } as unknown as Parameters<Driver['run']>[0]))
        .rejects.toThrow('runSuite invocation omitted workspace path');
    } finally {
      await task.cleanup();
    }
  }, 30_000);

  it('D20: wrapper delegates cancel and capability access to the underlying driver', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    const bundle = await createReviewLoopRunSuiteBundle(task);
    let cancelled = false;
    const driver: Driver & { cancel(): void; capabilities?: { readonly label: string } } = {
      cancel() { cancelled = true; },
      capabilities: { label: 'local-corpus-driver' },
      async run() { throw new Error('unreachable'); },
    };
    try {
      const wrapped = bundle.wrapDriver(driver) as unknown as Driver & { cancel(): void; capabilities?: { readonly label: string } };
      wrapped.cancel();
      expect(cancelled).toBe(true);
      expect(wrapped.capabilities?.label).toBe('local-corpus-driver');
    } finally {
      await task.cleanup();
    }
  }, 30_000);

  it('D67: review expansion candidates are judged on scope, identity and candidate bytes, not reference bytes', async () => {
    const reference = `export function canEditCampaign(actorId, ownerId, role, grants = []) {\n  if (typeof actorId !== 'string' || actorId.length === 0) return false;\n  if (actorId === ownerId) return true;\n  return role === 'admin' && grants.includes('campaign:edit');\n}\n`;
    const alternative = `export function canEditCampaign(actorId, ownerId, role, grants = []) {\n  const isOwner = actorId === ownerId;\n  const isGrantedAdmin = role === 'admin' && Array.from(grants).includes('campaign:edit');\n  return typeof actorId === 'string' && actorId.length > 0 && (isOwner || isGrantedAdmin);\n}\n`;
    const seed = {
      'settings/review-permissions.mjs': 'export function canEditCampaign(actorId, ownerId) { return actorId === ownerId; }\n',
      'test/public-settings.test.mjs': 'import assert from "node:assert/strict";\n',
    };

    const referenceRepo = await seedRepo(seed);
    const alternativeRepo = await seedRepo(seed);
    const outOfScopeRepo = await seedRepo(seed);
    const dirtyRepo = await seedRepo(seed);
    const pristineRepo = await seedRepo(seed);
    try {
      // Reference repair: in scope, committed, non-empty patch.
      writeFileSync(join(referenceRepo.root, 'settings/review-permissions.mjs'), reference);
      const referenceCommit = commitAll(referenceRepo.root, 'Reference repair');
      const referenceIdentity = judgeReviewTaskCandidateIdentity('roleScope', {
        candidateRoot: referenceRepo.root,
        baselineCommit: gitIn(referenceRepo.root, ['rev-parse', `${referenceCommit}~1`]),
      });
      expect(referenceIdentity.failures).toEqual([]);
      expect(referenceIdentity.passed).toBe(true);
      expect(referenceIdentity.candidateCommit).toBe(referenceCommit);
      expect(referenceIdentity.cleanGitCandidate).toBe(true);
      expect(referenceIdentity.candidatePatchSha256).toMatch(/^[a-f0-9]{64}$/);

      // Materially alternative repair: different bytes, identical scope verdict.
      writeFileSync(join(alternativeRepo.root, 'settings/review-permissions.mjs'), alternative);
      commitAll(alternativeRepo.root, 'Alternative repair');
      const alternativeIdentity = judgeReviewTaskCandidateIdentity('roleScope', {
        candidateRoot: alternativeRepo.root,
        baselineCommit: gitIn(alternativeRepo.root, ['rev-parse', 'HEAD~1']),
      });
      expect(alternativeIdentity.passed).toBe(true);
      expect(alternativeIdentity.candidatePatchSha256).not.toBe(referenceIdentity.candidatePatchSha256);

      // Out-of-scope repair: correct file plus a rewritten public test stays red.
      writeFileSync(join(outOfScopeRepo.root, 'settings/review-permissions.mjs'), reference);
      writeFileSync(join(outOfScopeRepo.root, 'test/public-settings.test.mjs'), '// rewritten by the candidate\n');
      commitAll(outOfScopeRepo.root, 'Out-of-scope repair');
      const outOfScope = judgeReviewTaskCandidateIdentity('roleScope', {
        candidateRoot: outOfScopeRepo.root,
        baselineCommit: gitIn(outOfScopeRepo.root, ['rev-parse', 'HEAD~1']),
      });
      expect(outOfScope.passed).toBe(false);
      expect(outOfScope.failures).toContain('candidate changed paths did not exactly match its task allowlist');

      // Uncommitted repair: identity stays red even though the bytes are correct.
      writeFileSync(join(dirtyRepo.root, 'settings/review-permissions.mjs'), reference);
      const dirty = judgeReviewTaskCandidateIdentity('roleScope', {
        candidateRoot: dirtyRepo.root,
        baselineCommit: gitIn(dirtyRepo.root, ['rev-parse', 'HEAD']),
      });
      expect(dirty.passed).toBe(false);
      expect(dirty.cleanGitCandidate).toBe(false);
      expect(dirty.failures).toContain('candidate has uncommitted or untracked repository changes');
      expect(dirty.failures).toContain('candidate HEAD is still the pristine baseline');

      // A candidate that changed nothing is red, never vacuously green.
      const pristine = judgeReviewTaskCandidateIdentity('roleScope', {
        candidateRoot: pristineRepo.root,
        baselineCommit: gitIn(pristineRepo.root, ['rev-parse', 'HEAD']),
      });
      expect(pristine.passed).toBe(false);
      expect(pristine.failures).toContain('candidate HEAD is still the pristine baseline');
      expect(pristine.failures).toContain('candidate patch bytes are empty');

      // A rewritten history is red and names ancestry instead of collapsing into scope.
      const rewritten = gitIn(alternativeRepo.root, ['rev-parse', 'HEAD~1']);
      gitIn(alternativeRepo.root, ['checkout', '-q', '--orphan', 'rewritten']);
      gitIn(alternativeRepo.root, ['rm', '-rq', '--cached', '.']);
      writeFileSync(join(alternativeRepo.root, 'settings/review-permissions.mjs'), 'export function canEditCampaign(actorId) { return actorId === "anyone"; }\n');
      commitAll(alternativeRepo.root, 'Rewritten history');
      const ancestry = judgeReviewTaskCandidateIdentity('roleScope', {
        candidateRoot: alternativeRepo.root,
        baselineCommit: rewritten,
      });
      expect(ancestry.passed).toBe(false);
      expect(ancestry.failures).toContain('recorded baseline commit is not an ancestor of the candidate');

      // The label task carries its own single-path scope.
      expect(REVIEW_TASK_CONTRACTS.roleScope.allowedPaths).toEqual(['settings/review-permissions.mjs']);
      expect(REVIEW_TASK_CONTRACTS.labelNfc.allowedPaths).toEqual(['settings/campaign-labels.mjs']);
    } finally {
      await Promise.all([
        referenceRepo.cleanup(), alternativeRepo.cleanup(), outOfScopeRepo.cleanup(),
        dirtyRepo.cleanup(), pristineRepo.cleanup(),
      ]);
    }
  }, 300_000);

  it('D67: submission oracle keeps behavior, scope and identity as separate facts', async () => {
    const repo = await seedRepo({ 'settings/review-permissions.mjs': 'export function canEditCampaign(actorId, ownerId) { return actorId === ownerId; }\n' });
    try {
      const baseline = gitIn(repo.root, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo.root, 'settings/review-permissions.mjs'), 'export function canEditCampaign(actorId, ownerId, role, grants = []) {\n  if (typeof actorId !== "string" || actorId.length === 0) return false;\n  return actorId === ownerId || (role === "admin" && grants.includes("campaign:edit"));\n}\n');
      commitAll(repo.root, 'Reference repair');
      const report = await judgeReviewTaskSubmission('roleScope', { candidateRoot: repo.root, baselineCommit: baseline });
      // Identity and scope are decided on the host regardless of protected-child availability.
      expect(report.identity.passed).toBe(true);
      expect(report.candidatePatchSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report.identity.failures).toEqual([]);
      // Behavior is judged only through the protected child; when it is unavailable the
      // report stays red and says so instead of collapsing into a scope verdict.
      if (!report.behavior.passed) {
        expect(report.behavior.failures.join(' ')).toMatch(/protected candidate execution/);
        expect(report.passed).toBe(false);
      }
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('D67/D69: merge oracle reports ancestry, scope and no-commit as distinct named facts', async () => {
    const seed = { 'src/settings.mjs': 'export function campaignLabel(value) { return typeof value === "string" ? value : ""; }\n' };
    const correct = 'export function campaignLabel(value) { const label = typeof value === "string" ? value.trim() : ""; return [...label].length <= 40 ? label : ""; }\n';

    const noCommit = await seedRepo(seed);
    const outOfScope = await seedRepo(seed);
    const rewritten = await seedRepo(seed);
    const inScope = await seedRepo(seed);
    try {
      const baselineNoCommit = gitIn(noCommit.root, ['rev-parse', 'HEAD']);
      const noCommitReport = await judgeMergeConflictWorkspace(noCommit.root, baselineNoCommit);
      expect(noCommitReport.passed).toBe(false);
      expect(noCommitReport.failures).toContain('candidate did not create a new commit');

      const baselineOutOfScope = gitIn(outOfScope.root, ['rev-parse', 'HEAD']);
      writeFileSync(join(outOfScope.root, 'src/settings.mjs'), correct);
      writeFileSync(join(outOfScope.root, 'src/extra.mjs'), 'export const bypass = true;\n');
      commitAll(outOfScope.root, 'Out-of-scope merge resolution');
      const outOfScopeReport = await judgeMergeConflictWorkspace(outOfScope.root, baselineOutOfScope);
      expect(outOfScopeReport.passed).toBe(false);
      expect(outOfScopeReport.failures.some((failure) => failure.startsWith('unexpected candidate paths:'))).toBe(true);
      expect(outOfScopeReport.failures).not.toContain('recorded baseline commit is not an ancestor of the candidate');

      const baselineRewritten = gitIn(rewritten.root, ['rev-parse', 'HEAD']);
      writeFileSync(join(rewritten.root, 'src/settings.mjs'), correct);
      commitAll(rewritten.root, 'First resolution');
      gitIn(rewritten.root, ['checkout', '-q', '--orphan', 'rebased']);
      gitIn(rewritten.root, ['rm', '-rq', '--cached', '.']);
      writeFileSync(join(rewritten.root, 'src/settings.mjs'), correct);
      commitAll(rewritten.root, 'Rebased resolution');
      const rewrittenReport = await judgeMergeConflictWorkspace(rewritten.root, baselineRewritten);
      expect(rewrittenReport.passed).toBe(false);
      expect(rewrittenReport.failures).toContain('recorded baseline commit is not an ancestor of the candidate');
      // Non-conflation: the named ancestry failure must not be reported as unreadable state.
      expect(rewrittenReport.failures).not.toContain('merge candidate repository state could not be read');
      expect(rewrittenReport.failures).not.toContain('merge candidate identity or protected behavior check failed');

      const baselineInScope = gitIn(inScope.root, ['rev-parse', 'HEAD']);
      writeFileSync(join(inScope.root, 'src/settings.mjs'), correct);
      commitAll(inScope.root, 'In-scope merge resolution');
      const inScopeReport = await judgeMergeConflictWorkspace(inScope.root, baselineInScope);
      expect(inScopeReport.failures).toEqual([]);
      expect(inScopeReport.passed).toBe(true);

      // D69: the astral 40/41 code-point boundary is now pinned through the oracle
      // itself, not only through a direct candidate import. This implementation
      // mis-counts code points as at most 20, so it is red exactly at the boundary.
      const wrongBoundary = await seedRepo(seed);
      const alternative = await seedRepo(seed);
      try {
        const boundaryBaseline = gitIn(wrongBoundary.root, ['rev-parse', 'HEAD']);
        writeFileSync(join(wrongBoundary.root, 'src/settings.mjs'), 'export function campaignLabel(value) { const label = typeof value === "string" ? value.trim() : ""; return [...label].length <= 20 ? label : ""; }\n');
        commitAll(wrongBoundary.root, 'Wrong boundary');
        const boundaryReport = await judgeMergeConflictWorkspace(wrongBoundary.root, boundaryBaseline);
        expect(boundaryReport.passed).toBe(false);
        expect(boundaryReport.failures).toContain('merge candidate failed an independent behavior case');
        // The scope, ancestry and commit facts stayed green: only behavior failed.
        expect(boundaryReport.failures).not.toContain('recorded baseline commit is not an ancestor of the candidate');

        // A materially alternative but correct merge resolution stays green.
        const alternativeBaseline = gitIn(alternative.root, ['rev-parse', 'HEAD']);
        writeFileSync(join(alternative.root, 'src/settings.mjs'), 'export function campaignLabel(value) {\n  if (typeof value !== "string") return "";\n  const trimmed = value.trim();\n  const codePoints = Array.from(trimmed);\n  return codePoints.length <= 40 ? codePoints.join("") : "";\n}\n');
        commitAll(alternative.root, 'Alternative resolution');
        const alternativeReport = await judgeMergeConflictWorkspace(alternative.root, alternativeBaseline);
        expect(alternativeReport.failures).toEqual([]);
        expect(alternativeReport.passed).toBe(true);
      } finally {
        await Promise.all([wrongBoundary.cleanup(), alternative.cleanup()]);
      }
    } finally {
      await Promise.all([noCommit.cleanup(), outOfScope.cleanup(), rewritten.cleanup(), inScope.cleanup()]);
    }
  }, 600_000);

  it('D67: shared local identity oracle names ancestry and scope failures separately', async () => {
    // Mirrors judgeMergeOriginConflictTask, which scopes the merge candidate to the
    // single settings path and checks the intention files separately.
    const allowed = ['settings/origin-precedence.mjs'];
    const seed = {
      'settings/origin-precedence.mjs': 'export function resolveCampaignSetting(env, file, builtin) { return builtin; }\n',
      'branch-intentions/main.md': 'main intent\n',
      'branch-intentions/feature.md': 'feature intent\n',
    };

    const exact = await seedRepo(seed);
    const extra = await seedRepo(seed);
    const orphan = await seedRepo(seed);
    const subsetFleet = await seedRepo(seed);
    try {
      const exactBaseline = gitIn(exact.root, ['rev-parse', 'HEAD']);
      writeFileSync(join(exact.root, 'settings/origin-precedence.mjs'), 'export function resolveCampaignSetting(env, file, builtin) { return env ?? file ?? builtin; }\n');
      commitAll(exact.root, 'Exact-scope resolution');
      const exactReport = judgeLocalCandidateIdentity({
        repoRoot: exact.root, baselineCommit: exactBaseline, allowedPaths: allowed,
      });
      expect(exactReport.passed).toBe(true);
      expect(exactReport.failures).toEqual([]);
      expect(exactReport.patchSha256).toMatch(/^[a-f0-9]{64}$/);

      const extraBaseline = gitIn(extra.root, ['rev-parse', 'HEAD']);
      writeFileSync(join(extra.root, 'settings/origin-precedence.mjs'), 'export function resolveCampaignSetting(env, file, builtin) { return env ?? file ?? builtin; }\n');
      writeFileSync(join(extra.root, 'settings/extra.mjs'), 'export const bypass = true;\n');
      commitAll(extra.root, 'Over-scope resolution');
      const extraReport = judgeLocalCandidateIdentity({
        repoRoot: extra.root, baselineCommit: extraBaseline, allowedPaths: allowed,
      });
      expect(extraReport.passed).toBe(false);
      expect(extraReport.failures).toContain('candidate changed paths did not exactly match its task allowlist');
      expect(extraReport.failures).not.toContain('candidate identity or scope could not be verified');

      const orphanBaseline = gitIn(orphan.root, ['rev-parse', 'HEAD']);
      writeFileSync(join(orphan.root, 'settings/origin-precedence.mjs'), 'export function resolveCampaignSetting(env, file, builtin) { return env ?? file ?? builtin; }\n');
      commitAll(orphan.root, 'First resolution');
      gitIn(orphan.root, ['checkout', '-q', '--orphan', 'rebased']);
      gitIn(orphan.root, ['rm', '-rq', '--cached', '.']);
      writeFileSync(join(orphan.root, 'settings/origin-precedence.mjs'), 'export function resolveCampaignSetting(env, file, builtin) { return env ?? file ?? builtin; }\n');
      commitAll(orphan.root, 'Rebased resolution');
      const orphanReport = judgeLocalCandidateIdentity({
        repoRoot: orphan.root, baselineCommit: orphanBaseline, allowedPaths: allowed,
      });
      expect(orphanReport.passed).toBe(false);
      expect(orphanReport.failures).toContain('recorded baseline commit is not an ancestor of the candidate');
      expect(orphanReport.failures).not.toContain('candidate identity or scope could not be verified');

      expect(MERGE_ORIGIN_CONTRACT.allowedPaths).toEqual([
        'branch-intentions/feature.md',
        'branch-intentions/main.md',
        'settings/origin-precedence.mjs',
      ]);

      // Fleet uses subset-with-nonzero scope. Both the accepting and the rejecting
      // shapes are pinned here so the semantics cannot drift silently; whether the
      // brief's "exact" wording should tighten this is conductor question LR4/N4.
      const fleetBaseline = gitIn(subsetFleet.root, ['rev-parse', 'HEAD']);
      writeFileSync(join(subsetFleet.root, 'settings/origin-precedence.mjs'), 'export function resolveCampaignSetting(env, file, builtin) { return env ?? file ?? builtin; }\n');
      commitAll(subsetFleet.root, 'Subset-scope resolution');
      const subsetReport = judgeLocalCandidateIdentity({
        repoRoot: subsetFleet.root,
        baselineCommit: fleetBaseline,
        allowedPaths: allowed,
        exactPaths: false,
      });
      expect(subsetReport.passed).toBe(true);

      const noChangeReport = judgeLocalCandidateIdentity({
        repoRoot: subsetFleet.root,
        baselineCommit: gitIn(subsetFleet.root, ['rev-parse', 'HEAD']),
        allowedPaths: allowed,
        exactPaths: false,
      });
      expect(noChangeReport.passed).toBe(false);
      expect(noChangeReport.failures).toContain('candidate changed paths outside its task allowlist or made no change');
    } finally {
      await Promise.all([exact.cleanup(), extra.cleanup(), orphan.cleanup(), subsetFleet.cleanup()]);
    }
  }, 300_000);

  it('D67: the review oracle pin covers the full runtime import closure of the host judge', () => {
    // Generator-level invariant. It is independent of the committed JSON manifests,
    // which PK00 owns, so it stays meaningful before and after the pin transaction.
    const pin = createReviewLoopOraclePin();
    const paths = pin.dependencies.map((dependency) => dependency.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const required of [
      // Value-imported by pinned boundary modules but previously omitted.
      'runner/boundary/assignment-supervisor-owner.ts',
      'runner/boundary/g2-daemon-contract.ts',
      // Reached because the review expansion oracle delegates scope/ancestry.
      'campaigns/cq-settings/corpus/integration-task-oracles.ts',
    ]) {
      expect(paths).toContain(required);
    }
    // Explicitly classified as compile-time only, so it stays unpinned by decision.
    expect(paths).not.toContain('runner/boundary/assignment-supervisor.ts');
    expect(pin.sha256).toMatch(/^[a-f0-9]{64}$/);
    for (const dependency of pin.dependencies) {
      expect(dependency.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('D19: analysis boundary vectors are executed by the host truth table, and no proposal oracle was widened', () => {
    const integerVector = [...ANALYSIS_TASK_CONTRACTS.safeIntegerSetting.expected];
    const originVector = [...ANALYSIS_TASK_CONTRACTS.originPolicy.expected];
    expect(evaluateAnalysisTaskVectors('safeIntegerSetting', integerVector)).toBe(true);
    expect(evaluateAnalysisTaskVectors('originPolicy', originVector)).toBe(true);
    // The vector truth table discriminates rather than echoing its own expectation.
    expect(evaluateAnalysisTaskVectors('safeIntegerSetting', integerVector.map((value) => !value))).toBe(false);
    expect(evaluateAnalysisTaskVectors('safeIntegerSetting', integerVector.slice(0, -1))).toBe(false);
    expect(evaluateAnalysisTaskVectors('originPolicy', originVector.slice(1))).toBe(false);
    expect(evaluateAnalysisTaskVectors('safeIntegerSetting', 'not-an-array')).toBe(false);

    // Current semantics are pinned unchanged: a materially alternative proposal that
    // does not carry the host constraint tokens is still rejected. Any future widening
    // must arrive as a deliberate, conductor-pinned oracle-pin change (LR4), not as a
    // side effect of this packet.
    expect(judgeAnalysisProposalMeaning('safeIntegerSetting', {
      setting: 'maxParallelJobs',
      constraints: ['integer', 'safe-integer', 'range-1-through-64'],
      rejectsInvalidValues: true,
      preservesInputRepresentation: true,
    }).passed).toBe(true);
    expect(judgeAnalysisProposalMeaning('safeIntegerSetting', {
      setting: 'maxParallelJobs',
      constraints: ['integer', 'rejects fractional and unsafe values', 'stays within 1..64'],
      rejectsInvalidValues: true,
      preservesInputRepresentation: true,
    }).passed).toBe(false);
    expect(judgeAnalysisProposalMeaning('safeIntegerSetting', {
      setting: 'someOtherSetting',
      constraints: ['integer', 'safe-integer', 'range-1-through-64'],
      rejectsInvalidValues: true,
      preservesInputRepresentation: true,
    }).passed).toBe(false);
    expect(judgeAnalysisProposalMeaning('safeIntegerSetting', {
      setting: 'maxParallelJobs',
      constraints: ['integer', 'safe-integer', 'range-1-through-64'],
      rejectsInvalidValues: false,
      preservesInputRepresentation: true,
    }).passed).toBe(false);
    expect(judgeAnalysisProposalMeaning('safeIntegerSetting', {
      setting: 'maxParallelJobs',
      constraints: ['integer', 'safe-integer', 'range-1-through-64'],
      rejectsInvalidValues: true,
      preservesInputRepresentation: false,
    }).passed).toBe(false);
  });

  it('D67: reviewed successor pins match the exact source bytes', () => {
    // The failing-before receipt for stale pins remains in the prior matrix log.
    // A matching pin enables materialization; executor red/green adequacy is separate.
    for (const name of [
      'operation-oracle-pins.json',
      'integration-oracle-pins.json',
      'review-loop-oracle-pin.json',
    ]) {
      const manifest = JSON.parse(readFileSync(new URL(`../campaigns/cq-settings/corpus/${name}`, import.meta.url), 'utf8')) as {
        dependencies: { path: string; sha256: string }[];
      };
      expect(manifest.dependencies.length).toBeGreaterThan(0);
      for (const entry of manifest.dependencies) {
        const actual = createHash('sha256').update(readFileSync(new URL(`../${entry.path}`, import.meta.url))).digest('hex');
        expect(entry.sha256, `${name}: ${entry.path}`).toBe(actual);
      }
    }
  });
});

/**
 * PK11 successor visible-corpus evidence at the reviewed pin epoch.
 *
 * Each of the six expansion tasks is exercised through its real local executor
 * (injected deterministic Driver, exported toolkit operation, local-only Git)
 * and judged through the task-owned semantic oracle. For every task this block
 * records: seeded-baseline red, reference green, materially different
 * alternative green, and scope/ancestry negative controls, keeping those facts
 * separately attributable.
 *
 * Scope limits kept in force: no model or evaluation target, no daemon
 * provisioning, no shared namespace, no credits, no auth, no publication or
 * merge, no private held-out task, and no oracle widening. The fleet allowlist
 * question (subset-with-nonzero vs the brief's exact wording) is deliberately
 * left unresolved; only behaviours that hold under the current implementation
 * are asserted.
 */
describe('six visible expansion tasks: executor-level red, reference, alternative and negatives', () => {
  const ROUTE = { model: 'offline-corpus-only', provider: 'fake' } as const;

  const gitIn = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  const commitAll = (cwd: string, message: string): string => {
    gitIn(cwd, ['add', '-A']);
    gitIn(cwd, ['-c', 'user.name=CQ Corpus', '-c', 'user.email=corpus@example.invalid', 'commit', '-q', '-m', message]);
    return gitIn(cwd, ['rev-parse', 'HEAD']);
  };

  /** Detach HEAD from the recorded baseline so ancestry must be judged by name. */
  const orphanHistory = (cwd: string, message: string): void => {
    gitIn(cwd, ['checkout', '-q', '--orphan', 'rewritten-history']);
    gitIn(cwd, ['rm', '-rq', '--cached', '.']);
    commitAll(cwd, message);
  };

  const worker = (structuredOutput: unknown) => ({
    ...completedWorker(structuredOutput),
  });

  /**
   * A Driver that writes the supplied task files, commits, then reports honestly.
   * The review operation requires the exact fix contract: keys changed/summary/commits,
   * with commits non-empty exactly when changed is true.
   */
  const editingDriver = (
    root: string,
    files: Record<string, string>,
    options: { changed?: boolean; throwAfterCommit?: boolean } = {},
  ): Driver => ({
    async run(invocation) {
      for (const [path, contents] of Object.entries(files)) {
        writeFileSync(join(root, path), contents);
      }
      let commits: string[] = [];
      if (options.throwAfterCommit) commits = [commitAll(root, 'Committed then transport failed')];
      else if (options.changed !== false) commits = [commitAll(root, 'Candidate repair commit')];
      if (options.throwAfterCommit) throw new Error('local driver transport ended after commit');
      const changed = commits.length > 0;
      return {
        ...worker({
          changed,
          summary: 'Applied the task repair.',
          commits,
        }),
        model: invocation.modelSpec.model,
      };
    },
  });

  const ROLE_SCOPE_REFERENCE = `export function canEditCampaign(actorId, ownerId, role, grants = []) {
  if (typeof actorId !== 'string' || actorId.length === 0) return false;
  if (actorId === ownerId) return true;
  return role === 'admin' && grants.includes('campaign:edit');
}
`;
  const ROLE_SCOPE_ALTERNATIVE = `const EDIT_GRANT = 'campaign:edit';
export function canEditCampaign(actorId, ownerId, role, grants = []) {
  if (typeof actorId !== 'string' || actorId.length === 0) return false;
  const granted = new Set(Array.isArray(grants) ? grants : []);
  if (actorId === ownerId) return true;
  return role === 'admin' && granted.has(EDIT_GRANT);
}
`;
  const LABEL_NFC_REFERENCE = `export function sameCampaignLabel(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const canonicalLeft = left.trim().normalize('NFC');
  const canonicalRight = right.trim().normalize('NFC');
  if (canonicalLeft.length === 0) return false;
  return canonicalLeft === canonicalRight;
}
`;
  const LABEL_NFC_ALTERNATIVE = `const canonical = (value) => (typeof value === 'string' ? value.trim().normalize('NFC') : null);
export function sameCampaignLabel(left, right) {
  const a = canonical(left);
  const b = canonical(right);
  if (a === null || b === null || a === '') return false;
  return a === b;
}
`;

  it.each([
    {
      variant: 'roleScope' as const,
      title: 'review-role-scope-01',
      sourcePath: REVIEW_TASK_CONTRACTS.roleScope.module,
      reference: ROLE_SCOPE_REFERENCE,
      alternative: ROLE_SCOPE_ALTERNATIVE,
      extraOutOfScopePath: 'test/public-settings.test.mjs',
      extraContents: '// candidate rewrote the public regression test\n',
    },
    {
      variant: 'labelNfc' as const,
      title: 'review-label-nfc-01',
      sourcePath: REVIEW_TASK_CONTRACTS.labelNfc.module,
      reference: LABEL_NFC_REFERENCE,
      alternative: LABEL_NFC_ALTERNATIVE,
      extraOutOfScopePath: REVIEW_TASK_CONTRACTS.labelNfc.displayModule,
      extraContents: `export function displayCampaignLabel(label) { return String(label).normalize('NFC'); }\n`,
    },
  ])(
    '$title: executor baseline red, reference green, alternative green, scope and ancestry negatives',
    async ({ variant, title, sourcePath, reference, alternative, extraOutOfScopePath, extraContents }) => {
      const create = variant === 'roleScope' ? createReviewRoleScopeTask : createReviewLabelNfcTask;
      const identity = (task: { worktreePath: string; baselineCommit: string }) =>
        judgeReviewTaskCandidateIdentity(variant, { candidateRoot: task.worktreePath, baselineCommit: task.baselineCommit });

      // (1) Seeded baseline is red before any candidate exists.
      const baseline = await create(ROUTE);
      try {
        expect(baseline.id).toBe(title);
        expect(baseline.baselineCommit).toMatch(/^[a-f0-9]{40}$/);
        expect(baseline.oraclePin).toMatch(/^[a-f0-9]{64}$/);
        const baselineIdentity = identity(baseline);
        expect(baselineIdentity.passed).toBe(false);
        expect(baselineIdentity.failures).toContain('candidate HEAD is still the pristine baseline');
        const baselineReport = await judgeReviewTaskSubmission(variant, {
          candidateRoot: baseline.worktreePath,
          baselineCommit: baseline.baselineCommit,
        });
        expect(baselineReport.passed).toBe(false);
        expect(baselineReport.behavior.passed).toBe(false);
        expect(baselineReport.behavior.failures.length).toBeGreaterThan(0);
      } finally {
        await baseline.cleanup();
      }

      // (2) Reference repair through the real executor is green.
      const referenceTask = await create(ROUTE);
      try {
        expectOk(await executeReviewLoopRepairTask(referenceTask, editingDriver(referenceTask.worktreePath, { [sourcePath]: reference })));
        const report = await judgeReviewTaskSubmission(variant, {
          candidateRoot: referenceTask.worktreePath,
          baselineCommit: referenceTask.baselineCommit,
        });
        expect(report.identity.failures).toEqual([]);
        expect(report.behavior.passed).toBe(true);
        expect(report.passed).toBe(true);
        expect(report.candidatePatchSha256).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await referenceTask.cleanup();
      }

      // (3) A materially different but correct repair is also green, with different bytes.
      const altTask = await create(ROUTE);
      try {
        expectOk(await executeReviewLoopRepairTask(altTask, editingDriver(altTask.worktreePath, { [sourcePath]: alternative })));
        const report = await judgeReviewTaskSubmission(variant, {
          candidateRoot: altTask.worktreePath,
          baselineCommit: altTask.baselineCommit,
        });
        expect(report.behavior.passed).toBe(true);
        expect(report.passed).toBe(true);
        const referenceDigest = await (async () => {
          const probe = await create(ROUTE);
          try {
            writeFileSync(join(probe.worktreePath, sourcePath), reference);
            commitAll(probe.worktreePath, 'reference bytes');
            return judgeReviewTaskCandidateIdentity(variant, {
              candidateRoot: probe.worktreePath,
              baselineCommit: probe.baselineCommit,
            }).candidatePatchSha256;
          } finally {
            await probe.cleanup();
          }
        })();
        expect(report.candidatePatchSha256).not.toBe(referenceDigest);
      } finally {
        await altTask.cleanup();
      }

      // (4) Correct behaviour with an out-of-scope edit stays red on scope alone.
      const scopedTask = await create(ROUTE);
      try {
        expectOk(await executeReviewLoopRepairTask(scopedTask, editingDriver(scopedTask.worktreePath, {
          [sourcePath]: reference,
          [extraOutOfScopePath]: extraContents,
        })));
        const report = await judgeReviewTaskSubmission(variant, {
          candidateRoot: scopedTask.worktreePath,
          baselineCommit: scopedTask.baselineCommit,
        });
        expect(report.identity.passed).toBe(false);
        expect(report.identity.failures).toContain('candidate changed paths did not exactly match its task allowlist');
        expect(report.behavior.passed).toBe(true);
        expect(report.passed).toBe(false);
      } finally {
        await scopedTask.cleanup();
      }

      // (5) A correct repair whose history no longer contains the baseline is red on ancestry.
      const rewrittenTask = await create(ROUTE);
      try {
        expectOk(await executeReviewLoopRepairTask(rewrittenTask, editingDriver(rewrittenTask.worktreePath, { [sourcePath]: reference })));
        expect((await judgeReviewTaskSubmission(variant, { candidateRoot: rewrittenTask.worktreePath, baselineCommit: rewrittenTask.baselineCommit })).passed).toBe(true);
        orphanHistory(rewrittenTask.worktreePath, 'Rewritten candidate history');
        const afterRewrite = await judgeReviewTaskSubmission(variant, {
          candidateRoot: rewrittenTask.worktreePath,
          baselineCommit: rewrittenTask.baselineCommit,
        });
        expect(afterRewrite.identity.passed).toBe(false);
        expect(afterRewrite.identity.failures).toContain('recorded baseline commit is not an ancestor of the candidate');
        expect(afterRewrite.passed).toBe(false);
      } finally {
        await rewrittenTask.cleanup();
      }

      // (6) A driver that claims success without editing is red, not silently green.
      const noopTask = await create(ROUTE);
      try {
        expectOk(await executeReviewLoopRepairTask(noopTask, editingDriver(noopTask.worktreePath, {}, { changed: false })));
        const report = await judgeReviewTaskSubmission(variant, {
          candidateRoot: noopTask.worktreePath,
          baselineCommit: noopTask.baselineCommit,
        });
        expect(report.identity.passed).toBe(false);
        expect(report.identity.failures).toContain('candidate HEAD is still the pristine baseline');
        expect(report.behavior.passed).toBe(false);
        expect(report.passed).toBe(false);
      } finally {
        await noopTask.cleanup();
      }
    },
    1_200_000,
  );

  it('labelNfc seeds the display module its own oracle and public test probe', async () => {
    // Regression for a real defect found by executor-level evidence: the labelNfc oracle
    // probes settings/display.mjs and its seeded public test imports ../settings/display.mjs,
    // but the factory used to materialize settings/display.js instead. The display module
    // was therefore absent for the labelNfc task, so a correct reference repair could never
    // be green and the seeded public test could not run.
    const task = await createReviewLabelNfcTask(ROUTE);
    try {
      const displayPath = join(task.worktreePath, REVIEW_TASK_CONTRACTS.labelNfc.displayModule);
      expect(existsSync(displayPath)).toBe(true);
      const displaySource = readFileSync(displayPath, 'utf8');
      expect(displaySource).toContain('displayCampaignLabel');
      expect(displaySource).toContain('return label;');
      // The seeded public test must be able to resolve the module it imports.
      const publicTest = readFileSync(join(task.worktreePath, 'test/public-settings.test.mjs'), 'utf8');
      expect(publicTest).toContain(`'../${REVIEW_TASK_CONTRACTS.labelNfc.displayModule}'`);
      // The v2 family keeps its own pinned display path and must not be disturbed.
      const v2 = await createReviewLoopRepairTask(ROUTE);
      try {
        expect(existsSync(join(v2.worktreePath, 'settings/display.js'))).toBe(true);
        expect(existsSync(join(v2.worktreePath, REVIEW_TASK_CONTRACTS.labelNfc.displayModule))).toBe(false);
      } finally {
        await v2.cleanup();
      }
    } finally {
      await task.cleanup();
    }
  }, 120_000);

  it.each(['safeIntegerSetting', 'originPolicy'] as const)(
    'analysis-$variant: executor defect cluster, reference green and semantic negatives',
    async (variant) => {
      const contract = ANALYSIS_TASK_CONTRACTS[variant];
      const proposalFor = (overrides: Record<string, unknown> = {}) => ({
        setting: contract.setting,
        constraints: [...contract.requiredConstraints],
        rejectsInvalidValues: true,
        preservesInputRepresentation: true,
        ...overrides,
      });

      const task = await createAnalysisRemediationTask(variant, ROUTE);
      try {
        expect(task.id).toBe(contract.id);
        expect(task.baselineCommit).toMatch(/^[a-f0-9]{40}$/);
        expect(task.oraclePin).toMatch(/^[a-f0-9]{64}$/);

        // (1) The seeded substrate really does carry the defect: the executor clusters it.
        const defectExecution = await executeAnalysisRemediationTask(task, {
          async run(invocation) {
            return { ...worker(proposalFor()), model: invocation.modelSpec.model };
          },
        });
        expect(defectExecution.clusterCount).toBeGreaterThan(0);
        expect(defectExecution.clusterSize).toBeGreaterThan(0);

        // (2) The reference proposal is green through the real executor.
        expect(defectExecution.oracle.passed).toBe(true);
        expect(defectExecution.oracle.failures).toEqual([]);
        expect(defectExecution.oracle).toMatchObject({
          sourceId: task.sourceId,
          baselineId: task.baselineId,
          oracleId: task.oracleId,
        });

        // (3) Semantic negatives: each required behaviour is load-bearing.
        const negatives: readonly (readonly [string, Record<string, unknown>])[] = [
          ['proposal targets a different setting', { setting: 'someOtherSetting' }],
          ['proposal does not reject invalid configuration values', { rejectsInvalidValues: false }],
          ['proposal does not preserve the original input representation', { preservesInputRepresentation: false }],
        ];
        for (const [expectedFailure, overrides] of negatives) {
          const execution = await executeAnalysisRemediationTask(task, {
            async run(invocation) {
              return { ...worker(proposalFor(overrides)), model: invocation.modelSpec.model };
            },
          });
          expect(execution.oracle.passed).toBe(false);
          expect(execution.oracle.failures).toContain(expectedFailure);
        }
        // Omitting a required constraint is red too.
        const missing = await executeAnalysisRemediationTask(task, {
          async run(invocation) {
            return {
              ...worker(proposalFor({ constraints: [...contract.requiredConstraints].slice(0, 1) })),
              model: invocation.modelSpec.model,
            };
          },
        });
        expect(missing.oracle.passed).toBe(false);
        expect(missing.oracle.failures.some((failure) => failure.startsWith('proposal omits required behavior'))).toBe(true);

        // (4) Operation failure is red, not a pass.
        const threw = await executeAnalysisRemediationTask(task, {
          async run() { throw new Error('local driver transport ended before any proposal'); },
        });
        expect(threw.oracle.passed).toBe(false);
        expect(threw.oracle.failures.some((failure) => failure.startsWith('operation returned'))).toBe(true);

        // (5) The seeded boundary vectors stay discriminative and are not widened here.
        const expected = [...contract.expected];
        expect(evaluateAnalysisTaskVectors(variant, expected)).toBe(true);
        expect(evaluateAnalysisTaskVectors(variant, expected.map((value) => !value))).toBe(false);
        expect(contract.vectors).toHaveLength(expected.length);

        // (6) KNOWN GAP, deliberately not closed here: a materially alternative proposal whose
        // constraint wording differs from the host tokens is still rejected. Accepting it is
        // conductor decision LR4; widening this oracle without a pin assignment would weaken
        // the meaning check, so this block pins the current semantics instead.
        const alternative = await executeAnalysisRemediationTask(task, {
          async run(invocation) {
            return {
              ...worker(proposalFor({ constraints: ['the current validator must be corrected', 'boundary values are accepted incorrectly'] })),
              model: invocation.modelSpec.model,
            };
          },
        });
        expect(alternative.oracle.passed).toBe(false);
        expect(alternative.oracle.failures.some((failure) => failure.startsWith('proposal omits required behavior'))).toBe(true);
      } finally {
        await task.cleanup();
      }
    },
    600_000,
  );

  it('merge-origin-precedence-01: executor baseline red, reference green, alternative green, scope, ancestry and intention negatives', async () => {
    const settingsPath = 'settings/origin-precedence.mjs';
    const REFERENCE = `export function resolveCampaignSetting(environmentValue, fileValue, builtInValue) {\n  return environmentValue ?? fileValue ?? builtInValue;\n}\n`;
    const ALTERNATIVE = `export function resolveCampaignSetting(environmentValue, fileValue, builtInValue) {\n  for (const candidate of [environmentValue, fileValue, builtInValue]) {\n    if (candidate !== null && candidate !== undefined) return candidate;\n  }\n  return undefined;\n}\n`;

    // (1) Seeded baseline is red.
    const baseline = await createIntegrationMergeTask('originPrecedence', ROUTE);
    try {
      expect(baseline.id).toBe(MERGE_ORIGIN_CONTRACT.id);
      expect(baseline.baselineCommit).toMatch(/^[a-f0-9]{40}$/);
      const red = await judgeMergeOriginConflictTask(baseline);
      expect(red.passed).toBe(false);
      expect(red.failures).toContain('precedence vector 0 returned the wrong source value');
      expect(red.failures).toContain('candidate changed paths did not exactly match its task allowlist');
    } finally {
      await baseline.cleanup();
    }

    // (2) Reference resolution through the real executor is green.
    const reference = await createIntegrationMergeTask('originPrecedence', ROUTE);
    try {
      const operation = expectOk(await executeMergeConflictTask(reference, {
        async run(invocation) {
          writeFileSync(reference.settingsPath, REFERENCE);
          gitIn(reference.repoRoot, ['add', settingsPath]);
          commitAll(reference.repoRoot, 'Resolve origin precedence');
          return { ...worker({ decision: 'acted', summary: 'Environment override wins.' }), model: invocation.modelSpec.model };
        },
      }));
      expect(operation.decision).toBe('acted');
      const green = await judgeMergeOriginConflictTask(reference);
      expect(green.failures).toEqual([]);
      expect(green.passed).toBe(true);
    } finally {
      await reference.cleanup();
    }

    // (3) A materially different resolution is also green.
    const alternative = await createIntegrationMergeTask('originPrecedence', ROUTE);
    try {
      expectOk(await executeMergeConflictTask(alternative, {
        async run(invocation) {
          writeFileSync(alternative.settingsPath, ALTERNATIVE);
          gitIn(alternative.repoRoot, ['add', settingsPath]);
          commitAll(alternative.repoRoot, 'Resolve origin precedence differently');
          return { ...worker({ decision: 'acted', summary: 'First defined source wins.' }), model: invocation.modelSpec.model };
        },
      }));
      const green = await judgeMergeOriginConflictTask(alternative);
      expect(green.failures).toEqual([]);
      expect(green.passed).toBe(true);
    } finally {
      await alternative.cleanup();
    }

    // (4) Correct resolution plus an out-of-scope edit is red on scope alone.
    const scoped = await createIntegrationMergeTask('originPrecedence', ROUTE);
    try {
      expectOk(await executeMergeConflictTask(scoped, {
        async run(invocation) {
          writeFileSync(scoped.settingsPath, REFERENCE);
          writeFileSync(join(scoped.repoRoot, 'settings/extra.mjs'), 'export const bypass = true;\n');
          commitAll(scoped.repoRoot, 'Resolution plus extra file');
          return { ...worker({ decision: 'acted', summary: 'acted' }), model: invocation.modelSpec.model };
        },
      }));
      const report = await judgeMergeOriginConflictTask(scoped);
      expect(report.passed).toBe(false);
      expect(report.failures).toContain('candidate changed paths did not exactly match its task allowlist');
      expect(report.failures).not.toContain('precedence vector 0 returned the wrong source value');
    } finally {
      await scoped.cleanup();
    }

    // (5) Destroying a branch intention file is red and named.
    const intentions = await createIntegrationMergeTask('originPrecedence', ROUTE);
    try {
      expectOk(await executeMergeConflictTask(intentions, {
        async run(invocation) {
          writeFileSync(intentions.settingsPath, REFERENCE);
          writeFileSync(join(intentions.repoRoot, 'branch-intentions/main.md'), 'Main branch: silently rewritten by the candidate.\n');
          commitAll(intentions.repoRoot, 'Resolution that drops an intention');
          return { ...worker({ decision: 'acted', summary: 'acted' }), model: invocation.modelSpec.model };
        },
      }));
      const report = await judgeMergeOriginConflictTask(intentions);
      expect(report.passed).toBe(false);
      expect(report.failures).toContain('candidate did not preserve both branch intention files');
    } finally {
      await intentions.cleanup();
    }

    // (6) A green resolution whose history no longer contains the baseline is red on ancestry.
    const rewritten = await createIntegrationMergeTask('originPrecedence', ROUTE);
    try {
      expectOk(await executeMergeConflictTask(rewritten, {
        async run(invocation) {
          writeFileSync(rewritten.settingsPath, REFERENCE);
          commitAll(rewritten.repoRoot, 'Resolve origin precedence');
          return { ...worker({ decision: 'acted', summary: 'acted' }), model: invocation.modelSpec.model };
        },
      }));
      expect((await judgeMergeOriginConflictTask(rewritten)).passed).toBe(true);
      orphanHistory(rewritten.repoRoot, 'Rebased resolution');
      const afterRewrite = await judgeMergeOriginConflictTask(rewritten);
      expect(afterRewrite.passed).toBe(false);
      expect(afterRewrite.failures).toContain('recorded baseline commit is not an ancestor of the candidate');
    } finally {
      await rewritten.cleanup();
    }
  }, 1_200_000);

  it('fleet-test-unit-repair-01: executor baseline red, reference green, alternative green and scope negative', async () => {
    const modulePath = FLEET_TEST_UNIT_CONTRACT.module;
    const REFERENCE = `export function normalizeWorkItem(value) {
  if (value === undefined || value === null) return { status: 'empty', value: '' };
  if (typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || typeof value.title !== 'string') return { status: 'invalid' };
  return { status: 'ready', value: { id: value.id, title: value.title } };
}
`;
    const ALTERNATIVE = `export function normalizeWorkItem(value) {
  const record = value ?? null;
  if (record === null) return { value: '', status: 'empty' };
  const isWorkItem = typeof record === 'object'
    && !Array.isArray(record)
    && 'id' in record && 'title' in record
    && typeof record.id === 'string' && typeof record.title === 'string';
  return isWorkItem
    ? { value: { title: record.title, id: record.id }, status: 'ready' }
    : { status: 'invalid' };
}
`;

    const runSweep = (task: Awaited<ReturnType<typeof createFleetTestUnitRepairTask>>, files: Record<string, string>) =>
      executeFleetTestUnitRepairTask(task, {
        async run(invocation) {
          const worktree = invocation.prompt.match(/worktree: (.+)$/m)?.[1];
          if (worktree === undefined) throw new Error('sweep prompt omitted the worktree path');
          for (const [path, contents] of Object.entries(files)) writeFileSync(join(worktree, path), contents);
          return { ...worker({ changed: true, summary: 'Repair the missing and null input contract.' }), model: invocation.modelSpec.model };
        },
      });

    // (1) Seeded baseline is red at the oracle level.
    const baseline = await createFleetTestUnitRepairTask();
    try {
      expect(baseline.id).toBe(FLEET_TEST_UNIT_CONTRACT.id);
      expect(baseline.baselineCommit).toMatch(/^[a-f0-9]{40}$/);
      const red = await judgeFleetTestUnitRepairTask(baseline, baseline.repoRoot);
      expect(red.passed).toBe(false);
      expect(red.failures.length).toBeGreaterThan(0);
    } finally {
      await baseline.cleanup();
    }

    // (2) Reference repair through the real sweep executor is green.
    const reference = await createFleetTestUnitRepairTask();
    try {
      const operation = expectOk(await runSweep(reference, { [modulePath]: REFERENCE }));
      expect(operation.committed).toBe(true);
      const green = await judgeFleetTestUnitRepairTask(reference, operation.worktree.path);
      expect(green.failures).toEqual([]);
      expect(green.passed).toBe(true);
    } finally {
      await reference.cleanup();
    }

    // (3) A materially different repair is also green.
    const alternative = await createFleetTestUnitRepairTask();
    try {
      const operation = expectOk(await runSweep(alternative, { [modulePath]: ALTERNATIVE }));
      const green = await judgeFleetTestUnitRepairTask(alternative, operation.worktree.path);
      expect(green.failures).toEqual([]);
      expect(green.passed).toBe(true);
    } finally {
      await alternative.cleanup();
    }

    // (4) Correct repair plus an edit outside the task allowlist is red on scope.
    // The extra file is deliberately not a test path: the sweep operation itself refuses
    // worker changes to test/setup/config files, so a test file would be blocked by the
    // operation before the oracle ever saw it. This holds under the current
    // subset-with-nonzero scope implementation; whether that should instead be the brief's
    // exact two-path allowlist is conductor decision LR4 and is left unresolved here.
    const scoped = await createFleetTestUnitRepairTask();
    try {
      const operation = expectOk(await runSweep(scoped, {
        [modulePath]: REFERENCE,
        'packages/settings/extra-helper.mjs': 'export const bypass = true;\n',
      }));
      const report = await judgeFleetTestUnitRepairTask(scoped, operation.worktree.path);
      expect(report.passed).toBe(false);
      expect(report.failures).toContain('candidate changed paths outside its task allowlist or made no change');
    } finally {
      await scoped.cleanup();
    }

    // (5) An uncommitted edit never reaches green, even with correct bytes.
    const dirty = await createFleetTestUnitRepairTask();
    try {
      expectOk(await runSweep(dirty, { [modulePath]: REFERENCE }));
      writeFileSync(join(dirty.repoRoot, modulePath), `${REFERENCE}// trailing uncommitted change\n`);
      const report = await judgeFleetTestUnitRepairTask(dirty, dirty.repoRoot);
      expect(report.passed).toBe(false);
      expect(report.failures).toContain('candidate worktree is not clean after its commit');
    } finally {
      await dirty.cleanup();
    }
  }, 1_200_000);
});
