import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore, sha256 } from '../runner/artifacts/index.ts';
import { nativeGovernorUsage } from '../runner/budget.ts';
import { experimentId, judgeManifestHash, suiteTaskId, type ExperimentContext, type TaskOutcome, type TaskOutcomeJudgement } from '../runner/experiment.ts';
import type { ResultRow } from '../runner/aggregate.ts';
import { runSuite } from '../runner/index.ts';
import { campaignUsage, sanitizeNativeObservation, type NativeObservation, type InvocationIdentity } from '../runner/native/observation.ts';
import { regradeCampaignCandidate } from '../runner/regrade.ts';
import { mapPipelineCampaignEvidence, type PipelineStageLedger, type PipelineStrategyLedger } from '../runner/pipelineMapping.ts';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function fixtureObservation(identity: InvocationIdentity, workerResult: WorkerResult | null = null): NativeObservation {
  const counter = (semantics: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning') => ({
    value: null, availability: 'unavailable' as const, source: null, semantics,
  });
  return {
    schemaVersion: 1, identity, transport: 'codex-exec',
    executable: { path: '/usr/bin/codex', version: 'test', profile: 'native' }, artifacts: [], withheldArtifacts: [],
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
      tokenTotal: { value: null, availability: 'unavailable', source: null, semantics: 'unknown' },
      inclusion: { input: null, output: null, cache: null, reasoning: 'unknown' },
    },
    terminal: { cause: 'transport-throw', cancelled: false, transportException: null, observedAt: new Date().toISOString() },
    capture: { status: 'pending', baselineCommit: null, baselineTree: null, patchSha256: null, workspaceSha256: null },
    timing: { startedAt: new Date().toISOString(), endedAt: null, stages: {} }, workerResult,
  };
}

