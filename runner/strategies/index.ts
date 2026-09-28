/** Bounded, fixtures-local campaign strategy engine.
 *
 * This module deliberately knows nothing about native transports or toolkit
 * Drivers. A parent stage executor owns launch, capture, selection and the
 * independent oracle. The engine owns recipe identity, stage/attempt identity,
 * cumulative limits and truthful whole-pipeline accounting.
 */
import { createHash, randomUUID } from 'node:crypto';

export type TokenCounter = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'tokenTotal';
export type TokenEnforcement = 'hard' | 'advisory' | 'unsupported';
export type EvaluationTrack = 'native' | 'diagnostic';

export interface StrategyRoute {
  /** Stable configured route label, never an inferred underlying model identity. */
  id: string;
  /** Token-cap conformance is explicit for each native route. */
  tokenEnforcement: TokenEnforcement;
  transport: 'codex-exec' | 'pi-json' | 'pi-rpc' | 'zcode-acp' | 'shared-diagnostic' | 'fake';
  /** Optional native settings inventory. Unsupported values must not be sent. */
  supportedSettings?: Readonly<Record<string, readonly string[]>>;
}

export interface PerTaskBudgetTier {
  id: string;
  /** One cumulative cap over model attempts, selection and verification. */
  maxAttempts: number;
  /** Counts all executor stages, including selection and final judgement. */
  maxStages: number;
  /** Hard end-to-end wall clock limit, including independent judgement. */
  wallClockMs: number;
  /** Reserved within wallClockMs for the independent final judge. */
  judgementAllowanceMs: number;
  /** Reserved after cancellation for process-tree stop confirmation. */
  shutdownAllowanceMs: number;
  /** Reserved for authoritative S1 envelope retrieval, including failed outcomes. */
  observationAllowanceMs: number;
  /** Reserved after confirmed shutdown to preserve workspace edits. */
  captureAllowanceMs: number;
  tokenPolicy?: 'hard-required' | 'advisory';
  /** If present, enforced only on routes whose conformance is `hard`. */
  tokenBudget?: number;
}

