import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openRunLog, type Driver, type OpInvocation, type WorkerResult } from '@camerontaylor/cq-toolkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore, sha256 } from '../runner/artifacts/index.ts';
import { nativeGovernorUsage } from '../runner/budget.ts';
import { experimentId, suiteTaskId, type ExperimentContext, type TaskOutcome, type TaskOutcomeJudgement } from '../runner/experiment.ts';
import { aggregate, aggregateCorrected, type ResultRow } from '../runner/aggregate.ts';
// PK14 / D22 + D77 consumption seam, reached through the PUBLIC runner
// entrypoint rather than by importing the sidecar internals: if this import
// ever stops resolving, the wiring has been undone.
import {
  consumeRetention,
  consumeRunReport,
  consumeStatus,
  loadPinnedCorrections,
  projectRetention,
  type CorrectionsManifest,
  type ManifestResolver,
} from '../runner/index.ts';
import { canonicalRecordHash } from '../runner/reporting/corrections.ts';
import { runSuite } from '../runner/index.ts';
import { campaignUsage, sanitizeNativeObservation, type NativeObservation, type InvocationIdentity } from '../runner/native/observation.ts';
import { regradeCampaignCandidate } from '../runner/regrade.ts';
import { mapPipelineCampaignEvidence, type PipelineStageLedger, type PipelineStrategyLedger } from '../runner/pipelineMapping.ts';

let root = '';
afterEach(() => { vi.restoreAllMocks(); if (root) rmSync(root, { recursive: true, force: true }); });

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

class ThrowsWithoutPatchCapture implements Driver {
  private identity?: InvocationIdentity;
  async beginInvocation(identity: InvocationIdentity): Promise<void> { this.identity = identity; }
  async run(): Promise<WorkerResult> { throw new Error('transport ended before trusted patch capture'); }
  getObservation(invocationId: string): NativeObservation | undefined {
    if (this.identity?.invocationId !== invocationId) return undefined;
    const observation = fixtureObservation(this.identity, {
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      denials: [], stopReason: 'complete', structuredOutput: { candidate: 'not a patch' },
    });
    observation.terminal.transportException = { name: 'Error', message: 'transport ended before trusted patch capture' };
    return observation;
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
      sourcePin: '1'.repeat(64), dependencies: [{ path: 'fixture/check.mjs', sha256: '0'.repeat(64) }],
    },
  };
}

