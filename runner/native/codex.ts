import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { currentJobContext } from '@camerontaylor/cq-toolkit';
import type { InvocationIdentity, NativeObservation } from './observation.ts';
import { readExecutableVersion, resolveLaunchExecutable } from './launch-inventory.ts';
import { applyUsageObservation, parseJsonEventLines, toStructuredOutput } from './events.ts';
import { ObservedNativeDriver, createWorkerResult, usageProjection, type NativeDriverOptions } from './observed-driver.ts';
import { launchEvidenceStatus, runSupervised, type NativeInvocationCleanup, type NativeInvocationStage, type NativeSpawnAdapterFactory, type SupervisedProcessResult } from './process.ts';
import { resolveNativeSession } from './session.ts';
import type { BoundaryLaunch } from '../boundary/spawn.ts';
import type { NativeSpawnAdapter } from './process.ts';

export interface CodexExecOptions {
  executable?: string;
  version?: string | null;
  profile?: string;
  effort?: string;
  model?: string;
  /** Explicit S5-only sandbox policy, bound to one frozen final-profile assignment. */
  finalProfileContainerPolicy?: {
    profile: 'cq-subscription-http';
    identity: Pick<InvocationIdentity, 'assignmentId' | 'stageId' | 'attemptId'>;
  };
  artifactDirectory?: string;
  hardWallClockMs?: number;
  killGraceMs?: number;
  workspaceForInvocation?: (invocation: OpInvocation) => string;
  boundaryForInvocation?: (identity: InvocationIdentity, invocation: OpInvocation, workspace: string) => Omit<BoundaryLaunch, 'executable' | 'args'>;
  spawnAdapter?: NativeSpawnAdapter;
  spawnAdapterFactory?: NativeSpawnAdapterFactory;
  cleanupInvocation?: NativeInvocationCleanup;
  invocationStage?: NativeInvocationStage;
  assignmentDeadlineEpochMs?: number;
  signal?: AbortSignal;
  expectedTaskBaselineCommit?: () => string | undefined;
}

/** Native subscription route through `codex exec --json`; this never starts a Codex app-server turn. */
export class CodexExecDriver extends ObservedNativeDriver {
  private readonly executable: string;
  private readonly hardWallClockMs: number;
  private readonly killGraceMs: number;
  private readonly effort: string;
  private readonly model: string;
  private readonly finalProfileContainerPolicy: CodexExecOptions['finalProfileContainerPolicy'];
  private readonly workspaceForInvocation: NonNullable<CodexExecOptions['workspaceForInvocation']>;
  private readonly boundaryForInvocation: CodexExecOptions['boundaryForInvocation'];
  private readonly spawnAdapter: NativeSpawnAdapter | undefined;
  private readonly spawnAdapterFactory: NativeSpawnAdapterFactory | undefined;
  private readonly cleanupInvocation: NativeInvocationCleanup | undefined;
  private readonly invocationStage: NativeInvocationStage;
  private readonly assignmentDeadlineEpochMs: number | undefined;
  private readonly assignmentSignal: AbortSignal | undefined;
  private readonly expectedTaskBaselineCommit: (() => string | undefined) | undefined;

  constructor(options: CodexExecOptions = {}) {
    const executable = options.executable ?? 'codex';
    const profile = options.profile ?? 'codex/gpt-6-luna';
    const effort = options.effort ?? 'high';
    const model = options.model ?? 'gpt-6-luna';
    const base: NativeDriverOptions = {
      configuredTarget: `codex/${model}`, transport: 'codex-exec',
      executable: resolveLaunchExecutable(executable), executableVersion: options.version ?? readExecutableVersion(resolveLaunchExecutable(executable)),
      profile, artifactDirectory: options.artifactDirectory,
    };
    super(base);
    this.executable = executable;
    this.hardWallClockMs = options.hardWallClockMs ?? 120_000;
    this.killGraceMs = options.killGraceMs ?? 300;
    this.effort = effort;
    this.model = model;
    this.workspaceForInvocation = options.workspaceForInvocation ?? (() => process.cwd());
    this.boundaryForInvocation = options.boundaryForInvocation;
    this.spawnAdapter = options.spawnAdapter;
    this.spawnAdapterFactory = options.spawnAdapterFactory;
    this.cleanupInvocation = options.cleanupInvocation;
    this.invocationStage = options.invocationStage ?? 'visible-calibration-G1';
    this.finalProfileContainerPolicy = options.finalProfileContainerPolicy === undefined ? undefined : {
      profile: options.finalProfileContainerPolicy.profile,
      identity: Object.freeze({ ...options.finalProfileContainerPolicy.identity }),
    };
    if (this.finalProfileContainerPolicy && (
      this.invocationStage !== 'final-profile-G1' || model !== 'gpt-6-sol' || effort !== 'low' ||
      resolveLaunchExecutable(executable) !== '/usr/local/bin/codex' || !options.spawnAdapterFactory || options.spawnAdapter || options.boundaryForInvocation
    )) {
      throw new Error('final-profile container sandbox policy requires the exact Sol/low Codex boundary factory');
    }
    this.assignmentDeadlineEpochMs = options.assignmentDeadlineEpochMs;
    this.assignmentSignal = options.signal;
    this.expectedTaskBaselineCommit = options.expectedTaskBaselineCommit;
  }

