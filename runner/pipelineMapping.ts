/** Strict join from S4 strategy ledgers and the S1 independent runSuite judge. */
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { aggregate, type ResultRow } from './aggregate.ts';
import { judgeManifestHash, type ExperimentContext, type TaskOutcome, type TaskOutcomeJudgement } from './experiment.ts';

export interface PipelineStageLedger {
  assignmentId: string;
  stageId: string;
  attemptId: string;
  invocationId: string | null;
  kind: string;
  routeId: string | null;
  status: string;
  launched: boolean | null;
  terminalCause: string | null;
  transportException: { name: string; message: string } | null;
  usage: Readonly<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'tokenTotal', { value: number | null; availability: string }>>;
}

/** Structural S4 input keeps the shared S1 runner independent of strategy packages. */
export interface PipelineStrategyLedger {
  assignmentId: string;
  /** S4's recipe task key, retained for diagnostics; campaign task identity is context.taskId. */
  taskId: string;
  finalCandidate: { sha256: string } | null;
  candidateCorrectness: boolean | null;
  formatCompliance: boolean | null;
  assignedStrategySuccess: boolean | null;
  operationalStatus: 'complete' | 'budget-exhausted' | 'cancelled' | 'timed-out' | 'judge-unavailable' | 'operational-failure';
  recipeCompleted: boolean;
  authorizedBudgetStop: boolean;
  stages: readonly PipelineStageLedger[];
  accounting: { endToEndMs: number };
}

export interface PipelineJudgeResult {
  rows: readonly ResultRow[];
  tables: readonly unknown[];
}

export interface PipelineMappingResult {
  taskOutcome: TaskOutcome;
  rows: ResultRow[];
  tables: ReturnType<typeof aggregate>;
}

const ajv = addFormats(new Ajv2020({ allErrors: true }));
const validateRow = ajv.compile(JSON.parse(readFileSync(new URL('../schema/result-row.schema.json', import.meta.url), 'utf8')) as object);
const validateTable = ajv.compile(JSON.parse(readFileSync(new URL('../schema/comparison-table.schema.json', import.meta.url), 'utf8')) as object);

const counters = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tokenTotal'] as const;
type Counter = typeof counters[number];

function sameIdentity(row: ResultRow, context: ExperimentContext): void {
  const identity = row.experiment;
  if (!identity) throw new Error('pipeline mapping: independent runSuite row has no experiment identity');
  for (const key of ['campaignId', 'cohortId', 'experimentId', 'taskId', 'repeatId', 'assignmentId', 'stageId', 'attemptId', 'track', 'strategyId', 'settingsId', 'budgetId', 'profileId', 'substrateId'] as const) {
    if (identity[key] !== context[key]) throw new Error(`pipeline mapping: runSuite ${key} does not match frozen assignment`);
  }
  if (identity.judgePin !== judgeManifestHash(context.judgeManifest)) throw new Error('pipeline mapping: runSuite judge pin does not match the frozen judge manifest');
  const outcomeIdentity = row.taskOutcome?.identity;
  if (!outcomeIdentity || outcomeIdentity.campaignId !== context.campaignId || outcomeIdentity.cohortId !== context.cohortId
    || outcomeIdentity.experimentId !== context.experimentId || outcomeIdentity.taskId !== context.taskId
    || outcomeIdentity.substrateId !== context.substrateId || outcomeIdentity.track !== context.track
    || outcomeIdentity.repeatId !== context.repeatId || outcomeIdentity.assignmentId !== context.assignmentId
    || outcomeIdentity.strategyId !== context.strategyId || outcomeIdentity.budgetId !== context.budgetId
    || outcomeIdentity.frozenWeight !== context.frozenWeight) {
    throw new Error('pipeline mapping: runSuite TaskOutcome does not join the frozen assignment and substrate');
  }
}

function deriveUsage(stages: readonly PipelineStageLedger[]): ResultRow['observedUsage'] {
  const modelStages = stages.filter((stage) => stage.routeId !== null);
  const values = {} as Record<Counter, number | null>;
  for (const counter of counters) {
    let total = 0;
    let known = modelStages.length > 0;
    for (const stage of modelStages) {
      const observed = stage.usage[counter];
      if (observed.availability !== 'observed' || observed.value === null || !Number.isFinite(observed.value) || observed.value < 0) known = false;
      else total += observed.value;
    }
    values[counter] = known && Number.isFinite(total) ? total : null;
  }
  return { ...values, complete: counters.every((counter) => values[counter] !== null) };
}

