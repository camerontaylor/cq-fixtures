import { resolve } from 'node:path';
import { currentJobContext, type OpInvocation, type WorkerResult } from '@camerontaylor/cq-toolkit';
import type { InvocationIdentity } from './observation.ts';
import { readExecutableVersion, resolveLaunchExecutable } from './launch-inventory.ts';
import { applyUsageObservation, parseJsonEventLines, toStructuredOutput } from './events.ts';
import { ObservedNativeDriver, createWorkerResult, usageProjection, type NativeDriverOptions } from './observed-driver.ts';
import { runSupervised } from './process.ts';
import type { BoundaryLaunch } from '../boundary/spawn.ts';
import type { NativeSpawnAdapter } from './process.ts';

export type PiMode = 'json' | 'rpc';

export interface PiNativeOptions {
  mode?: PiMode;
  executable?: string;
  version?: string | null;
  profile?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  artifactDirectory?: string;
  hardWallClockMs?: number;
  killGraceMs?: number;
  workspaceForInvocation?: (invocation: OpInvocation) => string;
  boundaryForInvocation?: (identity: InvocationIdentity, invocation: OpInvocation, workspace: string) => Omit<BoundaryLaunch, 'executable' | 'args'>;
  spawnAdapter?: NativeSpawnAdapter;
  allowUnconfinedTestProcess?: boolean;
}

/** Pi native JSON/RPC transport for the configured OpenCode Go subscription route. */
export class PiNativeDriver extends ObservedNativeDriver {
  private readonly executable: string;
  private readonly mode: PiMode;
  private readonly provider: string;
  private readonly model: string;
  private readonly thinking: string;
  private readonly modelSpecProvider: string;
  private readonly hardWallClockMs: number;
  private readonly killGraceMs: number;
  private readonly workspaceForInvocation: NonNullable<PiNativeOptions['workspaceForInvocation']>;
  private readonly boundaryForInvocation: PiNativeOptions['boundaryForInvocation'];
  private readonly spawnAdapter: NativeSpawnAdapter | undefined;
  private readonly allowUnconfinedTestProcess: boolean;

  constructor(options: PiNativeOptions = {}) {
    const executable = options.executable ?? 'pi';
    const mode = options.mode ?? 'json';
    const provider = options.provider ?? 'opencode-go';
    const model = options.model ?? 'opencode-go/space-bunny-free';
    const thinking = options.thinking ?? 'high';
    const modelSpecProvider = 'pi-opencode';
    super({
      configuredTarget: 'pi-opencode/opencode-go/space-bunny-free',
      transport: `pi-${mode}`, executable: resolveLaunchExecutable(executable),
      executableVersion: options.version ?? readExecutableVersion(resolveLaunchExecutable(executable)),
      profile: options.profile ?? 'Space Bunny Free (Pi OpenCode)', artifactDirectory: options.artifactDirectory,
    } satisfies NativeDriverOptions);
    this.executable = executable;
    this.mode = mode;
    this.provider = provider;
    this.model = model;
    this.thinking = thinking;
    this.modelSpecProvider = modelSpecProvider;
    this.hardWallClockMs = options.hardWallClockMs ?? 120_000;
    this.killGraceMs = options.killGraceMs ?? 300;
    this.workspaceForInvocation = options.workspaceForInvocation ?? (() => process.cwd());
    this.boundaryForInvocation = options.boundaryForInvocation;
    this.spawnAdapter = options.spawnAdapter;
    this.allowUnconfinedTestProcess = options.allowUnconfinedTestProcess ?? false;
  }

