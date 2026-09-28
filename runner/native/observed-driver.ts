import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import type { InvocationIdentity, NativeObservation, ObservedDriver } from './observation.ts';

export interface NativeDriverOptions {
  configuredTarget: string;
  transport: string;
  executable: string;
  executableVersion: string | null;
  profile: string;
  artifactDirectory?: string;
}

/**
 * Base class for fixtures-local native bridges. The shared S1 seam performs a
 * serialized identity handoff immediately before Driver.run(). Serializing
 * here keeps the structural contract safe if callers dispatch concurrently.
 */
export abstract class ObservedNativeDriver implements Driver, ObservedDriver {
  readonly observations = new Map<string, NativeObservation>();
  protected readonly artifactDirectory: string;
  private identityQueue: Promise<void> = Promise.resolve();
  private activeIdentity: InvocationIdentity | undefined;
  private releaseIdentity: (() => void) | undefined;

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
    const release = this.releaseIdentity;
    this.activeIdentity = undefined;
    this.releaseIdentity = undefined;
    try {
      return await this.runObserved(invocation, identity);
    } finally {
      release?.();
    }
  }

  getObservation(invocationId: string): NativeObservation | undefined {
    return this.observations.get(invocationId);
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
        tokenTotal: { value: null, availability: 'not-reported', source: null },
        inclusion: { input: null, output: null, cache: null, reasoning: null },
      },
      terminal: { cause: null, cancelled: false, transportException: null, observedAt: startedAt },
      capture: { status: 'pending-runner-capture', patchSha256: null, workspaceSha256: null },
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
