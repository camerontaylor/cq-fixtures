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
    })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${tier.id}.${name} must be a positive safe integer`);
    }
    if (tier.maxStages < 2) throw new RangeError(`${tier.id}.maxStages must reserve a candidate and judge stage`);
    if (tier.judgementAllowanceMs >= tier.wallClockMs) {
      throw new RangeError(`${tier.id}.judgementAllowanceMs must leave time for candidate work`);
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
  /** Parent-controlled opaque workspace/context handle. */
  workspace: unknown;
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

export interface Candidate {
  id: string;
  /** Content-addressed by the executor when persisted; opaque to this engine. */
  sha256: string | null;
  value: unknown;
}

export interface CounterObservation {
  value: number | null;
  availability: 'observed' | 'unavailable' | 'not-reported';
  source: string | null;
  semantics: TokenCounter;
}

export type UsageObservations = Readonly<Record<TokenCounter, CounterObservation>>;

export function unknownUsage(): UsageObservations {
  return Object.freeze(Object.fromEntries(
    (['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tokenTotal'] as const).map((key) => [key, {
      value: null,
      availability: 'not-reported',
      source: null,
      semantics: key,
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
    }]),
  ) as Record<TokenCounter, CounterObservation>);
}

function sanitizeUsage(usage: UsageObservations): UsageObservations {
  return Object.freeze(Object.fromEntries(COUNTERS.map((counter) => {
    const value = usage?.[counter];
    if (!value || value.semantics !== counter) {
      return [counter, { value: null, availability: 'not-reported', source: null, semantics: counter }];
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
  judgement?: { correctness: boolean | null; status: 'valid' | 'unavailable' | 'invalid'; detail?: string };
}

export interface StageRequest extends InvocationIdentity {
  task: StrategyTask;
  recipeHash: string;
  kind: StageKind;
  purpose: StagePurpose;
  route: StrategyRoute | null;
  effort?: string;
  tier: PerTaskBudgetTier;
  /** Remaining candidate-stage elapsed-time budget. */
  deadlineAt: number;
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
  /** Called after both return and throw so edits survive transport failures. */
  captureCandidate?(
    request: StageRequest,
    state: { result: ExecutorResult | null; error: unknown | null },
  ): Promise<Candidate | null> | Candidate | null;
}

export interface StrategyEngineOptions {
  ids?: { next(kind: 'assignment' | 'stage' | 'attempt'): string };
  now?: () => number;
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
  usage: UsageObservations;
  candidateId: string | null;
  candidateSha256: string | null;
  tokenCapMode: StageRequest['tokenCapMode'];
  operationalError: { name: string; message: string } | null;
  detail: string | null;
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
  accounting: {
    usage: Readonly<Record<TokenCounter, number | null>>;
    knownUsageSubtotals: Readonly<Record<TokenCounter, number>>;
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

function hashForTrack(recipe: StrategyRecipe, track: EvaluationTrack): string {
  return createHash('sha256').update(canonical({ evaluationTrack: track, recipe })).digest('hex');
}

function validateRecipe(recipe: StrategyRecipe): void {
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
  })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${tier.id}.${name} must be a positive safe integer`);
  }
  if (tier.maxStages < 2) throw new RangeError(`${tier.id}.maxStages must reserve a candidate and judge stage`);
  if (tier.judgementAllowanceMs >= tier.wallClockMs) throw new RangeError(`${tier.id}.judgementAllowanceMs must leave time for candidate work`);
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
  known: Record<TokenCounter, number>;
  complete: Record<TokenCounter, boolean>;
} {
  const usage = {} as Record<TokenCounter, number | null>;
  const known = {} as Record<TokenCounter, number>;
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

function joinSignal(parent: AbortSignal | undefined, deadlineMs: number): { controller: AbortController; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort(parent?.reason ?? new Error('Strategy cancelled'));
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Stage deadline exceeded')), Math.max(0, deadlineMs));
  return { controller, dispose: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}

function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Hard wall-clock deadline exceeded')), Math.max(0, ms));
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
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
  if (!task.id || !task.prompt) throw new Error('Strategy task requires stable id and prompt');
  const now = options.now ?? (() => performance.now());
  const ids = options.ids ?? DEFAULT_IDS;
  const assignmentId = ids.next('assignment');
  if (!assignmentId) throw new Error('Assignment id must be non-empty');
  const seenStageIds = new Set<string>();
  const seenAttemptIds = new Set<string>();
  const hash = hashForTrack(recipe, task.evaluationTrack);
  const startedAt = now();
  const endAt = startedAt + tier.wallClockMs;
  const candidateEndAt = endAt - tier.judgementAllowanceMs;
  const stages: StageRecord[] = [];
  const candidates: Candidate[] = [];
  const incompleteReasons: string[] = [];
  const routeList = routesOf(recipe);
  const configuredTokenBudgetMode = tier.tokenBudget === undefined
    ? 'not-configured'
    : routeList.every((route) => route.tokenEnforcement === 'hard') ? 'hard'
      : routeList.some((route) => route.tokenEnforcement === 'unsupported') ? 'unsupported' : 'advisory';
  let attempts = 0;
  let stageOrdinal = 0;
  let lastStatus: StrategyResult['operationalStatus'] = 'complete';
  let usageTokensKnown = 0;
  let allTokenTotalsKnown = true;
  let lastCandidate: Candidate | null = null;
  let verificationMs = 0;

  const invoke = async (input: {
    kind: StageKind; purpose: StagePurpose; route: StrategyRoute | null; effort?: string;
    inputCandidates?: readonly Candidate[]; feedback?: string; selectionPolicy?: 'frozen-rule' | 'judge' | 'model';
    oracle?: boolean;
  }): Promise<{ result: ExecutorResult | null; candidate: Candidate | null; record: StageRecord }> => {
    if (input.kind === 'independent-judge' ? stageOrdinal >= tier.maxStages : stageOrdinal >= tier.maxStages - 1) throw new Error('stage-limit');
    const isModelAttempt = input.kind !== 'independent-judge' && input.route !== null;
    if (isModelAttempt && attempts >= tier.maxAttempts) throw new Error('attempt-limit');
    if (isModelAttempt && tier.tokenBudget !== undefined && routeList.every((item) => item.tokenEnforcement === 'hard')
      && allTokenTotalsKnown && usageTokensKnown >= tier.tokenBudget) throw new Error('token-limit');
    if (input.kind !== 'independent-judge' && now() >= candidateEndAt) throw new Error('candidate-deadline');
    stageOrdinal += 1;
    if (isModelAttempt) attempts += 1;
    const stageId = ids.next('stage');
    const attemptId = ids.next('attempt');
    if (!stageId || seenStageIds.has(stageId)) throw new Error(`Stage id must be new and non-empty: ${stageId}`);
    if (!attemptId || seenAttemptIds.has(attemptId)) throw new Error(`Attempt id must be new and non-empty: ${attemptId}`);
    seenStageIds.add(stageId);
    seenAttemptIds.add(attemptId);
    const route = input.route;
    let capMode: StageRequest['tokenCapMode'] = tier.tokenBudget === undefined ? 'not-configured' : route?.tokenEnforcement ?? 'unsupported';
    if (capMode === 'hard' && !allTokenTotalsKnown) capMode = 'advisory';
    const hardTokenCap = capMode === 'hard' ? Math.max(0, tier.tokenBudget! - usageTokensKnown) : null;
    const timeoutAt = input.kind === 'independent-judge' ? endAt : candidateEndAt;
    const stageStart = now();
    const joined = joinSignal(options.signal, Math.max(0, timeoutAt - stageStart));
    const request: StageRequest = Object.freeze({
      assignmentId, stageId, attemptId, task, recipeHash: hash, kind: input.kind, purpose: input.purpose,
      route, effort: input.effort, tier, deadlineAt: timeoutAt, signal: joined.controller.signal,
      hardTokenCap, tokenCapMode: capMode, inputCandidates: Object.freeze([...(input.inputCandidates ?? [])]), feedback: input.feedback,
      selectionPolicy: input.selectionPolicy, allowedExternalEffects: Object.freeze([] as const),
    });
    let result: ExecutorResult | null = null;
    let error: unknown | null = null;
    let captured: Candidate | null = null;
    try {
      const remaining = Math.max(0, timeoutAt - now());
      result = await raceDeadline(executor.execute(request), remaining);
    } catch (caught) {
      error = caught;
      const message = caught instanceof Error ? caught.message : String(caught);
      const timedOut = /deadline|timed out/i.test(message) || now() >= timeoutAt;
      result = {
        status: options.signal?.aborted ? 'cancelled' : timedOut ? 'timed-out' : 'failed',
        usage: unknownUsage(), serviceTimeMs: null,
        operationalError: { name: caught instanceof Error ? caught.name : 'Error', message },
      };
    } finally {
      try {
        captured = await raceDeadline(Promise.resolve(executor.captureCandidate?.(request, { result, error }) ?? null), Math.max(0, timeoutAt - now()));
      } catch (captureError) {
        incompleteReasons.push(`capture-failed:${stageId}:${captureError instanceof Error ? captureError.message : String(captureError)}`);
      }
      joined.controller.abort(new Error('Stage complete'));
      joined.dispose();
    }
    if (!captured) captured = result?.candidate ?? null;
    if (captured && !candidates.some((candidate) => candidate.id === captured!.id)) candidates.push(captured);
    const stageEnd = now();
    const normalizedResult = result ?? {
      status: 'failed' as const, usage: unknownUsage(), serviceTimeMs: null,
      operationalError: { name: 'Error', message: 'Executor returned no result' },
    };
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
      usage: safeUsage, candidateId: captured?.id ?? normalizedResult.candidate?.id ?? null,
      candidateSha256: captured?.sha256 ?? normalizedResult.candidate?.sha256 ?? null,
      tokenCapMode: capMode, operationalError: normalizedResult.operationalError ?? null,
      detail: normalizedResult.judgement?.detail ?? null,
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

  const canAttempt = (): boolean => attempts < tier.maxAttempts && stageOrdinal < tier.maxStages - 1 && now() < candidateEndAt
    && !options.signal?.aborted && !(tier.tokenBudget !== undefined && routeList.every((item) => item.tokenEnforcement === 'hard')
      && allTokenTotalsKnown && usageTokensKnown >= tier.tokenBudget);
  const markBound = (): void => {
    if (options.signal?.aborted) lastStatus = 'cancelled';
    else if (now() >= candidateEndAt) lastStatus = 'timed-out';
    else lastStatus = 'budget-exhausted';
  };
  const generation = async (route: StrategyRoute, kind: 'draft' | 'repair' | 'escalate', feedback?: string, effort?: string): Promise<Candidate | null> => {
    const outcome = await invoke({ kind, purpose: 'candidate-generation', route, effort, feedback, inputCandidates: lastCandidate ? [lastCandidate] : [] });
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
        for (let repair = 0; repair < recipe.maxRepairs && lastCandidate && canAttempt(); repair += 1) {
          const checked = await invoke({ kind: 'verify', purpose: 'scaffold', route: recipe.route, inputCandidates: [lastCandidate] });
          if (checked.result?.verification?.passed) break;
          if (checked.result?.verification) await generation(recipe.route, 'repair', checked.result.verification.feedback);
          else { incompleteReasons.push(`verification-unavailable:${checked.record.stageId}`); break; }
        }
        break;
      }
      case 'candidate-selection': {
        const drafts: Candidate[] = [];
        for (let index = 0; index < recipe.candidateCount && canAttempt(); index += 1) {
          const candidate = await generation(recipe.route, 'draft');
          if (candidate) drafts.push(candidate);
        }
        if (drafts.length) {
          const selectionRoute = recipe.selector.kind === 'model' || recipe.selector.kind === 'judge'
            ? recipe.selector.route ?? null : null;
          const chosen = await invoke({ kind: 'select', purpose: 'selection', route: selectionRoute,
            inputCandidates: drafts, selectionPolicy: recipe.selector.kind });
          lastCandidate = drafts.find((candidate) => candidate.id === chosen.result?.selectedCandidateId) ?? null;
          if (!lastCandidate) incompleteReasons.push('candidate-selection-produced-no-valid-choice');
        }
        break;
      }
      case 'mixed-model-verify-repair': {
        await generation(recipe.draftRoute, 'draft');
        for (let repair = 0; repair < recipe.maxRepairs && lastCandidate && canAttempt(); repair += 1) {
          const checked = await invoke({ kind: 'verify', purpose: 'scaffold', route: recipe.verifyRoute, inputCandidates: [lastCandidate] });
          if (checked.result?.verification?.passed) break;
          if (checked.result?.verification) await generation(recipe.repairRoute ?? recipe.draftRoute, 'repair', checked.result.verification.feedback);
          else { incompleteReasons.push(`verification-unavailable:${checked.record.stageId}`); break; }
        }
        break;
      }
      case 'cheap-first-escalation': {
        for (let index = 0; index < recipe.tiers.length && canAttempt(); index += 1) {
          const tierRoute = recipe.tiers[index]!;
          const current = await generation(tierRoute.route, index === 0 ? 'draft' : 'escalate', undefined, tierRoute.effort);
          if (!current) {
            if (recipe.promoteWhen === 'no-candidate' && index + 1 < recipe.tiers.length) continue;
            break;
          }
          if (index + 1 >= recipe.tiers.length) break;
          const check = await invoke({ kind: 'verify', purpose: 'scaffold', route: tierRoute.route, inputCandidates: [current] });
          const shouldPromote = recipe.promoteWhen === 'verification-failed'
            ? check.result?.verification?.passed !== true
            : !current;
          if (!shouldPromote) break;
        }
        break;
      }
    }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (message === 'attempt-limit' || message === 'stage-limit' || message === 'candidate-deadline' || message === 'token-limit') markBound();
    else { lastStatus = 'operational-failure'; incompleteReasons.push(`strategy-error:${message}`); }
  }

  // A completed strategy with no candidate after launched, bounded work is a measured
  // task failure. A valid candidate still requires the parent's independent oracle.
  if (!lastCandidate && lastStatus === 'complete' && (attempts >= tier.maxAttempts || stageOrdinal >= tier.maxStages || now() >= candidateEndAt)) markBound();
  let candidateCorrectness: boolean | null = lastCandidate ? null : false;
  let assignedStrategySuccess: boolean | null = lastCandidate ? null : false;
  if (!lastCandidate && stages.length > 0 && !stages.some((stage) => stage.launched === true)) {
    // A prelaunch/unknown transport failure is missingness, not a fabricated
    // zero. Once dispatch is established, a bounded no-candidate outcome fails.
    candidateCorrectness = null;
    assignedStrategySuccess = null;
    if (stages.some((stage) => stage.status === 'failed')) lastStatus = 'operational-failure';
  }
  if (lastCandidate && now() < endAt && stageOrdinal < tier.maxStages) {
    try {
      const judged = await invoke({ kind: 'independent-judge', purpose: 'oracle', route: null, inputCandidates: [lastCandidate], oracle: true });
      const verdict = judged.result?.judgement;
      if (verdict?.status === 'valid' && typeof verdict.correctness === 'boolean') {
        candidateCorrectness = verdict.correctness;
        assignedStrategySuccess = verdict.correctness;
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
  const tokenBudgetMode = configuredTokenBudgetMode === 'not-configured' || configuredTokenBudgetMode === 'unsupported'
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
    finalCandidate: lastCandidate, candidateCorrectness, assignedStrategySuccess,
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