  protected async runObserved(invocation: OpInvocation, identity: InvocationIdentity): Promise<WorkerResult> {
    const startedAt = new Date().toISOString();
    const observation = this.newObservation(identity, invocation, startedAt);
    observation.model.settings.launchedTarget = { value: `codex/${this.model}`, source: 'CodexExecDriver configuration', status: 'configured' };
    observation.model.settings.effort = { value: this.effort, source: 'codex exec --config', status: 'requested-unobservable' };
    observation.model.settings.toolPolicy = { value: invocation.toolPolicy, source: 'OpInvocation.toolPolicy', status: 'not-enforced-by-codex-exec-flags' };
    observation.model.settings.extensions = { value: [], source: 'codex exec --ignore-user-config', status: 'user-config-disabled' };
    this.observations.set(identity.invocationId, observation);
    try {
      const sandbox = this.sandboxForInvocation(invocation, identity);
      if (this.finalProfileContainerPolicy) {
        observation.model.settings.requestedSandbox = observation.model.settings.sandbox;
        observation.model.settings.sandbox = {
          value: sandbox, source: 'identity-bound final-profile S5 container policy',
          status: 'effective-inside-unverified-boundary',
        };
      } else {
        observation.model.settings.sandbox = { value: sandbox, source: 'codex exec --sandbox', status: 'requested' };
      }
      this.assertRequestedModel(invocation, this.model);
      const session = await resolveNativeSession(invocation, this.workspaceForInvocation);
      const cwd = resolve(session.cwd);
      observation.model.settings.session = {
        value: session.status === 'runner-workspace-resolved' ? 'runner workspace binding; Codex turn ephemeral' : 'fresh Codex ephemeral turn',
        source: 'runner SessionStore + codex exec --ephemeral', status: session.status,
      };
      const args = [
        'exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', sandbox,
        '-C', cwd, '-m', this.model,
        '-c', `model_reasoning_effort=${JSON.stringify(this.effort)}`, '-',
      ];
      this.nativeSupervisor.expectProcessTree(identity);
      const result = await runSupervised(this.executable, args, {
        cwd, identity, stage: this.invocationStage, input: invocation.prompt,
        timeoutMs: Math.min(invocation.budget.wallClockMs ?? this.hardWallClockMs, this.hardWallClockMs),
        ...(this.assignmentDeadlineEpochMs === undefined ? {} : { hardDeadlineEpochMs: this.assignmentDeadlineEpochMs }),
        killGraceMs: this.killGraceMs,
        signal: this.signalFor(identity, joinSignals(this.assignmentSignal, currentJobContext()?.signal)),
        ...(this.boundaryForInvocation ? { boundary: this.boundaryForInvocation(identity, invocation, cwd) } : {}),
        ...(this.spawnAdapter ? { spawnAdapter: this.spawnAdapter } : {}),
        ...(this.spawnAdapterFactory ? { spawnAdapterFactory: this.spawnAdapterFactory } : {}),
        ...(this.cleanupInvocation ? { cleanupInvocation: this.cleanupInvocation } : {}),
        ...(this.expectedTaskBaselineCommit ? { expectedTaskBaselineCommit: this.expectedTaskBaselineCommit } : {}),
      });
      this.reportProcessTree(identity, result.treeStopped);
      if (result.launch) observation.model.settings.launch = { value: result.launch, source: 'native spawn admission', status: launchEvidenceStatus(result.launch) };
      observation.model.settings.processTree = { value: result.treeStopped, source: 'native process-group stop proof', status: result.treeStopped ? 'stopped-and-settled' : 'stop-unproven-capture-forbidden' };
      try {
        this.persistSupervisorLifecycle(observation, result);
        observation.model.settings.supervisorLifecycleArtifact = { value: 'persisted', source: 'native supervisor lifecycle evidence', status: 'persisted' };
      } catch {
        // Diagnostic artifact I/O must not replace process-tree status or lose
        // the primary native observation. The report retains this failure state.
        observation.model.settings.supervisorLifecycleArtifact = { value: null, source: 'native supervisor lifecycle evidence', status: 'write-failed' };
      }
      const raw = [result.stdout, result.stderr ? `\n${result.stderr}` : ''].join('');
      this.persistEventArtifact(observation, raw);
      const parsed = parseJsonEventLines(result.stdout, 'codex');
      applyUsageObservation(observation, parsed, 'codex-exec-json-event');
      if (result.terminal === 'timeout' || result.terminal === 'cancelled') {
        observation.terminal.cause = result.terminal;
        observation.terminal.cancelled = result.terminal === 'cancelled';
      } else if (result.terminal === 'spawn-error') {
        const error = new Error(result.error?.message ?? 'codex exec could not start');
        this.failObservation(observation, error);
        observation.terminal.cause = 'spawn-error';
        throw error;
      } else if (result.code !== 0) observation.terminal.cause = `exit:${result.code ?? result.signal ?? 'unknown'}`;
      if (!result.treeStopped) observation.terminal.cause = 'process-tree-stop-unproven';
      const worker = createWorkerResult(usageProjection(observation.usage.counters), result.code === 0 && result.treeStopped ? 'complete' :
        result.terminal === 'timeout' ? 'budget' : result.terminal === 'cancelled' ? 'aborted' : 'error', {
        ...(parsed.model ? { model: parsed.model } : {}),
        ...(parsed.finalText ? { structuredOutput: toStructuredOutput(parsed.finalText) } : {}),
        ...(result.code !== 0 || !result.treeStopped ? { error: result.stderr.slice(-2000) || (!result.treeStopped ? 'codex process tree stop could not be proven; capture is forbidden' : `codex exec exited ${result.code ?? result.signal}`) } : {}),
        ...(session.sessionRef ? { sessionId: session.sessionRef } : {}),
      });
      this.finishObservation(observation, worker);
      if (!result.treeStopped) throw new Error('codex process tree stop could not be proven; candidate capture is forbidden');
      return worker;
    } catch (error) {
      if (!this.observations.has(identity.invocationId) || this.observations.get(identity.invocationId) !== observation) {
        this.failObservation(observation, error);
      } else if (!observation.timing.endedAt) this.failObservation(observation, error);
      throw error;
    }
  }

