import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import {
  judgeReviewLoopRepairTask,
  judgeReviewLoopWorkspace,
} from '../runner/workflow-corpus/review-loop-judge.ts';
import { createReviewLoopRunSuiteBundle } from '../runner/workflow-corpus/review-loop-suite.ts';
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
        await writeFile(join(task.worktreePath, 'src/settings.mjs'), candidateSource);
        execFileSync('git', ['add', 'src/settings.mjs'], { cwd: task.worktreePath });
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
  writeFileSync(join(task.worktreePath, 'src/settings.mjs'), source);
  execFileSync('git', ['add', 'src/settings.mjs'], { cwd: task.worktreePath });
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
      expect(green.conformance.sourceTestAllowlist.changedPaths).toEqual(['src/settings.mjs']);
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

      await writeFile(join(task.worktreePath, 'src/settings.mjs'), ALTERNATIVE_SETTINGS_SOURCE);
      const dirty = await judgeReviewLoopRepairTask(task);
      expect(dirty.identity.passed).toBe(false);
      expect(dirty.identity.cleanGitCandidate).toBe(false);
      expect(dirty.conformance.passed).toBe(true);
      expect(dirty.identity.candidatePatchSha256).not.toBe(committed.identity.candidatePatchSha256);
    } finally {
      await task.cleanup();
    }
  }, 120_000);

  it('bounds arbitrary candidate-module execution in the host judge', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    try {
      await writeFile(join(task.worktreePath, 'src/settings.mjs'), 'while (true) {}\n');
      const report = await judgeReviewLoopWorkspace(task.worktreePath, {
        baselineRef: task.baselineCommit,
        sourceId: task.sourceId,
        baselineId: task.baselineId,
        oracleId: task.oracleId,
      });
      expect(report.passed).toBe(false);
      expect(report.behavior.failures.some((failure) => failure.includes('bounded candidate module probe failed'))).toBe(true);
      expect(report.visibleTests.passed).toBe(false);
    } finally {
      await task.cleanup();
    }
  }, 30_000);

  it('adapts the typed operation task to runSuite with the task model route and host oracle', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    const bundle = await createReviewLoopRunSuiteBundle(task);
    let workerWorkspace = '';
    const driver: Driver = {
      async run(invocation) {
        const workspace = invocation.prompt.match(/^workspace: (.+)$/m)?.[1];
        if (!workspace) throw new Error('runSuite invocation omitted workspace path');
        workerWorkspace = workspace;
        await writeFile(join(workspace, 'src/settings.mjs'), ALTERNATIVE_SETTINGS_SOURCE);
        execFileSync('git', ['-C', workspace, 'add', 'src/settings.mjs']);
        execFileSync('git', [
          '-C', workspace,
          '-c', 'user.name=CQ Corpus',
          '-c', 'user.email=corpus@example.invalid',
          'commit', '-q', '-m', 'Model-created valid candidate commit',
        ]);
        return {
          ...completedWorker({
            fixed: true,
            notes: 'Count Unicode code points after trimming while preserving display input.',
          }),
          model: invocation.modelSpec.model,
        };
      },
    };
    try {
      expect(bundle.suite.cases[0]?.id).toBe(task.id);
      expect(bundle.suite.cases[0]?.task.notes).toContain(`source=${REVIEW_LOOP_SOURCE_ID}`);
      expect(bundle.suite.cases[0]?.task.notes).toContain(`baseline=${REVIEW_LOOP_BASELINE_ID}`);
      expect(bundle.suite.cases[0]?.task.notes).toContain(`oracle=${REVIEW_LOOP_ORACLE_ID}`);
      const result = await runSuite({
        suiteDir: bundle.suiteDir,
        repoRoot: bundle.repoRoot,
        driver: bundle.wrapDriver(driver),
        model: bundle.modelSpec.model,
        provider: bundle.modelSpec.provider,
        driverName: 'subprocess',
        checkTimeoutMs: 20_000,
      });
      expect(result.materializationFailures).toBe(0);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ case: task.id, role: 'fixer-worker', model: 'glm-5.3-flash' });
      expect(result.rows[0]?.outcome).toMatchObject({ score: 1 });
      expect(result.tables).toHaveLength(1);
      const baselineCommit = bundle.pinnedBaselineCommit(workerWorkspace);
      const candidateCommit = bundle.pinnedCandidateCommit(workerWorkspace);
      expect(baselineCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(candidateCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(candidateCommit).not.toBe(baselineCommit);
      expect(bundle.oraclePin).toMatchObject({
        version: 1,
        oracleId: REVIEW_LOOP_ORACLE_ID,
        dependencies: expect.arrayContaining([
          expect.objectContaining({ path: 'runner/workflow-corpus/review-loop-judge.ts', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
          expect.objectContaining({ path: 'campaigns/cq-settings/corpus/review-loop-task.ts', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
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
  }, 30_000);

  it('grades a correct committed patch independently when structured output is invalid', async () => {
    const task = await createReviewLoopRepairTask(OFFLINE_REVIEW_ROUTE);
    try {
      const result = await executeReviewLoopRepairTask(task, scriptedReviewDriver(task, 'bad-json-with-edits'));
      expect(result.status).toBe('failed');
      expect((await judgeReviewLoopRepairTask(task)).passed).toBe(true);
    } finally {
      await task.cleanup();
    }
  }, 30_000);

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
      expect(invocations[0]?.prompt).toContain('src/settings.mjs');
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
    const replacement = `export function campaignLabel(label) {\n  if (typeof label !== 'string') return '';\n  return Array.from(label.trim()).slice(0, 40).join('');\n}\n`;
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
      expect(judgeMergeConflictWorkspace(repoRoot, baseline)).toMatchObject({
        passed: true,
        sourceId: 'cq-settings.merge-worktree-seed.v1',
        baselineId: 'cq-settings.merge-conflict.baseline.v1',
        oracleId: 'cq-settings.merge-label-limit.oracle.v1',
      });
      expect(validations).toBe(2);
      expect(pushedCommit).not.toBe(baseline);
      expect(execFileSync('git', ['diff', '--name-only', baseline, 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('src/settings.mjs');
      const candidate = await import(`${pathToFileURL(settingsPath).href}?fresh=${Date.now()}`) as { campaignLabel(label: unknown): string };
      expect(candidate.campaignLabel('x'.repeat(41))).toHaveLength(40);
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

    expect(judgeAnalysisRemediationProposal(expectOk(proposal).structuredOutput)).toMatchObject({
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

  it('accepts a distinct behaviorally correct remediation implementation', () => {
    const report = judgeAnalysisRemediationProposal({
      summary: 'Reject blank settings at the shared validation boundary.',
      patch: 'update isValidSetting in src/settings.ts to reject trimmed empty text',
      candidateSource: `export function isValidSetting(value) {
  return typeof value === 'string' && [...value.trim()].length !== 0;
}
`,
    });
    expect(report).toMatchObject({ passed: true, oracleId: 'cq-settings.analysis-remediation.oracle.v1' });
  }, 10_000);
});
