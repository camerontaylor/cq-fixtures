import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import {
  createReviewLoopRepairTask,
  executeReviewLoopRepairTask,
  type ReviewLoopRepairTask,
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

const HIDDEN_REVIEW_JUDGE = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[1];
const baseline = process.argv[2];
const sourcePath = join(root, 'src/settings.mjs');
const expectedSource = ${JSON.stringify(REFERENCE_SETTINGS_SOURCE)};
assert.equal(readFileSync(sourcePath, 'utf8'), expectedSource, 'implementation must match the exact reference patch');
const settings = await import(pathToFileURL(sourcePath).href);
const display = await import(pathToFileURL(join(root, 'src/display.mjs')).href);
assert.equal(settings.isValidCampaignLabel(null), false);
assert.equal(settings.isValidCampaignLabel(''), false);
assert.equal(settings.isValidCampaignLabel('   '), false);
assert.equal(settings.isValidCampaignLabel('Campaign A'), true);
assert.equal(settings.isValidCampaignLabel('x'.repeat(40)), true);
assert.equal(settings.isValidCampaignLabel('x'.repeat(41)), false);
assert.equal(settings.isValidCampaignLabel('😀'.repeat(40)), true);
assert.equal(settings.isValidCampaignLabel('😀'.repeat(41)), false);
assert.equal(display.displayCampaignLabel('  Campaign A  '), '  Campaign A  ');
assert.deepEqual(execFileSync('git', ['diff', '--name-only', baseline, 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().split('\\n'), ['src/settings.mjs']);
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '', 'candidate must be committed');
assert.equal(execFileSync('git', ['show', baseline + ':test/public-settings.test.mjs'], { cwd: root, encoding: 'utf8' }), readFileSync(join(root, 'test/public-settings.test.mjs'), 'utf8'), 'visible tests must remain pristine');
`;

function runHiddenReviewJudge(task: ReviewLoopRepairTask): { passed: boolean; exactPatch: boolean } {
  try {
    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      HIDDEN_REVIEW_JUDGE,
      task.worktreePath,
      task.baselineCommit,
    ], { cwd: task.worktreePath, stdio: 'pipe' });
    return { passed: true, exactPatch: true };
  } catch {
    return { passed: false, exactPatch: false };
  }
}

function runVisibleTaskTests(task: ReviewLoopRepairTask): boolean {
  try {
    execFileSync(process.execPath, ['test/public-settings.test.mjs'], {
      cwd: task.worktreePath,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

type ReviewDriverMode = 'reference-patch' | 'no-op-claim' | 'bad-json-with-edits' | 'throw-with-edits';

function scriptedReviewDriver(task: ReviewLoopRepairTask, mode: ReviewDriverMode): Driver {
  return {
    async run(invocation) {
      let commits: string[] = ['f'.repeat(40)];
      if (mode !== 'no-op-claim') {
        await writeFile(join(task.worktreePath, 'src/settings.mjs'), REFERENCE_SETTINGS_SOURCE);
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

describe('cq-settings bounded workflow corpus', () => {
  it('judges the original bug red and an exact committed repair green', async () => {
    const task = await createReviewLoopRepairTask();
    try {
      expect(runHiddenReviewJudge(task).passed).toBe(false);
      expect(runVisibleTaskTests(task)).toBe(false);
      const driver = scriptedReviewDriver(task, 'reference-patch');
      const operationResult = await executeReviewLoopRepairTask(task, driver);

      expect(expectOk(operationResult).changed).toBe(true);
      expect(runHiddenReviewJudge(task)).toMatchObject({ passed: true, exactPatch: true });
      expect(runVisibleTaskTests(task)).toBe(true);
    } finally {
      await task.cleanup();
    }
  }, 30_000);

  it('grades a claimed no-op as incorrect even when the operation contract says changed', async () => {
    const task = await createReviewLoopRepairTask();
    try {
      const result = await executeReviewLoopRepairTask(task, scriptedReviewDriver(task, 'no-op-claim'));
      expect(expectOk(result)).toMatchObject({ changed: true, commits: ['f'.repeat(40)] });
      expect(runHiddenReviewJudge(task).passed).toBe(false);
    } finally {
      await task.cleanup();
    }
  }, 30_000);

  it('grades a correct committed patch independently when structured output is invalid', async () => {
    const task = await createReviewLoopRepairTask();
    try {
      const result = await executeReviewLoopRepairTask(task, scriptedReviewDriver(task, 'bad-json-with-edits'));
      expect(result.status).toBe('failed');
      expect(runHiddenReviewJudge(task)).toMatchObject({ passed: true, exactPatch: true });
    } finally {
      await task.cleanup();
    }
  }, 30_000);

  it('grades a correct committed patch independently when the Driver throws after editing', async () => {
    const task = await createReviewLoopRepairTask();
    try {
      const result = await executeReviewLoopRepairTask(task, scriptedReviewDriver(task, 'throw-with-edits'));
      expect(result.status).toBe('needs-human');
      expect(runHiddenReviewJudge(task)).toMatchObject({ passed: true, exactPatch: true });
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
    const task = await createReviewLoopRepairTask();
    const operationInput: ReviewLoopRepairTask['operationInput'] = {
      ...task.operationInput,
      driver: { model: 'offline-review', provider: 'fake' },
    };
    const injectedTask: ReviewLoopRepairTask = { ...task, operationInput };
    try {
      const result = await executeReviewLoopRepairTask(injectedTask, driver);

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
    let validations = 0;
    const effects: MergeEffects = {
      async validateRef() {
        validations += 1;
        return { ok: true, sha: validations === 1 ? 'b'.repeat(40) : 'c'.repeat(40) };
      },
      async fetchRef() { return { code: 0, stdout: '', stderr: '' }; },
      async readBaseRef() { return { ok: true, baseRefName: 'main' }; },
      async worktreePrepare() { return { path: '/tmp/cq-settings-conflict-fixture' }; },
      async worktreeRemove() {},
      async mergePr() { return { code: 0, stdout: '', stderr: '' }; },
      async retargetBase() { return { code: 0, stdout: '', stderr: '' }; },
      async pushRef() { return { code: 0, stdout: '', stderr: '' }; },
    };
    const invocations: Parameters<Driver['run']>[0][] = [];
    const driver: Driver = {
      async run(invocation) {
        invocations.push(invocation);
        return {
          ...completedWorker({ decision: 'acted', summary: 'Resolve the settings conflict.' }),
          model: invocation.modelSpec.model,
        };
      },
    };
    const resolveConflict = makeResolveConflictOp({
      effects,
      driver,
      createSession: async () => 'local-session',
      loadPrompt: async () => 'PR {{pr}}; files {{conflictFiles}}; base {{baseBranch}}; tree {{worktree}}',
    });
    const result = await resolveConflict({
      pr: 17,
      repoRoot: '/tmp/cq-settings-conflict-fixture',
      headBranch: 'fix/settings',
      baseBranch: 'main',
      conflictFiles: ['src/settings.ts'],
      modelSpec: { model: 'offline-conflict', provider: 'fake' },
    });

    expect(expectOk(result).decision).toBe('acted');
    expect(validations).toBe(2);
    expect(invocations[0]?.prompt).toContain('src/settings.ts');
    expect(invocations[0]?.sandboxPolicy).toEqual({ level: 'none' });
  });

  it('plans a fleet sweep using changed-file evidence and nested package ownership', async () => {
    const planner = makePlanSweep({
      changedFiles: async () => [{
        path: 'packages/core/test/settings.test.ts',
        status: 'M',
        deleted: false,
        fixerTarget: true,
      }],
    });
    const input: PlanSweepInput = {
      repoRoot: '/tmp/cq-settings-fleet-fixture',
      packages: [
        { name: 'core', path: 'packages/core' },
        { name: 'core-tests', path: 'packages/core/test' },
        { name: 'cli', path: 'packages/cli' },
      ],
      selector: { mode: 'changed-vs-base', base: 'campaign-base' },
      fixers: ['settings-fixer'],
    };
    const report = expectOk(await planner(input));

    expect(report.units).toEqual([{
      package: 'core-tests',
      fixer: 'settings-fixer',
      files: ['packages/core/test/settings.test.ts'],
    }]);
    expect(report.jobs).toHaveLength(1);
  });

  it('builds the baseline test-fix phase with test-only scope', async () => {
    const config = {
      repoRoot: '/tmp/cq-settings-test-fix-fixture',
      worktreesDir: '/tmp/cq-settings-test-fix-worktrees',
      runPrefix: 'cq/local-test-fix',
      base: 'campaign-base',
      packages: [{ name: 'settings', path: 'packages/settings' }],
      selector: { mode: 'workspace-all' as const },
      fixers: ['test-fix'],
      packageFiles: { settings: ['packages/settings/test/settings.test.ts'] },
    };
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

    expect(plan.id).toBe('test-fix');
    expect(serializedJobs).toContain('test-fix');
    expect(serializedJobs).toContain('test/settings.test.ts');
    expect(serializedJobs).not.toContain('product-fix');
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
          patch: '--- a/src/settings.ts\n+++ b/src/settings.ts\n@@\n-empty\n+validated',
        });
      },
    };
    const propose = makeAgenticRemediation(driver);
    const proposal = await propose({
      clusterId: clustered.clusters[0]!.id,
      cluster: clustered.clusters[0]!,
      modelSpec: { model: 'offline-analysis', provider: 'fake' },
    });

    expect(expectOk(proposal).structuredOutput).toMatchObject({ summary: expect.any(String) });
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
      expect(expectOk(await check(input)).verdict).toBe('pass');
      current = 3;
      expect(expectOk(await check(input)).verdict).toBe('fail');
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
      expect(checkDiffMonotonicity(baselineDiff(2, 3))).toMatchObject({ ok: false });
      expect(checkDiffMonotonicity(baselineDiff(2, 1))).toMatchObject({ ok: true });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
