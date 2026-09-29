/** Strict join from S4 strategy ledgers and S1's independent runSuite judge. */
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { aggregate, type ResultRow } from './aggregate.ts';
import { judgeManifestHash, type ExperimentContext, type StageAttemptEvidenceRef, type TaskOutcome, type TaskOutcomeJudgement } from './experiment.ts';

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
  usage: Readonly<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'tokenTotal', {
    value: number | null;
    availability: string;
    semantics: string;
    inclusion: string | null;
  }>>;
}

/** Structural S4 input keeps the shared S1 runner independent of strategy packages. */
export interface PipelineStrategyLedger {
  assignmentId: string;
  taskId: string;
  finalCandidate: { sha256: string | null } | null;
  candidateCorrectness: boolean | null;
  operationalStatus: 'complete' | 'budget-exhausted' | 'cancelled' | 'timed-out' | 'judge-unavailable' | 'operational-failure';
  authorizedBudgetStop: boolean;
  stages: readonly PipelineStageLedger[];
  accounting: { endToEndMs: number };
}

export interface PipelineJudgeSelection {
  /** Exact judgement frozen by the assignment; no latest/best fallback is permitted. */
  judgementId: string;
  version: number;
  judgePin: string;
  candidateSha256: string;
}

export interface PipelineJudgementArtifact {
  judgementId: string;
  version: number;
  artifact: { path: string; sha256: string };
}

export interface PipelineRowMetadata {
  role: 'fixer-worker';
  suite: string;
  case: string;
  model: string;
  driver: string;
  runId: string;
  timestamp: string;
  expectedCases: number;
}

export interface PipelineJudgeResult {
  /** The local runSuite row is retained as row/check evidence, never as recipe-format evidence. */
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
  if (identity.judgePin !== context.judgeManifest.sourcePin) throw new Error('pipeline mapping: runSuite semantic oracle pin does not match frozen oracle source pin');
  const outcome = row.taskOutcome?.identity;
  if (!outcome || outcome.campaignId !== context.campaignId || outcome.cohortId !== context.cohortId
    || outcome.experimentId !== context.experimentId || outcome.taskId !== context.taskId
    || outcome.substrateId !== context.substrateId || outcome.track !== context.track
    || outcome.repeatId !== context.repeatId || outcome.assignmentId !== context.assignmentId
    || outcome.strategyId !== context.strategyId || outcome.budgetId !== context.budgetId
    || outcome.frozenWeight !== context.frozenWeight) {
    throw new Error('pipeline mapping: runSuite TaskOutcome does not join the frozen assignment and substrate');
  }
}

