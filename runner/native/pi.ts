import { resolve } from 'node:path';
import { currentJobContext, type OpInvocation, type WorkerResult } from '@camerontaylor/cq-toolkit';
import type { InvocationIdentity } from './observation.ts';
import { readExecutableVersion, resolveLaunchExecutable } from './launch-inventory.ts';
import { applyUsageObservation, parseJsonEventLines, toStructuredOutput } from './events.ts';
import { ObservedNativeDriver, createWorkerResult, usageProjection, type NativeDriverOptions } from './observed-driver.ts';
import { launchEvidenceStatus, runSupervised } from './process.ts';
import { resolveNativeSession } from './session.ts';
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
}

/** Pi native JSON/RPC transport for the configured OpenCode Go subscription route. */
export class PiNativeDriver extends ObservedNativeDriver {
  private readonly executable: string;
  private readonly mode: PiMode;
  private readonly provider: string;
  private readonly model: string;
  private readonly thinking: string;
  private readonly hardWallClockMs: number;
  private readonly killGraceMs: number;
  private readonly workspaceForInvocation: NonNullable<PiNativeOptions['workspaceForInvocation']>;
  private readonly boundaryForInvocation: PiNativeOptions['boundaryForInvocation'];
  private readonly spawnAdapter: NativeSpawnAdapter | undefined;

  constructor(options: PiNativeOptions = {}) {
    const executable = options.executable ?? 'pi';
    const mode = options.mode ?? 'json';
    const provider = options.provider ?? 'opencode-go';
    const model = options.model ?? 'opencode-go/space-bunny-free';
    const thinking = options.thinking ?? 'high';
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
    this.hardWallClockMs = options.hardWallClockMs ?? 120_000;
    this.killGraceMs = options.killGraceMs ?? 300;
    this.workspaceForInvocation = options.workspaceForInvocation ?? (() => process.cwd());
    this.boundaryForInvocation = options.boundaryForInvocation;
    this.spawnAdapter = options.spawnAdapter;
  }

  protected async runObserved(invocation: OpInvocation, identity: InvocationIdentity): Promise<WorkerResult> {
    const observation = this.newObservation(identity, invocation, new Date().toISOString());
    observation.model.configuredTarget = 'pi-opencode/opencode-go/space-bunny-free';
    observation.model.settings.launchedTarget = { value: `opencode-go/${this.model}`, source: 'PiNativeDriver configuration', status: 'configured' };
    observation.model.settings.effort = { value: this.thinking, source: 'Paseo pi-opencode profile', status: 'requested-unobservable' };
    observation.model.settings.session = { value: 'ephemeral', source: 'Pi --no-session', status: 'requested' };
    observation.model.settings.toolPolicy = { value: invocation.toolPolicy, source: 'Pi --tools/--no-tools', status: 'requested-unverified' };
    observation.model.settings.extensions = { value: [], source: 'Pi --no-extensions', status: 'disabled' };
    observation.model.settings.sandbox = { value: invocation.sandboxPolicy.level, source: 'Pi native profile', status: 'unsupported-by-pi-cli' };
    this.observations.set(identity.invocationId, observation);
    try {
      this.assertRequestedModel(invocation, this.model);
      const session = await resolveNativeSession(invocation, this.workspaceForInvocation);
      const cwd = resolve(session.cwd);
      observation.model.settings.session = {
        value: session.status === 'runner-workspace-resolved' ? 'runner workspace binding; Pi session ephemeral' : 'fresh Pi ephemeral session',
        source: 'runner SessionStore + Pi --no-session', status: session.status,
      };
      const args = [
        '--mode', this.mode,
        '--provider', this.provider,
        '--model', `${this.model}:${this.thinking}`,
        '--thinking', this.thinking,
        '--no-session',
        '--no-extensions',
        '-p', invocation.prompt,
      ];
      const toolArgs = piToolArgs(invocation);
      args.splice(args.length - 2, 0, ...toolArgs);
      this.nativeSupervisor.expectProcessTree(identity);
      const result = await runSupervised(this.executable, args, {
        cwd, timeoutMs: invocation.budget.wallClockMs ?? this.hardWallClockMs,
        killGraceMs: this.killGraceMs,
        signal: this.signalFor(identity, currentJobContext()?.signal),
        ...(this.boundaryForInvocation ? { boundary: this.boundaryForInvocation(identity, invocation, cwd) } : {}),
        ...(this.spawnAdapter ? { spawnAdapter: this.spawnAdapter } : {}),
      });
      this.reportProcessTree(identity, result.treeStopped);
      if (result.launch) observation.model.settings.launch = { value: result.launch, source: 'native spawn admission', status: launchEvidenceStatus(result.launch) };
      observation.model.settings.processTree = { value: result.treeStopped, source: 'native process-group stop proof', status: result.treeStopped ? 'stopped-and-settled' : 'stop-unproven-capture-forbidden' };
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
      if (!result.treeStopped) observation.terminal.cause = 'process-tree-stop-unproven';
      const worker = createWorkerResult(usageProjection(observation.usage.counters), result.code === 0 && result.treeStopped ? 'complete' :
        result.terminal === 'timeout' ? 'budget' : result.terminal === 'cancelled' ? 'aborted' : 'error', {
        // Do not infer or reveal the anonymous served identity from the route.
        ...(parsed.finalText ? { structuredOutput: toStructuredOutput(parsed.finalText) } : {}),
        ...(result.code !== 0 || !result.treeStopped ? { error: result.stderr.slice(-2000) || (!result.treeStopped ? 'Pi process tree stop could not be proven; capture is forbidden' : `Pi exited ${result.code ?? result.signal}`) } : {}),
        ...(session.sessionRef ? { sessionId: session.sessionRef } : {}),
      });
      this.finishObservation(observation, worker);
      if (!result.treeStopped) throw new Error('Pi process tree stop could not be proven; candidate capture is forbidden');
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
