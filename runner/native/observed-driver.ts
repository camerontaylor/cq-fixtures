import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import type { InvocationIdentity, NativeLifecycleEvidence, NativeLifecycleEvidenceRef, NativeObservation, ObservedDriver } from './observation.ts';
import { NativeSupervisorControl } from './process.ts';

export interface NativeDriverOptions {
  configuredTarget: string;
  transport: string;
  executable: string;
  executableVersion: string | null;
  profile: string;
  artifactDirectory?: string;
}

export type { NativeStopProof } from './process.ts';

export interface NativeCampaignBudgetCapabilities {
  hardTokenCap: boolean;
  authoritativeTokenTotal: boolean;
}

interface NativeLifecycleState {
  identity: InvocationIdentity;
  processStatus: NativeLifecycleEvidence['process']['status'];
  processProofSource: string | null;
  settlementStatus: NativeLifecycleEvidence['settlement']['status'];
  artifact: NativeLifecycleEvidenceRef | null;
}

/**
 * Base class for fixtures-local native bridges. The shared S1 seam performs a
 * serialized identity handoff immediately before Driver.run(). Serializing
 * here keeps the structural contract safe if callers dispatch concurrently.
 */
export abstract class ObservedNativeDriver implements Driver, ObservedDriver {
  readonly observations = new Map<string, NativeObservation>();
  readonly campaignBudgetCapabilities: NativeCampaignBudgetCapabilities = { hardTokenCap: false, authoritativeTokenTotal: false };
  get nativeTransport(): string { return this.options.transport; }
  get configuredNativeTarget(): string { return this.options.configuredTarget; }
  protected readonly artifactDirectory: string;
  private identityQueue: Promise<void> = Promise.resolve();
  private activeIdentity: InvocationIdentity | undefined;
  private releaseIdentity: (() => void) | undefined;
  private readonly lifecycle = new Map<string, NativeLifecycleState>();
  protected readonly nativeSupervisor = new NativeSupervisorControl();

  protected constructor(protected readonly options: NativeDriverOptions) {
    this.artifactDirectory = options.artifactDirectory ?? join(process.env.TMPDIR ?? '/tmp', 'cq-native-artifacts');
  }

  async beginInvocation(identity: InvocationIdentity): Promise<void> {
    let release!: () => void;
    const previous = this.identityQueue;
    this.identityQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    this.activeIdentity = { ...identity };
    this.releaseIdentity = release;
  }

  async run(invocation: OpInvocation): Promise<WorkerResult> {
    if (!this.activeIdentity) {
      const id = randomUUID();
      await this.beginInvocation({ invocationId: id, assignmentId: id, stageId: id, attemptId: id });
    }
    const identity = this.activeIdentity!;
    this.nativeSupervisor.beginInvocation(identity);
    const lifecycle: NativeLifecycleState = {
      identity: { ...identity }, processStatus: 'unknown', processProofSource: null,
      settlementStatus: 'unsettled', artifact: null,
    };
    this.lifecycle.set(identity.invocationId, lifecycle);
    const release = this.releaseIdentity;
    this.activeIdentity = undefined;
    this.releaseIdentity = undefined;
    try {
      return await this.runObserved(invocation, identity);
    } finally {
      try {
        this.nativeSupervisor.settleInvocation(identity);
        lifecycle.settlementStatus = 'settled';
      } catch {
        lifecycle.settlementStatus = 'unknown';
      }
      try { this.persistLifecycleEvidence(lifecycle); }
      catch {
        // Lifecycle persistence is diagnostic evidence and must never replace
        // the native driver's primary WorkerResult or transport exception.
        lifecycle.artifact = null;
      } finally {
        release?.();
      }
    }
  }

  /** Cancellation seam consumed by the bounded native strategy executor. */
  protected signalFor(identity: InvocationIdentity, parent?: AbortSignal): AbortSignal {
    return this.nativeSupervisor.signal(identity, parent);
  }

  protected reportProcessTree(identity: InvocationIdentity, stopped: boolean): void {
    this.nativeSupervisor.reportProcessTree(identity, stopped);
    const lifecycle = this.lifecycle.get(identity.invocationId);
    if (lifecycle && sameIdentity(lifecycle.identity, identity)) {
      lifecycle.processStatus = stopped ? 'stopped' : 'unknown';
      lifecycle.processProofSource = 'runSupervised.treeStopped';
    }
  }

  cancelInvocationAndWait = this.nativeSupervisor.cancelInvocationAndWait.bind(this.nativeSupervisor);

  getObservation(invocationId: string): NativeObservation | undefined {
    return this.observations.get(invocationId);
  }

  getLifecycleEvidence(invocationId: string): NativeLifecycleEvidence | undefined {
    const state = this.lifecycle.get(invocationId);
    if (!state) return undefined;
    // Status is meaningful to the shared helper only when the immutable
    // private artifact was written and joined to this exact observation.
    if (!state.artifact) return {
      identity: { ...state.identity },
      process: { status: 'unknown', evidence: null },
      settlement: { status: 'unknown', evidence: null },
    };
    const evidence = { ...state.artifact };
    return {
      identity: { ...state.identity },
      process: { status: state.processStatus, evidence: { ...evidence } },
      settlement: { status: state.settlementStatus, evidence: { ...evidence } },
    };
  }

  protected abstract runObserved(invocation: OpInvocation, identity: InvocationIdentity): Promise<WorkerResult>;