export function defineBudgetTiers(tiers: readonly PerTaskBudgetTier[]): readonly PerTaskBudgetTier[] {
  if (tiers.length < 3) throw new RangeError('A strategy matrix requires at least three per-task budget tiers');
  const ids = new Set<string>();
  for (const tier of tiers) {
    if (!tier.id || ids.has(tier.id)) throw new Error(`Budget tier ids must be non-empty and unique: ${tier.id}`);
    ids.add(tier.id);
    for (const [name, value] of Object.entries({
      maxAttempts: tier.maxAttempts,
      maxStages: tier.maxStages,
      wallClockMs: tier.wallClockMs,
      judgementAllowanceMs: tier.judgementAllowanceMs,
      shutdownAllowanceMs: tier.shutdownAllowanceMs,
      observationAllowanceMs: tier.observationAllowanceMs,
      captureAllowanceMs: tier.captureAllowanceMs,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${tier.id}.${name} must be a positive safe integer`);
    }
    if (tier.maxStages < 2) throw new RangeError(`${tier.id}.maxStages must reserve a candidate and judge stage`);
    if (tier.judgementAllowanceMs + tier.shutdownAllowanceMs + tier.observationAllowanceMs + tier.captureAllowanceMs >= tier.wallClockMs) {
      throw new RangeError(`${tier.id} allowances must leave time for candidate work`);
    }
    if (tier.tokenBudget !== undefined && (!Number.isSafeInteger(tier.tokenBudget) || tier.tokenBudget < 1)) {
      throw new RangeError(`${tier.id}.tokenBudget must be a positive safe integer`);
    }
  }
  return Object.freeze(tiers.map((tier) => Object.freeze({ ...tier })));
}

export interface StrategyTask {
  id: string;
  prompt: string;
  evaluationTrack: EvaluationTrack;
  /** Parent-selected independent oracle route; execution and judging remain parent-owned. */
  independentJudgeRoute?: StrategyRoute;
  /** Parent-controlled opaque workspace/context handle. */
  workspace: unknown;
  /** Frozen campaign identity included in the strategy hash. */
  campaignIdentity: Readonly<{
    profileInventoryHash: string;
    evaluationBoundaryHash: string;
    scaffoldAssistanceHash: string;
    sourcePin?: string;
    corpusPin?: string;
    judgePin?: string;
  }>;
  requireFormatCompliance?: boolean;
}

export type StrategyRecipe =
  | { kind: 'one-shot'; route: StrategyRoute }
  | { kind: 'same-model-verify-repair'; route: StrategyRoute; maxRepairs: number }
  | {
      kind: 'candidate-selection'; route: StrategyRoute; candidateCount: number;
      selector: { kind: 'frozen-rule' } | { kind: 'judge'; route?: StrategyRoute } | { kind: 'model'; route: StrategyRoute };
    }
  | {
      kind: 'mixed-model-verify-repair'; draftRoute: StrategyRoute; verifyRoute: StrategyRoute;
      repairRoute?: StrategyRoute; maxRepairs: number;
    }
  | {
      kind: 'cheap-first-escalation'; tiers: readonly { route: StrategyRoute; effort: string }[];
      promoteWhen: 'verification-failed' | 'no-candidate';
    };

export type StageKind = 'draft' | 'verify' | 'repair' | 'select' | 'escalate' | 'independent-judge';
export type StagePurpose = 'candidate-generation' | 'scaffold' | 'selection' | 'oracle';

export interface InvocationIdentity {
  readonly assignmentId: string;
  readonly stageId: string;
  readonly attemptId: string;
}

/** Deterministic S1-safe identities. Reusing a stage key preserves stageId;
 * each retry ordinal gets a distinct attemptId under that same stage. */
export function strategyInvocationIdentity(
  assignmentId: string,
  recipeDigest: string,
  stageKey: string,
  attemptOrdinal: number,
): Pick<InvocationIdentity, 'stageId' | 'attemptId'> {
  if (!assignmentId || !recipeDigest || !stageKey) throw new Error('Strategy identity fields must be non-empty');
  if (!Number.isSafeInteger(attemptOrdinal) || attemptOrdinal < 1) throw new RangeError('attemptOrdinal must be a positive safe integer');
  const digest = (part: string): string => createHash('sha256').update(part).digest('hex');
  const namespace = digest(`${assignmentId}\0${recipeDigest}`).slice(0, 20);
  const stage = digest(stageKey).slice(0, 20);
  return {
    stageId: `s-${namespace}-${stage}`,
    attemptId: `a-${digest(`${assignmentId}\0${recipeDigest}\0${stageKey}\0${attemptOrdinal}`).slice(0, 32)}`,
  };
}

export interface Candidate {
  id: string;
  /** Content-addressed by the executor when persisted; opaque to this engine. */
  sha256: string | null;
  workspaceId: string;
  /** Opaque parent-owned branch/worktree handle required for follow-up repair. */
  workspace: unknown;
  value: unknown;
}

export interface CounterObservation {
  value: number | null;
  availability: 'observed' | 'unavailable' | 'not-reported';
  source: string | null;
  semantics: TokenCounter;
  inclusion: string | null;
}

export type UsageObservations = Readonly<Record<TokenCounter, CounterObservation>>;

export function unknownUsage(): UsageObservations {
  return Object.freeze(Object.fromEntries(
    (['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tokenTotal'] as const).map((key) => [key, {
      value: null,
      availability: 'not-reported',
      source: null,
      semantics: key,
      inclusion: null,
    }]),
  ) as Record<TokenCounter, CounterObservation>);
}

export function observedZeroUsage(source = 'local-stage-no-model-usage'): UsageObservations {
  return Object.freeze(Object.fromEntries(
    (['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tokenTotal'] as const).map((key) => [key, {
      value: 0,
      availability: 'observed',
      source,
      semantics: key,
      inclusion: null,
    }]),
  ) as Record<TokenCounter, CounterObservation>);
}

function sanitizeUsage(usage: UsageObservations): UsageObservations {
  return Object.freeze(Object.fromEntries(COUNTERS.map((counter) => {
    const value = usage?.[counter];
    if (!value || value.semantics !== counter) {
      return [counter, { value: null, availability: 'not-reported', source: null, semantics: counter, inclusion: null }];
    }
    if (value.availability !== 'observed') return [counter, { ...value, value: null }];
    if (value.availability === 'observed' && (!Number.isFinite(value.value) || value.value === null || value.value < 0)) {
      return [counter, { ...value, value: null, availability: 'unavailable' }];
    }
    return [counter, value];
  })) as Record<TokenCounter, CounterObservation>);
}

export interface Verification {
  passed: boolean;
  feedback: string;
}

export interface ExecutorResult {
  status: 'completed' | 'failed' | 'cancelled' | 'timed-out';
  usage: UsageObservations;
  /** Executor stage service duration. End-to-end elapsed is measured by engine. */
  serviceTimeMs: number | null;
  candidate?: Candidate | null;
  verification?: Verification;
  selectedCandidateId?: string;
  output?: unknown;
  operationalError?: { name: string; message: string };
  /** Null means the transport did not establish whether dispatch reached a model. */
  launched?: boolean | null;
  /** Independent oracle fields. Ignored for all non-oracle stages. */
  judgement?: { correctness: boolean | null; taskSuccess?: boolean | null; formatCompliance?: boolean | null; status: 'valid' | 'unavailable' | 'invalid'; detail?: string };
}

export interface StageRequest extends InvocationIdentity {
  /** Stable logical stage key; native retry adapters reuse it across attempts. */
  stageKey: string;
  /** One based retry ordinal; attemptId changes while stageId remains fixed. */
  attemptOrdinal: number;
  task: StrategyTask;
  recipeHash: string;
  kind: StageKind;
  purpose: StagePurpose;
  route: StrategyRoute | null;
  effort?: string;
  tier: PerTaskBudgetTier;
  /** Monotonic deadline in the same basis as monotonicNowMs. */
  deadlineMonotonicMs: number;
  /** Epoch deadline for native adapters; duration accounting stays monotonic. */
  deadlineEpochMs: number;
  monotonicNowMs: number;
  workspace: unknown;
  workspaceId: string;
  workspacePolicy: 'task' | 'candidate-workspace' | 'fresh-independent' | 'read-only-candidates';
  signal: AbortSignal;
  /** A native token cap is sent only when conformance proves hard enforcement. */
  hardTokenCap: number | null;
  tokenCapMode: 'hard' | 'advisory' | 'unsupported' | 'not-configured';
  inputCandidates: readonly Candidate[];
  feedback?: string;
  selectionPolicy?: 'frozen-rule' | 'judge' | 'model';
  /** Strategy stages can never create public/external effects. */
  allowedExternalEffects: readonly [];
}

export interface StageExecutor {
  /** Run one bounded model/scaffold/oracle stage. Must honor AbortSignal in child processes. */
  execute(request: StageRequest): Promise<ExecutorResult>;
  /** Must resolve only after the process tree is stopped and execute() has settled. */
  stopAndWait(request: StageRequest, execution: Promise<ExecutorResult>, cause: unknown): Promise<{ stopped: boolean; executionSettled: boolean }>;
  /** Authoritative S1 observation retrieval after return, throw, or timeout. */
  getObservation(request: StageRequest): Promise<StageObservation | null> | StageObservation | null;
  /** Allocate a pristine independent substrate for each candidate draft. */
  createCandidateWorkspace?(request: Omit<StageRequest, 'workspace' | 'workspaceId'>, index: number): Promise<{ id: string; handle: unknown }> | { id: string; handle: unknown };
  /** Called after both return and throw so edits survive transport failures. */
  captureCandidate(
    request: StageRequest,
    state: { result: ExecutorResult | null; error: unknown | null },
  ): Promise<Candidate | null> | Candidate | null;
}

export interface StageObservation {
  usage: UsageObservations;
  launched: boolean | null;
  serviceTimeMs: number | null;
  /** Native baseline pin for captured patches, when the S1 workspace supplies it. */
  baselineCommit?: string | null;
  inclusion?: Readonly<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'tokenTotal', string | null>>;
}

export interface StrategyEngineOptions {
  ids?: { next(kind: 'assignment' | 'stage' | 'attempt'): string };
  /** Frozen parent roster ID; required for campaign use. */
  assignmentId?: string;
  now?: () => number;
  epochNow?: () => number;
  /** Independent signal for operator/provider cancellation. */
  signal?: AbortSignal;
}

export interface StageRecord extends InvocationIdentity {
  kind: StageKind;
  purpose: StagePurpose;
  routeId: string | null;
  status: ExecutorResult['status'];
  launched: boolean | null;
  startedAtMs: number;
  endedAtMs: number;
  elapsedMs: number;
  serviceTimeMs: number | null;
  baselineCommit: string | null;
  usage: UsageObservations;
  candidateId: string | null;
  candidateSha256: string | null;
  tokenCapMode: StageRequest['tokenCapMode'];
  operationalError: { name: string; message: string } | null;
  detail: string | null;
  quarantined: boolean;
}

export interface StrategyResult {
  assignmentId: string;
  recipeHash: string;
  recipeKind: StrategyRecipe['kind'];
  taskId: string;
  tierId: string;
  stages: readonly StageRecord[];
  candidates: readonly Candidate[];
  selectedCandidateId: string | null;
  finalCandidate: Candidate | null;
  /** Independent mechanical oracle result, never used as scaffold feedback. */
  candidateCorrectness: boolean | null;
  /** Success attributed to this complete configured recipe. */
  assignedStrategySuccess: boolean | null;
  operationalStatus: 'complete' | 'budget-exhausted' | 'cancelled' | 'timed-out' | 'judge-unavailable' | 'operational-failure';
  recipeCompleted: boolean;
  formatCompliance: boolean | null;
  authorizedBudgetStop: boolean;
  accounting: {
    usage: Readonly<Record<TokenCounter, number | null>>;
    knownUsageSubtotals: Readonly<Record<TokenCounter, number | null>>;
    usageComplete: Readonly<Record<TokenCounter, boolean>>;
    endToEndMs: number;
    stageServiceMs: number | null;
    verificationMs: number | null;
    tokenBudgetMode: 'hard' | 'advisory' | 'unsupported' | 'not-configured';
    attempts: number;
    stages: number;
  };
  incompleteReasons: readonly string[];
}

const DEFAULT_IDS = { next: () => randomUUID() };
const COUNTERS: readonly TokenCounter[] = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tokenTotal'];

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

export function recipeHash(recipe: StrategyRecipe): string {
  return createHash('sha256').update(canonical(recipe)).digest('hex');
}

function hashForTrack(recipe: StrategyRecipe, task: StrategyTask, tier: PerTaskBudgetTier): string {
  return createHash('sha256').update(canonical({ evaluationTrack: task.evaluationTrack, taskId: task.id,
    campaignIdentity: task.campaignIdentity ?? null, taskPrompt: task.prompt, requireFormatCompliance: task.requireFormatCompliance ?? false,
    independentJudgeRoute: task.independentJudgeRoute ?? null, recipe, tier })).digest('hex');
}

function validateRecipe(recipe: StrategyRecipe): void {
  if (!recipe || !['one-shot', 'same-model-verify-repair', 'candidate-selection', 'mixed-model-verify-repair', 'cheap-first-escalation'].includes((recipe as StrategyRecipe).kind)) throw new Error('Unknown strategy recipe');
  for (const route of routesOf(recipe)) {
    if (!route.id || !['hard', 'advisory', 'unsupported'].includes(route.tokenEnforcement)
      || !['codex-exec', 'pi-json', 'pi-rpc', 'zcode-acp', 'shared-diagnostic', 'fake'].includes(route.transport)) throw new Error(`Invalid configured route: ${route.id}`);
  }
  const count = (name: string, value: number, max: number): void => {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError(`${name} must be in [1, ${max}]`);
  };
  if (recipe.kind === 'same-model-verify-repair' || recipe.kind === 'mixed-model-verify-repair') count('maxRepairs', recipe.maxRepairs, 20);
  if (recipe.kind === 'candidate-selection') count('candidateCount', recipe.candidateCount, 20);
  if (recipe.kind === 'cheap-first-escalation') {
    if (recipe.tiers.length < 2) throw new RangeError('cheap-first-escalation requires at least two ordered routes');
    if (recipe.tiers.length > 20 || recipe.tiers.some((tier) => !tier.effort)) throw new RangeError('escalation tiers must be bounded and name effort');
  }
}

function validateBudgetTier(tier: PerTaskBudgetTier): void {
  if (!tier.id) throw new Error('Budget tier id must be non-empty');
  for (const [name, value] of Object.entries({
    maxAttempts: tier.maxAttempts,
    maxStages: tier.maxStages,
    wallClockMs: tier.wallClockMs,
    judgementAllowanceMs: tier.judgementAllowanceMs,
    shutdownAllowanceMs: tier.shutdownAllowanceMs,
    observationAllowanceMs: tier.observationAllowanceMs,
    captureAllowanceMs: tier.captureAllowanceMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${tier.id}.${name} must be a positive safe integer`);
  }
  if (tier.maxStages < 2) throw new RangeError(`${tier.id}.maxStages must reserve a candidate and judge stage`);
  if (tier.judgementAllowanceMs + tier.shutdownAllowanceMs + tier.observationAllowanceMs + tier.captureAllowanceMs >= tier.wallClockMs) throw new RangeError(`${tier.id} allowances must leave time for candidate work`);
  if (tier.tokenBudget !== undefined && (!Number.isSafeInteger(tier.tokenBudget) || tier.tokenBudget < 1)) {
    throw new RangeError(`${tier.id}.tokenBudget must be a positive safe integer`);
  }
}

function routesOf(recipe: StrategyRecipe): StrategyRoute[] {
  switch (recipe.kind) {
    case 'one-shot':
    case 'same-model-verify-repair': return [recipe.route];
    case 'candidate-selection': return [recipe.route,
      ...(recipe.selector.kind === 'model' ? [recipe.selector.route] : recipe.selector.kind === 'judge' && recipe.selector.route ? [recipe.selector.route] : [])];
    case 'mixed-model-verify-repair': return [recipe.draftRoute, recipe.verifyRoute, ...(recipe.repairRoute ? [recipe.repairRoute] : [])];
    case 'cheap-first-escalation': return recipe.tiers.map((tier) => tier.route);
  }
}

function aggregateUsage(records: readonly StageRecord[]): {
  usage: Record<TokenCounter, number | null>;
  known: Record<TokenCounter, number | null>;
  complete: Record<TokenCounter, boolean>;
} {
  const usage = {} as Record<TokenCounter, number | null>;
  const known = {} as Record<TokenCounter, number | null>;
  const complete = {} as Record<TokenCounter, boolean>;
  for (const counter of COUNTERS) {
    let subtotal = 0;
    let fullyObserved = records.length > 0;
    for (const record of records) {
      const item = record.usage[counter];
      if (item.availability !== 'observed' || item.value === null) fullyObserved = false;
      else subtotal += item.value;
    }
    known[counter] = subtotal;
    complete[counter] = fullyObserved;
    usage[counter] = fullyObserved ? subtotal : null;
  }
  return { usage, known, complete };
}

function joinSignal(parent: AbortSignal | undefined): { controller: AbortController; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort(parent?.reason ?? new Error('Strategy cancelled'));
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  return { controller, dispose: () => { parent?.removeEventListener('abort', abort); } };
}

function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Hard wall-clock deadline exceeded')), Math.max(0, ms));
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

function raceStage<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Hard wall-clock deadline exceeded')), Math.max(0, ms));
    const abort = (): void => reject(signal.reason ?? new Error('cancelled'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(value); }, (error: unknown) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

/** Run one recipe/tier. Calling this once per frozen tier produces comparable bounded cells. */
export async function runStrategy(
  task: StrategyTask,
  recipe: StrategyRecipe,
  tier: PerTaskBudgetTier,
  executor: StageExecutor,
  options: StrategyEngineOptions = {},
): Promise<StrategyResult> {
  recipe = deepFreeze(structuredClone(recipe));
  validateRecipe(recipe);
  validateBudgetTier(tier);
  task = Object.freeze({ ...task, campaignIdentity: Object.freeze({ ...task.campaignIdentity }) });
  if (!task.id || !task.prompt) throw new Error('Strategy task requires stable id and prompt');
  if (!task.campaignIdentity?.profileInventoryHash || !task.campaignIdentity.evaluationBoundaryHash || !task.campaignIdentity.scaffoldAssistanceHash) {
    throw new Error('Strategy task requires frozen profile, evaluation-boundary, and scaffold-assistance identity');
  }
  if (task.independentJudgeRoute) {
    if (!task.independentJudgeRoute.id || !['hard', 'advisory', 'unsupported'].includes(task.independentJudgeRoute.tokenEnforcement)
      || !['codex-exec', 'pi-json', 'pi-rpc', 'zcode-acp', 'shared-diagnostic', 'fake'].includes(task.independentJudgeRoute.transport)) {
      throw new Error(`Invalid independent judge route: ${task.independentJudgeRoute.id}`);
    }
    if (task.evaluationTrack === 'native' && task.independentJudgeRoute.transport === 'shared-diagnostic') throw new Error('Diagnostic judge cannot enter a native campaign');
    if (task.evaluationTrack === 'diagnostic' && task.independentJudgeRoute.transport !== 'shared-diagnostic' && task.independentJudgeRoute.transport !== 'fake') throw new Error('Native judge cannot enter a diagnostic campaign');
  }
  for (const route of routesOf(recipe)) {
    if (task.evaluationTrack === 'native' && route.transport === 'shared-diagnostic') throw new Error('Diagnostic transport cannot enter a native campaign');
    if (task.evaluationTrack === 'diagnostic' && route.transport !== 'shared-diagnostic' && route.transport !== 'fake') throw new Error('Native transport cannot enter a diagnostic campaign');
  }
  if (recipe.kind === 'cheap-first-escalation') for (const item of recipe.tiers) {
    if (!item.route.supportedSettings?.effort?.includes(item.effort)) throw new Error(`Unsupported or unpinned effort ${item.effort} on route ${item.route.id}`);
  }
  const now = options.now ?? (() => performance.now());
  const ids = options.ids ?? DEFAULT_IDS;
  const assignmentId = options.assignmentId ?? ids.next('assignment');
  if (!assignmentId) throw new Error('Assignment id must be non-empty');
  const seenAttemptIds = new Set<string>();
  const hash = hashForTrack(recipe, task, tier);
  const startedAt = now();
  const endAt = startedAt + tier.wallClockMs;
  const workEndAt = endAt - tier.judgementAllowanceMs - tier.shutdownAllowanceMs - tier.observationAllowanceMs - tier.captureAllowanceMs;
  const judgeEndAt = endAt;
  const stages: StageRecord[] = [];
  const candidates: Candidate[] = [];
  const candidateWorkspaceIds = new Set<string>();
  const incompleteReasons: string[] = [];
  const routeList = [...routesOf(recipe), ...(task.independentJudgeRoute ? [task.independentJudgeRoute] : [])];
  const hardRequired = tier.tokenPolicy === 'hard-required';
  const configuredTokenBudgetMode = tier.tokenBudget === undefined
    ? 'not-configured'
    : routeList.some((route) => route.tokenEnforcement === 'unsupported') ? 'unsupported'
      : tier.tokenPolicy === 'advisory' || !task.independentJudgeRoute ? 'advisory'
        : routeList.every((route) => route.tokenEnforcement === 'hard') ? 'hard' : 'advisory';
  if (hardRequired && configuredTokenBudgetMode !== 'hard') throw new Error(`Tier ${tier.id} requires hard token enforcement on every route`);
  let attempts = 0;
  let stageOrdinal = 0;
  let lastStatus: StrategyResult['operationalStatus'] = 'complete';
  let usageTokensKnown = 0;
  let allTokenTotalsKnown = true;
  let recipeCompleted = true;
  let authorizedBudgetStop = false;
  let formatCompliance: boolean | null = null;
  let lastCandidate: Candidate | null = null;
  let verificationMs = 0;
  let shutdownReserveRemainingMs = tier.shutdownAllowanceMs;
  let observationReserveRemainingMs = tier.observationAllowanceMs;
  let captureReserveRemainingMs = tier.captureAllowanceMs;

  const invoke = async (input: {
    kind: StageKind; purpose: StagePurpose; route: StrategyRoute | null; effort?: string;
    inputCandidates?: readonly Candidate[]; feedback?: string; selectionPolicy?: 'frozen-rule' | 'judge' | 'model';
    oracle?: boolean;
    workspace?: unknown; workspaceId?: string; stageKey?: string; attemptOrdinal?: number;
    workspacePolicy?: StageRequest['workspacePolicy'];
  }): Promise<{ result: ExecutorResult | null; candidate: Candidate | null; record: StageRecord }> => {
    if (input.kind === 'independent-judge' ? stageOrdinal >= tier.maxStages : stageOrdinal >= tier.maxStages - 1) throw new Error('stage-limit');
    const isModelAttempt = input.kind !== 'independent-judge' && input.route !== null;
    if (isModelAttempt && attempts >= tier.maxAttempts) throw new Error('attempt-limit');
    if (isModelAttempt && tier.tokenBudget !== undefined && configuredTokenBudgetMode === 'hard'
      && !allTokenTotalsKnown && attempts > 0 && hardRequired) throw new Error('token-usage-indeterminate');
    if (isModelAttempt && tier.tokenBudget !== undefined && configuredTokenBudgetMode === 'hard'
      && allTokenTotalsKnown && usageTokensKnown >= tier.tokenBudget) throw new Error('token-limit');
    if (input.kind !== 'independent-judge' && (now() >= workEndAt || options.signal?.aborted)) throw new Error(options.signal?.aborted ? 'cancelled' : 'candidate-deadline');
    stageOrdinal += 1;
    if (isModelAttempt) attempts += 1;
    const stageKey = input.stageKey ?? `${input.kind}-${stageOrdinal}`;
    const attemptOrdinal = input.attemptOrdinal ?? 1;
    const mappedIdentity = options.assignmentId
      ? strategyInvocationIdentity(assignmentId, hash, stageKey, attemptOrdinal)
      : null;
    const stageId = mappedIdentity?.stageId ?? ids.next('stage');
    const attemptId = mappedIdentity?.attemptId ?? ids.next('attempt');
    if (!stageId) throw new Error(`Stage id must be non-empty: ${stageId}`);
    if (!attemptId || seenAttemptIds.has(attemptId)) throw new Error(`Attempt id must be new and non-empty: ${attemptId}`);
    seenAttemptIds.add(attemptId);
    const route = input.kind === 'independent-judge' ? task.independentJudgeRoute ?? null : input.route;
    let capMode: StageRequest['tokenCapMode'] = tier.tokenBudget === undefined || route === null ? 'not-configured' : configuredTokenBudgetMode;
    if (capMode === 'hard' && !allTokenTotalsKnown) capMode = 'advisory';
    if (configuredTokenBudgetMode !== 'hard' && capMode === 'hard') capMode = 'advisory';
    const hardTokenCap = capMode === 'hard' ? Math.max(0, tier.tokenBudget! - usageTokensKnown) : null;
    const timeoutAt = input.kind === 'independent-judge' ? judgeEndAt : workEndAt;
    const stageStart = now();
    const joined = joinSignal(input.kind === 'independent-judge' ? undefined : options.signal);
    const candidateWorkspace = input.workspace ?? (input.inputCandidates?.[0]?.workspace ?? task.workspace);
    const workspaceId = input.workspaceId ?? input.inputCandidates?.[0]?.workspaceId ?? 'task-workspace';
    const epochNow = options.epochNow ?? Date.now;
    const request: StageRequest = Object.freeze({
      assignmentId, stageId, attemptId, stageKey, attemptOrdinal, task, recipeHash: hash, kind: input.kind, purpose: input.purpose,
      route, effort: input.effort, tier, deadlineMonotonicMs: timeoutAt,
      deadlineEpochMs: epochNow() + Math.max(0, timeoutAt - stageStart), monotonicNowMs: stageStart,
      workspace: candidateWorkspace, workspaceId, workspacePolicy: input.workspacePolicy ?? 'task', signal: joined.controller.signal,
      hardTokenCap, tokenCapMode: capMode, inputCandidates: Object.freeze([...(input.inputCandidates ?? [])]), feedback: input.feedback,
      selectionPolicy: input.selectionPolicy, allowedExternalEffects: Object.freeze([] as const),
    });
    let result: ExecutorResult | null = null;
    let error: unknown | null = null;
    let captured: Candidate | null = null;
    let quarantined = false;
    let execution: Promise<ExecutorResult> | null = null;
    let settledProof = true;
    const timedOut = (): boolean => now() >= timeoutAt;
    try {
      if (options.signal?.aborted && input.kind !== 'independent-judge') throw new Error('cancelled');
      if (now() >= timeoutAt) throw new Error('deadline exceeded before launch');
      execution = Promise.resolve().then(() => executor.execute(request));
      result = await raceStage(execution, Math.max(0, timeoutAt - now()), joined.controller.signal);
    } catch (caught) {
      error = caught;
      const message = caught instanceof Error ? caught.message : String(caught);
      const deadlineHit = /deadline|timed out/i.test(message) || timedOut();
      const cancelled = message === 'cancelled' || (options.signal?.aborted && input.kind !== 'independent-judge');
      joined.controller.abort(caught);
      if (execution && !result && (deadlineHit || cancelled)) {
        const shutdownStart = now();
        try {
          const proof = await raceDeadline(executor.stopAndWait(request, execution, caught), Math.min(shutdownReserveRemainingMs, Math.max(0, endAt - now())));
          settledProof = proof.stopped && proof.executionSettled;
        } catch { settledProof = false; }
        shutdownReserveRemainingMs = Math.max(0, shutdownReserveRemainingMs - Math.max(0, now() - shutdownStart));
      }
      if (!settledProof) { quarantined = true; recipeCompleted = false; incompleteReasons.push(`executor-not-settled:${stageId}`); }
      result = {
        status: cancelled ? 'cancelled' : deadlineHit ? 'timed-out' : 'failed',
        usage: unknownUsage(), serviceTimeMs: null,
        operationalError: { name: caught instanceof Error ? caught.name : 'Error', message },
      };
    }
    if (!joined.controller.signal.aborted) joined.controller.abort(new Error('Stage execution settled'));
    let observation: StageObservation | null = null;
    const observationStart = now();
    try {
      const observationWindow = Math.min(observationReserveRemainingMs, Math.max(0, endAt - tier.judgementAllowanceMs - tier.captureAllowanceMs - now()));
      observation = observationWindow > 0 ? await raceDeadline(Promise.resolve(executor.getObservation(request)), observationWindow) ?? null : null;
      if (!observation) incompleteReasons.push(`observation-unavailable:${stageId}`);
    } catch (observationError) { incompleteReasons.push(`observation-retrieval-failed:${stageId}:${String(observationError)}`); }
    observationReserveRemainingMs = Math.max(0, observationReserveRemainingMs - Math.max(0, now() - observationStart));
    if (observation) {
      result = { ...(result ?? { status: 'failed', usage: unknownUsage(), serviceTimeMs: null }),
        usage: observation.usage, launched: observation.launched, serviceTimeMs: observation.serviceTimeMs };
      if (observation.inclusion) result.usage = Object.fromEntries(COUNTERS.map((counter) => [counter, {
        ...result!.usage[counter], inclusion: observation!.inclusion![counter],
      }])) as UsageObservations;
    }
    let captureStart: number | null = null;
    if (settledProof) {
      try {
        if (input.kind !== 'independent-judge') {
          captureStart = now();
          const remaining = Math.min(captureReserveRemainingMs, Math.max(0, endAt - tier.judgementAllowanceMs - now()));
          if (remaining <= 0) throw new Error('capture reserve exhausted');
          captured = await raceDeadline(Promise.resolve(executor.captureCandidate(request, { result, error })), remaining);
          captureReserveRemainingMs = Math.max(0, captureReserveRemainingMs - Math.max(0, now() - captureStart));
        }
      } catch (captureError) {
        if (captureStart !== null) captureReserveRemainingMs = Math.max(0, captureReserveRemainingMs - Math.max(0, now() - captureStart));
        incompleteReasons.push(`capture-failed:${stageId}:${captureError instanceof Error ? captureError.message : String(captureError)}`);
      }
    }
    joined.controller.abort(new Error('Stage complete'));
    joined.dispose();
    if (!quarantined && !captured) captured = result?.candidate ?? null;
    if (captured) {
      if (!captured.id || !captured.sha256 || !/^[a-f0-9]{64}$/i.test(captured.sha256) || captured.workspaceId !== workspaceId) {
        recipeCompleted = false; incompleteReasons.push(`candidate-identity-invalid:${stageId}`); captured = null;
      } else {
        const collision = candidates.find((candidate) => candidate.id === captured!.id);
        if (collision && (collision.sha256 !== captured.sha256 || collision.workspaceId !== captured.workspaceId)) {
          recipeCompleted = false; incompleteReasons.push(`candidate-id-collision:${captured.id}`); captured = null;
        } else if (!collision && !candidates.some((candidate) => candidate.sha256 === captured!.sha256)) {
          candidates.push(Object.freeze({ ...captured, value: deepFreeze(structuredClone(captured.value)) }));
        }
      }
    }
    const stageEnd = now();
    const normalizedResult = result ?? {
      status: 'failed' as const, usage: unknownUsage(), serviceTimeMs: null,
      operationalError: { name: 'Error', message: 'Executor returned no result' },
    };
    if (input.kind !== 'independent-judge' && normalizedResult.status !== 'completed') recipeCompleted = false;
    const safeUsage = sanitizeUsage(normalizedResult.usage);
    const tokenCounter = safeUsage.tokenTotal;
    if (tier.tokenBudget !== undefined && tokenCounter.availability !== 'observed' && capMode === 'hard') capMode = 'advisory';
    if (error) incompleteReasons.push(`stage-threw:${stageId}:${error instanceof Error ? error.message : String(error)}`);
    const record: StageRecord = Object.freeze({
      assignmentId, stageId, attemptId, kind: input.kind, purpose: input.purpose, routeId: route?.id ?? null,
      status: normalizedResult.status,
      launched: normalizedResult.launched ?? (route === null ? false : normalizedResult.status === 'completed' ? true : null),
      startedAtMs: stageStart, endedAtMs: stageEnd,
      elapsedMs: Math.max(0, stageEnd - stageStart), serviceTimeMs: normalizedResult.serviceTimeMs,
      baselineCommit: observation?.baselineCommit ?? null,
      usage: safeUsage, candidateId: captured?.id ?? normalizedResult.candidate?.id ?? null,
      candidateSha256: captured?.sha256 ?? normalizedResult.candidate?.sha256 ?? null,
      tokenCapMode: capMode, operationalError: normalizedResult.operationalError ?? null,
      detail: normalizedResult.judgement?.detail ?? null,
      quarantined,
    });
    stages.push(record);
    if (tokenCounter.availability === 'observed' && tokenCounter.value !== null) usageTokensKnown += tokenCounter.value;
    else allTokenTotalsKnown = false;
    if (input.kind === 'verify') verificationMs += record.elapsedMs;
    if (normalizedResult.status === 'timed-out') lastStatus = 'timed-out';
    else if (normalizedResult.status === 'cancelled') lastStatus = 'cancelled';
    else if (normalizedResult.status === 'failed' && input.kind !== 'independent-judge') lastStatus = 'operational-failure';
    return { result: normalizedResult, candidate: captured, record };
  };

  const canAttempt = (): boolean => attempts < tier.maxAttempts && stageOrdinal < tier.maxStages - 1 && now() < workEndAt
    && !options.signal?.aborted && !(tier.tokenBudget !== undefined && configuredTokenBudgetMode === 'hard'
      && ((hardRequired && !allTokenTotalsKnown) || (allTokenTotalsKnown && usageTokensKnown >= tier.tokenBudget)));
  const markBound = (): void => {
    if (options.signal?.aborted) lastStatus = 'cancelled';
    else if (now() >= workEndAt) lastStatus = 'timed-out';
    else if (hardRequired && !allTokenTotalsKnown) lastStatus = 'operational-failure';
    else { lastStatus = 'budget-exhausted'; authorizedBudgetStop = true; }
  };
  const generation = async (route: StrategyRoute, kind: 'draft' | 'repair' | 'escalate', feedback?: string, effort?: string,
    workspace?: { id: string; handle: unknown }, independent = false): Promise<Candidate | null> => {
    const outcome = await invoke({ kind, purpose: 'candidate-generation', route, effort, feedback,
      inputCandidates: independent ? [] : lastCandidate ? [lastCandidate] : [], workspace: workspace?.handle,
      workspaceId: workspace?.id ?? lastCandidate?.workspaceId ?? 'task-workspace',
      workspacePolicy: independent ? 'fresh-independent' : lastCandidate ? 'candidate-workspace' : 'task' });
    lastCandidate = outcome.candidate ?? lastCandidate;
    if (outcome.result?.status !== 'completed') incompleteReasons.push(`${kind}-stage-${outcome.result?.status ?? 'missing'}:${outcome.record.stageId}`);
    return outcome.candidate;
  };

  try {
    switch (recipe.kind) {
      case 'one-shot':
        await generation(recipe.route, 'draft');
        break;
      case 'same-model-verify-repair': {
        await generation(recipe.route, 'draft');
        let verifiedFinal = false;
        for (let repair = 0; repair < recipe.maxRepairs && lastCandidate && canAttempt(); repair += 1) {
          const checked = await invoke({ kind: 'verify', purpose: 'scaffold', route: recipe.route, inputCandidates: [lastCandidate] });
          if (checked.result?.status === 'completed' && checked.result.verification && typeof checked.result.verification.passed === 'boolean' && checked.result.verification.passed) { verifiedFinal = true; break; }
          if (checked.result?.status === 'completed' && checked.result.verification && typeof checked.result.verification.passed === 'boolean') {
            await generation(recipe.route, 'repair', checked.result.verification.feedback);
          } else { recipeCompleted = false; incompleteReasons.push(`verification-unavailable:${checked.record.stageId}`); break; }
        }
        if (!verifiedFinal && lastCandidate) {
          if (canAttempt()) {
            const finalCheck = await invoke({ kind: 'verify', purpose: 'scaffold', route: recipe.route, inputCandidates: [lastCandidate] });
            verifiedFinal = finalCheck.result?.status === 'completed' && finalCheck.result.verification?.passed === true;
            if (finalCheck.result?.status !== 'completed' || typeof finalCheck.result.verification?.passed !== 'boolean') {
              recipeCompleted = false; incompleteReasons.push(`final-verification-unavailable:${finalCheck.record.stageId}`);
            } else if (!verifiedFinal) incompleteReasons.push(`final-verification-rejected:${finalCheck.record.stageId}`);
          } else { recipeCompleted = false; incompleteReasons.push('required-final-verification-not-admitted'); }
        }
        break;
      }
      case 'candidate-selection': {
        const drafts: Candidate[] = [];
        let workspaceIndex = 0;
        for (let index = 0; index < recipe.candidateCount && canAttempt(); index += 1) {
          const allocation = joinSignal(options.signal);
          const allocationMs = Math.max(0, workEndAt - now());
          const allocationTimer = setTimeout(() => allocation.controller.abort(new Error('Workspace allocation deadline exceeded')), allocationMs);
          const workspaceIdentity = strategyInvocationIdentity(assignmentId, hash, `candidate-workspace-${index + 1}`, 1);
          const baseRequest = { assignmentId, stageId: workspaceIdentity.stageId,
            attemptId: workspaceIdentity.attemptId, stageKey: `candidate-workspace-${index + 1}`, attemptOrdinal: 1,
            task, recipeHash: hash, kind: 'draft' as const,
            purpose: 'candidate-generation' as const, route: recipe.route, tier, deadlineMonotonicMs: workEndAt,
            deadlineEpochMs: (options.epochNow ?? Date.now)() + Math.max(0, workEndAt - now()), monotonicNowMs: now(),
            workspacePolicy: 'fresh-independent' as const, signal: allocation.controller.signal, hardTokenCap: null,
            tokenCapMode: 'advisory' as const, inputCandidates: [], allowedExternalEffects: [] as const };
          if (!executor.createCandidateWorkspace) {
            clearTimeout(allocationTimer); allocation.dispose(); recipeCompleted = false; incompleteReasons.push('independent-candidate-workspace-unavailable'); break;
          }
          let workspace: { id: string; handle: unknown };
          try {
            workspace = await raceStage(Promise.resolve(executor.createCandidateWorkspace(baseRequest, workspaceIndex++)), allocationMs, allocation.controller.signal);
          } finally {
            clearTimeout(allocationTimer); allocation.controller.abort(new Error('Workspace allocation settled')); allocation.dispose();
          }
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workspace.id) || workspace.id === 'task-workspace' || candidateWorkspaceIds.has(workspace.id)) throw new Error('Candidate workspace requires a unique path-safe stable id');
          candidateWorkspaceIds.add(workspace.id);
          const candidate = await generation(recipe.route, 'draft', undefined, undefined, workspace, true);
          if (candidate && !drafts.some((item) => item.sha256 === candidate.sha256)) drafts.push(candidate);
        }
        if (workspaceIndex < recipe.candidateCount) {
          recipeCompleted = false; incompleteReasons.push('candidate-drafts-not-admitted');
          if (lastStatus === 'complete') markBound();
        }
        lastCandidate = null;
        if (workspaceIndex === recipe.candidateCount && recipeCompleted) {
          const selectionRoute = recipe.selector.kind === 'model' || recipe.selector.kind === 'judge'
            ? recipe.selector.route ?? null : null;
          const chosen = await invoke({ kind: 'select', purpose: 'selection', route: selectionRoute,
            inputCandidates: drafts, selectionPolicy: recipe.selector.kind });
          lastCandidate = chosen.result?.status === 'completed' ? drafts.find((candidate) => candidate.id === chosen.result?.selectedCandidateId) ?? null : null;
          if (!lastCandidate) incompleteReasons.push('candidate-selection-produced-no-valid-choice');
        }
        break;
      }
      case 'mixed-model-verify-repair': {
        await generation(recipe.draftRoute, 'draft');
        let verifiedFinal = false;
        for (let repair = 0; repair < recipe.maxRepairs && lastCandidate && canAttempt(); repair += 1) {
          const checked = await invoke({ kind: 'verify', purpose: 'scaffold', route: recipe.verifyRoute, inputCandidates: [lastCandidate] });
          if (checked.result?.status === 'completed' && checked.result.verification && typeof checked.result.verification.passed === 'boolean' && checked.result.verification.passed) { verifiedFinal = true; break; }
          if (checked.result?.status === 'completed' && checked.result.verification && typeof checked.result.verification.passed === 'boolean') {
            await generation(recipe.repairRoute ?? recipe.draftRoute, 'repair', checked.result.verification.feedback);
          } else { recipeCompleted = false; incompleteReasons.push(`verification-unavailable:${checked.record.stageId}`); break; }
        }
        if (!verifiedFinal && lastCandidate) {
          if (canAttempt()) {
            const finalCheck = await invoke({ kind: 'verify', purpose: 'scaffold', route: recipe.verifyRoute, inputCandidates: [lastCandidate] });
            verifiedFinal = finalCheck.result?.status === 'completed' && finalCheck.result.verification?.passed === true;
            if (finalCheck.result?.status !== 'completed' || typeof finalCheck.result.verification?.passed !== 'boolean') {
              recipeCompleted = false; incompleteReasons.push(`final-verification-unavailable:${finalCheck.record.stageId}`);
            } else if (!verifiedFinal) incompleteReasons.push(`final-verification-rejected:${finalCheck.record.stageId}`);
          } else { recipeCompleted = false; incompleteReasons.push('required-final-verification-not-admitted'); }
        }
        break;
      }
      case 'cheap-first-escalation': {
        let tierIndex = 0;
        for (; tierIndex < recipe.tiers.length && canAttempt(); tierIndex += 1) {
          const tierRoute = recipe.tiers[tierIndex]!;
          const current = await generation(tierRoute.route, tierIndex === 0 ? 'draft' : 'escalate', undefined, tierRoute.effort);
          if (!current) {
            if (recipe.promoteWhen === 'no-candidate' && tierIndex + 1 < recipe.tiers.length) continue;
            break;
          }
          if (tierIndex + 1 >= recipe.tiers.length) break;
          if (recipe.promoteWhen === 'no-candidate') break;
          const check = await invoke({ kind: 'verify', purpose: 'scaffold', route: tierRoute.route, inputCandidates: [current] });
          if (check.result?.status !== 'completed' || typeof check.result.verification?.passed !== 'boolean') {
            recipeCompleted = false; incompleteReasons.push(`escalation-verification-unavailable:${check.record.stageId}`); break;
          }
          const shouldPromote = !check.result.verification.passed;
          if (!shouldPromote) break;
        }
        if (tierIndex < recipe.tiers.length && !canAttempt() && lastStatus === 'complete') {
          recipeCompleted = false; incompleteReasons.push('escalation-tier-not-admitted'); markBound();
        }
        break;
      }
    }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (message === 'token-usage-indeterminate') { lastStatus = 'operational-failure'; recipeCompleted = false; incompleteReasons.push(message); }
    else if (message === 'attempt-limit' || message === 'stage-limit' || message === 'candidate-deadline' || message === 'token-limit' || message === 'cancelled') { markBound(); recipeCompleted = false; }
    else { lastStatus = 'operational-failure'; incompleteReasons.push(`strategy-error:${message}`); }
  }

  if (!recipeCompleted && lastStatus === 'complete') {
    if (options.signal?.aborted) lastStatus = 'cancelled';
    else if (now() >= workEndAt) lastStatus = 'timed-out';
    else if (hardRequired && !allTokenTotalsKnown) lastStatus = 'operational-failure';
    else { lastStatus = 'budget-exhausted'; authorizedBudgetStop = true; }
  }

  // A completed strategy with no candidate after launched, bounded work is a measured
  // task failure. A valid candidate still requires the parent's independent oracle.
  if (attempts >= tier.maxAttempts || stageOrdinal >= tier.maxStages - 1 || now() >= workEndAt) {
    if (recipe.kind !== 'one-shot' && recipe.kind !== 'cheap-first-escalation' && !recipeCompleted) incompleteReasons.push('required-recipe-stage-not-admitted');
    if (lastStatus === 'complete' && !recipeCompleted) markBound();
  }
  let candidateCorrectness: boolean | null = lastCandidate ? null : options.signal?.aborted || stages.some((stage) => stage.status === 'cancelled' || stage.status === 'timed-out' || stage.status === 'failed') ? null : false;
  let assignedStrategySuccess: boolean | null = lastCandidate ? null : candidateCorrectness;
  if (!lastCandidate && stages.length > 0 && !stages.some((stage) => stage.launched === true)) {
    // A prelaunch/unknown transport failure is missingness, not a fabricated
    // zero. Once dispatch is established, a bounded no-candidate outcome fails.
    candidateCorrectness = null;
    assignedStrategySuccess = null;
    if (stages.some((stage) => stage.status === 'failed')) lastStatus = 'operational-failure';
  }
  if (lastCandidate && !stages.some((stage) => stage.quarantined) && now() < judgeEndAt && stageOrdinal < tier.maxStages) {
    try {
      const judged = await invoke({ kind: 'independent-judge', purpose: 'oracle', route: null, inputCandidates: [lastCandidate], oracle: true });
      const verdict = judged.result?.judgement;
      if (judged.result?.status === 'completed' && verdict?.status === 'valid' && typeof verdict.correctness === 'boolean') {
        candidateCorrectness = verdict.correctness;
        formatCompliance = typeof verdict.formatCompliance === 'boolean' ? verdict.formatCompliance : null;
        const measuredSuccess = verdict.taskSuccess ?? (task.requireFormatCompliance && formatCompliance === false ? false : verdict.correctness);
        assignedStrategySuccess = recipeCompleted && !options.signal?.aborted && now() < workEndAt
          ? measuredSuccess : false;
      } else {
        candidateCorrectness = null;
        assignedStrategySuccess = null;
        lastStatus = 'judge-unavailable';
        incompleteReasons.push(`independent-judge-${verdict?.status ?? 'missing'}:${judged.record.stageId}`);
      }
    } catch (caught) {
      candidateCorrectness = null;
      assignedStrategySuccess = null;
      lastStatus = 'judge-unavailable';
      incompleteReasons.push(`independent-judge-unavailable:${caught instanceof Error ? caught.message : String(caught)}`);
    }
  } else if (lastCandidate) {
    candidateCorrectness = null;
    assignedStrategySuccess = null;
    lastStatus = now() >= endAt ? 'timed-out' : 'budget-exhausted';
    incompleteReasons.push('independent-judge-not-admitted-within-reserved-bounds');
  }

  const aggregate = aggregateUsage(stages);
  const tokenBudgetMode = configuredTokenBudgetMode === 'not-configured' || configuredTokenBudgetMode === 'unsupported' || configuredTokenBudgetMode === 'advisory'
    ? configuredTokenBudgetMode
    : !allTokenTotalsKnown || stages.some((stage) => stage.tokenCapMode === 'advisory') ? 'advisory' : 'hard';
  // Preserve explicit known subtotals, while a nullable whole-pipeline total remains null.
  if (tier.tokenBudget !== undefined && tokenBudgetMode !== 'hard') {
    incompleteReasons.push(`token-budget-${tokenBudgetMode}:one-or-more-routes-lack-proven-enforcement`);
  }
  if (!allTokenTotalsKnown && stages.length) incompleteReasons.push('whole-pipeline-token-total-unknown');
  const serviceValues = stages.map((stage) => stage.serviceTimeMs);
  const stageServiceMs = serviceValues.every((value): value is number => value !== null)
    ? serviceValues.reduce((sum, value) => sum + value, 0) : null;
  return {
    assignmentId, recipeHash: hash, recipeKind: recipe.kind, taskId: task.id, tierId: tier.id,
    stages: Object.freeze(stages), candidates: Object.freeze(candidates), selectedCandidateId: lastCandidate?.id ?? null,
    finalCandidate: lastCandidate, candidateCorrectness, assignedStrategySuccess, recipeCompleted, formatCompliance, authorizedBudgetStop,
    operationalStatus: lastStatus,
    accounting: {
      usage: Object.freeze(aggregate.usage), knownUsageSubtotals: Object.freeze(aggregate.known),
      usageComplete: Object.freeze(aggregate.complete), endToEndMs: Math.max(0, now() - startedAt),
      stageServiceMs, verificationMs, tokenBudgetMode, attempts, stages: stages.length,
    },
    incompleteReasons: Object.freeze(incompleteReasons),
  };
}

/** Execute a frozen recipe across three or more configured per-task tiers. */
export async function runStrategyTiers(
  task: StrategyTask,
  recipe: StrategyRecipe,
  tiers: readonly PerTaskBudgetTier[],
  executor: StageExecutor,
  options: StrategyEngineOptions = {},
): Promise<readonly StrategyResult[]> {
  const frozen = defineBudgetTiers(tiers);
  const results: StrategyResult[] = [];
  for (const tier of frozen) results.push(await runStrategy(task, recipe, tier, executor, options));
  return Object.freeze(results);
}
