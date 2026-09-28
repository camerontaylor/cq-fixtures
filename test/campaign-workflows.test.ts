import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTestFixPlan,
  checkDiffMonotonicity,
  clusterErrorsOp,
  createCaptureBaseline,
  createCheckRatchet,
  makeAgenticRemediation,
  makeFixReviewItem,
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

interface Scenario {
  id: string;
  family: string;
  red: Record<string, unknown>;
  green: Record<string, unknown>;
}

const corpus = JSON.parse(
  await (await import('node:fs/promises')).readFile(
    new URL('../campaigns/cq-settings/corpus/workflows.json', import.meta.url),
    'utf8',
  ),
) as { scenarios: Scenario[] };

function oracle(scenario: Scenario, candidate: Record<string, unknown>): boolean {
  switch (scenario.family) {
    case 'review-loop':
      return candidate.changed === true &&
        Array.isArray(candidate.commits) &&
        candidate.commits.length > 0;
    case 'merge-pr-conflicts':
      return candidate.baselineSha !== candidate.headShaAfter && candidate.expected === 'ok';
    case 'fleet-sweep':
      return JSON.stringify(candidate.selected) === JSON.stringify(candidate.expected);
    case 'baseline-test-fix':
      return JSON.stringify(candidate.fixers) === JSON.stringify(['test-fix']) && candidate.testOnly === true;
    case 'analyze-remediate':
      return candidate.clusterCount === 1 && candidate.toolMode === 'none' && candidate.sandbox === 'read-only';
    case 'monotonic-ratchets':
      return typeof candidate.baseline === 'number' &&
        typeof candidate.current === 'number' &&
        candidate.current <= candidate.baseline &&
        candidate.expected === 'pass';
    default:
      return false;
  }
}

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

describe('cq-settings bounded workflow corpus', () => {
  it('discovers exactly the six declared calibration workflow families', () => {
    expect(corpus.scenarios.map(({ family }) => family)).toEqual([
      'review-loop',
      'merge-pr-conflicts',
      'fleet-sweep',
      'baseline-test-fix',
      'analyze-remediate',
      'monotonic-ratchets',
    ]);
    expect(new Set(corpus.scenarios.map(({ id }) => id)).size).toBe(6);
  });

  it.each(corpus.scenarios)('$id reproduces its buggy red and fixed green oracle vectors', (scenario) => {
    expect(oracle(scenario, scenario.red)).toBe(false);
    expect(oracle(scenario, scenario.green)).toBe(true);
  });

  it('runs the review fix operation with a constrained anchor and injected Driver', async () => {
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
    const fix = makeFixReviewItem({ driver });
    const result = await fix({
      repo: 'local/cq-settings',
      pr: 17,
      item: {
        id: 'thread-local-17',
        path: 'src/settings.ts',
        line: 42,
        body: 'Reject an empty campaign setting before saving.',
        comments: [],
      },
      worktree: { path: '/tmp/cq-settings-review-fixture', branch: 'fix/settings' },
      driver: { model: 'offline-review', provider: 'fake' },
    });

    expect(expectOk(result).changed).toBe(true);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.prompt).toContain('src/settings.ts');
    expect(invocations[0]?.prompt).toContain('empty campaign setting');
    expect(invocations[0]?.sandboxPolicy).toEqual({ level: 'workspace-write' });
  });

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
  });
});