describe('campaign envelope', () => {
  it('does not infer observed usage from compatibility counters or promote incomplete observations', () => {
    const row: ResultRow = {
      role: 'fixer-worker', suite: 'usage-seam', model: 'no-model', driver: 'synthetic',
      outcome: { score: 1, passed: 1, total: 1 }, costUSD: null, wallTimeMs: 1,
      tokens: { input: 12, output: 3, cacheRead: 7 }, runId: 'local', timestamp: '2026-09-29T00:00:00Z',
    };
    const legacy = aggregate([row])[0]!.cells[0]!;
    expect(legacy.tokens).toEqual(row.tokens);
    expect(legacy.observedUsage).toBeUndefined();
    const incomplete = aggregate([{ ...row, observedUsage: {
      input: 12, output: 3, cacheRead: 7, cacheWrite: 0, reasoning: 0, tokenTotal: 15, complete: false,
    } }])[0]!.cells[0]!;
    expect(incomplete.observedUsage).toEqual({
      input: 12, output: 3, cacheRead: 7, cacheWrite: 0, reasoning: 0, tokenTotal: 15, complete: false,
    });
    const mixed = aggregate([row, { ...row, observedUsage: {
      input: 12, output: 3, cacheRead: 7, cacheWrite: 0, reasoning: 0, tokenTotal: 15, complete: true,
    } }])[0]!.cells[0]!;
    expect(mixed.observedUsage).toEqual({
      input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, tokenTotal: null, complete: false,
    });
  });

  it.each(['valid-json', 'format-miss', 'transport-failure', 'valid-empty'] as const)(
    'independently grades the same correct edit with %s', async (mode) => {
      root = mkdtempSync(join(tmpdir(), 'cq-correctness-format-'));
      mkdirSync(join(root, 'policy', 'denylist'), { recursive: true });
      writeFileSync(join(root, 'policy', 'denylist', 'patterns.yml'), readFileSync(new URL('../policy/denylist/patterns.yml', import.meta.url)));
      mkdirSync(join(root, 'fixture'));
      writeFileSync(join(root, 'fixture', 'fix.txt'), mode === 'valid-empty' ? 'fixed\n' : 'broken\n');
      const checkPath = join(root, 'fixture', 'check.mjs');
      writeFileSync(checkPath, "import { readFileSync } from 'node:fs'; process.exit(readFileSync('fix.txt', 'utf8') === 'fixed\\n' ? 0 : 1);\n");
      const suiteDir = join(root, 'suite');
      mkdirSync(suiteDir);
      writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify({
        name: 'format-independent', role: 'fixer-worker', provenance: { origin: 'hand-seeded' },
        cases: [{ id: 'case-1', fixture: 'fixture', task: { prompt: 'Fix the file.' }, probe: { kind: 'check-rerun', check: 'fixture/check.mjs' } }],
      }));
      const driver: Driver = {
        async run(invocation) {
          const workspace = /workspace: (.+)$/.exec(invocation.prompt)?.[1];
          if (workspace === undefined) throw new Error('test workspace missing');
          writeFileSync(join(workspace, 'fix.txt'), 'fixed\n');
          if (mode === 'transport-failure') throw new Error('transport failed after edit');
          return {
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, denials: [],
            stopReason: mode === 'format-miss' ? 'error' : 'complete',
            ...((mode === 'valid-json' || mode === 'valid-empty') ? { structuredOutput: { fixed: true, notes: 'fixed' } }
              : { error: 'ai-sdk driver: [structured-output-miss] missing JSON' }),
          };
        },
      };
      const context = experiment();
      context.judgeManifest = { sourcePin: 'a'.repeat(64), dependencies: [{ path: 'fixture/check.mjs', sha256: sha256(readFileSync(checkPath)) }] };
      const result = await runSuite({ suiteDir, driver, model: 'test-model', provider: 'openai', repoRoot: root,
        artifactRoot: join(root, 'artifacts'), experiment: context });
      const row = result.rows[0]!;
      expect(row.outcomes).toMatchObject({ candidateCorrectness: true, assignedStrategySuccess: true,
        formatConformance: (mode === 'valid-json' || mode === 'valid-empty'), operationalStatus: mode === 'transport-failure' ? 'measured-transport-failure' : 'complete' });
      expect(row.taskOutcome?.judgements[0]?.candidateCorrectness).toBe(true);
      if (mode === 'valid-empty') expect(row.taskOutcome?.judgements[0]?.candidateSha256).toBe(sha256(''));
      expect(result.tables[0]?.cells[0]?.conditionalCorrectness).toBe(1);
      expect(row.outcome.score).toBe((mode === 'valid-json' || mode === 'valid-empty') ? 1 : 0.5);
    }, 20_000,
  );

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
      judgementId: 'judge-v1', version: 1, judgePin: context.judgeManifest.sourcePin,
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
        judgePin: context.judgeManifest.sourcePin,
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

  it('validates trusted judge source roots independently of a temporary runSuite repo', async () => {
    root = mkdtempSync(join(tmpdir(), 'cq-trusted-judge-root-'));
    const repoRoot = join(root, 'temporary-suite-repo');
    mkdirSync(join(repoRoot, 'policy', 'denylist'), { recursive: true });
    writeFileSync(join(repoRoot, 'policy', 'denylist', 'patterns.yml'), readFileSync(new URL('../policy/denylist/patterns.yml', import.meta.url)));
    mkdirSync(join(repoRoot, 'fixture'), { recursive: true });
    writeFileSync(join(repoRoot, 'fixture', 'fix.txt'), 'unchanged\n');
    writeFileSync(join(repoRoot, 'fixture', 'check.mjs'), "process.exit(process.env.CQ_REVIEW_LOOP_ORACLE_PIN === 'a'.repeat(64) ? 0 : 1);\n");
    const suiteDir = join(root, 'suite');
    mkdirSync(suiteDir);
    writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify({
      name: 'trusted-root-suite', role: 'fixer-worker', provenance: { origin: 'local test' },
      cases: [{ id: 'case-1', fixture: 'fixture', task: { prompt: 'Verify trusted oracle root.' },
        probe: { kind: 'check-rerun', check: 'fixture/check.mjs' } }],
    }));

    const trustedDependency = {
      path: 'runner/index.ts',
      sha256: sha256(readFileSync(new URL('../runner/index.ts', import.meta.url))),
    };
    const context = experiment();
    context.judgeManifest = {
      sourcePin: 'a'.repeat(64), sourceRootId: 'cq-settings-native-checkout', dependencies: [trustedDependency],
    };
    let dispatches = 0;
    const driver: Driver = {
      async run(invocation) {
        dispatches += 1;
        const workspace = /workspace: (.+)$/.exec(invocation.prompt)?.[1];
        if (workspace === undefined) throw new Error('test could not locate candidate workspace');
        writeFileSync(join(workspace, 'fix.txt'), 'candidate edit\n');
        return { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, denials: [], stopReason: 'complete',
          structuredOutput: { fixed: true, notes: 'trusted root fixture' } };
      },
    };
    const run = (judgeManifest: ExperimentContext['judgeManifest']) => runSuite({
      suiteDir, driver, model: 'gpt-6-luna', provider: 'openai', driverName: 'codex-exec',
      repoRoot, artifactRoot: join(root, 'artifacts'), experiment: { ...context, judgeManifest },
      hostCheckScoringEnvironment: (_workspace, pinnedBaselineCommit) => ({
        CQ_REVIEW_LOOP_BASELINE_SHA: pinnedBaselineCommit, CQ_REVIEW_LOOP_ORACLE_PIN: 'a'.repeat(64),
      }),
    });

    const result = await run(context.judgeManifest);
    expect(result.rows[0]?.taskOutcome?.judgements[0]?.judgeManifest.sourceRootId).toBe('cq-settings-native-checkout');
    expect(result.rows[0]?.outcomes?.candidateCorrectness).toBe(true);
    expect(dispatches).toBe(1);
    const unknownRootManifest = { ...context.judgeManifest, sourceRootId: 'unconfigured-checkout' } as unknown as ExperimentContext['judgeManifest'];
    await expect(run(unknownRootManifest)).rejects.toThrow(/unknown trusted sourceRootId/);
    await expect(run({ ...context.judgeManifest, dependencies: [{ ...trustedDependency, sha256: '0'.repeat(64) }] })).rejects.toThrow(/hash mismatch/);
    await expect(run({ ...context.judgeManifest, dependencies: [{ path: '../runner/index.ts', sha256: trustedDependency.sha256 }] })).rejects.toThrow(/unsafe or duplicate path/);
    expect(dispatches).toBe(1);
    expect(existsSync(join(repoRoot, 'runner'))).toBe(false);
  }, 20_000);

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

  it.each([false, true])('runSuite retrieves the envelope and finalizes thrown transport with judgement write failure %s', async (failJudgement) => {
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
      sourcePin: 'a'.repeat(64),
      dependencies: [{ path: 'fixture/check.mjs', sha256: sha256(readFileSync(join(root, 'fixture', 'check.mjs'))) }],
    };
    await expect(runSuite({
      suiteDir, driver, model: 'gpt-6-luna', provider: 'openai', driverName: 'codex-exec',
      repoRoot: root, artifactRoot: join(root, 'artifacts'), experiment: runExperiment, maxTokens: 1,
    })).rejects.toThrow(/hard token cap unsupported/);
    if (failJudgement) vi.spyOn(ArtifactStore.prototype, 'writeJudgement').mockImplementation(() => { throw new Error('injected judgement artifact write failure'); });
    const result = await runSuite({
      suiteDir, driver, model: 'gpt-6-luna', provider: 'openai',
      driverName: 'codex-exec', repoRoot: root, artifactRoot: join(root, 'artifacts'), experiment: runExperiment, journalPath: join(root, 'journal'),
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
    if (failJudgement) {
      expect(result.judgements).toEqual([]);
      expect(result.taskOutcomes).toHaveLength(1);
      expect(result.taskOutcomes[0]?.outcome.judgements).toEqual([]);
      expect(result.rows[0]?.taskOutcome?.judgements).toEqual([]);
      expect(result.diagnostics.join('\n')).toContain('judgement persistence failed: injected judgement artifact write failure');
      const log = openRunLog(join(root, 'journal'));
      const events = await log.read(result.runId);
      expect(events.some(event => event.type === 'job-finished')).toBe(true);
      expect(events.some(event => event.type === 'run-finished')).toBe(true);
      const terminal = events.find(event => event.type === 'job-finished');
      expect(JSON.stringify(terminal)).toContain('transport broke');
      expect(JSON.stringify(terminal)).not.toContain('injected judgement');
      return;
    }
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

    // Map the actual independent runSuite result with the frozen semantic
    // oracle pin. Its manifest digest is a separate identity.
    const actualRow = result.rows[0]!;
    const actualContext = { ...runExperiment, taskId: suiteTaskId('native-fixer', runExperiment.substrateId),
      stageId: actualRow.experiment!.stageId, attemptId: actualRow.experiment!.attemptId };
    const hostJudgement = actualRow.taskOutcome!.judgements[0]!;
    const native = result.observations[0]!;
    const actualStage: PipelineStageLedger = {
      assignmentId: actualContext.assignmentId, stageId: 'model-stage',
      attemptId: 'model-attempt', invocationId: native.observation.identity.invocationId,
      kind: 'draft', routeId: 'codex-native', status: 'failed', launched: true,
      terminalCause: 'transport-throw', transportException: { name: 'Error', message: 'transport broke after edit' },
      usage: fixtureUsage(),
    };
    const actualStageEvidence = {
      [native.observation.identity.invocationId]: {
        artifacts: [{ kind: 'native-observation', path: native.artifact.path, sha256: native.artifact.sha256 }],
        observation: { path: native.artifact.path, sha256: native.artifact.sha256 },
      },
    };
    const mapActual = (selection = {
      judgementId: hostJudgement.judgementId, version: hostJudgement.version,
      judgePin: hostJudgement.judgePin, candidateSha256: hostJudgement.candidateSha256,
    }) => mapPipelineCampaignEvidence({
      strategy: {
        assignmentId: actualContext.assignmentId, taskId: actualContext.taskId,
        finalCandidate: { sha256: hostJudgement.candidateSha256 }, candidateCorrectness: hostJudgement.candidateCorrectness,
        operationalStatus: 'operational-failure', authorizedBudgetStop: false,
        stages: [actualStage, {
          assignmentId: actualContext.assignmentId, stageId: actualContext.stageId, attemptId: actualContext.attemptId,
          invocationId: null, kind: 'independent-judge', routeId: null, status: 'completed', launched: false,
          terminalCause: null, transportException: null, usage: fixtureUsage(),
        }], accounting: { endToEndMs: actualRow.wallTimeMs },
      },
      judgeResult: { rows: result.rows, tables: result.tables }, caseId: 'case-1', context: actualContext,
      selection, recipeEvidence: { formatConformance: false, assignedStrategySuccess: true },
      pipelineJudgementArtifact: { judgementId: 'recipe-judge-v2', version: 2, artifact: { path: 'recipe.json', sha256: 'd'.repeat(64) } },
      rowMetadata: {
        role: 'fixer-worker' as const, suite: actualRow.suite ?? 'native-fixer', case: actualRow.case ?? 'case-1', model: actualRow.model ?? 'gpt-6-luna',
        driver: actualRow.driver, runId: 'actual-runSuite-map', timestamp: actualRow.timestamp, expectedCases: 1,
      },
      stageEvidence: actualStageEvidence,
    });
    const actualMapped = mapActual();
    expect(actualMapped.taskOutcome.candidateCorrectness).toBe(true);
    expect(actualMapped.taskOutcome.judgements[0]).toEqual(hostJudgement);
    expect(actualMapped.taskOutcome.judgements[1]).toMatchObject({ formatConformance: false, assignedStrategySuccess: true });
    expect(actualMapped.rows[0]?.experiment?.judgePin).toBe(actualContext.judgeManifest.sourcePin);
    expect(() => mapActual({ judgementId: hostJudgement.judgementId, version: hostJudgement.version,
      judgePin: '0'.repeat(64), candidateSha256: hostJudgement.candidateSha256 })).toThrow(/semantic oracle pin/);

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
  }, 35_000);

  it('keeps thrown structured output as observation evidence when trusted fixer patch capture is unavailable', async () => {
    root = mkdtempSync(join(tmpdir(), 'cq-missing-patch-'));
    mkdirSync(join(root, 'policy', 'denylist'), { recursive: true });
    writeFileSync(join(root, 'policy', 'denylist', 'patterns.yml'), readFileSync(new URL('../policy/denylist/patterns.yml', import.meta.url)));
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'fix.txt'), 'broken\n');
    writeFileSync(join(root, 'fixture', 'check.mjs'), 'process.exit(1);\n');
    const suiteDir = join(root, 'suite');
    mkdirSync(suiteDir);
    writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify({
      name: 'native-fixer', role: 'fixer-worker', provenance: { origin: 'hand-seeded' },
      cases: [{ id: 'case-1', fixture: 'fixture', task: { prompt: 'Fix the file.' }, probe: { kind: 'check-rerun', check: 'fixture/check.mjs' } }],
    }));
    const context = experiment();
    context.judgeManifest = {
      sourcePin: 'a'.repeat(64),
      dependencies: [{ path: 'fixture/check.mjs', sha256: sha256(readFileSync(join(root, 'fixture', 'check.mjs'))) }],
    };
    const artifactRoot = join(root, 'artifacts');
    const result = await runSuite({
      suiteDir, driver: new ThrowsWithoutPatchCapture(), model: 'gpt-6-luna', provider: 'openai',
      driverName: 'codex-exec', repoRoot: root, artifactRoot, experiment: context,
    });

    expect(result.rows).toHaveLength(0);
    expect(result.absences).toHaveLength(1);
    expect(result.observations).toHaveLength(1);
    const observation = result.observations[0]!.observation;
    expect(observation.workerResult?.structuredOutput).toEqual({ candidate: 'not a patch' });
    expect(observation.capture.patchSha256).toBeNull();
    expect(observation.usage.tokenTotal).toMatchObject({ value: null, availability: 'unavailable', semantics: 'unknown' });
    expect(observation.artifacts.some((item) => item.kind === 'candidate-patch')).toBe(false);
    expect(result.judgements).toHaveLength(0);

    expect(result.taskOutcomes).toHaveLength(1);
    const savedAttempt = result.taskOutcomes[0]!;
    expect(savedAttempt.outcome).toMatchObject({
      candidateCorrectness: null, formatConformance: null, assignedStrategySuccess: null,
      operationalStatus: 'operational-missingness',
      execution: { launched: true, terminalCause: 'transport-error', sourceInvocationIds: [observation.identity.invocationId] },
      judgements: [],
      stages: [{ invocationId: observation.identity.invocationId, observation: result.observations[0]!.artifact }],
    });
    const envelopePath = join(artifactRoot, savedAttempt.artifact.path);
    expect(sha256(readFileSync(envelopePath))).toBe(savedAttempt.artifact.sha256);
    expect(JSON.parse(readFileSync(envelopePath, 'utf8'))).toEqual(savedAttempt.outcome);
    expect(result.diagnostics.join('\n')).not.toContain('Received undefined');
  }, 20_000);
});

