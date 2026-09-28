import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../runner/artifacts/index.ts';
import { nativeGovernorUsage } from '../runner/budget.ts';
import { experimentId, suiteTaskId, type ExperimentContext } from '../runner/experiment.ts';
import { runSuite } from '../runner/index.ts';
import { campaignUsage, type NativeObservation, type InvocationIdentity } from '../runner/native/observation.ts';
import { regradeCampaignCandidate } from '../runner/regrade.ts';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function fixtureObservation(identity: InvocationIdentity, workerResult: WorkerResult | null = null): NativeObservation {
  const counter = (semantics: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning') => ({
    value: null, availability: 'unavailable' as const, source: null, semantics,
  });
  return {
    schemaVersion: 1, identity, transport: 'codex-exec',
    executable: { path: '/usr/bin/codex', version: 'test', profile: 'native' }, artifacts: [],
    model: {
      configuredTarget: 'luna-subscription',
      requested: { value: 'gpt-6-luna', source: 'test', status: 'verified' },
      observed: { value: null, source: null, status: 'unavailable' }, settings: {},
    },
    usage: {
      counters: {
        input: counter('input'), output: counter('output'), cacheRead: counter('cacheRead'),
        cacheWrite: counter('cacheWrite'), reasoning: counter('reasoning'),
      },
      tokenTotal: { value: null, availability: 'unavailable', source: null },
      inclusion: { input: null, output: null, cache: null, reasoning: 'unknown' },
    },
    terminal: { cause: 'transport-throw', cancelled: false, transportException: null, observedAt: new Date().toISOString() },
    capture: { status: 'pending', baselineCommit: null, patchSha256: null, workspaceSha256: null },
    timing: { startedAt: new Date().toISOString(), endedAt: null, stages: {} }, workerResult,
  };
}

class ThrowsAfterEditing implements Driver {
  identity?: InvocationIdentity;
  async beginInvocation(identity: InvocationIdentity): Promise<void> { this.identity = identity; }
  async run(invocation: OpInvocation): Promise<WorkerResult> {
    const workspace = /workspace: (.+)$/.exec(invocation.prompt)?.[1];
    if (workspace === undefined) throw new Error('test could not locate workspace');
    writeFileSync(join(workspace, 'fix.txt'), 'fixed\n');
    const add = spawnSync('git', ['-C', workspace, '-c', 'user.name=Worker', '-c', 'user.email=worker@test', 'add', '-A']);
    const commit = spawnSync('git', ['-C', workspace, '-c', 'user.name=Worker', '-c', 'user.email=worker@test', 'commit', '-m', 'worker edit']);
    if (add.status !== 0 || commit.status !== 0) throw new Error('test worker could not commit fixture edit');
    throw new Error('transport broke after edit');
  }
  getObservation(invocationId: string): NativeObservation | undefined {
    if (this.identity?.invocationId !== invocationId) return undefined;
    throw new Error('observation retrieval crashed');
  }
}

function experiment(): ExperimentContext {
  return {
    campaignId: 'campaign-test', cohortId: 'cohort-1', experimentId: 'exp-test', taskId: 'task-test',
    repeatId: 'repeat-1', assignmentId: 'assign-base', stageId: 'stage-1', attemptId: 'attempt-base',
    track: 'native-primary', strategyId: 'codex-one-shot', settingsId: 'settings-default',
    budgetId: 'budget-small', profileId: 'codex-profile-v1',
  };
}