function operationalStatus(strategy: PipelineStrategyLedger): TaskOutcomeJudgement['operationalStatus'] {
  switch (strategy.operationalStatus) {
    case 'complete': return 'complete';
    case 'budget-exhausted': return 'measured-failure';
    case 'cancelled': case 'timed-out': return 'interrupted';
    case 'judge-unavailable': return 'judge-failure';
    case 'operational-failure':
      return strategy.stages.some((stage) => stage.transportException !== null) ? 'measured-transport-failure' : 'operational-missingness';
  }
}

function execution(strategy: PipelineStrategyLedger, modelStages: readonly PipelineStageLedger[]): NonNullable<TaskOutcome['execution']> {
  const launched = modelStages.some((stage) => stage.launched === true) ? true
    : modelStages.some((stage) => stage.launched === null) ? null : false;
  const sourceInvocationIds = modelStages.flatMap((stage) => stage.invocationId === null ? [] : [stage.invocationId]);
  const causes = modelStages.map((stage) => stage.terminalCause);
  const terminalCause: NonNullable<TaskOutcome['execution']>['terminalCause'] =
    strategy.authorizedBudgetStop || causes.includes('budget-exhausted') ? 'budget-exhausted'
      : causes.includes('operator-cancelled') ? 'operator-cancelled'
        : causes.includes('provider-cancelled') ? 'provider-cancelled'
          : modelStages.some((stage) => stage.transportException !== null) || causes.includes('transport-error') || causes.includes('transport-throw') ? 'transport-error'
            : strategy.operationalStatus === 'complete' ? 'complete'
              : launched === false ? 'prelaunch-failure' : 'unknown';
  return { launched, terminalCause, sourceInvocationIds };
}

/**
 * Join one final S4 recipe ledger with its S1 runSuite independent judgement.
 * Refuses ambiguous/mismatched joins; local synthetic driver usage is discarded.
 */