// ===========================================================================
// PK14 / D22 + D77: correction-reporting consumption, end to end.
//
// This is the caller regression for the wiring seam. It drives the PUBLIC
// runner entrypoint the way a report consumer does - load the hash-pinned
// manifest, resolve pinned bytes, consume corrections for a run, re-aggregate
// through the ordinary lane - and asserts the D22 behaviours end to end:
//
//   * the run19 timeout correction can never restore the retracted
//     operationalCompletionRate of 1, in EITHER direction: when its named
//     artifacts cannot be re-hashed the claim is withheld (null), and when
//     they can it is RECOMPUTED from corrected rows (0).
//   * a stale or mismatched record is rejected and the claim is withheld,
//     rather than the original value being quietly republished.
//   * run18's lost full candidate stays absent, and never becomes a retained
//     auth or patch; an unproven resource stays unknown (null), not false.
//   * live raw rows survive consumption untouched, and correctness / format
//     conformance / strategy success are never rewritten by a lifecycle
//     correction.
//
// It is a DEVELOPMENT regression for this seam. It is not actual-route
// evidence and satisfies no campaign acceptance criterion.
// ===========================================================================

const PK14_AUTHORITY = 'cq-settings-execution-orchestrator';
const RUN19 = 'cq-s5-final-20260929-19';
const RUN18 = 'cq-s5-final-20260929-18';