function fixtureUsage(overrides: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'tokenTotal', { value: number | null; availability: 'observed' | 'unavailable' | 'not-reported' }>> = {}) {
  return Object.fromEntries((['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tokenTotal'] as const).map((name) => {
    const item = overrides[name] ?? { value: null, availability: 'not-reported' as const };
    return [name, { ...item, source: item.availability === 'observed' ? 'test-ledger' : null,
      semantics: name === 'tokenTotal' && item.availability === 'observed' ? 'authoritative-total' : name, inclusion: null }];
  })) as unknown as PipelineStageLedger['usage'];
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

class BudgetStop implements Driver {
  private identity?: InvocationIdentity;
  async beginInvocation(identity: InvocationIdentity): Promise<void> { this.identity = identity; }
  async run(): Promise<WorkerResult> {
    return { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, denials: [], stopReason: 'budget' };
  }
  getObservation(invocationId: string): NativeObservation | undefined {
    if (this.identity?.invocationId !== invocationId) return undefined;
    const observation = fixtureObservation(this.identity, {
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, denials: [], stopReason: 'budget',
    });
    observation.terminal.cause = 'budget-exhausted';
    return observation;
  }
}

function experiment(): ExperimentContext {
  return {
    campaignId: 'campaign-test', cohortId: 'cohort-1', experimentId: 'exp-test', taskId: 'task-test',
    repeatId: 'repeat-1', assignmentId: 'assign-base', stageId: 'stage-1', attemptId: 'attempt-base',
    track: 'native-primary', strategyId: 'codex-one-shot', settingsId: 'settings-default',
    budgetId: 'budget-small', profileId: 'codex-profile-v1', frozenWeight: 1,
    substrateId: 'substrate-default', judgeManifest: {
      sourcePin: 'judge-source-v1', dependencies: [{ path: 'fixture/check.mjs', sha256: '0'.repeat(64) }],
    },
  };
}

describe('campaign envelope', () => {
  it('maps only frozen judgements, exact evidence refs, recipe format, budget failure, and unknown totals', () => {
    const context = experiment();
    const candidateSha256 = 'a'.repeat(64);
    const judgeStage: PipelineStageLedger = {
      assignmentId: context.assignmentId, stageId: context.stageId, attemptId: context.attemptId,
      invocationId: null, kind: 'independent-judge', routeId: null, status: 'completed', launched: false,
      terminalCause: null, transportException: null, usage: fixtureUsage(),
    };
    const modelStage: PipelineStageLedger = {
      assignmentId: context.assignmentId, stageId: 'stage-draft', attemptId: 'attempt-draft',
      invocationId: 'invocation-draft', kind: 'draft', routeId: 'codex-one-shot', status: 'completed', launched: true,
      terminalCause: 'complete', transportException: null,
      usage: { ...fixtureUsage({ input: { value: 12, availability: 'observed' }, output: { value: 5, availability: 'observed' },
        tokenTotal: { value: 99, availability: 'observed' } }), tokenTotal: {
        ...fixtureUsage({ tokenTotal: { value: 99, availability: 'observed' } }).tokenTotal, semantics: 'unknown',
      } },
    };
    const strategy = (overrides: Partial<PipelineStrategyLedger> = {}): PipelineStrategyLedger => ({
      assignmentId: context.assignmentId, taskId: 'review-loop-task', finalCandidate: { sha256: candidateSha256 }, candidateCorrectness: true,
      operationalStatus: 'complete', authorizedBudgetStop: false,
      stages: [modelStage, judgeStage], accounting: { endToEndMs: 321 }, ...overrides,
    });
    const judgement: TaskOutcomeJudgement = {
      judgementId: 'judge-v1', version: 1, judgePin: judgeManifestHash(context.judgeManifest),
      judgeManifest: context.judgeManifest, baselineCommit: 'baseline-commit', baselineTree: 'baseline-tree',
      candidateSha256, candidateCorrectness: true, formatConformance: true, assignedStrategySuccess: true,
      operationalStatus: 'complete', artifact: { path: 'campaign/judgement.json', sha256: 'b'.repeat(64) },
    };
    const taskOutcome: TaskOutcome = {
      identity: {
        campaignId: context.campaignId, cohortId: context.cohortId, experimentId: context.experimentId,
        taskId: context.taskId, substrateId: context.substrateId, track: context.track, repeatId: context.repeatId,
        assignmentId: context.assignmentId, strategyId: context.strategyId, role: 'fixer-worker',
        budgetId: context.budgetId, frozenWeight: context.frozenWeight,
      },
      candidateCorrectness: true, formatConformance: true, assignedStrategySuccess: true, operationalStatus: 'complete',
      stages: [], judgements: [judgement],
    };
    const judgeRow: ResultRow = {
      role: 'fixer-worker', suite: 'pipeline-test-suite', case: 'case-1', model: 'gpt-6-luna', driver: 'codex-exec',
      outcome: { score: 1, passed: 1, total: 1 }, costUSD: null, wallTimeMs: 1,
      tokens: { input: 0, output: 0 }, taskOutcome,
      experiment: {
        campaignId: context.campaignId, cohortId: context.cohortId, experimentId: context.experimentId,
        taskId: context.taskId, repeatId: context.repeatId, assignmentId: context.assignmentId,
        stageId: context.stageId, attemptId: context.attemptId, track: context.track, strategyId: context.strategyId,
        settingsId: context.settingsId, budgetId: context.budgetId, profileId: context.profileId,
        frozenWeight: context.frozenWeight, substrateId: context.substrateId,
        judgePin: judgeManifestHash(context.judgeManifest),
      },
      runId: 'local-judge-run', timestamp: new Date().toISOString(),
    };
    const historyBefore = structuredClone(taskOutcome.judgements);
    const map = (options: Partial<Parameters<typeof mapPipelineCampaignEvidence>[0]> = {}) => mapPipelineCampaignEvidence({
      strategy: strategy(), judgeResult: { rows: [judgeRow], tables: [] }, caseId: 'case-1', context,
      selection: { judgementId: 'judge-v1', version: 1, judgePin: judgement.judgePin, candidateSha256 },
      recipeEvidence: { formatConformance: true, assignedStrategySuccess: true },
      pipelineJudgementArtifact: { judgementId: 'pipeline-judge-v2', version: 2, artifact: { path: 'campaign/pipeline-judge.json', sha256: 'c'.repeat(64) } },
      rowMetadata: { role: 'fixer-worker', suite: 'pipeline-test-suite', case: 'case-1', model: 'gpt-6-luna', driver: 'codex-exec', runId: 'pipeline-run', timestamp: new Date().toISOString(), expectedCases: 1 },
      stageEvidence: { 'invocation-draft': { artifacts: [{ kind: 'native-observation', path: 'attempts/observation.json', sha256: 'd'.repeat(64) }], observation: { path: 'attempts/observation.json', sha256: 'd'.repeat(64) } } },
      ...options,
    });
    const mapped = map();
    expect(mapped.taskOutcome.candidateCorrectness).toBe(true);
    expect(mapped.taskOutcome.judgements[0]).toEqual(judgement);
    expect(mapped.taskOutcome.judgements).toHaveLength(2);
    expect(mapped.taskOutcome.judgements[1]).toMatchObject({ judgementId: 'pipeline-judge-v2', formatConformance: true, assignedStrategySuccess: true });
    expect(mapped.taskOutcome.stages[0]).toMatchObject({ invocationId: 'invocation-draft', artifacts: [{ path: 'attempts/observation.json' }] });
    expect(mapped.rows[0]?.observedUsage).toMatchObject({ input: 12, output: 5, tokenTotal: null, complete: false });
    expect(mapped.tables[0]?.cells[0]).toMatchObject({ assignedStrategySuccess: 1, observedUsage: { input: 12, output: 5, tokenTotal: null } });
    expect(taskOutcome.judgements).toEqual(historyBefore);
    const authoritativeStage = { ...modelStage, usage: { ...modelStage.usage, tokenTotal: { ...modelStage.usage.tokenTotal, semantics: 'authoritative-total' } } };
    const authoritativeTotal = map({ strategy: strategy({ stages: [authoritativeStage, judgeStage] }) });
    expect(authoritativeTotal.rows[0]?.observedUsage?.tokenTotal).toBe(99);

    const formatMiss = map({ recipeEvidence: { formatConformance: false, assignedStrategySuccess: false } });
    expect(formatMiss.rows[0]?.outcomes).toMatchObject({ candidateCorrectness: true, formatConformance: false, assignedStrategySuccess: false });
    expect(formatMiss.taskOutcome.judgements[0]?.formatConformance).toBe(true);
    expect(formatMiss.taskOutcome.judgements[1]?.formatConformance).toBe(false);
    expect(formatMiss.tables[0]?.cells[0]?.assignedStrategySuccess).toBe(0);

    const noCandidate = strategy({ finalCandidate: null, candidateCorrectness: null, operationalStatus: 'budget-exhausted', authorizedBudgetStop: true,
      stages: [{ ...modelStage, terminalCause: 'budget-exhausted', usage: fixtureUsage() }] });
    const budget = map({ strategy: noCandidate, judgeResult: { rows: [], tables: [] }, selection: null,
      recipeEvidence: { formatConformance: null, assignedStrategySuccess: null }, pipelineJudgementArtifact: undefined,
      stageEvidence: { 'invocation-draft': { artifacts: [{ kind: 'native-observation', path: 'attempts/budget.json', sha256: 'e'.repeat(64) }] } } });
    expect(budget.taskOutcome).toMatchObject({ candidateCorrectness: null, assignedStrategySuccess: false, execution: { launched: true, terminalCause: 'budget-exhausted' }, judgements: [] });
    expect(budget.rows[0]?.observedUsage).toMatchObject({ input: null, output: null, tokenTotal: null, complete: false });
    expect(budget.tables[0]?.cells[0]?.assignedStrategySuccess).toBe(0);

    const thrown = map({ strategy: strategy({ finalCandidate: null, candidateCorrectness: null, operationalStatus: 'operational-failure',
      stages: [{ ...modelStage, status: 'failed', terminalCause: 'transport-throw', transportException: { name: 'Error', message: 'fixture transport failure' }, usage: fixtureUsage() }] }),
      judgeResult: { rows: [], tables: [] }, selection: null, recipeEvidence: { formatConformance: null, assignedStrategySuccess: null },
      pipelineJudgementArtifact: undefined, stageEvidence: { 'invocation-draft': { artifacts: [{ kind: 'native-observation', path: 'attempts/throw.json', sha256: 'f'.repeat(64) }] } } });
    expect(thrown.taskOutcome).toMatchObject({ candidateCorrectness: null, assignedStrategySuccess: null, operationalStatus: 'measured-transport-failure', execution: { terminalCause: 'transport-error' } });

    expect(() => map({ selection: { judgementId: 'other', version: 9, judgePin: judgement.judgePin, candidateSha256 } })).toThrow(/ID\/version/);
  });

  it('keeps unavailable counters and invalid totals unknown; total is not recomputed from possibly overlapping counters', () => {
    const observation = fixtureObservation({ invocationId: 'i', assignmentId: 'a', stageId: 's', attemptId: 't' });
    observation.usage.counters.input = { value: 7, availability: 'observed', source: 'event', semantics: 'input' };
    observation.usage.counters.output = { value: 3, availability: 'observed', source: 'event', semantics: 'output' };
    observation.usage.tokenTotal = { value: Number.POSITIVE_INFINITY, availability: 'observed', source: 'event', semantics: 'authoritative-total' };
    observation.usage.inclusion.reasoning = 'included in output';
    expect(campaignUsage(observation)).toMatchObject({ input: 7, output: 3, cacheRead: null, tokenTotal: null, complete: false });
    observation.usage.tokenTotal = { value: 25, availability: 'observed', source: 'event', semantics: 'authoritative-total' };
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

  it('contains artifact paths across symlinks, quarantines stale temp files, and publishes manifests', async () => {
    root = mkdtempSync(join(tmpdir(), 'cq-artifacts-'));
    const outside = mkdtempSync(join(tmpdir(), 'cq-artifacts-outside-'));
    const store = new ArtifactStore(root);
    const context = experiment();
    const namespace = store.attemptDirectory(context);
    mkdirSync(namespace, { recursive: true });
    const campaignDir = join(root, 'campaign');
    rmSync(campaignDir, { recursive: true });
    symlinkSync(outside, campaignDir, 'dir');
    expect(() => store.write(context, 'candidate.patch', 'patch')).toThrow(/symlink|escaped root/);
    rmSync(campaignDir);
    const artifact = store.write(context, 'events.jsonl', '{}\n');
    expect(existsSync(join(root, '.manifests', `${sha256(artifact.path)}.json`))).toBe(true);
    const stale = join(namespace, '.cq-tmp-crash');
    writeFileSync(stale, 'partial');
    const old = new Date(Date.now() - 120_000);
    utimesSync(stale, old, old);
    store.write(context, 'another.json', '{}');
    const quarantine = join(root, '.quarantine');
    const names = (await import('node:fs/promises')).readdir(quarantine);
    expect((await names).some((name) => name.endsWith('.orphan'))).toBe(true);
    expect((await names).some((name) => name.endsWith('.orphan.json'))).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  it('redacts secret values without erasing usage contract field names', () => {
    const observation = fixtureObservation({ invocationId: 'i', assignmentId: 'a', stageId: 's', attemptId: 't' });
    observation.usage.tokenTotal = { value: 42, availability: 'observed', source: 'event', semantics: 'authoritative-total' };
    observation.terminal.transportException = { name: 'Error', message: 'request failed API_KEY=sk-12345678901234567890' };
    const safe = sanitizeNativeObservation(observation);
    expect(safe.usage.tokenTotal).toMatchObject({ value: 42, semantics: 'authoritative-total' });
    expect(JSON.stringify(safe)).not.toContain('sk-12345678901234567890');
    expect(safe.terminal.transportException?.message).toContain('[redacted]');
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
    writeFileSync(join(root, 'fixture', 'check.mjs'), "import { readFileSync } from 'node:fs'; import { execFileSync } from 'node:child_process'; const ref = process.env.CQ_BASELINE_REF; const corpusBaseline = process.env.CQ_REVIEW_LOOP_BASELINE_SHA; const oraclePin = process.env.CQ_REVIEW_LOOP_ORACLE_PIN; const pristine = ref ? execFileSync('git', ['show', ref + ':fix.txt'], { encoding: 'utf8' }) : ''; process.exit(ref && corpusBaseline === ref && oraclePin === 'a'.repeat(64) && pristine === 'broken\\n' && readFileSync('fix.txt', 'utf8') === 'fixed\\n' ? 0 : 1);\n");
    const suiteDir = join(root, 'suite');
    mkdirSync(suiteDir);
    writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify({
      name: 'native-fixer', role: 'fixer-worker', provenance: { origin: 'hand-seeded' },
      cases: [{ id: 'case-1', fixture: 'fixture', task: { prompt: 'Fix the file.' }, probe: { kind: 'check-rerun', check: 'fixture/check.mjs' } }],
    }));
    const driver = new ThrowsAfterEditing();
    const runExperiment = experiment();
    runExperiment.substrateId = 'repair-task-44';
    runExperiment.judgeManifest = {
      sourcePin: 'review-loop-judge@v1',
      dependencies: [{ path: 'fixture/check.mjs', sha256: sha256(readFileSync(join(root, 'fixture', 'check.mjs'))) }],
    };
    await expect(runSuite({
      suiteDir, driver, model: 'gpt-6-luna', provider: 'openai', driverName: 'codex-exec',
      repoRoot: root, artifactRoot: join(root, 'artifacts'), experiment: runExperiment, maxTokens: 1,
    })).rejects.toThrow(/hard token cap unsupported/);
    const result = await runSuite({
      suiteDir, driver, model: 'gpt-6-luna', provider: 'openai',
      driverName: 'codex-exec', repoRoot: root, artifactRoot: join(root, 'artifacts'), experiment: runExperiment,
      hostCheckScoringEnvironment: (_workspace, pinnedBaselineCommit) => ({
        CQ_REVIEW_LOOP_BASELINE_SHA: pinnedBaselineCommit,
        CQ_REVIEW_LOOP_ORACLE_PIN: 'a'.repeat(64),
      }),
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      costUSD: null,
      observedUsage: { input: null, output: null, cacheRead: null, cacheWrite: null, tokenTotal: null, complete: false },
      outcomes: { candidateCorrectness: true, assignedStrategySuccess: true, operationalStatus: 'measured-transport-failure' },
    });
    expect(result.rows[0]?.outcome).toMatchObject({ passed: 1, total: 2 });
    expect(result.rows[0]?.taskOutcome).toMatchObject({
      identity: { assignmentId: 'assign-base', substrateId: 'repair-task-44', track: 'native-primary', frozenWeight: 1 },
      candidateCorrectness: true, formatConformance: false, assignedStrategySuccess: true,
      operationalStatus: 'measured-transport-failure',
    });
    expect(result.gatedByBudget).toBe(false);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.observation.terminal.transportException?.message).toContain('transport broke');
    expect(result.judgements).toHaveLength(1);
    expect(result.tables).toHaveLength(1);
    expect(result.rows[0]?.experiment?.substrateId).toBe('repair-task-44');
    expect(result.rows[0]?.experiment?.judgePin).toBe('a'.repeat(64));
    expect(result.rows[0]?.taskOutcome?.identity.taskId).toBe(suiteTaskId('native-fixer', 'repair-task-44'));
    expect(result.rows[0]?.taskOutcome?.judgements[0]).toMatchObject({
      judgePin: 'a'.repeat(64),
      judgeManifest: runExperiment.judgeManifest,
      baselineCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
      baselineTree: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    const attemptDir = join(root, 'artifacts', 'campaign', 'campaign-test', 'cohort', 'cohort-1', 'experiment', 'exp-test', 'task', suiteTaskId('native-fixer', 'repair-task-44'));
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

    const budgetExperiment = { ...runExperiment, attemptId: 'attempt-budget' };
    const budgetResult = await runSuite({
      suiteDir, driver: new BudgetStop(), model: 'gpt-6-luna', provider: 'openai',
      driverName: 'codex-exec', repoRoot: root, artifactRoot: join(root, 'artifacts'), experiment: budgetExperiment,
      hostCheckScoringEnvironment: (_workspace, pinnedBaselineCommit) => ({
        CQ_REVIEW_LOOP_BASELINE_SHA: pinnedBaselineCommit,
        CQ_REVIEW_LOOP_ORACLE_PIN: 'a'.repeat(64),
      }),
    });
    expect(budgetResult.rows[0]?.taskOutcome).toMatchObject({
      candidateCorrectness: false, assignedStrategySuccess: false,
      execution: { launched: true, terminalCause: 'budget-exhausted', sourceInvocationIds: [expect.any(String)] },
    });
    expect(budgetResult.rows[0]?.stopCause).toBe('budget');
  }, 20_000);
});
