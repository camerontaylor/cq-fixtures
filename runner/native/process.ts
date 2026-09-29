import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { spawnBoundary } from '../boundary/spawn.ts';
import type { BoundaryLaunch } from '../boundary/spawn.ts';
import { snapshotTask } from '../boundary/task-tree.ts';

export type ProcessTerminal = 'exit' | 'timeout' | 'cancelled' | 'spawn-error';

export interface SupervisedProcessResult {
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  terminal: ProcessTerminal;
  treeStopped: boolean;
  startedAt: string;
  endedAt: string;
  launch?: NativeLaunchEvidence;
  lifecycle?: {
    terminated: boolean; finalized: boolean;
    invocationCleanup?: { status: 'completed' | 'failed' | 'unconfigured'; proof?: NativeInvocationCleanupProof; errorName?: string };
    error?: { name: string; message: string };
  };
  error?: { name: string; message: string };
}

export interface NativeLaunchEvidence {
  boundaryIdentity: string;
  launchIdentity: string;
  /** S5 final profile identity (boundary + exact args/bootstrap/runtime budget). */
  profileInvocationIdentity?: string;
  admissionId: string;
  environmentNames: string[];
  scope: 'visible-calibration' | 'boundary';
  isolation: 'disabled' | 'unverified';
  heldOut: false;
  taskExport?: NativeTaskExport;
}

export type NativeInvocationStage = 'visible-calibration-G1' | 'final-profile-G1' | 'actual-route-G2';
export interface NativeSpawnContext {
  cwd: string;
  identity: SupervisedInvocationIdentity;
  stage: NativeInvocationStage;
  /** Absolute wall deadline for admission, provisioning, transport and teardown. */
  deadlineEpochMs: number;
  /** Aborted at the assignment deadline; adapters should stop provisioning promptly. */
  signal: AbortSignal;
}
export interface NativeTaskPublicationEvidence {
  destination: string;
  baselineCommit: string;
  baselineTree: string;
  hostUnchanged: true;
  afterTeardown: true;
  captureEligible: true;
}
export interface NativeTaskExport { inventoryHash: string; head: string; publication?: NativeTaskPublicationEvidence }

export interface NativeSpawnReceipt {
  child: ChildProcess;
  boundaryIdentity: string;
  launchIdentity: string;
  admissionId: string;
  profileInvocationIdentity?: string;
  environmentNames: string[];
  scope: 'visible-calibration' | 'boundary';
  isolation: 'disabled' | 'unverified';
  heldOut: false;
  terminate?: () => Promise<void>;
  finalize?: () => Promise<NativeTaskExport>;
}
export type NativeSpawnAdapter = (command: string, args: readonly string[], context: NativeSpawnContext) => Promise<NativeSpawnReceipt>;
export type NativeSpawnAdapterFactory = (context: NativeSpawnContext) => Promise<NativeSpawnAdapter>;

/** Invocation-owned runtime cleanup, called after setup failure or after the
 * adapter's terminate/finalize sequence. Recovery is retained by default. */
export interface NativeInvocationCleanupRequest {
  identity: SupervisedInvocationIdentity;
  reason: string;
  deadlineEpochMs: number;
  signal: AbortSignal;
  preserveRecovery: true;
}
export interface NativeInvocationCleanupProof {
  status: 'stopped-and-reaped' | 'quarantined';
  resourceIds: string[] | null;
  volumeDisposition: 'disposed' | 'quarantined';
}
export type NativeInvocationCleanup = (request: NativeInvocationCleanupRequest) => Promise<NativeInvocationCleanupProof>;

export interface SupervisedInvocationIdentity {
  invocationId: string;
  assignmentId: string;
  stageId: string;
  attemptId: string;
}

export interface NativeStopProof {
  invocationId: string;
  stageId: string;
  attemptId: string;
  processTree: 'stopped-and-reaped';
  invocation: 'settled';
}

interface SupervisedInvocation {
  identity: SupervisedInvocationIdentity;
  controller: AbortController;
  settled: Promise<void>;
  settle: () => void;
  invocationSettled: boolean;
  processTreeStopped: boolean | undefined;
}

/** Tracks native invocation cancellation through process-tree reap and Driver settlement. */
export class NativeSupervisorControl {
  private readonly invocations = new Map<string, SupervisedInvocation>();