const readRepo = (relative: string): string => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');

/** The historic run19 row as it was published: complete, rate 1. */
function run19Row(): ResultRow {
  return {
    role: 'fixer-worker', suite: 'fixer-worker', case: 'case-1', model: 'luna-subscription', driver: 'codex-exec',
    outcome: { score: 0.5, passed: 1, total: 2 }, costUSD: null, wallTimeMs: 1000,
    tokens: { input: 100, output: 10 },
    runId: RUN19, timestamp: '2026-09-29T00:00:00.000Z',
    // Campaign rows carry the experiment identity, which is what makes the
    // aggregate lane emit the rate and correctness columns this seam corrects.
    experiment: {
      campaignId: 'cq', cohortId: 's5', experimentId: RUN19, taskId: 'task-1', repeatId: '0',
      assignmentId: 'final-profile-g1-cq-s5-final-20260929-19', stageId: 'final', attemptId: '1',
      track: 'default', strategyId: 's', settingsId: 'set', budgetId: 'b', profileId: 'p', frozenWeight: 1,
      substrateId: 'sub', judgePin: 'pin',
    },
    outcomes: { candidateCorrectness: true, formatConformance: false, assignedStrategySuccess: true, operationalStatus: 'complete' },
    taskOutcome: {
      identity: {
        campaignId: 'cq', cohortId: 's5', experimentId: RUN19, taskId: 'task-1', substrateId: 'sub', track: 'default',
        repeatId: '0', assignmentId: 'final-profile-g1-cq-s5-final-20260929-19', strategyId: 's', role: 'fixer-worker',
        budgetId: 'b', frozenWeight: 1, judgeManifest: { sourcePin: 'pin', dependencies: [] },
      },
      candidateCorrectness: true, formatConformance: false, assignedStrategySuccess: true, operationalStatus: 'complete',
      execution: { launched: true, terminalCause: 'complete', sourceInvocationIds: ['d9cd61ba-3ca3-478e-b275-fefca2a41e05'] },
      stages: [], judgements: [],
    },
  } as ResultRow;
}

