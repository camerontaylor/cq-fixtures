import { resolve } from 'node:path';
import type { OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { currentJobContext } from '@camerontaylor/cq-toolkit';
import type { InvocationIdentity } from './observation.ts';
import { readExecutableVersion, resolveLaunchExecutable } from './launch-inventory.ts';
import { applyUsageObservation, parseJsonEventLines, toStructuredOutput } from './events.ts';
import { ObservedNativeDriver, createWorkerResult, usageProjection, type NativeDriverOptions } from './observed-driver.ts';
import { launchEvidenceStatus, runSupervised } from './process.ts';
import { resolveNativeSession } from './session.ts';
import type { BoundaryLaunch } from '../boundary/spawn.ts';
import type { NativeSpawnAdapter } from './process.ts';

export interface CodexExecOptions {
  executable?: string;
  version?: string | null;
  profile?: string;
  effort?: string;
  model?: string;
  artifactDirectory?: string;
  hardWallClockMs?: number;
  killGraceMs?: number;
  workspaceForInvocation?: (invocation: OpInvocation) => string;
  boundaryForInvocation?: (identity: InvocationIdentity, invocation: OpInvocation, workspace: string) => Omit<BoundaryLaunch, 'executable' | 'args'>;
  spawnAdapter?: NativeSpawnAdapter;
}

/** Native subscription route through `codex exec --json`; this never starts a Codex app-server turn. */
export class CodexExecDriver extends ObservedNativeDriver {
  private readonly executable: string;
  private readonly hardWallClockMs: number;
  private readonly killGraceMs: number;
  private readonly effort: string;
  private readonly model: string;
  private readonly workspaceForInvocation: NonNullable<CodexExecOptions['workspaceForInvocation']>;
  private readonly boundaryForInvocation: CodexExecOptions['boundaryForInvocation'];
  private readonly spawnAdapter: NativeSpawnAdapter | undefined;

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
  }

  protected async runObserved(invocation: OpInvocation, identity: InvocationIdentity): Promise<WorkerResult> {
    const startedAt = new Date().toISOString();
    const observation = this.newObservation(identity, invocation, startedAt);
    observation.model.settings.launchedTarget = { value: `codex/${this.model}`, source: 'CodexExecDriver configuration', status: 'configured' };
    observation.model.settings.effort = { value: this.effort, source: 'codex exec --config', status: 'requested-unobservable' };
    observation.model.settings.sandbox = { value: invocation.sandboxPolicy.level, source: 'codex exec --sandbox', status: 'requested' };
    observation.model.settings.toolPolicy = { value: invocation.toolPolicy, source: 'OpInvocation.toolPolicy', status: 'not-enforced-by-codex-exec-flags' };
    observation.model.settings.extensions = { value: [], source: 'codex exec --ignore-user-config', status: 'user-config-disabled' };
    this.observations.set(identity.invocationId, observation);
    try {
      this.assertRequestedModel(invocation, this.model);
      const session = await resolveNativeSession(invocation, this.workspaceForInvocation);
      const cwd = resolve(session.cwd);
      observation.model.settings.session = {
        value: session.status === 'runner-workspace-resolved' ? 'runner workspace binding; Codex turn ephemeral' : 'fresh Codex ephemeral turn',
        source: 'runner SessionStore + codex exec --ephemeral', status: session.status,
      };
      const args = [
        'exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', codexSandbox(invocation),
        '-C', cwd, '-m', this.model,
        '-c', `model_reasoning_effort=${JSON.stringify(this.effort)}`, '-',
      ];
      this.nativeSupervisor.expectProcessTree(identity);
      const result = await runSupervised(this.executable, args, {
        cwd, input: invocation.prompt,
        timeoutMs: invocation.budget.wallClockMs ?? this.hardWallClockMs,
        killGraceMs: this.killGraceMs,
        signal: this.signalFor(identity, currentJobContext()?.signal),
        ...(this.boundaryForInvocation ? { boundary: this.boundaryForInvocation(identity, invocation, cwd) } : {}),
        ...(this.spawnAdapter ? { spawnAdapter: this.spawnAdapter } : {}),
      });
      this.reportProcessTree(identity, result.treeStopped);
      if (result.launch) observation.model.settings.launch = { value: result.launch, source: 'native spawn admission', status: launchEvidenceStatus(result.launch) };
      observation.model.settings.processTree = { value: result.treeStopped, source: 'native process-group stop proof', status: result.treeStopped ? 'stopped-and-settled' : 'stop-unproven-capture-forbidden' };
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
}

function codexSandbox(invocation: OpInvocation): string {
  switch (invocation.sandboxPolicy.level) {
    case 'read-only': return 'read-only';
    case 'workspace-write': return 'workspace-write';
    case 'none': return 'danger-full-access';
  }
}