function deriveUsage(stages: readonly PipelineStageLedger[]): NonNullable<ResultRow['observedUsage']> {
  const modelStages = stages.filter((stage) => stage.routeId !== null);
  const values = {} as Record<Counter, number | null>;
  for (const counter of counters) {
    let total = 0;
    let known = modelStages.length > 0;
    for (const stage of modelStages) {
      const observed = stage.usage[counter];
      const valid = observed.availability === 'observed' && typeof observed.value === 'number'
        && Number.isFinite(observed.value) && observed.value >= 0;
      if (!valid || (counter === 'tokenTotal'
        ? observed.semantics !== 'authoritative-total'
        : observed.semantics !== counter)) {
        known = false;
      } else {
        total += observed.value!;
      }
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

function campaignStatus(strategy: PipelineStrategyLedger, launched: boolean | null): TaskOutcomeJudgement['operationalStatus'] {
  if (launched === true && strategy.authorizedBudgetStop && strategy.finalCandidate === null) return 'measured-failure';
  return operationalStatus(strategy);
}

/**
 * Join a frozen S4 recipe assignment, native invocation evidence, and the
 * selected immutable S1 judgement. Missing host judgement remains missing.
 */
export function mapPipelineCampaignEvidence(input: {
  strategy: PipelineStrategyLedger;
  judgeResult: PipelineJudgeResult;
  caseId: string;
  context: ExperimentContext;
  selection: PipelineJudgeSelection | null;
  recipeEvidence: { formatConformance: boolean | null; assignedStrategySuccess: boolean | null };
  pipelineJudgementArtifact?: PipelineJudgementArtifact;
  rowMetadata: PipelineRowMetadata;
  /** Exact refs keyed by native invocation ID; empty arrays must be explicit. */
  stageEvidence: Readonly<Record<string, Pick<StageAttemptEvidenceRef, 'artifacts' | 'observation'>>>;
}): PipelineMappingResult {
  const { strategy, judgeResult, caseId, context, selection, recipeEvidence } = input;
  if (strategy.assignmentId !== context.assignmentId) throw new Error('pipeline mapping: strategy assignment differs from frozen assignment');
  if (!strategy.taskId) throw new Error('pipeline mapping: strategy ledger has no task key');
  if (input.rowMetadata.case !== caseId || input.rowMetadata.role !== 'fixer-worker') throw new Error('pipeline mapping: row metadata does not identify the assigned case');

  const judgeStage = strategy.stages.find((stage) => stage.stageId === context.stageId && stage.attemptId === context.attemptId);
  if (selection !== null && (!judgeStage || judgeStage.kind !== 'independent-judge')) throw new Error('pipeline mapping: no exact selected independent-judge stage/attempt');
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
    if (!(stage.invocationId in input.stageEvidence)) throw new Error(`pipeline mapping: missing retained evidence refs for invocation '${stage.invocationId}'`);
  }
  for (const invocationId of Object.keys(input.stageEvidence)) {
    if (!invocations.has(invocationId)) throw new Error(`pipeline mapping: evidence refs do not join native invocation '${invocationId}'`);
  }

  const matching = judgeResult.rows.filter((row) => row.case === caseId);
  if (matching.length > 1) throw new Error(`pipeline mapping: ambiguous runSuite rows for '${caseId}'`);
  const judgeRow = matching[0];
  const historicalJudgements = judgeRow?.taskOutcome?.judgements ?? [];
  if (judgeRow && selection !== null) sameIdentity(judgeRow, context);
  if (selection !== null && !judgeRow?.taskOutcome) throw new Error('pipeline mapping: selected judgement has no S1 TaskOutcome evidence');
  if (selection !== null && strategy.finalCandidate === null) throw new Error('pipeline mapping: frozen judge selection exists without a final candidate');
  if (strategy.finalCandidate !== null && selection === null && strategy.operationalStatus === 'complete') {
    throw new Error('pipeline mapping: completed candidate has no frozen independent-judge selection');
  }
  if (strategy.finalCandidate === null && strategy.operationalStatus === 'budget-exhausted'
    && (!strategy.authorizedBudgetStop || execution(strategy, modelStages).launched !== true)) {
    throw new Error('pipeline mapping: no-candidate budget outcome lacks authoritative launched budget exhaustion');
  }

  let selected: TaskOutcomeJudgement | undefined;
  if (selection !== null) {
    if (selection.judgePin !== context.judgeManifest.sourcePin) throw new Error('pipeline mapping: frozen judgement semantic oracle pin differs from the assigned oracle source pin');
    if (strategy.finalCandidate!.sha256 === null || selection.candidateSha256 !== strategy.finalCandidate!.sha256) throw new Error('pipeline mapping: frozen judgement candidate hash differs from final candidate');
    const matches = historicalJudgements.filter((entry) => entry.judgementId === selection.judgementId && entry.version === selection.version);
    if (matches.length !== 1) throw new Error('pipeline mapping: frozen judgement ID/version is missing or ambiguous');
    selected = matches[0]!;
    if (selected.judgePin !== selection.judgePin || selected.candidateSha256 !== selection.candidateSha256
      || judgeManifestHash(selected.judgeManifest) !== judgeManifestHash(context.judgeManifest)) {
      throw new Error('pipeline mapping: selected judgement pin, manifest, or candidate hash differs from frozen selection');
    }
    if (strategy.candidateCorrectness !== selected.candidateCorrectness) throw new Error('pipeline mapping: independent correctness differs from selected judgement');
    if (judgeStage!.launched !== false) throw new Error('pipeline mapping: local independent judge stage must not count as a model launch');
    if (!input.pipelineJudgementArtifact) throw new Error('pipeline mapping: a new immutable recipe judgement artifact is required');
    if (input.pipelineJudgementArtifact.version <= Math.max(0, ...historicalJudgements.map((entry) => entry.version))) {
      throw new Error('pipeline mapping: mapped judgement version must append after preserved history');
    }
    if (historicalJudgements.some((entry) => entry.judgementId === input.pipelineJudgementArtifact!.judgementId)) {
      throw new Error('pipeline mapping: mapped judgement ID already exists in immutable history');
    }
  } else if (strategy.candidateCorrectness !== null) {
    throw new Error('pipeline mapping: correctness must remain unknown without a frozen host judgement');
  }

  const stageEvidence: StageAttemptEvidenceRef[] = modelStages.map((stage) => ({
    stageId: stage.stageId, attemptId: stage.attemptId, invocationId: stage.invocationId!,
    artifacts: input.stageEvidence[stage.invocationId!]!.artifacts,
    ...(input.stageEvidence[stage.invocationId!]!.observation !== undefined
      ? { observation: input.stageEvidence[stage.invocationId!]!.observation } : {}),
  }));
  const runLaunch = execution(strategy, modelStages).launched;
  const status = campaignStatus(strategy, runLaunch);
  const assignedSuccess = runLaunch === true && strategy.authorizedBudgetStop && strategy.finalCandidate === null
    ? false : recipeEvidence.assignedStrategySuccess;
  if (selection === null && strategy.operationalStatus === 'judge-unavailable' && assignedSuccess !== null) {
    throw new Error('pipeline mapping: host judge inability must leave assigned recipe success unknown');
  }
  const pipelineJudgement: TaskOutcomeJudgement | undefined = selected && input.pipelineJudgementArtifact ? {
    judgementId: input.pipelineJudgementArtifact.judgementId,
    version: input.pipelineJudgementArtifact.version,
    judgePin: selected.judgePin,
    judgeManifest: selected.judgeManifest,
    baselineCommit: selected.baselineCommit,
    baselineTree: selected.baselineTree,
    candidateSha256: selected.candidateSha256,
    candidateCorrectness: selected.candidateCorrectness,
    formatConformance: recipeEvidence.formatConformance,
    assignedStrategySuccess: assignedSuccess,
    operationalStatus: status,
    artifact: input.pipelineJudgementArtifact.artifact,
  } : undefined;
  const outcome: TaskOutcome = {
    identity: {
      campaignId: context.campaignId, cohortId: context.cohortId, experimentId: context.experimentId,
      taskId: context.taskId, substrateId: context.substrateId, track: context.track, repeatId: context.repeatId,
      assignmentId: context.assignmentId, strategyId: context.strategyId, role: 'fixer-worker',
      budgetId: context.budgetId, frozenWeight: context.frozenWeight,
    },
    candidateCorrectness: selected?.candidateCorrectness ?? null,
    formatConformance: recipeEvidence.formatConformance,
    assignedStrategySuccess: assignedSuccess,
    operationalStatus: status,
    execution: execution(strategy, modelStages),
    stages: stageEvidence,
    judgements: [...historicalJudgements, ...(pipelineJudgement ? [pipelineJudgement] : [])],
  };
  const observedUsage = deriveUsage(strategy.stages);
  const metadata = input.rowMetadata;
  const baseRow: ResultRow = judgeRow ?? {
    role: metadata.role, suite: metadata.suite, case: metadata.case, model: metadata.model, driver: metadata.driver,
    outcome: { score: assignedSuccess === true ? 1 : 0, passed: assignedSuccess === true ? 1 : 0, total: 1 },
    costUSD: null, wallTimeMs: 0, tokens: { input: 0, output: 0 }, runId: metadata.runId, timestamp: metadata.timestamp,
    experiment: {
      campaignId: context.campaignId, cohortId: context.cohortId, experimentId: context.experimentId,
      taskId: context.taskId, repeatId: context.repeatId, assignmentId: context.assignmentId,
      stageId: context.stageId, attemptId: context.attemptId, track: context.track, strategyId: context.strategyId,
      settingsId: context.settingsId, budgetId: context.budgetId, profileId: context.profileId,
      frozenWeight: context.frozenWeight, substrateId: context.substrateId,
      judgePin: context.judgeManifest.sourcePin,
    },
  };
  const judgeBase = { ...baseRow };
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
    tokens: {
      input: observedUsage.input ?? baseRow.tokens.input,
      output: observedUsage.output ?? baseRow.tokens.output,
      ...(baseRow.tokens.cacheRead !== undefined || observedUsage.cacheRead !== null ? { cacheRead: observedUsage.cacheRead ?? baseRow.tokens.cacheRead ?? 0 } : {}),
      ...(baseRow.tokens.cacheWrite !== undefined || observedUsage.cacheWrite !== null ? { cacheWrite: observedUsage.cacheWrite ?? baseRow.tokens.cacheWrite ?? 0 } : {}),
      ...(baseRow.tokens.reasoning !== undefined || observedUsage.reasoning !== null ? { reasoning: observedUsage.reasoning ?? baseRow.tokens.reasoning ?? 0 } : {}),
    },
    costUSD: null,
    wallTimeMs: Math.max(0, Math.round(strategy.accounting.endToEndMs)),
    expectedCases: metadata.expectedCases,
  };
  const rows = [row];
  const tables = aggregate(rows);
  if (!validateRow(row)) throw new Error(`pipeline mapping: mapped row failed result-row schema validation: ${ajv.errorsText(validateRow.errors)}`);
  for (const table of tables) if (!validateTable(table)) throw new Error(`pipeline mapping: mapped table failed comparison-table schema validation: ${ajv.errorsText(validateTable.errors)}`);
  return { taskOutcome: outcome, rows, tables };
}