const RUN19_HISTORIC = {
  'execution.terminalCause': 'complete',
  'operationalStatus': 'complete',
  'table.operationalCompletionRate': 1,
};

/**
 * A test-local manifest + record for the APPLIED path.
 *
 * The real run19 correction names six private native artifacts that were never
 * exported, so no consumer in this checkout can re-hash them and its claims
 * are (correctly) withheld. To also exercise the path where a correction DOES
 * qualify, this builds an equivalent record whose named artifacts are bytes the
 * test controls, so the hash verification is real rather than stubbed.
 */
function appliedCase(): { manifest: CorrectionsManifest; resolve: ManifestResolver; artifacts: Record<string, string> } {
  const artifacts = {
    reportSha256: 'test artifact: native report\n',
    taskOutcomeSha256: 'test artifact: task outcome\n',
  };
  const record = {
    schemaVersion: 1,
    kind: 'append-only-lifecycle-correction',
    runId: RUN19,
    assignmentId: 'final-profile-g1-cq-s5-final-20260929-19',
    invocationId: 'd9cd61ba-3ca3-478e-b275-fefca2a41e05',
    sourceEvidence: Object.fromEntries(Object.entries(artifacts).map(([name, bytes]) => [name, sha256(bytes)])),
    authoritativeNativeTerminal: 'timeout',
    supersededLifecycleProjections: ['execution.terminalCause=complete', 'operationalStatus=complete', 'table.operationalCompletionRate=1'],
    normalWorkerCompletion: false,
    processTreeStopped: true,
  };
  const bytes = JSON.stringify(record, null, 2);
  const manifest: CorrectionsManifest = {
    schemaVersion: 1,
    approvedAuthorities: [PK14_AUTHORITY],
    entries: [{
      id: 'test-run19-lifecycle', kind: 'append-only-lifecycle-correction', root: 'repo', path: 'test-record.json',
      sha256: sha256(bytes), canonicalId: canonicalRecordHash(record), authorityId: PK14_AUTHORITY, recordedAt: null,
    }],
  };
  return { manifest, resolve: () => bytes, artifacts };
}