  private persistSupervisorLifecycle(observation: NativeObservation, result: SupervisedProcessResult): void {
    const lifecycle = result.lifecycle;
    const evidence = {
      schemaVersion: 1,
      terminal: result.terminal,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      processTreeStopped: result.treeStopped,
      boundaryTermination: lifecycle ? (lifecycle.terminated ? 'proven' : 'unproven') : 'not-applicable-or-unavailable',
      boundaryExport: lifecycle ? (lifecycle.finalized ? 'proven' : 'unproven') : 'not-applicable-or-unavailable',
      ...(lifecycle?.failurePhase ? { failurePhase: lifecycle.failurePhase } : {}),
      ...(lifecycle?.error ? { failureClass: safeLifecycleErrorClass(lifecycle.error.name) } : {}),
      assignmentDeadlineCrossed: this.assignmentDeadlineEpochMs === undefined
        ? null : Date.parse(result.endedAt) > this.assignmentDeadlineEpochMs,
      exportReceiptPresent: result.launch?.taskExport !== undefined,
    };
    const text = `${JSON.stringify(evidence, null, 2)}\n`;
    const path = join(this.artifactDirectory, observation.identity.invocationId, 'supervisor-lifecycle.json');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
    observation.artifacts.push({ kind: 'supervisor-lifecycle', path, sha256: createHash('sha256').update(text).digest('hex') });
  }

  private sandboxForInvocation(invocation: OpInvocation, identity: InvocationIdentity): string {
    const policy = this.finalProfileContainerPolicy;
    if (!policy) return codexSandbox(invocation);
    if (identity.assignmentId !== policy.identity.assignmentId || identity.stageId !== policy.identity.stageId ||
        identity.attemptId !== policy.identity.attemptId || identity.assignmentId.length === 0 ||
        invocation.modelSpec.model !== 'gpt-6-sol' || invocation.modelSpec.provider !== 'codex' ||
        invocation.sandboxPolicy.level !== 'workspace-write') {
      throw new Error('final-profile container sandbox policy does not match the frozen Codex invocation');
    }
    return 'danger-full-access';
  }
}

function safeLifecycleErrorClass(name: string): string {
  // Persist only a small class allowlist. Never copy lifecycle messages or
  // arbitrary error names into campaign artifacts.
  return ['Error', 'TypeError', 'RangeError', 'DeadlineExceeded', 'CleanupUnconfigured', 'CleanupUnproven'].includes(name)
    ? name : 'Error';
}

function joinSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (first && second) return AbortSignal.any([first, second]);
  return first ?? second;
}

function codexSandbox(invocation: OpInvocation): string {
  switch (invocation.sandboxPolicy.level) {
    case 'read-only': return 'read-only';
    case 'workspace-write': return 'workspace-write';
    case 'none': return 'danger-full-access';
  }
}
