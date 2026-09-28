/** Native S1/S2 adapter for the bounded strategy engine.
 *
 * Route specific operation construction and candidate capture stay injectable,
 * while this adapter owns identity handoff, authoritative post-outcome
 * observation retrieval, workspace allocation, and the native stop proof.
 */
import { createHash } from 'node:crypto';
import type {
  Candidate, ExecutorResult, StageExecutor, StageObservation, StageRequest, UsageObservations,
} from './index.ts';
import { unknownUsage } from './index.ts';

export interface NativeInvocationIdentity {
  invocationId: string;
  assignmentId: string;
  stageId: string;
  attemptId: string;
}

export interface NativeCounter {
  value: number | null;
  availability: 'observed' | 'unavailable' | 'not-reported';
  source: string | null;
  semantics: string;
}

/** Structural S1 observation shape; keeps this adapter independent of S1 files. */
export interface NativeStrategyObservation {
  schemaVersion: 1;
  identity: NativeInvocationIdentity;
  usage: {
    counters: Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning', NativeCounter>;
    tokenTotal: Omit<NativeCounter, 'semantics'> & { semantics: 'authoritative-total' | 'unknown' };
    inclusion: { input: string | null; output: string | null; cache: string | null; reasoning: string | null };
  };
  terminal: { cause: string | null; cancelled: boolean; transportException: { name: string; message: string } | null };
  capture: { status: string; baselineCommit: string | null; patchSha256: string | null; workspaceSha256: string | null };
  timing: { startedAt: string; endedAt: string | null; stages: Record<string, number | null> };
}

export interface NativeObservedDriver {
  beginInvocation?(identity: NativeInvocationIdentity): void | Promise<void>;
  setInvocationIdentity?(identity: NativeInvocationIdentity): void | Promise<void>;
  getObservation(invocationId: string): NativeStrategyObservation | undefined | Promise<NativeStrategyObservation | undefined>;
}

/**
 * S2 must expose this operation backed by the native child supervisor. It must
 * abort the invocation, terminate/reap the process tree, and wait for the
 * Driver invocation to finish before returning a matching proof.
 */
export interface NativeStopProof {
  invocationId: string;
  stageId: string;
  attemptId: string;
  processTree: 'stopped-and-reaped';
  invocation: 'settled';
}

export interface NativeSupervisorControl {
  cancelInvocationAndWait(input: {
    identity: NativeInvocationIdentity;
    cause: unknown;
    deadlineEpochMs: number;
  }): Promise<NativeStopProof>;
}

export interface NativeStrategyExecutorHooks {
  /** Runs one concrete toolkit operation with the configured native Driver. */
  runStage(request: StageRequest, driver: NativeObservedDriver): Promise<ExecutorResult>;
  /** Captures the candidate from the request's workspace after return or throw. */
  captureCandidate(request: StageRequest, state: { result: ExecutorResult | null; error: unknown | null }): Promise<Candidate | null> | Candidate | null;
  /** Creates an isolated substrate for each independently generated candidate. */
  createCandidateWorkspace(request: Omit<StageRequest, 'workspace' | 'workspaceId'>, index: number, stableWorkspaceId: string): Promise<{ id: string; handle: unknown }> | { id: string; handle: unknown };
  supervisor: NativeSupervisorControl;
}

interface RunningInvocation {
  identity: NativeInvocationIdentity;
  settled: boolean;
}

function invocationId(request: StageRequest): string {
  return `iv-${createHash('sha256').update(`${request.assignmentId}\0${request.stageId}\0${request.attemptId}`).digest('hex').slice(0, 40)}`;
}

function toCounter(counter: Pick<NativeCounter, 'value' | 'availability' | 'source'>, semantics: UsageObservations[keyof UsageObservations]['semantics'], inclusion: string | null) {
  const observed = counter.availability === 'observed' && typeof counter.value === 'number'
    && Number.isFinite(counter.value) && counter.value >= 0;
  return {
    value: observed ? counter.value : null,
    availability: observed ? 'observed' as const : counter.availability === 'unavailable' ? 'unavailable' as const : 'not-reported' as const,
    source: counter.source,
    semantics,
    inclusion,
  };
}