  beginInvocation(identity: SupervisedInvocationIdentity): void {
    if (this.invocations.has(identity.invocationId)) throw new Error(`native invocation '${identity.invocationId}' is already active`);
    let settle!: () => void;
    this.invocations.set(identity.invocationId, {
      identity: { ...identity }, controller: new AbortController(),
      settled: new Promise<void>((resolve) => { settle = resolve; }), settle: () => settle(),
      invocationSettled: false, processTreeStopped: true,
    });
    // Keep a bounded history so late stop requests can still prove a settled
    // invocation without retaining an unbounded campaign's control objects.
    while (this.invocations.size > 256) {
      const oldest = this.invocations.entries().next().value as [string, SupervisedInvocation] | undefined;
      if (!oldest || !oldest[1].invocationSettled) break;
      this.invocations.delete(oldest[0]);
    }
  }

  signal(identity: SupervisedInvocationIdentity, parent?: AbortSignal): AbortSignal {
    const state = this.require(identity);
    return parent ? AbortSignal.any([parent, state.controller.signal]) : state.controller.signal;
  }

  expectProcessTree(identity: SupervisedInvocationIdentity): void {
    this.require(identity).processTreeStopped = false;
  }

  reportProcessTree(identity: SupervisedInvocationIdentity, stopped: boolean): void {
    this.require(identity).processTreeStopped = stopped;
  }

  settleInvocation(identity: SupervisedInvocationIdentity): void {
    const state = this.require(identity);
    state.invocationSettled = true;
    state.settle();
  }

  async cancelInvocationAndWait(input: {
    identity: SupervisedInvocationIdentity;
    cause: unknown;
    deadlineEpochMs: number;
  }): Promise<NativeStopProof> {
    const state = this.require(input.identity);
    if (!Number.isFinite(input.deadlineEpochMs)) throw new RangeError('native stop proof requires a finite epoch deadline');
    state.controller.abort(input.cause);
    const remaining = Math.max(0, input.deadlineEpochMs - Date.now());
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        state.settled,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('native invocation settlement deadline elapsed')), remaining); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!sameSupervisorIdentity(state.identity, input.identity)) throw new Error('native stop proof identity mismatch');
    if (!state.invocationSettled || state.processTreeStopped !== true) {
      throw new Error('native supervisor cannot prove the invocation settled and its process tree was reaped');
    }
    return {
      invocationId: state.identity.invocationId, stageId: state.identity.stageId, attemptId: state.identity.attemptId,
      processTree: 'stopped-and-reaped', invocation: 'settled',
    };
  }

  private require(identity: SupervisedInvocationIdentity): SupervisedInvocation {
    const state = this.invocations.get(identity.invocationId);
    if (!state || !sameSupervisorIdentity(state.identity, identity)) throw new Error('native supervisor has no matching invocation');
    return state;
  }
}

function sameSupervisorIdentity(left: SupervisedInvocationIdentity, right: SupervisedInvocationIdentity): boolean {
  return left.invocationId === right.invocationId && left.assignmentId === right.assignmentId
    && left.stageId === right.stageId && left.attemptId === right.attemptId;
}

export interface VisibleCalibrationAdmission {
  admissionId: string;
  scope: 'visible-calibration';
  isolation: 'disabled';
  heldOut: false;
  environmentNames: string[];
}

export function launchEvidenceStatus(evidence: NativeLaunchEvidence): string {
  return evidence.isolation === 'disabled' ? 'visible-only-unconfined' : 'visible-boundary-isolation-unverified';
}

/** Explicit, auditable direct launch for visible calibration only; never held-out eligible. */
export function visibleCalibrationSpawnAdapter(
  admission: VisibleCalibrationAdmission,
  options: { environmentValues?: Record<string, string> } = {},
): NativeSpawnAdapter {
  if (!admission.admissionId.trim() || admission.scope !== 'visible-calibration' ||
      admission.isolation !== 'disabled' || admission.heldOut !== false) {
    throw new Error('visible calibration launch requires a non-empty parent admission and heldOut=false');
  }
  if (admission.environmentNames.some((name) => /(?:proxy|base.?url|endpoint)/iu.test(name))) {
    throw new Error('visible calibration cannot override provider or proxy endpoints');
  }
  const environmentNames = [...new Set(admission.environmentNames)].sort();
  for (const name of Object.keys(options.environmentValues ?? {})) {
    if (!environmentNames.includes(name)) throw new Error(`native credential environment key '${name}' is not allowlisted`);
  }
  return async (command, args, { cwd }) => {
    const env: NodeJS.ProcessEnv = Object.fromEntries(environmentNames.flatMap((name) => {
      const value = options.environmentValues?.[name] ?? process.env[name];
      return value === undefined ? [] : [[name, value]];
    }));
    const child = spawn(command, [...args], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', windowsHide: true,
    });
    const launchIdentity = createHash('sha256').update(JSON.stringify({ command, args, cwd, admissionId: admission.admissionId })).digest('hex');
    return {
      child, boundaryIdentity: 'visible-only-unconfined', launchIdentity,
      admissionId: admission.admissionId, environmentNames: environmentNames.filter((name) => env[name] !== undefined),
      scope: 'visible-calibration', isolation: 'disabled', heldOut: false,
    };
  };
}

