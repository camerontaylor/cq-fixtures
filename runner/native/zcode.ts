import { resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { AcpDriver, currentJobContext, runLadder, SessionStore, type Driver, type OpInvocation, type WorkerResult } from '@camerontaylor/cq-toolkit';
import type { InvocationIdentity } from './observation.ts';
import type { NativeLaunchEvidence } from './process.ts';
import { readExecutableVersion, resolveLaunchExecutable } from './launch-inventory.ts';
import { ObservedNativeDriver, type NativeDriverOptions } from './observed-driver.ts';
import { resolveNativeSession, RUNNER_SESSION_DIRECTORY } from './session.ts';
import { launchEvidenceStatus, stopAndWait } from './process.ts';

export interface ZcodeAcpOptions {
  executable?: string;
  version?: string | null;
  profile?: string;
  sessionsDirectory?: string;
  workspaceForInvocation?: (identity: InvocationIdentity, invocation: OpInvocation) => string;
  artifactDirectory?: string;
  hardWallClockMs?: number;
  abortGraceMs?: number;
  killGraceMs?: number;
  driver?: Pick<Driver, 'run'>;
  /** Must be created from parent admission and enforce the supplied native boundary at spawn. */
  spawn?: NonNullable<ConstructorParameters<typeof AcpDriver>[0]>['spawn'];
  launchEvidence?: NativeLaunchEvidence;
}

/** Launch evidence returned through the additive S1 ObservedDriver seam. */
export interface ZcodeLaunchEvidenceRecord {
  identity: InvocationIdentity;
  status: 'spawn-observed' | 'no-spawn-observed' | 'unknown';
  source: string;
  observedAt: string;
}

/** Thrown only by a trusted adapter's exact pre-spawn executable/argv guard. */
export class AcpSpawnCommandRejected extends Error {
  constructor() {
    super('ZCode ACP command did not match the resolved executable and fixed server argument');
    this.name = 'AcpSpawnCommandRejected';
  }
}

/** ZCode's configured native ACP server, supervised by the toolkit process ladder. */
export class ZcodeAcpDriver extends ObservedNativeDriver {
  private readonly acp: Pick<Driver, 'run'>;
  private readonly sessions: SessionStore;
  private readonly workspaceForInvocation: NonNullable<ZcodeAcpOptions['workspaceForInvocation']>;
  private readonly hardWallClockMs: number;
  private readonly abortGraceMs: number;
  private readonly killGraceMs: number;
  private readonly admittedSpawnConfigured: boolean;
  private readonly launchEvidence: NativeLaunchEvidence | undefined;
  private activeChild: ChildProcess | undefined;
  private activeLaunchIdentity: InvocationIdentity | undefined;
  private readonly launchEvidenceByInvocation = new Map<string, ZcodeLaunchEvidenceRecord>();

  constructor(options: ZcodeAcpOptions = {}) {
    const executable = options.executable ?? 'zcode-acp';
    const version = options.version ?? null;
    const sessionsDirectory = options.sessionsDirectory ?? RUNNER_SESSION_DIRECTORY;
    super({
      configuredTarget: 'zcode/GLM-5.3-Flash', transport: 'zcode-acp',
      executable: resolveLaunchExecutable(executable),
      executableVersion: version ?? readExecutableVersion(resolveLaunchExecutable(executable)),
      profile: options.profile ?? 'GLM-5.3-Flash (ZCode)',
      artifactDirectory: options.artifactDirectory,
    } satisfies NativeDriverOptions);
    this.acp = options.driver ?? new AcpDriver({
      command: [executable, 'server'], termGraceMs: 300, killGraceMs: options.killGraceMs ?? 1_000,
      sessionsDir: sessionsDirectory,
      ...(options.spawn ? { spawn: (input) => {
        const spawnIdentity = this.activeLaunchIdentity;
        try {
          const child = options.spawn!(input);
          this.activeChild = child;
          let spawnObserved = false;
          child.once('spawn', () => {
            spawnObserved = true;
            this.recordLaunchEvidence('spawn-observed', 'node:child_process.ChildProcess:spawn-event-after-command-validation', spawnIdentity);
          });
          child.once('error', () => {
            if (!spawnObserved) {
              this.recordLaunchEvidence('no-spawn-observed', 'node:child_process.ChildProcess:error-before-spawn-event', spawnIdentity);
            }
          });
          return child;
        } catch (error) {
          if (error instanceof AcpSpawnCommandRejected) {
            this.recordLaunchEvidence('no-spawn-observed', 'visible-g1-glm-driver:spawn-command-guard-before-child_process.spawn', spawnIdentity);
          } else {
            this.recordLaunchEvidence('unknown', 'zcode-acp-driver:spawn-adapter-threw-before-child-return', spawnIdentity);
          }
          throw error;
        }
      } } : {}),
    });
    this.admittedSpawnConfigured = Boolean(options.driver || (options.spawn && options.launchEvidence?.admissionId.trim()));
    this.launchEvidence = options.launchEvidence;
    this.sessions = new SessionStore(sessionsDirectory);
    this.workspaceForInvocation = options.workspaceForInvocation ?? (() => process.cwd());
    this.hardWallClockMs = options.hardWallClockMs ?? 120_000;
    this.abortGraceMs = options.abortGraceMs ?? 300;
    this.killGraceMs = options.killGraceMs ?? 1_000;
  }

  /** Additive S1 evidence seam; a worker result is not launch evidence. */
  getLaunchEvidence(invocationId: string): ZcodeLaunchEvidenceRecord | undefined {
    const evidence = this.launchEvidenceByInvocation.get(invocationId);
    return evidence ? { ...evidence, identity: { ...evidence.identity } } : undefined;
  }

  protected async runObserved(invocation: OpInvocation, identity: InvocationIdentity): Promise<WorkerResult> {
    const startedAt = new Date().toISOString();
    const observation = this.newObservation(identity, invocation, startedAt);
    this.activeLaunchIdentity = { ...identity };
    this.launchEvidenceByInvocation.set(identity.invocationId, {
      identity: { ...identity }, status: 'unknown',
      source: 'zcode-acp-driver:no-authoritative-child-process-event-yet', observedAt: startedAt,
    });
    observation.model.configuredTarget = 'zcode/GLM-5.3-Flash';
    observation.model.settings.launchedTarget = { value: 'zcode/GLM-5.3-Flash', source: 'ZcodeAcpDriver configuration', status: 'configured' };
    observation.model.settings.effort = { value: 'high', source: 'Paseo ZCode GLM-5.3-Flash profile', status: 'requested-unobservable' };
    observation.model.settings.permissionMode = { value: 'yolo', source: 'Paseo ZCode profile', status: 'requested-unobservable' };
    this.observations.set(identity.invocationId, observation);
    try {
      this.assertRequestedModel(invocation, 'GLM-5.3-Flash');
      if (!this.admittedSpawnConfigured) {
        throw new Error('ZCode ACP requires a parent-admitted boundary spawn adapter');
      }
      if (this.launchEvidence) {
        observation.model.settings.launchAdmission = { value: this.launchEvidence, source: 'parent-admitted ACP spawn', status: launchEvidenceStatus(this.launchEvidence) };
      }
      assertOutsideGlmBlackout();
      const session = await resolveNativeSession(
        invocation,
        (candidate) => this.workspaceForInvocation(identity, candidate),
        this.sessions,
      );
      const workspace = resolve(session.cwd);
      const sessionRef = session.sessionRef ?? (await this.sessions.create(workspace)).sessionId;
      observation.model.settings.session = {
        value: session.status === 'runner-workspace-resolved' ? 'runner workspace binding; ACP session resume policy applies' : 'fresh ACP session',
        source: 'runner SessionStore + ACP session protocol', status: session.status,
      };
      const boundedInvocation: OpInvocation = {
        ...invocation,
        sessionRef,
        budget: { ...invocation.budget, wallClockMs: invocation.budget.wallClockMs ?? this.hardWallClockMs },
      };
      this.nativeSupervisor.expectProcessTree(identity);
      let ladder;
      try {
        ladder = await runLadder(
          () => this.acp.run(boundedInvocation),
          {
            wallClockMs: boundedInvocation.budget.wallClockMs,
            abortGraceMs: this.abortGraceMs,
            killGraceMs: this.killGraceMs,
          },
          { op: 'zcode-acp', jobKey: identity.assignmentId, attempt: 1 },
          { signal: this.signalFor(identity, currentJobContext()?.signal) },
        );
      } finally {
        const child = this.activeChild;
        this.activeChild = undefined;
        if (child) {
          observation.model.settings.launch = {
            value: this.launchEvidence ?? null,
            source: 'native ACP ChildProcess returned by the validated spawn adapter',
            status: 'spawn-returned',
          };
          const stopped = await stopAndWait(child, this.killGraceMs);
          this.reportProcessTree(identity, stopped);
          observation.model.settings.processTree = {
            value: stopped, source: 'native ACP process-group stop proof',
            status: stopped ? 'stopped-and-settled' : 'stop-unproven-capture-forbidden',
          };
          if (!stopped) throw new Error('ZCode ACP process tree stop could not be proven; candidate capture is forbidden');
        } else {
          this.reportProcessTree(identity, false);
          observation.model.settings.processTree = {
            value: null, source: 'native ACP process-group stop proof', status: 'no-child-process-receipt',
          };
        }
      }
      if (ladder.outcome === 'threw') throw ladder.error;
      if (ladder.outcome === 'killed') {
        observation.terminal.cause = 'hard-timeout-killed';
        observation.terminal.cancelled = true;
        observation.timing.stages.killLadderMs = ladder.elapsedMs;
        throw new Error(`ZCode ACP exceeded hard wall bound (${ladder.elapsedMs}ms)`);
      }
      const worker: WorkerResult = ladder.value;
      observation.timing.stages.transportMs = ladder.elapsedMs;
      observation.model.observed = worker.model
        ? { value: worker.model, source: 'ACP config_option_update', status: 'observed' }
        : { value: null, source: null, status: 'not-reported' };
      // The selected ACP package returns compatibility zeros when the server
      // omits usage. Without a per-counter presence bit those values are not
      // measurements, so this bridge leaves all campaign counters unknown.
      observation.terminal.cause = worker.stopReason === 'complete' ? null : worker.stopReason;
      observation.terminal.cancelled = worker.stopReason === 'aborted';
      const result = { ...worker, sessionId: sessionRef };
      this.finishObservation(observation, result);
      return result;
    } catch (error) {
      if (!observation.timing.endedAt) this.failObservation(observation, error);
      throw error;
    } finally {
      this.activeLaunchIdentity = undefined;
      const evidence = this.launchEvidenceByInvocation.get(identity.invocationId);
      if (evidence?.status === 'unknown') {
        evidence.source = 'zcode-acp-driver:invocation-settled-without-authoritative-child-process-event';
        evidence.observedAt = new Date().toISOString();
      }
    }
  }

  private recordLaunchEvidence(status: ZcodeLaunchEvidenceRecord['status'], source: string, boundIdentity = this.activeLaunchIdentity): void {
    const identity = boundIdentity;
    if (!identity) return;
    this.launchEvidenceByInvocation.set(identity.invocationId, {
      identity: { ...identity }, status, source, observedAt: new Date().toISOString(),
    });
  }
}

/** ZCode's configured Coding Plan is unavailable on weekdays 14:00–18:00 Singapore time. */
export function assertOutsideGlmBlackout(now = new Date()): void {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Asia/Singapore', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const field = (name: string) => parts.find((part) => part.type === name)?.value ?? '';
  const weekday = field('weekday');
  const hour = Number(field('hour'));
  if (['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday) && hour >= 14 && hour < 18) {
    throw new Error('ZCode/GLM transport is closed during the weekday 14:00–18:00 Asia/Singapore blackout');
  }
}
