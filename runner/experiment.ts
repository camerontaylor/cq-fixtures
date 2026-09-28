import { createHash } from 'node:crypto';

/** Canonical identity for one campaign experiment recipe. */
export interface ExperimentIdentityInput {
  track: string;
  sourcePins: Record<string, string>;
  corpusPin: string;
  promptPin: string;
  judgePin: string;
  strategy: unknown;
  settings: unknown;
  profile: unknown;
  budget: unknown;
}

export interface ExperimentContext {
  campaignId: string;
  cohortId: string;
  experimentId: string;
  taskId: string;
  repeatId: string;
  assignmentId: string;
  stageId: string;
  attemptId: string;
  track: string;
  strategyId: string;
  settingsId: string;
  budgetId: string;
  profileId: string;
  frozenWeight: number;
  /** Task's stable substrate identity; it is independent of the suite case label. */
  substrateId: string;
  judgeManifest: JudgeDependencyManifest;
  /** Required for multi-case runSuite dispatch; keys are suite case IDs. */
  caseAssignments?: Record<string, {
    assignmentId: string;
    stageId: string;
    attemptId: string;
    substrateId: string;
    judgeManifest: JudgeDependencyManifest;
  }>;
}

/** Exact task-supplied oracle provenance and the source files it depends on. */
export interface JudgeDependencyManifest {
  sourcePin: string;
  dependencies: ReadonlyArray<{ path: string; sha256: string }>;
}

export function judgeManifestHash(manifest: JudgeDependencyManifest): string {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

/** Frozen assignment identity shared by every retry and stage for one task. */
export interface TaskAssignmentIdentity {
  campaignId: string;
  cohortId: string;
  experimentId: string;
  /** Hash of suite plus substrate identity. */
  taskId: string;
  substrateId: string;
  track: string;
  repeatId: string;
  assignmentId: string;
  strategyId: string;
  role: 'fixer-worker' | 'review-classifier';
  budgetId: string;
  /** Frozen analysis weight; retries and stages must preserve it exactly. */
  frozenWeight: number;
}

export interface StageAttemptEvidenceRef {
  stageId: string;
  attemptId: string;
  invocationId: string;
  artifacts: ReadonlyArray<{ kind: string; path: string; sha256: string }>;
  observation?: { path: string; sha256: string };
}

export interface TaskOutcomeJudgement {
  judgementId: string;
  version: number;
  judgePin: string;
  judgeManifest: JudgeDependencyManifest;
  baselineCommit: string | null;
  baselineTree: string | null;
  candidateSha256: string;
  candidateCorrectness: boolean | null;
  formatConformance: boolean | null;
  assignedStrategySuccess: boolean | null;
  operationalStatus:
    | 'complete' | 'measured-failure' | 'measured-transport-failure'
    | 'operational-missingness' | 'judge-failure' | 'interrupted'
    | 'integrity-violation';
  artifact: { path: string; sha256: string };
}

/**
 * Authoritative campaign join. Invocation observations are evidence only;
 * an independent, hash-pinned judgement creates a TaskOutcome version.
 */
export interface TaskOutcome {
  identity: TaskAssignmentIdentity;
  candidateCorrectness: boolean | null;
  formatConformance: boolean | null;
  assignedStrategySuccess: boolean | null;
  operationalStatus: TaskOutcomeJudgement['operationalStatus'];
  /** Optional authoritative launch/terminal provenance; absent legacy values stay unknown. */
  execution?: {
    launched: boolean | null;
    terminalCause: 'complete' | 'budget-exhausted' | 'transport-error' | 'provider-cancelled' | 'operator-cancelled' | 'prelaunch-failure' | 'unknown';
    sourceInvocationIds: readonly string[];
  };
  stages: ReadonlyArray<StageAttemptEvidenceRef>;
  judgements: ReadonlyArray<TaskOutcomeJudgement>;
}

/** Stable JSON for identity hashing; object insertion order cannot change an ID. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function experimentId(input: ExperimentIdentityInput): string {
  return `exp-${createHash('sha256').update(canonicalJson(input)).digest('hex')}`;
}

export function suiteTaskId(suite: string, substrate: string): string {
  return `task-${createHash('sha256').update(canonicalJson({ suite, substrate })).digest('hex')}`;
}