export interface SupervisedProcessOptions {
  cwd: string;
  identity?: SupervisedInvocationIdentity;
  stage?: NativeInvocationStage;
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  /** Includes adapter admission/provisioning and teardown, not only child runtime. */
  hardDeadlineEpochMs?: number;
  timeoutMs: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void;
  boundary?: Omit<BoundaryLaunch, 'executable' | 'args'>;
  spawnAdapter?: NativeSpawnAdapter;
  /** Creates invocation-specific staging/admission inside the same hard deadline. */
  spawnAdapterFactory?: NativeSpawnAdapterFactory;
  /** S5 owned-resource cleanup; required for boundary receipts. */
  cleanupInvocation?: NativeInvocationCleanup;
  /** Bounded cleanup window after the decision deadline; not a hard resource-lifetime guarantee. */
  cleanupTimeoutMs?: number;
  /** Exact S5 baseline captured for this invocation before transport starts. */
  expectedTaskBaselineCommit?: string;
  /** Explicitly for fake executables in tests; production launches fail closed without a boundary adapter. */
  allowUnconfinedTestProcess?: boolean;
}

const DEFAULT_KILL_GRACE_MS = 300;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Run one native CLI with a decision cutoff and bounded awaited cleanup window.
 * Uncooperative adapter/runtime calls can outlive that window; those paths fail
 * closed and return no capture proof, but this is not a global lifetime bound. */
