import { describe, expect, it } from 'vitest';
import type { WorkerResult } from '@camerontaylor/cq-toolkit';
import type { ResultRow } from '../runner/aggregate.ts';
import { type ExperimentContext, type TaskOutcome, type TaskOutcomeJudgement } from '../runner/experiment.ts';
import { mapPipelineCampaignEvidence, type PipelineStageLedger, type PipelineStrategyLedger } from '../runner/pipelineMapping.ts';
import { legacyObservation, campaignUsage } from '../runner/native/observation.ts';
function fixtureUsage(overrides: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'tokenTotal', { value: number | null; availability: 'observed' | 'unavailable' | 'not-reported' }>> = {}) {
  return Object.fromEntries((['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tokenTotal'] as const).map((name) => {
    const item = overrides[name] ?? { value: null, availability: 'not-reported' as const };
    return [name, { ...item, source: item.availability === 'observed' ? 'test-ledger' : null,
      semantics: name === 'tokenTotal' && item.availability === 'observed' ? 'authoritative-total' : name, inclusion: null }];
  })) as unknown as PipelineStageLedger['usage'];
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


function mappingFixture() {
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
    const map = (options: Partial<Parameters<typeof mapPipelineCampaignEvidence>[0]> = {}) => mapPipelineCampaignEvidence({
      strategy: strategy(), judgeResult: { rows: [judgeRow], tables: [] }, caseId: 'case-1', context,
      selection: { judgementId: 'judge-v1', version: 1, judgePin: judgement.judgePin, candidateSha256 },
      recipeEvidence: { formatConformance: true, assignedStrategySuccess: true },
      pipelineJudgementArtifact: { judgementId: 'pipeline-judge-v2', version: 2, artifact: { path: 'campaign/pipeline-judge.json', sha256: 'c'.repeat(64) } },
      rowMetadata: { role: 'fixer-worker', suite: 'pipeline-test-suite', case: 'case-1', model: 'gpt-6-luna', driver: 'codex-exec', runId: 'pipeline-run', timestamp: new Date().toISOString(), expectedCases: 1 },
      stageEvidence: { 'invocation-draft': { artifacts: [{ kind: 'native-observation', path: 'attempts/observation.json', sha256: 'd'.repeat(64) }], observation: { path: 'attempts/observation.json', sha256: 'd'.repeat(64) } } },
      ...options,
    });

return { map, strategy, modelStage, judgeStage, judgeRow, judgement };
}
describe('pipeline usage frozen contract', () => {
  it('never synthesizes a legacy authoritative total from overlapping counters', () => {
    const result: WorkerResult = { usage: { input: 12, output: 3, cacheRead: 7, cacheWrite: 0 }, denials: [], stopReason: 'complete' };
    const observation = legacyObservation({ invocationId: 'i', assignmentId: 'a', stageId: 's', attemptId: 't' }, result, '2026-09-29T00:00:00Z', '2026-09-29T00:00:01Z');
    expect(observation.usage.tokenTotal).toEqual({ value: null, availability: 'not-reported', source: null, semantics: 'unknown' });
    expect(campaignUsage(observation)).toEqual({ input: 12, output: 3, cacheRead: 7, cacheWrite: 0, reasoning: null, tokenTotal: null, complete: false });
    expect(observation.usage.inclusion.cache).toBe('driver-defined');
    observation.usage.counters.input.semantics = 'output';
    expect(campaignUsage(observation).input).toBeNull();
  });
  it('selects the frozen older judgement and preserves both historical versions', () => {
    const { map, judgeRow, judgement } = mappingFixture();
    const newer = { ...judgement, judgementId: 'judge-newer', version: 2, candidateCorrectness: false };
    judgeRow.taskOutcome!.judgements = [...judgeRow.taskOutcome!.judgements, newer];
    const before = structuredClone(judgeRow.taskOutcome!.judgements);
    const result = map({ pipelineJudgementArtifact: { judgementId: 'recipe-v3', version: 3, artifact: { path: 'recipe.json', sha256: 'f'.repeat(64) } } });
    expect(result.taskOutcome.candidateCorrectness).toBe(true);
    expect(result.taskOutcome.judgements.slice(0, 2)).toEqual(before);
    expect(judgeRow.taskOutcome!.judgements).toEqual(before);
  });
  it('rejects whitespace artifact refs and empty invocation identities', () => {
    const { map, strategy, modelStage, judgeStage } = mappingFixture();
    expect(() => map({ stageEvidence: { 'invocation-draft': { artifacts: [{ kind: 'native-observation', path: ' ', sha256: 'd'.repeat(64) }] } } })).toThrow();
    expect(() => map({ stageEvidence: { 'invocation-draft': { artifacts: [{ kind: 'native-observation', path: 'events.json', sha256: '' }] } } })).toThrow();
    expect(() => map({ strategy: strategy({ stages: [{ ...modelStage, invocationId: '' }, judgeStage] }), stageEvidence: { '': { artifacts: [] } } })).toThrow();
  });
  it('rejects foreign history even when no judgement is selected', () => {
    const { map, strategy, judgeRow } = mappingFixture();
    judgeRow.experiment!.assignmentId = 'foreign';
    expect(() => map({ selection: null, strategy: strategy({ finalCandidate: null, candidateCorrectness: null, operationalStatus: 'judge-unavailable' }), recipeEvidence: { formatConformance: null, assignedStrategySuccess: null } })).toThrow(/assignmentId/);
  });
  it('does not combine counters with different inclusion semantics', () => {
    const { map, strategy, modelStage, judgeStage } = mappingFixture();
    const second = { ...modelStage, stageId: 'second', attemptId: 'second', invocationId: 'second', usage: { ...modelStage.usage, input: { ...modelStage.usage.input, inclusion: 'excludes cache' } } };
    const result = map({ strategy: strategy({ stages: [modelStage, second, judgeStage] }), stageEvidence: { 'invocation-draft': { artifacts: [] }, second: { artifacts: [] } } });
    expect(result.rows[0]!.observedUsage!.input).toBeNull();
    expect(result.rows[0]!.observedUsage!.output).toBe(10);
  });
  it('keeps observed zero and partial stage totals distinct from missing counters', () => {
    const { map, strategy, modelStage, judgeStage } = mappingFixture();
    const first = { ...modelStage, usage: fixtureUsage({ input: { value: 0, availability: 'observed' }, tokenTotal: { value: 0, availability: 'observed' } }) };
    const second = { ...first, stageId: 'second', attemptId: 'second', invocationId: 'second', usage: fixtureUsage({ input: { value: 0, availability: 'observed' } }) };
    const result = map({ strategy: strategy({ stages: [first, second, judgeStage] }), stageEvidence: { 'invocation-draft': { artifacts: [] }, second: { artifacts: [] } } });
    expect(result.rows[0]!.observedUsage).toEqual({ input: 0, output: null, cacheRead: null, cacheWrite: null, reasoning: null, tokenTotal: null, complete: false });
    expect(result.rows[0]!.costUSD).toBeNull();
  });
});