  /** Refuse silently relabeling an operation request as the configured native route. */
  protected assertRequestedModel(invocation: OpInvocation, configuredModel: string): void {
    if (invocation.modelSpec.model.toLowerCase() !== configuredModel.toLowerCase()) {
      throw new Error(`native route model mismatch: operation requested '${invocation.modelSpec.model}', configured profile is '${configuredModel}'`);
    }
  }

  protected newObservation(identity: InvocationIdentity, invocation: OpInvocation, startedAt: string): NativeObservation {
    const counterNames = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const;
    const counters = Object.fromEntries(counterNames.map((name) => [name, {
      value: null, availability: 'not-reported', source: null, semantics: name,
    }])) as NativeObservation['usage']['counters'];
    return {
      schemaVersion: 1,
      identity,
      transport: this.options.transport,
      executable: { path: this.options.executable, version: this.options.executableVersion, profile: this.options.profile },
      artifacts: [],
      withheldArtifacts: [],
      model: {
        configuredTarget: this.options.configuredTarget,
        requested: { value: invocation.modelSpec.model, source: 'OpInvocation.modelSpec', status: 'requested' },
        observed: { value: null, source: null, status: 'not-reported' },
        settings: {
          effort: { value: null, source: 'local-profile-inventory', status: 'requested-unobservable' },
          permissions: { value: invocation.toolPolicy.mode ?? 'allowlist', source: 'OpInvocation.toolPolicy', status: 'requested' },
          sandbox: { value: invocation.sandboxPolicy.level, source: 'OpInvocation.sandboxPolicy', status: 'requested' },
          requestedProvider: { value: invocation.modelSpec.provider, source: 'OpInvocation.modelSpec', status: 'requested' },
        },
      },
      usage: {
        counters,
        tokenTotal: { value: null, availability: 'not-reported', source: null, semantics: 'unknown' },
        inclusion: { input: null, output: null, cache: null, reasoning: null },
      },
      terminal: { cause: null, cancelled: false, transportException: null, observedAt: startedAt },
      capture: { status: 'pending-runner-capture', baselineCommit: null, baselineTree: null, patchSha256: null, workspaceSha256: null },
      timing: { startedAt, endedAt: null, stages: {} },
      workerResult: null,
    };
  }

  protected finishObservation(observation: NativeObservation, result: WorkerResult): void {
    observation.workerResult = result;
    observation.timing.endedAt = new Date().toISOString();
    observation.terminal.observedAt = observation.timing.endedAt;
    this.observations.set(observation.identity.invocationId, observation);
  }

  protected failObservation(observation: NativeObservation, error: unknown): void {
    const actual = error instanceof Error ? error : new Error(String(error));
    observation.terminal.cause = 'transport-exception';
    observation.terminal.transportException = { name: actual.name, message: actual.message };
    observation.timing.endedAt = new Date().toISOString();
    observation.terminal.observedAt = observation.timing.endedAt;
    this.observations.set(observation.identity.invocationId, observation);
  }

  protected persistEventArtifact(observation: NativeObservation, text: string): void {
    const path = join(this.artifactDirectory, observation.identity.invocationId, 'events.jsonl');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
    observation.artifacts.push({
      kind: 'raw-events', path,
      sha256: createHash('sha256').update(text).digest('hex'),
    });
  }

  private persistLifecycleEvidence(state: NativeLifecycleState): void {
    const observation = this.observations.get(state.identity.invocationId);
    if (!observation || !sameIdentity(observation.identity, state.identity)) return;
    const text = `${JSON.stringify({
      schemaVersion: 1,
      identity: state.identity,
      process: { status: state.processStatus, proofSource: state.processProofSource },
      settlement: { status: state.settlementStatus, proofSource: 'ObservedNativeDriver.run finally' },
    }, null, 2)}\n`;
    const path = join(this.artifactDirectory, state.identity.invocationId, 'native-lifecycle.json');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
    const artifact = {
      kind: 'native-lifecycle', path,
      sha256: createHash('sha256').update(text).digest('hex'),
    };
    observation.artifacts.push(artifact);
    state.artifact = artifact;
  }
}

function sameIdentity(left: InvocationIdentity, right: InvocationIdentity): boolean {
  return left.invocationId === right.invocationId && left.assignmentId === right.assignmentId &&
    left.stageId === right.stageId && left.attemptId === right.attemptId;
}


export function createWorkerResult(
  usage: WorkerResult['usage'],
  stopReason: WorkerResult['stopReason'],
  fields: Partial<Pick<WorkerResult, 'model' | 'structuredOutput' | 'denials' | 'sessionId'>> & { error?: string } = {},
): WorkerResult {
  return {
    usage,
    stopReason,
    denials: fields.denials ?? [],
    ...(fields.model === undefined ? {} : { model: fields.model }),
    ...(fields.structuredOutput === undefined ? {} : { structuredOutput: fields.structuredOutput }),
    ...(fields.sessionId === undefined ? {} : { sessionId: fields.sessionId }),
    ...(fields.error === undefined ? {} : { error: fields.error }),
  };
}

export function usageProjection(usage: NativeObservation['usage']['counters']): WorkerResult['usage'] {
  // Required numeric seam fields are a compatibility projection only. Missing
  // native measurements stay null in the authoritative envelope.
  return {
    input: usage.input.value ?? 0,
    output: usage.output.value ?? 0,
    cacheRead: usage.cacheRead.value ?? 0,
    cacheWrite: usage.cacheWrite.value ?? 0,
    ...(usage.reasoning.value === null ? {} : { reasoning: usage.reasoning.value }),
  };
}