function observationUsage(observation: NativeStrategyObservation): UsageObservations {
  const counters = observation.usage.counters;
  const inclusion = observation.usage.inclusion;
  return Object.freeze({
    input: toCounter(counters.input, 'input', inclusion.input),
    output: toCounter(counters.output, 'output', inclusion.output),
    cacheRead: toCounter(counters.cacheRead, 'cacheRead', inclusion.cache),
    cacheWrite: toCounter(counters.cacheWrite, 'cacheWrite', inclusion.cache),
    reasoning: toCounter(counters.reasoning, 'reasoning', inclusion.reasoning),
    tokenTotal: toCounter({
      ...observation.usage.tokenTotal,
      availability: observation.usage.tokenTotal.semantics === 'authoritative-total'
        ? observation.usage.tokenTotal.availability
        : 'unavailable',
      value: observation.usage.tokenTotal.semantics === 'authoritative-total'
        ? observation.usage.tokenTotal.value
        : null,
    }, 'tokenTotal', null),
  });
}

function stageObservation(observation: NativeStrategyObservation): StageObservation {
  const durations = Object.values(observation.timing.stages).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const serviceTimeMs = durations.length ? durations.reduce((sum, value) => sum + value, 0) : null;
  return {
    usage: observationUsage(observation),
    // S1 does not claim dispatch reachability in its observation schema. The
    // operation result remains authoritative where it can report this.
    launched: null,
    serviceTimeMs,
    baselineCommit: observation.capture.baselineCommit,
    inclusion: {
      input: observation.usage.inclusion.input,
      output: observation.usage.inclusion.output,
      cacheRead: observation.usage.inclusion.cache,
      cacheWrite: observation.usage.inclusion.cache,
      reasoning: observation.usage.inclusion.reasoning,
      tokenTotal: null,
    },
  };
}

export function createNativeStrategyExecutor(
  driver: NativeObservedDriver,
  hooks: NativeStrategyExecutorHooks,
): StageExecutor {
  const running = new Map<string, RunningInvocation>();
  const identityByAttempt = new Map<string, NativeInvocationIdentity>();

  return {
    async execute(request) {
      const id = invocationId(request);
      const identity: NativeInvocationIdentity = {
        invocationId: id,
        assignmentId: request.assignmentId,
        stageId: request.stageId,
        attemptId: request.attemptId,
      };
      const handoff = driver.beginInvocation ?? driver.setInvocationIdentity;
      if (request.route !== null && !handoff) throw new Error('S1 native driver requires beginInvocation or setInvocationIdentity');
      if (request.route !== null) await handoff!.call(driver, identity);
      identityByAttempt.set(request.attemptId, identity);
      const state: RunningInvocation = { identity, settled: false };
      running.set(request.attemptId, state);
      try {
        return await hooks.runStage(request, driver);
      } finally {
        state.settled = true;
      }
    },

    async stopAndWait(request, execution, cause) {
      const state = running.get(request.attemptId);
      const identity = state?.identity ?? identityByAttempt.get(request.attemptId);
      if (!identity) return { stopped: false, executionSettled: false };
      const proof = await hooks.supervisor.cancelInvocationAndWait({
        identity,
        cause,
        deadlineEpochMs: request.deadlineEpochMs + request.tier.shutdownAllowanceMs,
      });
      const matches = proof.invocationId === identity.invocationId
        && proof.stageId === identity.stageId && proof.attemptId === identity.attemptId
        && proof.processTree === 'stopped-and-reaped' && proof.invocation === 'settled';
      // Keep the adapter pending until execute() has also settled. The engine
      // bounds this wait with its shutdown reserve and quarantines on timeout.
      await execution.then(() => undefined, () => undefined);
      const settled = state?.settled === true;
      running.delete(request.attemptId);
      return { stopped: matches && settled, executionSettled: matches && settled };
    },

    async getObservation(request) {
      if (request.route === null) return null;
      const identity = identityByAttempt.get(request.attemptId);
      if (!identity) return null;
      const observation = await driver.getObservation(identity.invocationId);
      if (!observation || observation.identity.invocationId !== identity.invocationId
        || observation.identity.assignmentId !== request.assignmentId
        || observation.identity.stageId !== request.stageId || observation.identity.attemptId !== request.attemptId) return null;
      return stageObservation(observation);
    },

    createCandidateWorkspace(request, index) {
      const stableWorkspaceId = `w-${createHash('sha256')
        .update(`${request.assignmentId}\0${request.recipeHash}\0${request.stageId}\0${index}`)
        .digest('hex').slice(0, 32)}`;
      return Promise.resolve(hooks.createCandidateWorkspace(request, index, stableWorkspaceId)).then((allocated) => {
        if (allocated.id !== stableWorkspaceId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(allocated.id)) {
          throw new Error('Candidate workspace allocator must return its requested path-safe stable id');
        }
        return allocated;
      });
    },

    captureCandidate(request, state) {
      return hooks.captureCandidate(request, state);
    },
  };
}

/** Convenient explicit null envelope for routes with no native observation. */
export function missingNativeUsage(): UsageObservations {
  return unknownUsage();
}
