import { resolve } from 'node:path';
import type { OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { currentJobContext } from '@camerontaylor/cq-toolkit';
import type { InvocationIdentity } from './observation.ts';
import { readExecutableVersion, resolveLaunchExecutable } from './launch-inventory.ts';
import { applyUsageObservation, parseJsonEventLines, toStructuredOutput } from './events.ts';
import { ObservedNativeDriver, createWorkerResult, usageProjection, type NativeDriverOptions } from './observed-driver.ts';
import { runSupervised } from './process.ts';
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
  allowUnconfinedTestProcess?: boolean;
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
  private readonly allowUnconfinedTestProcess: boolean;

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
    this.allowUnconfinedTestProcess = options.allowUnconfinedTestProcess ?? false;
  }

  protected async runObserved(invocation: OpInvocation, identity: InvocationIdentity): Promise<WorkerResult> {
    invocation = this.invocationForTarget(invocation, this.model, 'openai-codex');
    const startedAt = new Date().toISOString();
    const observation = this.newObservation(identity, invocation, startedAt);
    observation.model.settings.effort = { value: this.effort, source: 'codex exec --config', status: 'requested-unobservable' };
    observation.model.settings.sandbox = { value: invocation.sandboxPolicy.level, source: 'codex exec --sandbox', status: 'requested' };
    observation.model.settings.toolPolicy = { value: invocation.toolPolicy, source: 'OpInvocation.toolPolicy', status: 'not-enforced-by-codex-exec-flags' };
    this.observations.set(identity.invocationId, observation);
    if (invocation.sessionRef) {
      const error = new Error('codex exec bridge does not resume sessions; use a fresh bounded assignment');
      this.failObservation(observation, error);
      throw error;
    }
    try {
      const cwd = resolve(this.workspaceForInvocation(invocation));
      const args = [
        'exec', '--json', '--ephemeral', '--sandbox', codexSandbox(invocation),
        '-C', cwd, '-m', invocation.modelSpec.model,
        '-c', `model_reasoning_effort=${JSON.stringify(this.effort)}`, '-',
      ];
      const result = await runSupervised(this.executable, args, {
        cwd, input: invocation.prompt,
        timeoutMs: invocation.budget.wallClockMs ?? this.hardWallClockMs,
        killGraceMs: this.killGraceMs,
        signal: currentJobContext()?.signal,
        ...(this.boundaryForInvocation ? { boundary: this.boundaryForInvocation(identity, invocation, cwd) } : {}),
        ...(this.spawnAdapter ? { spawnAdapter: this.spawnAdapter } : {}),
        allowUnconfinedTestProcess: this.allowUnconfinedTestProcess,
      });
      if (result.launch) observation.model.settings.launch = { value: result.launch, source: 'spawnBoundary', status: 'admitted-visible-route' };
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
      const worker = createWorkerResult(usageProjection(observation.usage.counters), result.code === 0 ? 'complete' :
        result.terminal === 'timeout' ? 'budget' : result.terminal === 'cancelled' ? 'aborted' : 'error', {
        ...(parsed.model ? { model: parsed.model } : {}),
        ...(parsed.text ? { structuredOutput: toStructuredOutput(parsed.text) } : {}),
        ...(result.code !== 0 ? { error: result.stderr.slice(-2000) || `codex exec exited ${result.code ?? result.signal}` } : {}),
      });
      this.finishObservation(observation, worker);
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