  protected async runObserved(invocation: OpInvocation, identity: InvocationIdentity): Promise<WorkerResult> {
    invocation = this.invocationForTarget(invocation, this.model, this.modelSpecProvider);
    const observation = this.newObservation(identity, invocation, new Date().toISOString());
    observation.model.configuredTarget = 'pi-opencode/opencode-go/space-bunny-free';
    observation.model.requested = { value: this.model, source: 'Paseo pi-opencode profile', status: 'requested' };
    observation.model.settings.effort = { value: this.thinking, source: 'Paseo pi-opencode profile', status: 'requested-unobservable' };
    observation.model.settings.session = { value: 'ephemeral', source: 'Pi --no-session', status: 'requested' };
    observation.model.settings.toolPolicy = { value: invocation.toolPolicy, source: 'Pi --tools/--no-tools', status: 'requested-unverified' };
    observation.model.settings.sandbox = { value: invocation.sandboxPolicy.level, source: 'Pi native profile', status: 'unsupported-by-pi-cli' };
    this.observations.set(identity.invocationId, observation);
    if (invocation.sessionRef) {
      const error = new Error('Pi native bridge is configured for ephemeral sessions and does not resume sessionRef');
      this.failObservation(observation, error);
      throw error;
    }
    try {
      const cwd = resolve(this.workspaceForInvocation(invocation));
      const args = [
        '--mode', this.mode,
        '--provider', this.provider,
        '--model', `${this.model}:${this.thinking}`,
        '--thinking', this.thinking,
        '--no-session',
        '-p', invocation.prompt,
      ];
      const toolArgs = piToolArgs(invocation);
      args.splice(args.length - 2, 0, ...toolArgs);
      const result = await runSupervised(this.executable, args, {
        cwd, timeoutMs: invocation.budget.wallClockMs ?? this.hardWallClockMs,
        killGraceMs: this.killGraceMs,
        signal: currentJobContext()?.signal,
        ...(this.boundaryForInvocation ? { boundary: this.boundaryForInvocation(identity, invocation, cwd) } : {}),
        ...(this.spawnAdapter ? { spawnAdapter: this.spawnAdapter } : {}),
        allowUnconfinedTestProcess: this.allowUnconfinedTestProcess,
      });
      if (result.launch) observation.model.settings.launch = { value: result.launch, source: 'spawnBoundary', status: 'admitted-visible-route' };
      const raw = redactAnonymousRouteEvents([result.stdout, result.stderr ? `\n${result.stderr}` : ''].join(''));
      this.persistEventArtifact(observation, raw);
      const parsed = parseJsonEventLines(result.stdout, 'pi');
      // Retain only the configured anonymous route. Provider response fields
      // may contain internal aliases; they are neither requested nor emitted.
      parsed.model = null;
      applyUsageObservation(observation, parsed, `pi-${this.mode}-event`);
      if (result.terminal === 'timeout' || result.terminal === 'cancelled') {
        observation.terminal.cause = result.terminal;
        observation.terminal.cancelled = result.terminal === 'cancelled';
      } else if (result.terminal === 'spawn-error') {
        const error = new Error(result.error?.message ?? 'Pi could not start');
        this.failObservation(observation, error);
        observation.terminal.cause = 'spawn-error';
        throw error;
      } else if (result.code !== 0) observation.terminal.cause = `exit:${result.code ?? result.signal ?? 'unknown'}`;
      const worker = createWorkerResult(usageProjection(observation.usage.counters), result.code === 0 ? 'complete' :
        result.terminal === 'timeout' ? 'budget' : result.terminal === 'cancelled' ? 'aborted' : 'error', {
        // Do not infer or reveal the anonymous served identity from the route.
        ...(parsed.text ? { structuredOutput: toStructuredOutput(parsed.text) } : {}),
        ...(result.code !== 0 ? { error: result.stderr.slice(-2000) || `Pi exited ${result.code ?? result.signal}` } : {}),
      });
      this.finishObservation(observation, worker);
      return worker;
    } catch (error) {
      if (!observation.timing.endedAt) this.failObservation(observation, error);
      throw error;
    }
  }
}

function piToolArgs(invocation: OpInvocation): string[] {
  if (invocation.toolPolicy.mode === 'unrestricted') return [];
  if (invocation.toolPolicy.mode === 'none' || invocation.toolPolicy.allow.length === 0) return ['--no-tools'];
  const mapped = invocation.toolPolicy.allow.map((tool) => tool === 'run' ? 'bash' : tool).filter((tool) =>
    ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'].includes(tool));
  return mapped.length ? ['--tools', [...new Set(mapped)].join(',')] : ['--no-tools'];
}

function redactAnonymousRouteEvents(raw: string): string {
  return raw.split(/\r?\n/u).map((line) => {
    try {
      const event = JSON.parse(line) as unknown;
      return JSON.stringify(redactModelFields(event));
    } catch {
      return line.replace(/\b(model(?:_id)?|servedModel)\s*[:=]\s*[^\s,}]+/giu, '$1=[anonymous route detail withheld]');
    }
  }).join('\n');
}

function redactModelFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactModelFields);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    const anonymousField = /^(?:model|modelId|model_id|servedModel)$/iu.test(key);
    return [key, anonymousField ? '[anonymous route detail withheld]' : redactModelFields(item)];
  }));
}
