import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIndependentJudgeProcessSupervisor } from '../runner/strategies/judge-process.ts';
import type { ReviewLoopJudgeProcessRequest } from '../runner/strategies/judge-protocol.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function request(): ReviewLoopJudgeProcessRequest {
  const identity = { assignmentId: 'assignment', stageId: 'judge', attemptId: 'single-use-attempt' };
  const oraclePin = 'a'.repeat(64);
  const judgeManifest = { sourcePin: oraclePin, dependencies: [] };
  const patch = 'candidate';
  return {
    schemaVersion: 1, identity, deadlineEpochMs: Date.now() + 5_000,
    shutdownDeadlineEpochMs: Date.now() + 10_000, s1DependencyRoot: '/unused-pinned-root',
    task: { id: 'task', sourceId: 'source', baselineId: 'baseline', oracleId: 'oracle',
      substrateFamily: 'test', worktreePath: '/private/task', baselineCommit: 'b'.repeat(40),
      modelSpec: { model: 'offline', provider: 'test' }, operationInput: {} },
    model: 'offline', provider: 'test', driverName: 'test', checkTimeoutMs: 1000,
    taskSourceSha256: 'b'.repeat(64), suiteSourceSha256: 'c'.repeat(64),
    baselineCommit: 'b'.repeat(40), baselineTree: 'c'.repeat(64), sourceId: 'source',
    baselineId: 'baseline', suiteName: 'suite', caseId: 'case', promptSha256: 'd'.repeat(64),
    taskFixtureFiles: [], oraclePin, candidateInventoryHash: 'e'.repeat(64),
    namespaceSlotCount: 1, judgeManifest,
    experiment: { campaignId: 'campaign', cohortId: 'development', experimentId: 'experiment',
      taskId: 'task', repeatId: 'repeat', ...identity, track: 'test', strategyId: 'strategy',
      settingsId: 'settings', budgetId: 'budget', profileId: 'profile', frozenWeight: 1,
      substrateId: 'substrate', judgeManifest },
    candidate: { sha256: sha(patch), patch, baselineCommit: 'b'.repeat(40), baselineTree: 'c'.repeat(64) },
  };
}

describe('protected judge admission', () => {
  it('launches the protected child with a loader that supports parameter properties', async () => {
    const root = mkdtempSync(join(tmpdir(), 'judge-lifecycle-'));
    let command = '';
    let args: readonly string[] = [];
    const supervisor = createIndependentJudgeProcessSupervisor({
      privateRoot: root,
      ownershipForTest: {
        stableJudgeCandidateInventory: () => ({ inventoryHash: 'e'.repeat(64) }),
        createJudgeNamespacePlan: (input) => {
          const plan = { identity: input.identity, candidateSha256: input.candidateSha256,
            oraclePin: input.oraclePin, slots: input.inventoryHashes.map((inventoryHash) => ({ inventoryHash })) };
          const planPath = join(input.privateParentRoot, 'plan.json');
          const bytes = JSON.stringify(plan);
          writeFileSync(planPath, bytes, { mode: 0o600, flag: 'wx' });
          return { planPath, planSha256: sha(bytes), plan };
        },
        cleanupJudgeNamespace: async (handle) => ({ identity: handle.plan.identity, planSha256: handle.planSha256,
          daemonVerified: true, ownershipVerified: true, containersAbsent: true,
          processTree: 'stopped-and-reaped' as const, volumeDisposition: 'absent' as const,
          resourceIds: [], cleanup: 'complete' as const, inventoryContentVerified: false as const }),
      },
      spawnChildForTest: ((childCommand: string, childArgs: readonly string[]) => {
        command = childCommand;
        args = childArgs;
        throw new Error('offline spawn sentinel');
      }) as unknown as typeof spawn,
    });
    const input = request();
    await expect(supervisor.run(input, new AbortController().signal))
      .rejects.toThrow('independent judge child could not be launched');
    expect(command).toBe(process.execPath);
    expect(args.slice(0, 3)).toEqual([
      '--disable-warning=ExperimentalWarning', '--experimental-transform-types',
      join(process.cwd(), 'runner/strategies/judge-child.ts'),
    ]);
    expect(args).toHaveLength(6);
    const proof = await supervisor.cancelAndWait({ identity: input.identity, cause: 'inspection', deadlineEpochMs: Date.now() + 100 });
    expect(proof).toMatchObject({ cleanup: 'complete', protectedOracleCleanup: 'proven' });
  });

  it('rejects impossible deadline composition before admission', async () => {
    const supervisor = createIndependentJudgeProcessSupervisor({ privateRoot: mkdtempSync(join(tmpdir(), 'judge-lifecycle-')) });
    const input = request();
    await expect(supervisor.run({ ...input, shutdownDeadlineEpochMs: input.deadlineEpochMs }, new AbortController().signal))
      .rejects.toThrow(/finite and ordered/);
    await expect(supervisor.run({ ...input, deadlineEpochMs: Number.POSITIVE_INFINITY }, new AbortController().signal))
      .rejects.toThrow(/finite and ordered/);
  });

  it('reserves an attempt before asynchronous preparation and refuses concurrent replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'judge-lifecycle-'));
    let entered!: () => void;
    const preparing = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const supervisor = createIndependentJudgeProcessSupervisor({ privateRoot: root,
      ownershipForTest: {
        stableJudgeCandidateInventory: () => ({ inventoryHash: 'e'.repeat(64) }),
        createJudgeNamespacePlan: (input) => {
          const plan = { identity: input.identity, candidateSha256: input.candidateSha256,
            oraclePin: input.oraclePin, slots: input.inventoryHashes.map((inventoryHash) => ({ inventoryHash })) };
          const planPath = join(input.privateParentRoot, 'plan.json');
          const bytes = JSON.stringify(plan);
          writeFileSync(planPath, bytes, { mode: 0o600, flag: 'wx' });
          return { planPath, planSha256: sha(bytes), plan };
        },
        cleanupJudgeNamespace: async (handle) => ({ identity: handle.plan.identity, planSha256: handle.planSha256,
          daemonVerified: true, ownershipVerified: true, containersAbsent: true,
          processTree: 'stopped-and-reaped' as const, volumeDisposition: 'absent' as const,
          resourceIds: [], cleanup: 'complete' as const, inventoryContentVerified: false as const }),
      },
      beforeSpawnForTest: async () => { entered(); await gate; },
    });
    const input = request();
    const first = supervisor.run(input, controller.signal);
    await preparing;
    await expect(supervisor.run(input, new AbortController().signal)).rejects.toThrow(/already admitted/);
    controller.abort();
    release();
    await expect(first).rejects.toThrow(/cancelled during preparation/);
    const proof = await supervisor.cancelAndWait({ identity: input.identity, cause: 'inspection', deadlineEpochMs: Date.now() + 100 });
    expect(proof).toMatchObject({ cleanup: 'complete', protectedOracleCleanup: 'proven' });
  });
});