export async function runSupervised(
  command: string,
  args: readonly string[],
  options: SupervisedProcessOptions,
): Promise<SupervisedProcessResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number');
  }
  const startedAt = new Date().toISOString();
  const hardDeadlineEpochMs = options.hardDeadlineEpochMs ?? Date.now() + options.timeoutMs;
  if (!Number.isFinite(hardDeadlineEpochMs)) throw new RangeError('hardDeadlineEpochMs must be finite');
  const setupController = new AbortController();
  const setupSignal = setupController.signal;
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let terminal: ProcessTerminal = 'exit';
  let spawnError: Error | undefined;
  let child: ChildProcess;
  let launch: SupervisedProcessResult['launch'];
  let boundaryLifecycle: Pick<NativeSpawnReceipt, 'terminate' | 'finalize'> | undefined;
  let lifecycleResult: SupervisedProcessResult['lifecycle'];
  let lifecycleResultFrozen = false;
  let treeStopped = false;
  let handoffComplete = false;

  if ((options.stage === 'final-profile-G1' || options.stage === 'actual-route-G2') &&
      (options.spawnAdapter || options.spawnAdapterFactory || options.boundary) && !options.cleanupInvocation) {
    return spawnFailure(command, args, options.cwd, startedAt,
      new Error('final-profile native boundary requires an invocation cleanup callback before dispatch'), 'spawn-error', false,
      { terminated: false, finalized: false, invocationCleanup: { status: 'unconfigured' },
        error: { name: 'CleanupUnconfigured', message: 'boundary dispatch refused without invocation cleanup ownership' } });
  }

  let launchTimeoutReject!: (error: Error) => void;
  const launchDeadline = new Promise<never>((_, reject) => { launchTimeoutReject = reject; });
  const onSetupAbort = () => {
    if (handoffComplete) return;
    const error = new Error('native assignment was cancelled during admission or provisioning');
    setupController.abort(error);
    launchTimeoutReject(error);
  };
  if (options.signal?.aborted) onSetupAbort();
  options.signal?.addEventListener('abort', onSetupAbort, { once: true });
  const remainingAtStart = hardDeadlineEpochMs - Date.now();
  if (remainingAtStart <= 0) {
    options.signal?.removeEventListener('abort', onSetupAbort);
    setupController.abort(new Error('native assignment deadline elapsed before launch'));
    return spawnFailure(command, args, options.cwd, startedAt, new Error('native assignment deadline elapsed before launch'), 'timeout');
  }
  let launchDeadlineExceeded = false;
  const launchTimeout = setTimeout(() => {
    launchDeadlineExceeded = true;
    setupController.abort(new Error('native assignment deadline elapsed during admission or provisioning'));
    launchTimeoutReject(new Error('native assignment deadline elapsed during admission or provisioning'));
  }, remainingAtStart);
  let launchPromise: Promise<{ child: ChildProcess; receipt?: NativeSpawnReceipt; launch?: NativeLaunchEvidence }> | undefined;
  try {
    launchPromise = (async () => {
    if (setupSignal.aborted || Date.now() >= hardDeadlineEpochMs) {
      throw new Error('native assignment ended before boundary setup began');
    }
    if (options.boundary) {
      if (options.boundary.purpose !== 'actual-route' || options.boundary.heldOut !== false) {
        throw new Error('native transport requires an explicitly admitted visible actual-route boundary');
      }
      if (resolve(options.boundary.policy.resolved.task) !== resolve(options.cwd)) {
        throw new Error('boundary task directory must match the invocation workspace');
      }
      const receipt = await spawnBoundary({ ...options.boundary, executable: command, args: [...args] });
      const launchEvidence: NativeLaunchEvidence = {
        boundaryIdentity: receipt.boundaryIdentity, launchIdentity: receipt.launchIdentity,
        admissionId: receipt.admissionId ?? '', environmentNames: receipt.environmentNames,
        scope: 'boundary', isolation: 'unverified', heldOut: false,
      };
      return { child: receipt.child, launch: launchEvidence };
    } else if (options.spawnAdapter || options.spawnAdapterFactory) {
      if (!options.identity) throw new Error('admitted native spawn requires invocation identity');
      const context: NativeSpawnContext = {
        cwd: options.cwd, identity: options.identity, stage: options.stage ?? 'visible-calibration-G1',
        deadlineEpochMs: hardDeadlineEpochMs, signal: setupSignal,
      };
      if (setupSignal.aborted || Date.now() >= hardDeadlineEpochMs) throw new Error('native assignment ended before adapter factory began');
      const adapter = options.spawnAdapter ?? await options.spawnAdapterFactory!(context);
      if (Date.now() >= hardDeadlineEpochMs || setupSignal.aborted) throw new Error('native assignment deadline elapsed before adapter launch');
      const receipt = await adapter(command, args, context);
      if (!receipt.admissionId.trim() || receipt.heldOut !== false ||
          (receipt.scope === 'visible-calibration' && receipt.isolation !== 'disabled') ||
          (receipt.scope === 'boundary' && (receipt.isolation !== 'unverified' || !receipt.terminate || !receipt.finalize))) {
        throw new Error('native spawn receipt does not match an admitted visible or final-profile boundary lifecycle');
      }
      const launchEvidence: NativeLaunchEvidence = {
        boundaryIdentity: receipt.boundaryIdentity, launchIdentity: receipt.launchIdentity,
        ...(receipt.profileInvocationIdentity ? { profileInvocationIdentity: receipt.profileInvocationIdentity } : {}),
        admissionId: receipt.admissionId, environmentNames: receipt.environmentNames,
        scope: receipt.scope, isolation: receipt.isolation, heldOut: receipt.heldOut,
      };
      return { child: receipt.child, receipt, launch: launchEvidence };
    } else if (options.allowUnconfinedTestProcess) {
      return { child: spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      }) };
    } else {
      throw new Error('native route launch requires boundary isolation and orchestrator admission');
    }
    throw new Error('native launch adapter returned no child');
    })();
    const launched = await Promise.race([launchPromise, launchDeadline]);
    child = launched.child;
    launch = launched.launch;
    if (launched.receipt?.scope === 'boundary') boundaryLifecycle = { terminate: launched.receipt.terminate, finalize: launched.receipt.finalize };
    handoffComplete = true;
    options.signal?.removeEventListener('abort', onSetupAbort);
  } catch (error) {
    clearTimeout(launchTimeout);
    const deadlineExpired = launchDeadlineExceeded || Date.now() >= hardDeadlineEpochMs;
    const launchCancelled = options.signal?.aborted === true;
    setupController.abort(error);
    const cleanupMs = options.cleanupTimeoutMs ?? 30_000;
    const cleanupDeadline = Date.now() + cleanupMs;
    const setupSettleDeadline = Math.min(cleanupDeadline, Date.now() + Math.min(250, Math.max(1, Math.floor(cleanupMs / 3))));
    let late: { child: ChildProcess; receipt?: NativeSpawnReceipt; launch?: NativeLaunchEvidence } | false = false;
    let launchPromiseSettled = !launchPromise;
    if (launchPromise) {
      try { late = await withinDeadline(launchPromise, setupSettleDeadline); launchPromiseSettled = late !== false; }
      catch { launchPromiseSettled = true; /* factory rejection settles setup; the owned cleanup hook still runs */ }
    }
    let cleanupCompleted = false;
    let cleanupErrorName: string | undefined;
    let cleanupProof: NativeInvocationCleanupProof | undefined;
    let lateTerminated = false;
    let lateFinalized = false;
    let lateLifecycleProven = false;
    if (late !== false) {
      const lateReceipt = late.receipt?.scope === 'boundary' ? late.receipt : undefined;
      const cleanupLater = async () => {
        if (!options.cleanupInvocation || !options.identity) return;
        await invokeBoundedCleanup(options.cleanupInvocation, options.identity, 'late native setup settled after bounded cleanup', Date.now() + cleanupMs);
      };
      const finalizeThenCleanupLater = async () => {
        if (lateReceipt) {
          try { await lateReceipt.finalize!(); } catch { /* failed stop proof remains fail-closed */ }
        }
        await cleanupLater();
      };
      const terminateThenCleanupLater = async () => {
        if (lateReceipt) {
          try { await lateReceipt.terminate!(); } catch { /* continue to finalization after termination settles */ }
        }
        await finalizeThenCleanupLater();
      };
      const stoppedWork = stopAndWait(late.child, Math.min(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
        Math.max(50, cleanupDeadline - Date.now())));
      const stoppedOutcome = await settleWithinDeadline(stoppedWork, cleanupDeadline);
      const hostStopped = stoppedOutcome.status === 'fulfilled' && stoppedOutcome.value;
      let lifecycleBlockedByPendingHook = false;
      if (stoppedOutcome.status === 'timed-out') {
        cleanupErrorName = 'DeadlineExceeded';
        lifecycleBlockedByPendingHook = true;
        // Once process-group stopping settles, continue the required ordered
        // hooks and cleanup. This continuation can never authorize capture.
        void stoppedWork.then(terminateThenCleanupLater, terminateThenCleanupLater).catch(() => undefined);
      } else if (stoppedOutcome.status === 'rejected') {
        cleanupErrorName = stoppedOutcome.error instanceof Error ? stoppedOutcome.error.name : 'Error';
      }
      lateTerminated = !late.receipt || late.receipt.scope !== 'boundary';
      lateFinalized = !late.receipt || late.receipt.scope !== 'boundary';
      if (!lifecycleBlockedByPendingHook && lateReceipt) {
        const terminateWork = Promise.resolve().then(() => lateReceipt.terminate!());
        const terminateOutcome = await settleWithinDeadline(terminateWork, cleanupDeadline);
        if (terminateOutcome.status === 'fulfilled') lateTerminated = true;
        else if (terminateOutcome.status === 'rejected') cleanupErrorName ??= terminateOutcome.error instanceof Error ? terminateOutcome.error.name : 'Error';
        else {
          cleanupErrorName ??= 'DeadlineExceeded';
          lifecycleBlockedByPendingHook = true;
          void terminateWork.then(finalizeThenCleanupLater, finalizeThenCleanupLater).catch(() => undefined);
        }
      }
      if (!lifecycleBlockedByPendingHook && lateReceipt) {
        const finalizeWork = Promise.resolve().then(() => lateReceipt.finalize!());
        const finalizeOutcome = await settleWithinDeadline(finalizeWork, cleanupDeadline);
        if (finalizeOutcome.status === 'fulfilled') lateFinalized = true;
        else if (finalizeOutcome.status === 'rejected') cleanupErrorName ??= finalizeOutcome.error instanceof Error ? finalizeOutcome.error.name : 'Error';
        else {
          cleanupErrorName ??= 'DeadlineExceeded';
          lifecycleBlockedByPendingHook = true;
          void finalizeWork.then(cleanupLater, cleanupLater).catch(() => undefined);
        }
      }
      if (!lifecycleBlockedByPendingHook && options.cleanupInvocation) {
        const outcome = options.identity ? await invokeBoundedCleanup(options.cleanupInvocation, options.identity, 'native setup ended before receipt handoff', cleanupDeadline) : { status: 'failed' as const, errorName: 'InvocationIdentityUnavailable' };
        cleanupCompleted = outcome.status === 'completed'; cleanupProof = outcome.proof; cleanupErrorName ??= outcome.errorName;
      }
      // Cleanup evidence is explicit in the returned failed envelope. A late
      // receipt never becomes capture eligible, even when all stop hooks pass.
      lateLifecycleProven = hostStopped && lateTerminated && lateFinalized && !lifecycleBlockedByPendingHook;
    } else if (options.cleanupInvocation && options.identity) {
      const outcome = await invokeBoundedCleanup(options.cleanupInvocation, options.identity, 'native setup did not settle before receipt handoff', cleanupDeadline);
      cleanupCompleted = outcome.status === 'completed'; cleanupProof = outcome.proof; cleanupErrorName = outcome.errorName;
      // A factory that settles after this bounded cleanup window gets one more
      // exact-receipt teardown attempt. This continuation cannot authorize capture.
      void launchPromise?.then(async (lateReceipt) => {
        await stopAndWait(lateReceipt.child, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
        try { await lateReceipt.receipt?.terminate?.(); } catch { /* cleanup proof remains failed */ }
        try { await lateReceipt.receipt?.finalize?.(); } catch { /* recovery is retained */ }
        try { await options.cleanupInvocation!({ identity: options.identity!, reason: 'late native setup settled after bounded cleanup',
          deadlineEpochMs: Date.now() + cleanupMs, signal: new AbortController().signal, preserveRecovery: true }); }
        catch { /* late cleanup has no capture/report path */ }
      }).catch(() => undefined);
    } else {
      void launchPromise?.catch(() => undefined);
    }
    const cleanupStatus: NonNullable<SupervisedProcessResult['lifecycle']>['invocationCleanup'] = options.cleanupInvocation
      ? { status: cleanupCompleted ? 'completed' : 'failed', ...(cleanupProof ? { proof: cleanupProof } : {}), ...(cleanupErrorName ? { errorName: cleanupErrorName } : {}) }
      : { status: 'unconfigured' };
    const failedLifecycle: SupervisedProcessResult['lifecycle'] = {
      terminated: lateTerminated, finalized: lateFinalized, invocationCleanup: cleanupStatus,
      ...((cleanupErrorName || (options.cleanupInvocation && !cleanupCompleted)) ? {
        error: { name: cleanupErrorName ?? 'CleanupUnproven', message: 'native setup failed before receipt handoff; invocation cleanup did not prove stop' },
      } : {}),
    };
    const setupStopped = launchPromiseSettled && cleanupCompleted && !cleanupErrorName && (late === false || lateLifecycleProven);
    return spawnFailure(command, args, options.cwd, startedAt, error,
      deadlineExpired ? 'timeout' : launchCancelled ? 'cancelled' : 'spawn-error',
      setupStopped, failedLifecycle, late !== false ? late.launch : undefined);
  } finally {
    clearTimeout(launchTimeout);
    options.signal?.removeEventListener('abort', onSetupAbort);
  }

  const collect = (target: string[], current: number, chunk: Buffer, stream: 'stdout' | 'stderr') => {
    const remaining = Math.max(0, maxBytes - current);
    if (remaining > 0) target.push(chunk.subarray(0, remaining).toString('utf8'));
    if (stream === 'stdout') {
      stdoutBytes = current + chunk.length;
      options.onStdout?.(chunk.toString('utf8'));
    } else stderrBytes = current + chunk.length;
  };
  child.stdout?.on('data', (chunk: Buffer) => collect(stdoutParts, stdoutBytes, chunk, 'stdout'));
  child.stderr?.on('data', (chunk: Buffer) => collect(stderrParts, stderrBytes, chunk, 'stderr'));
  if (options.input !== undefined) child.stdin?.end(options.input);
  else child.stdin?.end();

  let timedOut = false;
  let cancelled = options.signal?.aborted ?? false;
  const snapshot = (code: number | null, signal: NodeJS.Signals | null, stopped = treeStopped): SupervisedProcessResult => ({
    command, args: [...args], cwd: options.cwd,
    stdout: stdoutParts.join(''), stderr: stderrParts.join(''), code, signal,
    treeStopped: stopped,
    terminal: spawnError ? 'spawn-error' : cancelled ? 'cancelled' : timedOut ? 'timeout' : terminal,
    startedAt, endedAt: new Date().toISOString(),
    ...(launch ? { launch } : {}),
    ...(lifecycleResult ? { lifecycle: lifecycleResult } : {}),
    ...(spawnError ? { error: { name: spawnError.name, message: spawnError.message } } : {}),
  });
  let stopCompletion: Promise<boolean> | undefined;
  const stopAndFinalize = (): Promise<boolean> => stopCompletion ??= (async () => {
    const lifecycleDeadlineEpochMs = hardDeadlineEpochMs + (options.cleanupTimeoutMs ?? 30_000);
    const hostTreeStopped = await stopAndWait(child, Math.min(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
      Math.max(50, lifecycleDeadlineEpochMs - Date.now())));
    if (!boundaryLifecycle) {
      treeStopped = hostTreeStopped;
      return treeStopped;
    }
    let terminated = false;
    let finalized = false;
    let taskExport: NativeTaskExport | undefined;
    let lifecycleError: Error | undefined;
    let cleanupEvidence: NonNullable<SupervisedProcessResult['lifecycle']>['invocationCleanup'];
    try {
      await boundaryLifecycle.terminate!();
      terminated = true;
    } catch (error) {
      lifecycleError = error instanceof Error ? error : new Error(String(error));
    }
    try {
      // Always await finalization after termination has settled. The trusted
      // adapter itself refuses export unless container stop was proven.
      taskExport = await boundaryLifecycle.finalize!();
      if (!/^[a-f0-9]{64}$/iu.test(taskExport.inventoryHash) || !/^[a-f0-9]{40,64}$/iu.test(taskExport.head)) {
        throw new Error('native boundary task export returned an invalid inventory hash or HEAD');
      }
      if (options.stage === 'final-profile-G1') {
        const publication = taskExport.publication;
        if (!publication || resolve(publication.destination) !== resolve(options.cwd) ||
            !/^[a-f0-9]{40}$/iu.test(publication.baselineCommit) || !/^[a-f0-9]{40,64}$/iu.test(publication.baselineTree) ||
            publication.hostUnchanged !== true || publication.afterTeardown !== true || publication.captureEligible !== true) {
          throw new Error('final-profile G1 export lacks validated post-teardown publication into the exact runSuite workspace');
        }
        if (!options.expectedTaskBaselineCommit || publication.baselineCommit !== options.expectedTaskBaselineCommit) {
          throw new Error('final-profile G1 publication baseline differs from the exact staged runSuite baseline');
        }
        const published = snapshotTask(options.cwd, false);
        if (published.inventoryHash !== taskExport.inventoryHash) {
          throw new Error('final-profile G1 published workspace differs from the stopped export inventory');
        }
      }
      finalized = true;
    } catch (error) {
      if (!lifecycleError) lifecycleError = error instanceof Error ? error : new Error(String(error));
    }
    if (options.cleanupInvocation && options.identity) {
      const cleanupOutcome = await invokeBoundedCleanup(options.cleanupInvocation, options.identity,
        'native boundary lifecycle settled', lifecycleDeadlineEpochMs);
      cleanupEvidence = { status: cleanupOutcome.status, ...(cleanupOutcome.proof ? { proof: cleanupOutcome.proof } : {}),
        ...(cleanupOutcome.errorName ? { errorName: cleanupOutcome.errorName } : {}) };
      if (cleanupOutcome.status !== 'completed' && !lifecycleError) lifecycleError = new Error('native invocation cleanup did not prove stopped-and-reaped resources');
    } else {
      cleanupEvidence = { status: 'unconfigured' };
      if (!lifecycleError) lifecycleError = new Error('boundary receipt has no invocation cleanup callback');
    }
    if (terminated && hostTreeStopped && finalized && cleanupEvidence?.status === 'completed' && taskExport && launch) {
      launch.taskExport = { ...taskExport };
    }
    if (!lifecycleResultFrozen) lifecycleResult = {
      terminated, finalized, invocationCleanup: cleanupEvidence,
      ...(lifecycleError ? { error: { name: lifecycleError.name, message: lifecycleError.message } } : {}),
    };
    treeStopped = hostTreeStopped && terminated && finalized && cleanupEvidence?.status === 'completed';
    return treeStopped;
  })();
  let fallbackTimer: NodeJS.Timeout | undefined;
  const result = new Promise<SupervisedProcessResult>((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      terminal = 'spawn-error';
    });
    child.once('close', (code, signal) => {
      // A leader can exit while a detached descendant remains in its process
      // group. Prove the complete group is gone before resolving so callers
      // cannot capture a workspace while a late descendant can still edit it.
      const lifecycleDeadline = hardDeadlineEpochMs + (options.cleanupTimeoutMs ?? 30_000);
      void withinDeadline(stopAndFinalize(), lifecycleDeadline).then((stopped) => {
        treeStopped = stopped;
        if (stopped === false && !lifecycleResult) {
          lifecycleResultFrozen = true;
          lifecycleResult = { terminated: false, finalized: false, invocationCleanup: { status: 'failed', errorName: 'DeadlineExceeded' },
            error: { name: 'DeadlineExceeded', message: 'native boundary lifecycle exceeded its bounded cleanup window' } };
        }
        resolve(snapshot(code, signal, stopped));
      });
    });
  });

  const forceTimers: NodeJS.Timeout[] = [];
  const scheduleForceKill = () => {
    forceTimers.push(setTimeout(() => killTree(child, 'SIGKILL'), options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
  };
  const onAbort = () => { cancelled = true; terminateTree(child); scheduleForceKill(); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const remainingTransportMs = Math.max(1, Math.min(options.timeoutMs, hardDeadlineEpochMs - Date.now()));
  const timer = setTimeout(() => { timedOut = true; terminateTree(child); scheduleForceKill(); }, remainingTransportMs);
  if (cancelled) onAbort();

  // The hard fallback bounds even a child that closes its leader early but
  // leaves a descendant holding an inherited pipe open.
  const forceResolveMs = Math.max(1, hardDeadlineEpochMs + (options.cleanupTimeoutMs ?? 30_000) - Date.now());
  const forced = new Promise<SupervisedProcessResult>((resolve) => {
    fallbackTimer = setTimeout(() => {
      timedOut = true;
      terminateTree(child);
      const lifecycleDeadline = hardDeadlineEpochMs + (options.cleanupTimeoutMs ?? 30_000);
      void withinDeadline(stopAndFinalize(), lifecycleDeadline).then((stopped) => {
        treeStopped = stopped;
        if (stopped === false && !lifecycleResult) {
          lifecycleResultFrozen = true;
          lifecycleResult = { terminated: false, finalized: false, invocationCleanup: { status: 'failed', errorName: 'DeadlineExceeded' },
            error: { name: 'DeadlineExceeded', message: 'native boundary lifecycle exceeded its bounded cleanup window' } };
        }
        resolve(snapshot(null, 'SIGKILL', stopped));
      });
    }, forceResolveMs);
  });
  try {
    return await Promise.race([result, forced]);
  } finally {
    clearTimeout(timer);
    for (const forceTimer of forceTimers) clearTimeout(forceTimer);
    if (fallbackTimer) clearTimeout(fallbackTimer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function terminateTree(child: ChildProcess): void {
  killTree(child, 'SIGTERM');
}

export async function stopAndWait(child: ChildProcess, graceMs: number): Promise<boolean> {
  if (!child.pid) return true;
  terminateTree(child);
  if (await waitForGroupExit(child.pid, Math.max(50, graceMs))) return true;
  killTree(child, 'SIGKILL');
  return waitForGroupExit(child.pid, Math.max(500, graceMs * 4));
}

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (process.platform === 'win32') return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try { process.kill(-pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try { process.kill(-pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

function spawnFailure(
  command: string,
  args: readonly string[],
  cwd: string,
  startedAt: string,
  value: unknown,
  terminal: ProcessTerminal = 'spawn-error',
  treeStopped = true,
  lifecycle?: SupervisedProcessResult['lifecycle'],
  launch?: NativeLaunchEvidence,
): SupervisedProcessResult {
  const error = value instanceof Error ? value : new Error(String(value));
  return {
    command, args: [...args], cwd, stdout: '', stderr: '', code: null,
    signal: null, terminal, treeStopped, startedAt,
    endedAt: new Date().toISOString(),
    ...(lifecycle ? { lifecycle } : {}),
    ...(launch ? { launch } : {}),
    error: { name: error.name, message: error.message },
  };
}

async function withinDeadline<T>(work: Promise<T>, deadlineEpochMs: number): Promise<T | false> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadlineEpochMs - Date.now())); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

type SettledByDeadline<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; error: unknown }
  | { status: 'timed-out' };

async function settleWithinDeadline<T>(work: Promise<T>, deadlineEpochMs: number): Promise<SettledByDeadline<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then((value): SettledByDeadline<T> => ({ status: 'fulfilled', value }),
        (error): SettledByDeadline<T> => ({ status: 'rejected', error })),
      new Promise<SettledByDeadline<T>>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timed-out' }), Math.max(0, deadlineEpochMs - Date.now()));
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

type CleanupOutcome = { status: 'completed' | 'failed'; proof?: NativeInvocationCleanupProof; errorName?: string };

async function invokeBoundedCleanup(
  cleanup: NativeInvocationCleanup,
  identity: SupervisedInvocationIdentity,
  reason: string,
  deadlineEpochMs: number,
): Promise<CleanupOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('native invocation cleanup deadline elapsed')),
    Math.max(1, deadlineEpochMs - Date.now()));
  const work = Promise.resolve().then(() => cleanup({ identity: { ...identity }, reason, deadlineEpochMs,
    signal: controller.signal, preserveRecovery: true }));
  try {
    const proof = await Promise.race([
      work,
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () =>
        reject(controller.signal.reason ?? new Error('native invocation cleanup deadline elapsed')), { once: true })),
    ]);
    if (!proof || !['stopped-and-reaped', 'quarantined'].includes(proof.status) ||
        !Array.isArray(proof.resourceIds) || !['disposed', 'quarantined'].includes(proof.volumeDisposition)) {
      return { status: 'failed', errorName: 'InvalidCleanupProof' };
    }
    if (proof.status !== 'stopped-and-reaped') return { status: 'failed', proof, errorName: 'CleanupQuarantined' };
    return { status: 'completed', proof };
  } catch (error) {
    return { status: 'failed', errorName: error instanceof Error ? error.name : 'Error' };
  } finally {
    clearTimeout(timer);
  }
}