describe('campaign envelope', () => {
  it('keeps unavailable counters and invalid totals unknown; total is not recomputed from possibly overlapping counters', () => {
    const observation = fixtureObservation({ invocationId: 'i', assignmentId: 'a', stageId: 's', attemptId: 't' });
    observation.usage.counters.input = { value: 7, availability: 'observed', source: 'event', semantics: 'input' };
    observation.usage.counters.output = { value: 3, availability: 'observed', source: 'event', semantics: 'output' };
    observation.usage.tokenTotal = { value: Number.POSITIVE_INFINITY, availability: 'observed', source: 'event' };
    observation.usage.inclusion.reasoning = 'included in output';
    expect(campaignUsage(observation)).toMatchObject({ input: 7, output: 3, cacheRead: null, tokenTotal: null, complete: false });
    observation.usage.tokenTotal = { value: 25, availability: 'observed', source: 'event' };
    expect(campaignUsage(observation).tokenTotal).toBe(25);
  });

  it('hashes canonical experiment identity and scopes tasks by suite plus substrate', () => {
    const a = {
      track: 'native', sourcePins: { toolkit: 'abc' }, corpusPin: 'corpus', promptPin: 'prompt', judgePin: 'judge',
      strategy: { kind: 'one-shot' }, settings: { effort: 'high', mode: 'x' }, profile: 'profile', budget: 'budget',
    };
    const b = {
      budget: 'budget', profile: 'profile', settings: { mode: 'x', effort: 'high' }, strategy: { kind: 'one-shot' },
      judgePin: 'judge', promptPin: 'prompt', corpusPin: 'corpus', sourcePins: { toolkit: 'abc' }, track: 'native',
    };
    expect(experimentId(a)).toBe(experimentId(b));
    expect(suiteTaskId('one', 'same-name')).not.toBe(suiteTaskId('two', 'same-name'));
  });

  it('writes immutable attempt artifacts and rejects conflicting rewrites', () => {
    root = mkdtempSync(join(tmpdir(), 'cq-artifacts-'));
    const store = new ArtifactStore(root);
    const context = experiment();
    const artifact = store.write(context, 'events.jsonl', '{"event":1}\n');
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => store.write(context, 'events.jsonl', '{"event":2}\n')).toThrow(/already exists/);
    expect(existsSync(join(root, artifact.path))).toBe(true);
  });

  it('keeps overlapping usage out of governor/cost folding and regrades only hash-pinned candidate bytes', async () => {
    root = mkdtempSync(join(tmpdir(), 'cq-regrade-'));
    const store = new ArtifactStore(root);
    const context = experiment();
    const observation = fixtureObservation({ invocationId: 'i', assignmentId: 'a', stageId: 's', attemptId: 't' });
    for (const name of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      observation.usage.counters[name] = { value: 4, availability: 'observed', source: 'event', semantics: name };
    }
    expect(nativeGovernorUsage(observation)).toBeUndefined();
    observation.usage.inclusion.cache = 'disjoint-from-input';
    expect(nativeGovernorUsage(observation)).toMatchObject({ input: 4, output: 4, cacheRead: 4, cacheWrite: 4 });

    const candidate = store.write(context, 'candidate.patch', 'patch bytes\n');
    const judgement = await regradeCampaignCandidate({
      store, context, candidatePath: join(root, candidate.path), candidateSha256: candidate.sha256,
      judgementId: 'judge-v2', judgePin: 'checker@sha256:abc', judge: (bytes) => ({ bytes: bytes.toString(), passed: true }),
    });
    expect(judgement.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => regradeCampaignCandidate({
      store, context, candidatePath: join(root, candidate.path), candidateSha256: '0'.repeat(64),
      judgementId: 'judge-v3', judgePin: 'checker@sha256:def', judge: () => ({}),
    })).toThrow(/hash mismatch/);
  });

  it('runSuite retrieves the envelope by explicit identity and grades edits after a thrown transport', async () => {
    root = mkdtempSync(join(tmpdir(), 'cq-native-run-'));
    mkdirSync(join(root, 'policy', 'denylist'), { recursive: true });
    writeFileSync(join(root, 'policy', 'denylist', 'patterns.yml'), readFileSync(new URL('../policy/denylist/patterns.yml', import.meta.url)));
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'fix.txt'), 'broken\n');
    writeFileSync(join(root, 'fixture', 'check.mjs'), "import { readFileSync } from 'node:fs'; process.exit(readFileSync('fix.txt', 'utf8') === 'fixed\\n' ? 0 : 1);\n");
    const suiteDir = join(root, 'suite');
    mkdirSync(suiteDir);
    writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify({
      name: 'native-fixer', role: 'fixer-worker', provenance: { origin: 'hand-seeded' },
      cases: [{ id: 'case-1', fixture: 'fixture', task: { prompt: 'Fix the file.' }, probe: { kind: 'check-rerun', check: 'fixture/check.mjs' } }],
    }));
    const result = await runSuite({
      suiteDir, driver: new ThrowsAfterEditing(), model: 'gpt-6-luna', provider: 'openai',
      driverName: 'codex-exec', repoRoot: root, artifactRoot: join(root, 'artifacts'), experiment: experiment(),
      maxTokens: 1, maxUsd: 0,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      costUSD: null,
      observedUsage: { input: null, output: null, cacheRead: null, cacheWrite: null, tokenTotal: null, complete: false },
      outcomes: { candidateCorrectness: true, assignedStrategySuccess: true, operationalStatus: 'measured-transport-failure' },
    });
    expect(result.rows[0]?.outcome).toMatchObject({ passed: 1, total: 2 });
    expect(result.gatedByBudget).toBe(false);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.observation.terminal.transportException?.message).toContain('transport broke');
    expect(result.judgements).toHaveLength(1);
    const attemptDir = join(root, 'artifacts', 'campaign', 'campaign-test', 'cohort', 'cohort-1', 'experiment', 'exp-test', 'task', suiteTaskId('native-fixer', 'case-1'));
    const candidates = (await import('node:fs/promises')).readdir(join(attemptDir, 'repeat', 'repeat-1', 'assignment'));
    const assignments = await candidates;
    expect(assignments).toEqual(['assign-base']);
    const stagePath = join(attemptDir, 'repeat', 'repeat-1', 'assignment', assignments[0]!, 'stage', 'stage-1', 'attempt');
    const attemptId = (await (await import('node:fs/promises')).readdir(stagePath))[0]!;
    expect(attemptId).toBe('attempt-base');
    const attemptPath = join(stagePath, attemptId);
    const attemptNames = await (await import('node:fs/promises')).readdir(attemptPath);
    expect(attemptNames).toContain('candidate.patch');
    expect(attemptNames).toContain('observation.json');
    expect(readFileSync(join(attemptPath, 'candidate.patch'), 'utf8')).toContain('fixed');
  }, 20_000);
});