export function mapPipelineCampaignEvidence(input: {
  strategy: PipelineStrategyLedger;
  judgeResult: PipelineJudgeResult;
  caseId: string;
  context: ExperimentContext;
}): PipelineMappingResult {
  const { strategy, judgeResult, caseId, context } = input;
  if (strategy.assignmentId !== context.assignmentId) throw new Error('pipeline mapping: strategy assignment differs from frozen assignment');
  if (!strategy.taskId) throw new Error('pipeline mapping: strategy ledger has no task key');
  const judgeStage = strategy.stages.find((stage) => stage.stageId === context.stageId && stage.attemptId === context.attemptId);
  if (!judgeStage || judgeStage.kind !== 'independent-judge') throw new Error('pipeline mapping: no exact independent-judge stage/attempt join');
  const modelStages = strategy.stages.filter((stage) => stage.routeId !== null);
  const stageKeys = new Set<string>();
  const invocations = new Set<string>();
  for (const stage of modelStages) {
    if (stage.assignmentId !== context.assignmentId) throw new Error('pipeline mapping: stage belongs to a different frozen assignment');
    const key = `${stage.stageId}\0${stage.attemptId}`;
    if (stageKeys.has(key)) throw new Error('pipeline mapping: duplicate stage/attempt in native ledger');
    stageKeys.add(key);
    if (stage.invocationId === null) throw new Error('pipeline mapping: native stage has no invocation identity');
    if (invocations.has(stage.invocationId)) throw new Error('pipeline mapping: native invocation identity is reused');
    invocations.add(stage.invocationId);
  }
  const matching = judgeResult.rows.filter((row) => row.case === caseId);
  if (matching.length !== 1) throw new Error(`pipeline mapping: expected exactly one runSuite row for '${caseId}', found ${matching.length}`);
  const judgeRow = matching[0]!;
  sameIdentity(judgeRow, context);
  if (judgeRow.role !== 'fixer-worker' || judgeRow.taskOutcome === undefined) throw new Error('pipeline mapping: row is not an independent fixer TaskOutcome');
  if (strategy.finalCandidate === null) throw new Error('pipeline mapping: no final candidate exists for independent judgement');
  const judgements = [...judgeRow.taskOutcome.judgements].sort((a, b) => b.version - a.version);
  const finalJudgement = judgements[0];
  if (!finalJudgement) throw new Error('pipeline mapping: runSuite produced no pinned independent judgement');
  if (finalJudgement.judgePin !== judgeRow.experiment!.judgePin) throw new Error('pipeline mapping: judgement pin differs from row pin');
  if (judgeManifestHash(finalJudgement.judgeManifest) !== judgeRow.experiment!.judgePin) throw new Error('pipeline mapping: judgement manifest differs from the frozen oracle pin');
  if (finalJudgement.candidateSha256 !== strategy.finalCandidate.sha256) throw new Error('pipeline mapping: final judgement candidate hash differs from S4 final candidate');
  if (strategy.candidateCorrectness !== finalJudgement.candidateCorrectness) throw new Error('pipeline mapping: independent correctness differs from S4 judge result');
  if (strategy.formatCompliance !== finalJudgement.formatConformance) throw new Error('pipeline mapping: format compliance differs from S1 independent judgement');
  if (judgeStage.launched !== false) throw new Error('pipeline mapping: local independent judge stage must not be counted as a model launch');

  const status = operationalStatus(strategy);
  const mappedJudgements = judgements.map((judgement) => ({
    ...judgement,
    assignedStrategySuccess: strategy.assignedStrategySuccess,
    operationalStatus: status,
  }));
  const stageEvidence = modelStages.map((stage) => ({
    stageId: stage.stageId, attemptId: stage.attemptId, invocationId: stage.invocationId!, artifacts: [],
  }));
  const outcome: TaskOutcome = {
    identity: {
      campaignId: context.campaignId, cohortId: context.cohortId, experimentId: context.experimentId,
      taskId: context.taskId, substrateId: context.substrateId, track: context.track, repeatId: context.repeatId,
      assignmentId: context.assignmentId, strategyId: context.strategyId, role: judgeRow.role,
      budgetId: context.budgetId, frozenWeight: context.frozenWeight,
    },
    candidateCorrectness: finalJudgement.candidateCorrectness,
    formatConformance: finalJudgement.formatConformance,
    assignedStrategySuccess: strategy.assignedStrategySuccess,
    operationalStatus: status,
    execution: execution(strategy, modelStages),
    stages: stageEvidence,
    judgements: mappedJudgements,
  };
  const observedUsage = deriveUsage(strategy.stages);
  const judgeBase = { ...judgeRow };
  delete judgeBase.costBasis;
  const row: ResultRow = {
    ...judgeBase,
    taskOutcome: outcome,
    outcomes: {
      candidateCorrectness: outcome.candidateCorrectness,
      formatConformance: outcome.formatConformance,
      assignedStrategySuccess: outcome.assignedStrategySuccess,
      operationalStatus: status,
    },
    observedUsage,
    // Required legacy projection only; when the authoritative nullable value
    // is unknown these copied values remain compatibility data and are never
    // interpreted as measured by the campaign aggregator.
    tokens: {
      input: observedUsage!.input ?? judgeRow.tokens.input,
      output: observedUsage!.output ?? judgeRow.tokens.output,
      ...(judgeRow.tokens.cacheRead !== undefined || observedUsage!.cacheRead !== null
        ? { cacheRead: observedUsage!.cacheRead ?? judgeRow.tokens.cacheRead ?? 0 } : {}),
      ...(judgeRow.tokens.cacheWrite !== undefined || observedUsage!.cacheWrite !== null
        ? { cacheWrite: observedUsage!.cacheWrite ?? judgeRow.tokens.cacheWrite ?? 0 } : {}),
      ...(judgeRow.tokens.reasoning !== undefined || observedUsage!.reasoning !== null
        ? { reasoning: observedUsage!.reasoning ?? judgeRow.tokens.reasoning ?? 0 } : {}),
    },
    costUSD: null,
    wallTimeMs: Math.max(0, Math.round(strategy.accounting.endToEndMs)),
  };
  const rows = [row];
  const tables = aggregate(rows);
  if (!validateRow(row)) throw new Error(`pipeline mapping: mapped row failed result-row schema validation: ${ajv.errorsText(validateRow.errors)}`);
  for (const table of tables) if (!validateTable(table)) throw new Error(`pipeline mapping: mapped table failed comparison-table schema validation: ${ajv.errorsText(validateTable.errors)}`);
  return { taskOutcome: outcome, rows, tables };
}
