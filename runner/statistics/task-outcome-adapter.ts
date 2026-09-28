import { designHash, type Observation, type Preregistration } from './inference.js';

/** Structural subset of S1 e5702c7 runner/experiment.ts exports. S1 integration
 * may pass canonical TaskOutcome directly; no sibling-path runtime dependency.
 */
export interface TaskOutcomeInput {
  identity: {
    campaignId: string; cohortId: string; experimentId: string; taskId: string;
    /** Additive S1 ed54581 fields; e5702c7 joins supply these via the frozen map. */
    substrateId?: string; track?: string;
    repeatId: string; assignmentId: string; strategyId: string; role: string;
    budgetId: string; frozenWeight: number;
  };
  candidateCorrectness: boolean | null;
  formatConformance: boolean | null;
  assignedStrategySuccess: boolean | null;
  operationalStatus: string;
  stages: ReadonlyArray<{
    stageId: string; attemptId: string; invocationId: string;
    artifacts: ReadonlyArray<{ kind: string; path: string; sha256: string }>;
    observation?: { path: string; sha256: string };
  }>;
  judgements: ReadonlyArray<{
    judgementId: string; version: number; judgePin: string; candidateSha256: string;
    candidateCorrectness: boolean | null; formatConformance: boolean | null;
    assignedStrategySuccess: boolean | null; operationalStatus: string;
    artifact: { path: string; sha256: string };
  }>;
}
export interface OutcomeJoinRegistration {
  frozen: true;
  baseDesignHash: string;
  campaignId: string;
  /** Exactly one mapping per strategy/task/repeat. Missing outcomes may be
   * absent but retain this assigned roster; retries never create new outcomes.
   */
  assignments: ReadonlyArray<{
    assignmentId: string; experimentId: string; strategyId: string;
    taskId: string; repeatId: string; substrateId: string; frozenWeight: number;
    judgementId: string; judgementVersion: number; judgePin: string;
  }>;
}
const key = (s: string, t: string, r: string): string => JSON.stringify([s, t, r]);
const sha = (v: string): boolean => /^[a-f0-9]{64}$/i.test(v);
const statuses = new Set(['complete', 'measured-failure', 'measured-transport-failure', 'operational-missingness', 'judge-failure', 'interrupted', 'integrity-violation']);
export function adaptTaskOutcomes(reg: Preregistration, join: OutcomeJoinRegistration, outcomes: readonly TaskOutcomeInput[]): {
  observations: Observation[];
  audit: Array<{ assignmentId: string; judgementId: string; judgementVersion: number; stages: TaskOutcomeInput['stages']; judgementArtifact: { path: string; sha256: string } | null }>;
} {
  if (join.frozen !== true || join.baseDesignHash !== designHash(reg) || !join.campaignId) throw new Error('outcome join must bind the frozen design');
  const strategies = new Set(reg.contrasts.flatMap(c => [c.strategyId, c.baselineId]));
  const roster = new Map(reg.assignments.map(a => [key('', a.taskId, a.repeatId), a]));
  const mappings = new Map<string, OutcomeJoinRegistration['assignments'][number]>(), assignmentIds = new Set<string>();
  for (const j of join.assignments) {
    const a = roster.get(key('', j.taskId, j.repeatId)), k = key(j.strategyId, j.taskId, j.repeatId);
    if (!a || !strategies.has(j.strategyId) || a.substrateId !== j.substrateId || a.weight !== j.frozenWeight
      || !j.assignmentId || !j.experimentId || !j.judgementId || !j.judgePin || !Number.isSafeInteger(j.judgementVersion) || j.judgementVersion < 1
      || mappings.has(k) || assignmentIds.has(j.assignmentId)) throw new Error('invalid/duplicate frozen assignment join');
    mappings.set(k, j); assignmentIds.add(j.assignmentId);
  }
  if (mappings.size !== roster.size * strategies.size) throw new Error('outcome join must retain the full assigned strategy roster');
  const globalInvocations = new Set<string>();
  const observations: Observation[] = [], audit: ReturnType<typeof adaptTaskOutcomes>['audit'] = [], seen = new Set<string>();
  for (const o of outcomes) {
    const i = o.identity, k = key(i.strategyId, i.taskId, i.repeatId), j = mappings.get(k);
    if (!j || seen.has(k) || i.assignmentId !== j.assignmentId || i.experimentId !== j.experimentId
      || i.campaignId !== join.campaignId || i.cohortId !== reg.cohortId || i.role !== reg.role
      || (i.substrateId !== undefined && i.substrateId !== j.substrateId) || (i.track !== undefined && i.track !== reg.track)
      || i.budgetId !== reg.budgetId || i.frozenWeight !== j.frozenWeight) throw new Error('task outcome identity/weight parity violation or duplicate retry outcome');
    seen.add(k);
    const judgementIds = new Set<string>(), versions = new Set<number>();
    for (const v of o.judgements) {
      if (!v.judgementId || judgementIds.has(v.judgementId) || versions.has(v.version) || !Number.isSafeInteger(v.version) || v.version < 1
        || !v.judgePin || !sha(v.candidateSha256) || !v.artifact.path || !sha(v.artifact.sha256)) throw new Error('invalid append-only judgement evidence');
      judgementIds.add(v.judgementId); versions.add(v.version);
    }
    const selected = o.judgements.find(v => v.judgementId === j.judgementId && v.version === j.judgementVersion && v.judgePin === j.judgePin);
    const mechanicalNoCandidateFailure = o.judgements.length === 0 && o.stages.length > 0
      && o.candidateCorrectness === null && o.assignedStrategySuccess === false && o.operationalStatus === 'measured-failure';
    if (!selected && !mechanicalNoCandidateFailure && !(o.assignedStrategySuccess === null && ['operational-missingness', 'judge-failure', 'interrupted'].includes(o.operationalStatus))) throw new Error('frozen independent judgement selection is absent');
    const projection = selected ?? o;
    if (!statuses.has(projection.operationalStatus) || ![true, false, null].includes(projection.assignedStrategySuccess)
      || ![true, false, null].includes(projection.candidateCorrectness) || ![true, false, null].includes(projection.formatConformance)
      || (['measured-failure', 'integrity-violation'].includes(projection.operationalStatus) && projection.assignedStrategySuccess !== false)
      || (['operational-missingness', 'judge-failure'].includes(projection.operationalStatus) && projection.assignedStrategySuccess !== null)
      || projection.assignedStrategySuccess !== o.assignedStrategySuccess || projection.candidateCorrectness !== o.candidateCorrectness
      || projection.formatConformance !== o.formatConformance || projection.operationalStatus !== o.operationalStatus) throw new Error('task outcome projection differs from frozen judgement');
    const attempts = new Set<string>(), invocations = new Set<string>();
    for (const stage of o.stages) {
      const attempt = key(stage.stageId, stage.attemptId, '');
      if (!stage.stageId || !stage.attemptId || !stage.invocationId || attempts.has(attempt) || invocations.has(stage.invocationId)
        || globalInvocations.has(stage.invocationId)
        || stage.artifacts.some(a => !a.path || !a.kind || !sha(a.sha256))
        || (stage.observation && (!stage.observation.path || !sha(stage.observation.sha256)))) throw new Error('duplicate/invalid stage retry evidence');
      attempts.add(attempt); invocations.add(stage.invocationId); globalInvocations.add(stage.invocationId);
    }
    // Candidate correctness, format and transport status never substitute for
    // the independently mapped assigned-strategy success (including false).
    const success = projection.assignedStrategySuccess;
    observations.push({ taskId: i.taskId, substrateId: j.substrateId, repeatId: i.repeatId, weight: i.frozenWeight,
      strategyId: i.strategyId, track: reg.track, cohortId: reg.cohortId,
      status: success === null ? 'operational-missing' : 'measured', success, cause: projection.operationalStatus });
    audit.push({ assignmentId: i.assignmentId, judgementId: selected?.judgementId ?? j.judgementId, judgementVersion: selected?.version ?? j.judgementVersion,
      stages: o.stages, judgementArtifact: selected?.artifact ?? null });
  }
  return { observations, audit };
}