const MAPPING = { terminalCause: 'unknown', operationalStatus: 'interrupted' } as const;

describe('PK14 D22/D77: correction reporting is consumed end to end', () => {
  it('publishes the run19 timeout correction and recomputes the rate instead of restoring 1', () => {
    const row = run19Row();
    const { manifest, resolve, artifacts } = appliedCase();
    const pinned = loadPinnedCorrections(manifest, resolve, {
      mapping: { ...MAPPING, completionRows: [{ operationalStatus: 'complete' }] },
    });
    expect(pinned.ok, JSON.stringify(pinned.failures)).toBe(true);

    const report = consumeRunReport({
      runId: RUN19, rows: [row], original: RUN19_HISTORIC, corrections: pinned,
      resolveEvidence: (binding) => artifacts[binding.path] ?? null,
    });
    const tables = aggregateCorrected(report);

    // The correction qualified and landed on the derived row.
    expect(report.state.applied).toBe(true);
    expect(report.state.selectionStatus).toBe('selected');
    expect(report.correctedRows[0]!.outcomes!.operationalStatus).toBe('interrupted');
    expect(report.correctedRows[0]!.taskOutcome!.execution!.terminalCause).toBe('unknown');

    // The retracted rate is RECOMPUTED as 0. It is never the literal 1, and
    // the aggregate lane computes it from the corrected rows, not from the
    // record's own historic value.
    expect(report.state.historicCompletionRate).toBe(1);
    expect(report.state.correctedCompletionRate).toBe(0);
    expect(tables.correctedCompletionRate).toBe(0);
    const correctedCells = tables.corrected.flatMap((t) => t.cells);
    expect(correctedCells.every((c) => c.operationalCompletionRate === 0)).toBe(true);

    // The ORIGINAL tables are still there, still carrying the historic value.
    // Consumption is additive: it never rewrites what was already published.
    expect(tables.original.flatMap((t) => t.cells).every((c) => c.operationalCompletionRate === 1)).toBe(true);
  }, 20_000);

  it('keeps live raw rows, and never rewrites correctness, format or strategy success', () => {
    const row = run19Row();
    const { manifest, resolve, artifacts } = appliedCase();
    const pinned = loadPinnedCorrections(manifest, resolve, {
      mapping: { ...MAPPING, completionRows: [{ operationalStatus: 'complete' }] },
    });
    const before = JSON.stringify(row);
    const report = consumeRunReport({
      runId: RUN19, rows: [row], original: RUN19_HISTORIC, corrections: pinned,
      resolveEvidence: (binding) => artifacts[binding.path] ?? null,
    });

    expect(JSON.stringify(row)).toBe(before);
    expect(JSON.stringify(report.rawRows[0])).toBe(before);
    expect(report.rawRows).toHaveLength(1);
    // A lifecycle correction retracts COMPLETION. The judged outcome stands.
    const corrected = report.correctedRows[0]!;
    expect(corrected.outcomes!.candidateCorrectness).toBe(true);
    expect(corrected.outcomes!.formatConformance).toBe(false);
    expect(corrected.outcomes!.assignedStrategySuccess).toBe(true);
    expect(corrected.taskOutcome!.candidateCorrectness).toBe(true);
    expect(corrected.taskOutcome!.formatConformance).toBe(false);
    // And the aggregate lane's correctness columns are untouched by it.
    const cells = aggregateCorrected(report).corrected.flatMap((t) => t.cells);
    expect(cells.every((c) => c.conditionalCorrectness === 1)).toBe(true);
    expect(cells.every((c) => c.assignedStrategySuccess === 1)).toBe(true);
  }, 20_000);

  it('withholds the rate when a named artifact cannot be re-hashed, and never republishes 1', () => {
    const { manifest, resolve } = appliedCase();
    const pinned = loadPinnedCorrections(manifest, resolve, {
      mapping: { ...MAPPING, completionRows: [{ operationalStatus: 'complete' }] },
    });
    // The artifacts are NOT supplied. Unresolvable is unresolved - not
    // "so the correction is unnecessary" and not "so the original still holds".
    const report = consumeRunReport({
      runId: RUN19, rows: [run19Row()], original: RUN19_HISTORIC, corrections: pinned,
      resolveEvidence: () => null,
    });

    expect(report.state.applied).toBe(false);
    expect(report.state.selectionStatus).toBe('unresolved');
    expect(report.state.completionRateWithheld).toBe(true);
    expect(report.state.correctedCompletionRate).toBeNull();
    expect(report.state.correctedCompletionRate).not.toBe(1);
    expect(report.state.withheld.some((w) => w.field === 'table.operationalCompletionRate')).toBe(true);
    // And the derived rows are the raw rows, because nothing qualified.
    expect(JSON.stringify(report.correctedRows[0])).toBe(JSON.stringify(report.rawRows[0]));
  }, 20_000);

  it('rejects a stale record whose bytes no longer match the pin', () => {
    const { manifest, artifacts } = appliedCase();
    // Same pin, different bytes: a record that was edited after it was pinned.
    const tampered = JSON.stringify({ ...JSON.parse('{}'), note: 'rewritten' });
    const pinned = loadPinnedCorrections(manifest, () => tampered, {
      mapping: { ...MAPPING, completionRows: [{ operationalStatus: 'complete' }] },
    });
    expect(pinned.ok).toBe(false);
    expect(pinned.records).toHaveLength(0);
    expect(pinned.failures[0]!.disposition.reason).toBe('artifact-binding-mismatch');

    const report = consumeRunReport({
      runId: RUN19, rows: [run19Row()], original: RUN19_HISTORIC, corrections: pinned,
      resolveEvidence: (binding) => artifacts[binding.path] ?? null,
    });
    // Nothing qualified, and the historic 1 is reported as the original only.
    expect(report.state.applied).toBe(false);
    expect(report.state.correctedCompletionRate).toBe(1);
    expect(report.state.historicCompletionRate).toBe(1);
    expect(report.state.blockers.map((b) => b.reason)).toContain('artifact-binding-mismatch');
  }, 20_000);

  it('rejects a mismatched artifact and withholds the affected claim', () => {
    const { manifest, resolve, artifacts } = appliedCase();
    const pinned = loadPinnedCorrections(manifest, resolve, {
      mapping: { ...MAPPING, completionRows: [{ operationalStatus: 'complete' }] },
    });
    const report = consumeRunReport({
      runId: RUN19, rows: [run19Row()], original: RUN19_HISTORIC, corrections: pinned,
      // Right artifact name, WRONG bytes: resolved, but the hash differs.
      resolveEvidence: (binding) => (artifacts[binding.path] === undefined ? null : 'tampered bytes\n'),
    });
    expect(report.state.applied).toBe(false);
    expect(report.state.completionRateWithheld).toBe(true);
    expect(report.state.correctedCompletionRate).toBeNull();
    expect(report.state.blockers.map((b) => b.reason)).toContain('artifact-binding-mismatch');
  }, 20_000);

  it('never reuses the original rate for a lifecycle projection the adapter declined to map', () => {
    const { manifest, resolve, artifacts } = appliedCase();
    // No completionRows: the adapter retires the rate but emits no replacement.
    const pinned = loadPinnedCorrections(manifest, resolve, { mapping: MAPPING });
    const report = consumeRunReport({
      runId: RUN19, rows: [run19Row()], original: RUN19_HISTORIC, corrections: pinned,
      resolveEvidence: (binding) => artifacts[binding.path] ?? null,
    });
    // This is the retracted-1 regression: a field with no speaker must not fall
    // back to the original value, because the record DID retire it.
    expect(report.state.completionRateWithheld).toBe(true);
    expect(report.state.correctedCompletionRate).toBeNull();
    expect(report.state.withheld.some((w) => w.reason === 'adapter-unmapped')).toBe(true);
  }, 20_000);

  it('states run18 retention per resource and never restores the lost full candidate', () => {
    const run18 = projectRetention({
      runId: RUN18,
      record: JSON.parse(readRepo('runner/boundary/evidence/fallback/run18-retention-audit.public.json')),
      recordRef: { path: 'runner/boundary/evidence/fallback/run18-retention-audit.public.json', sha256: sha256(readRepo('runner/boundary/evidence/fallback/run18-retention-audit.public.json')) },
    });
    const r = run18.resources;
    // The D22 finding: recoveryRetained covered auth while the candidate was gone.
    expect(r.fullCandidate.state).toBe('absent');
    expect(r.patch.state).toBe('retained');
    // A surviving patch does NOT make auth retained, and the record never
    // speaks about auth, so auth stays UNKNOWN - not false, not retained.
    expect(r.auth.state).toBe('unknown');
    expect(r.taskVolume.state).toBe('absent');
    expect(r.contextVolume.state).toBe('absent');
    expect(r.publishedHost.state).toBe('absent');
    // The conflated historical field is reported, never used as a state.
    expect(run18.resources.fullCandidate.reason).toMatch(/fullCandidateAvailable=false/);
  }, 20_000);

  it('consumes run18 retention through the seam and keeps unknown as null', () => {
    const bytes = readRepo('runner/boundary/evidence/fallback/run18-retention-audit.public.json');
    const record = JSON.parse(bytes);
    const manifest: CorrectionsManifest = {
      schemaVersion: 1,
      approvedAuthorities: [PK14_AUTHORITY],
      entries: [{
        id: 'run18-retention-audit', kind: 'retention-binding', root: 'repo',
        path: 'runner/boundary/evidence/fallback/run18-retention-audit.public.json',
        sha256: sha256(bytes), canonicalId: canonicalRecordHash(record),
        authorityId: PK14_AUTHORITY, recordedAt: null,
      }],
    };
    const pinned = loadPinnedCorrections(manifest, () => bytes);
    expect(pinned.ok).toBe(true);

    const consumed = consumeRetention({ runId: RUN18, corrections: pinned });
    expect(consumed.view).not.toBeNull();
    expect(consumed.view!.resources.fullCandidate.state).toBe('absent');
    expect(consumed.view!.resources.auth.state).toBe('unknown');
    expect(consumed.view!.resources.patch.state).toBe('retained');
    // A different run is simply not covered: that is unknown, not "absent".
    expect(consumeRetention({ runId: 'cq-s5-final-20260929-99', corrections: pinned }).view).toBeNull();
  }, 20_000);

  it('renders the correction-aware board with per-route scope and the remaining criterion', () => {
    const route = consumeStatus({
      asOf: '2026-09-29T12:00:00.000Z',
      corrections: { ok: true, records: [], verifications: [], failures: [], approvedAuthorities: [PK14_AUTHORITY] },
      scopes: [{ entryId: 'run21-g1-contract-audit', route: 'final-container-codex-g1', lane: 'actual' }],
    });
    // An audit that did not verify leaves the route UNKNOWN, not unqualified.
    expect(route.unreadEntries).toContain('run21-g1-contract-audit');
    expect(route.view.routes[0]!.dimensions.actualRouteQualified.value).toBeNull();
    // A route pass never implies campaign completion.
    expect(route.view.campaignComplete.value).toBeNull();
    expect(route.view.campaignComplete.reason).toMatch(/route passes do not imply campaign completion/);
  }, 20_000);
});
