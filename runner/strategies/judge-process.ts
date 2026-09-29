/** Cancellable POSIX process-group supervisor for serializable host-judge work. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unknownUsage } from './index.ts';
import type { IndependentJudgeExecution, IndependentJudgeSettlementProof } from './executor.ts';
import type { JudgeProcessIdentity, ReviewLoopJudgeProcessRequest, ReviewLoopJudgeProcessResult } from './judge-protocol.ts';

const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const TERM_GRACE_MS = 500;
const CHILD_ENTRYPOINT = fileURLToPath(new URL('./judge-child.ts', import.meta.url));

interface ProcessControl {
  identity: JudgeProcessIdentity;
  child: ChildProcess | null;
  resultPath: string;
  exit: Promise<{ kind: 'exit'; code: number | null; signal: NodeJS.Signals | null } | { kind: 'spawn-error' }>;
  spawnState: 'pending' | 'spawned' | 'failed';
  proof: Promise<IndependentJudgeSettlementProof> | null;
  outputOverflow: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stderrTail: string;
  namespace: JudgeNamespaceHandle | null;
  namespaceCleanup: Promise<{ proof: JudgeNamespaceCleanupProof; receipt: { path: string; sha256: string; privatePath: string } }> | null;
  ownership: JudgeOwnershipBindings;
  artifactRoot: string;
  receiptWriteHook?: (path: string) => void;
  phaseObserver?: (phase: string, fields?: Readonly<Record<string, string | number | boolean>>) => void;
}

interface JudgeNamespaceIdentity { assignmentId: string; stageId: string; attemptId: string; }
interface JudgeNamespaceHandle { planPath: string; planSha256: string; plan: {
  identity: JudgeNamespaceIdentity; candidateSha256: string; oraclePin: string;
  slots: readonly { inventoryHash: string }[];
}; }
interface JudgeNamespaceCleanupProof {
  identity: JudgeNamespaceIdentity; planSha256: string; daemonVerified: boolean; ownershipVerified: boolean;
  containersAbsent: boolean; processTree: 'stopped-and-reaped' | 'unproven';
  volumeDisposition: 'quarantined' | 'absent' | 'unproven'; resourceIds: string[];
  cleanup: 'complete' | 'failed'; inventoryContentVerified: false;
}
interface JudgeOwnershipBindings {
  stableJudgeCandidateInventory(module: string, bytes: Uint8Array): { inventoryHash: string };
  createJudgeNamespacePlan(input: { privateParentRoot: string; identity: JudgeNamespaceIdentity; candidateSha256: string;
    oraclePin: string; inventoryHashes: readonly string[] }): JudgeNamespaceHandle;
  cleanupJudgeNamespace(handle: JudgeNamespaceHandle, input: { hostProcessStopped: boolean; deadlineEpochMs: number }): Promise<JudgeNamespaceCleanupProof>;
}
export interface PinnedJudgeOwnership {
  stableJudgeCandidateInventory(module: string, bytes: Uint8Array): { inventoryHash: string };
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameIdentity(left: JudgeProcessIdentity, right: JudgeProcessIdentity): boolean {
  return left.assignmentId === right.assignmentId && left.stageId === right.stageId && left.attemptId === right.attemptId;
}

function positiveDeadlineMs(epochMs: number): number {
  return Math.max(0, Math.floor(epochMs - Date.now()));
}

function recordPhase(
  control: ProcessControl,
  phase: string,
  fields?: Readonly<Record<string, string | number | boolean>>,
): void {
  try { control.phaseObserver?.(phase, fields); } catch { /* Diagnostics never change supervisor behavior. */ }
}

function groupExists(pgid: number): boolean | null {
  try { process.kill(-pgid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try { process.kill(-pgid, signal); return true; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function waitForExit(control: ProcessControl, deadlineEpochMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      control.exit.then(() => true),
      new Promise<boolean>((resolveWait) => { timer = setTimeout(() => resolveWait(false), positiveDeadlineMs(deadlineEpochMs)); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function waitForGroupGone(pgid: number, deadlineEpochMs: number): Promise<boolean> {
  for (;;) {
    const exists = groupExists(pgid);
    if (exists === false) return true;
    if (exists === null || Date.now() >= deadlineEpochMs) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(20, Math.max(1, deadlineEpochMs - Date.now()))));
  }
}

function stopProof(identity: JudgeProcessIdentity, stopped: boolean): IndependentJudgeSettlementProof {
  return {
    ...identity,
    processTree: stopped ? 'stopped-and-reaped' : 'running-or-unknown',
    execution: stopped ? 'settled' : 'unsettled',
    protectedOracleCleanup: 'unobserved',
    cleanup: stopped ? 'complete' : 'failed',
  };
}

const OWNERSHIP_CLOSURE = 'runner/boundary/evidence/fallback/judge-ownership-source-closure.public.json';
const OWNERSHIP_MODULE = 'runner/boundary/judge-ownership.ts';
const OWNERSHIP_CLOSURE_ASSETS = [
  'runner/boundary/broker-toolchain.ts', 'runner/boundary/codex-final-profile.ts',
  'runner/boundary/container-prepare.ts', 'runner/boundary/container.ts', 'runner/boundary/docker-control.ts',
  'runner/boundary/egress-broker.ts', 'runner/boundary/judge-child.ts', OWNERSHIP_MODULE,
  'runner/boundary/lifecycle-evidence.ts', 'runner/boundary/namespace-acl.sh',
  'runner/boundary/subscription-auth.ts', 'runner/boundary/task-session.ts',
  'runner/boundary/task-staging.ts', 'runner/boundary/task-tree.ts', 'runner/boundary/volume-io.mjs',
] as const;

async function loadPinnedOwnership(request: ReviewLoopJudgeProcessRequest): Promise<JudgeOwnershipBindings> {
  const dependencyHashes = new Map(request.judgeManifest.dependencies.map((entry) => [entry.path, entry.sha256]));
  if (dependencyHashes.size !== request.judgeManifest.dependencies.length) throw new Error('protected-judge dependency manifest contains duplicate paths');
  const readAsset = (path: string): Buffer => {
    const absolute = join(request.s1DependencyRoot, path);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`protected-judge source is not a pinned regular file: ${path}`);
    return readFileSync(absolute);
  };
  const closurePath = join(request.s1DependencyRoot, OWNERSHIP_CLOSURE);
  const closureStat = lstatSync(closurePath);
  if (!closureStat.isFile() || closureStat.isSymbolicLink()) throw new Error('protected-judge source closure is not a regular file');
  const closureBytes = readFileSync(closurePath);
  const closurePin = dependencyHashes.get(OWNERSHIP_CLOSURE);
  if (!closurePin || hash(closureBytes) !== closurePin) throw new Error('pinned protected-judge source closure is missing or changed');
  const closure = JSON.parse(closureBytes.toString('utf8')) as { schemaVersion?: number; assets?: Record<string, string> };
  if (closure.schemaVersion !== 1 || !closure.assets || Object.keys(closure.assets).length !== OWNERSHIP_CLOSURE_ASSETS.length) {
    throw new Error('pinned protected-judge source closure is malformed');
  }
  if (JSON.stringify((closure as { entrypoints?: unknown }).entrypoints)
    !== JSON.stringify([OWNERSHIP_MODULE, 'runner/boundary/judge-child.ts'])) {
    throw new Error('pinned protected-judge source closure entrypoints are malformed');
  }
  for (const path of OWNERSHIP_CLOSURE_ASSETS) {
    const expected = closure.assets[path];
    const manifest = dependencyHashes.get(path);
    if (!expected || expected !== manifest || hash(readAsset(path)) !== expected) {
      throw new Error(`protected-judge source closure pin mismatch: ${path}`);
    }
  }
  const source = join(request.s1DependencyRoot, OWNERSHIP_MODULE);
  return await import(pathToFileURL(source).href) as JudgeOwnershipBindings;
}

export async function loadPinnedJudgeOwnership(
  s1DependencyRoot: string,
  judgeManifest: ReviewLoopJudgeProcessRequest['judgeManifest'],
): Promise<PinnedJudgeOwnership> {
  return loadPinnedOwnership({ s1DependencyRoot, judgeManifest } as ReviewLoopJudgeProcessRequest);
}

function samePlanIdentity(plan: JudgeNamespaceIdentity, identity: JudgeProcessIdentity): boolean {
  return plan.assignmentId === identity.assignmentId && plan.stageId === identity.stageId && plan.attemptId === identity.attemptId;
}

function validCleanupProof(
  proof: JudgeNamespaceCleanupProof,
  handle: JudgeNamespaceHandle,
  hostStopped: boolean,
): boolean {
  return hostStopped && proof.cleanup === 'complete' && proof.planSha256 === handle.planSha256
    && samePlanIdentity(proof.identity, handle.plan.identity) && proof.daemonVerified && proof.ownershipVerified
    && proof.containersAbsent && proof.processTree === 'stopped-and-reaped'
    && (proof.volumeDisposition === 'quarantined' || proof.volumeDisposition === 'absent')
    && proof.inventoryContentVerified === false && Array.isArray(proof.resourceIds)
    && proof.resourceIds.length <= 24 && proof.resourceIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256)
    && new Set(proof.resourceIds).size === proof.resourceIds.length;
}

async function cleanupNamespace(
  control: ProcessControl,
  hostStopped: boolean,
  deadlineEpochMs: number,
): Promise<{ proof: JudgeNamespaceCleanupProof; receipt: { path: string; sha256: string; privatePath: string } } | null> {
  // S5 cleanup mutates daemon resources. Unknown host state must never be
  // represented as a stop proof or passed to the namespace cleanup API.
  if (!control.namespace || !hostStopped) return null;
  if (!control.namespaceCleanup) {
    recordPhase(control, 'namespace-cleanup-start', { planSha256: control.namespace.planSha256, hostProcessStopped: true });
    control.namespaceCleanup = (async () => {
      try {
        const proof = await control.ownership.cleanupJudgeNamespace(control.namespace!, {
          hostProcessStopped: hostStopped,
          deadlineEpochMs: Math.min(deadlineEpochMs, Date.now() + 30_000),
        });
        recordPhase(control, 'namespace-cleanup-end', { cleanup: proof.cleanup, containersAbsent: proof.containersAbsent,
          volumeDisposition: proof.volumeDisposition, planSha256: proof.planSha256 });
        return { proof, receipt: persistCleanupReceipt(control, proof) };
      } catch (error) {
        recordPhase(control, 'namespace-cleanup-failed', { planSha256: control.namespace!.planSha256 });
        throw error;
      }
    })();
  }
  return control.namespaceCleanup;
}

function canonicalCleanupProof(proof: JudgeNamespaceCleanupProof): JudgeNamespaceCleanupProof {
  return {
    identity: { assignmentId: proof.identity.assignmentId, stageId: proof.identity.stageId, attemptId: proof.identity.attemptId },
    planSha256: proof.planSha256,
    daemonVerified: proof.daemonVerified,
    ownershipVerified: proof.ownershipVerified,
    containersAbsent: proof.containersAbsent,
    processTree: proof.processTree,
    volumeDisposition: proof.volumeDisposition,
    resourceIds: [...proof.resourceIds],
    cleanup: proof.cleanup,
    inventoryContentVerified: false,
  };
}

function persistCleanupReceipt(
  control: ProcessControl,
  rawProof: JudgeNamespaceCleanupProof,
): { path: string; sha256: string; privatePath: string } {
  const proof = canonicalCleanupProof(rawProof);
  const relativePath = `s4-cleanup-${hash(control.identity.attemptId).slice(0, 20)}/protected-oracle-cleanup.json`;
  const absolutePath = join(control.artifactRoot, relativePath);
  const artifactStat = lstatSync(control.artifactRoot);
  if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink()) throw new Error('protected-oracle receipt root is not a private directory');
  const receiptDirectory = dirname(absolutePath);
  mkdirSync(receiptDirectory, { recursive: false, mode: 0o700 });
  const receiptDirectoryStat = lstatSync(receiptDirectory);
  if (!receiptDirectoryStat.isDirectory() || receiptDirectoryStat.isSymbolicLink()) throw new Error('protected-oracle receipt directory is unsafe');
  const envelope = {
    schemaVersion: 1,
    identity: { ...control.identity },
    planSha256: control.namespace!.planSha256,
    proof,
  };
  const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`);
  const descriptor = openSync(absolutePath, 'wx', 0o600);
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  try { control.receiptWriteHook?.(absolutePath); }
  catch { throw new Error('protected-oracle cleanup receipt could not be persisted'); }
  const recorded = readFileSync(absolutePath);
  if (hash(recorded) !== hash(bytes) || !recorded.equals(bytes)) throw new Error('protected-oracle cleanup receipt integrity check failed');
  const parsed = JSON.parse(recorded.toString('utf8')) as typeof envelope;
  if (JSON.stringify(parsed) !== JSON.stringify(envelope)
    || !sameIdentity(parsed.identity, control.identity) || parsed.planSha256 !== control.namespace!.planSha256
    || parsed.proof.planSha256 !== control.namespace!.planSha256 || !sameIdentity(parsed.proof.identity, control.identity)) {
    throw new Error('protected-oracle cleanup receipt binding is invalid');
  }
  const receipt = { path: `artifacts/${relativePath}`, sha256: hash(bytes), privatePath: absolutePath };
  recordPhase(control, 'cleanup-receipt-persisted', { path: receipt.path, sha256: receipt.sha256,
    planSha256: control.namespace!.planSha256 });
  return receipt;
}

function settlementWithNamespace(
  identity: JudgeProcessIdentity,
  hostProof: IndependentJudgeSettlementProof,
  handle: JudgeNamespaceHandle | null,
  namespaceProof: JudgeNamespaceCleanupProof | null,
  cleanupReceipt?: { path: string; sha256: string; privatePath?: string },
): IndependentJudgeSettlementProof {
  const valid = !!handle && !!namespaceProof && validCleanupProof(namespaceProof, handle, hostProof.processTree === 'stopped-and-reaped');
  return {
    ...hostProof,
    ...identity,
    processTree: valid ? 'stopped-and-reaped' : 'running-or-unknown',
    execution: hostProof.execution,
    protectedOracleCleanup: valid ? 'proven' : 'unobserved',
    ...(cleanupReceipt ? { protectedOracleCleanupReceipt: cleanupReceipt } : {}),
    ...(valid && namespaceProof ? { protectedOracleProof: {
      planSha256: namespaceProof.planSha256, daemonVerified: true as const,
      ownershipVerified: true as const, containersAbsent: true as const,
      volumeDisposition: namespaceProof.volumeDisposition, resourceIds: [...namespaceProof.resourceIds],
      inventoryContentVerified: false as const,
    } } : {}),
    cleanup: valid && hostProof.cleanup === 'complete' ? 'complete' : 'quarantined',
  };
}

function terminate(
  control: ProcessControl,
  deadlineEpochMs: number,
  groupGoneProbe: (pgid: number, deadlineEpochMs: number) => Promise<boolean> = waitForGroupGone,
): Promise<IndependentJudgeSettlementProof> {
  if (control.proof) return control.proof;
  control.proof = (async () => {
    try {
    // A synchronous throw or Node's pre-spawn error with no pid proves no
    // host child was created. This is the only no-pid case that permits S5
    // exact-plan cleanup.
    if (control.spawnState === 'failed') {
      recordPhase(control, 'host-group-stopped', { proof: 'pre-spawn-no-child' });
      return stopProof(control.identity, true);
    }
    const pgid = control.child?.pid;
    if (!pgid) {
      recordPhase(control, 'host-group-unproven', { proof: 'missing-pid-unknown' });
      return stopProof(control.identity, false);
    }
    signalGroup(pgid, 'SIGTERM');
    const termDeadline = Math.min(deadlineEpochMs, Date.now() + TERM_GRACE_MS);
    const leaderExited = await waitForExit(control, termDeadline);
    const groupGone = await groupGoneProbe(pgid, termDeadline);
    if (!leaderExited || !groupGone) {
      signalGroup(pgid, 'SIGKILL');
      const finalLeaderExit = await waitForExit(control, deadlineEpochMs);
      const finalGroupGone = await groupGoneProbe(pgid, deadlineEpochMs);
      const stopped = finalLeaderExit && finalGroupGone;
      recordPhase(control, stopped ? 'host-group-stopped' : 'host-group-unproven', { proof: stopped ? 'sigkill-reaped' : 'deadline-or-probe-failed' });
      return stopProof(control.identity, stopped);
    }
    recordPhase(control, 'host-group-stopped', { proof: 'natural-exit-and-group-gone' });
    return stopProof(control.identity, true);
    } catch {
      // Probe and termination adapter failures are evidence gaps, never
      // rejections that bypass the caller's bounded cleanup path.
      recordPhase(control, 'host-group-unproven', { proof: 'settlement-exception' });
      return stopProof(control.identity, false);
    }
  })();
  return control.proof;
}

function privateEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    LANG: process.env.LANG ?? 'C.UTF-8',
  };
  if (process.platform === 'win32') {
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (process.env.WINDIR) env.WINDIR = process.env.WINDIR;
  }
  return env;
}

function assertRequest(value: ReviewLoopJudgeProcessRequest): void {
  if (value.schemaVersion !== 1 || !value.identity.assignmentId || !value.identity.stageId || !value.identity.attemptId) {
    throw new Error('invalid independent judge process request');
  }
  if (value.identity.assignmentId !== value.experiment.assignmentId || value.identity.stageId !== value.experiment.stageId
    || value.identity.attemptId !== value.experiment.attemptId) throw new Error('independent judge process identity mismatch');
  if (value.oraclePin !== value.judgeManifest.sourcePin || value.experiment.judgeManifest.sourcePin !== value.oraclePin) {
    throw new Error('independent judge semantic oracle pin mismatch');
  }
  if (!isAbsolute(value.s1DependencyRoot)) throw new Error('independent judge S1 dependency root must be absolute');
  if (!/^[a-f0-9]{64}$/i.test(value.candidate.sha256) || hash(value.candidate.patch) !== value.candidate.sha256) {
    throw new Error('independent judge candidate hash mismatch');
  }
}

export interface IndependentJudgeProcessSupervisorOptions {
  /** Test seam for proving cleanup failures; production callers use the default process-group probe. */
  readonly groupGone?: (pgid: number, deadlineEpochMs: number) => Promise<boolean>;
  readonly childEntrypoint?: string;
  readonly privateRoot?: string;
  /** Injected only by offline tests. Production loads the exact pinned S1 dependency closure. */
  readonly ownershipForTest?: JudgeOwnershipBindings;
  /** Offline adversarial seams; production leaves both unset. */
  readonly spawnChildForTest?: typeof spawn;
  readonly beforeSpawnForTest?: () => Promise<void>;
  readonly receiptWriteHookForTest?: (path: string) => void;
  /** Synchronous, non-blocking phase timestamps for bounded offline conformance probes. */
  readonly phaseObserverForTest?: (phase: string, fields?: Readonly<Record<string, string | number | boolean>>) => void;
}

/**
 * This supervisor accepts only a frozen JSON DTO. It never accepts or invokes
 * a caller closure in the child process.
 */
export class IndependentJudgeProcessSupervisor {
  private readonly active = new Map<string, ProcessControl>();
  private readonly completed = new Map<string, IndependentJudgeSettlementProof>();
  private readonly admittedAttempts = new Set<string>();
  private readonly childEntrypoint: string;
  private readonly groupGone: (pgid: number, deadlineEpochMs: number) => Promise<boolean>;
  private readonly privateRoot: string;
  private readonly ownershipForTest: JudgeOwnershipBindings | undefined;
  private readonly spawnChild: typeof spawn;
  private readonly beforeSpawnForTest: (() => Promise<void>) | undefined;
  private readonly receiptWriteHookForTest: ((path: string) => void) | undefined;
  private readonly phaseObserverForTest: ((phase: string, fields?: Readonly<Record<string, string | number | boolean>>) => void) | undefined;

  constructor(options: IndependentJudgeProcessSupervisorOptions = {}) {
    if (process.platform === 'win32') throw new Error('independent judge process groups require POSIX detached process semantics');
    this.childEntrypoint = resolve(options.childEntrypoint ?? CHILD_ENTRYPOINT);
    this.groupGone = options.groupGone ?? waitForGroupGone;
    this.privateRoot = resolve(options.privateRoot ?? tmpdir());
    this.ownershipForTest = options.ownershipForTest;
    this.spawnChild = options.spawnChildForTest ?? spawn;
    this.beforeSpawnForTest = options.beforeSpawnForTest;
    this.receiptWriteHookForTest = options.receiptWriteHookForTest;
    this.phaseObserverForTest = options.phaseObserverForTest;
    mkdirSync(this.privateRoot, { recursive: true, mode: 0o700 });
  }

  async run(request: ReviewLoopJudgeProcessRequest, signal: AbortSignal): Promise<IndependentJudgeExecution> {
    assertRequest(request);
    // Snapshot the serializable DTO before the first await so caller mutation
    // cannot change the attempt or plan binding during pin loading.
    request = JSON.parse(JSON.stringify(request)) as ReviewLoopJudgeProcessRequest;
    assertRequest(request);
    if (signal.aborted) throw signal.reason ?? new Error('independent judge cancelled before process launch');
    if (Date.now() >= request.deadlineEpochMs) throw new Error('independent judge deadline elapsed before process launch');
    if (this.admittedAttempts.has(request.identity.attemptId)) {
      throw new Error('independent judge attempt identity was already admitted');
    }

    const processRoot = mkdtempSync(join(this.privateRoot, `s4-judge-${randomUUID()}-`));
    const requestPath = join(processRoot, 'request.json');
    const resultPath = join(processRoot, 'result.json');
    const artifactRoot = join(processRoot, 'artifacts');
    mkdirSync(artifactRoot, { mode: 0o700 });
    mkdirSync(join(processRoot, 'home'), { mode: 0o700 });
    mkdirSync(join(processRoot, 'tmp'), { mode: 0o700 });
    // S1's pinned protected-oracle client resolves this one fixed local socket
    // beneath HOME. Expose only the socket through a private-home symlink;
    // do not pass through the caller's HOME or provider credentials.
    const protectedOracleSocket = join(homedir(), '.colima', 'cq-boundary-s5', 'docker.sock');
    const privateOracleSocket = join(processRoot, 'home', '.colima', 'cq-boundary-s5', 'docker.sock');
    mkdirSync(dirname(privateOracleSocket), { recursive: true, mode: 0o700 });
    symlinkSync(protectedOracleSocket, privateOracleSocket);
    if (!/^[a-f0-9]{64}$/i.test(request.candidateInventoryHash)
      || !Number.isInteger(request.namespaceSlotCount) || request.namespaceSlotCount < 1 || request.namespaceSlotCount > 8) {
      throw new Error('independent judge request has no bounded S5 inventory plan');
    }
    const ownership = this.ownershipForTest ?? await loadPinnedOwnership(request);
    const namespace = ownership.createJudgeNamespacePlan({
      privateParentRoot: processRoot,
      identity: request.identity,
      candidateSha256: request.candidate.sha256,
      oraclePin: request.oraclePin,
      inventoryHashes: Array.from({ length: request.namespaceSlotCount }, () => request.candidateInventoryHash),
    });
    try {
      if (!namespace || !isAbsolute(namespace.planPath) || !/^[a-f0-9]{64}$/.test(namespace.planSha256)
        || !samePlanIdentity(namespace.plan.identity, request.identity) || namespace.plan.candidateSha256 !== request.candidate.sha256
        || namespace.plan.oraclePin !== request.oraclePin || namespace.plan.slots.length !== request.namespaceSlotCount
        || namespace.plan.slots.some((slot) => slot.inventoryHash !== request.candidateInventoryHash)) {
        throw new Error('protected-judge namespace plan does not match frozen request');
      }
      const planStat = lstatSync(namespace.planPath);
      if (!planStat.isFile() || planStat.isSymbolicLink() || !resolve(namespace.planPath).startsWith(`${processRoot}/`)) {
        throw new Error('protected-judge plan is not a private child of the parent process root');
      }
    } catch {
      try { await ownership.cleanupJudgeNamespace(namespace, { hostProcessStopped: true, deadlineEpochMs: Date.now() + 30_000 }); }
      catch { /* Keep S5 recovery state when the preregistered handle cannot be proven clean. */ }
      throw new Error('protected-judge namespace plan does not match the frozen request');
    }
    const childRequest = { ...request, namespacePlanSha256: namespace.planSha256, processRoot, artifactRoot };
    const requestBytes = Buffer.from(`${JSON.stringify(childRequest)}\n`);
    const requestSha256 = hash(requestBytes);
    const startedAt = performance.now();
    let resolveExit!: (exit: ProcessControl['exit'] extends Promise<infer T> ? T : never) => void;
    const control: ProcessControl = {
      identity: request.identity, child: null, resultPath,
      exit: new Promise((resolveExitPromise) => { resolveExit = resolveExitPromise; }),
      spawnState: 'pending', proof: null, outputOverflow: false, stdoutBytes: 0, stderrBytes: 0,
      stderrTail: '', namespace, namespaceCleanup: null, ownership, artifactRoot,
      ...(this.receiptWriteHookForTest ? { receiptWriteHook: this.receiptWriteHookForTest } : {}),
      ...(this.phaseObserverForTest ? { phaseObserver: this.phaseObserverForTest } : {}),
    };
    this.admittedAttempts.add(request.identity.attemptId);
    const finishBeforeSpawn = async (cause: Error): Promise<never> => {
      control.spawnState = 'failed';
      resolveExit({ kind: 'spawn-error' });
      const hostProof = stopProof(request.identity, true);
      let namespaceResult: Awaited<ReturnType<typeof cleanupNamespace>> = null;
      try { namespaceResult = await cleanupNamespace(control, true, request.shutdownDeadlineEpochMs); } catch { /* Keep the original launch/cancel error. */ }
      const settlement = settlementWithNamespace(request.identity, hostProof, namespace,
        namespaceResult?.proof ?? null, namespaceResult?.receipt);
      this.completed.set(request.identity.attemptId, settlement);
      throw cause;
    };
    try { await this.beforeSpawnForTest?.(); }
    catch { return finishBeforeSpawn(new Error('independent judge preparation failed before process launch')); }
    if (signal.aborted) return finishBeforeSpawn(new Error('independent judge cancelled during preparation before process launch'));
    if (Date.now() >= request.deadlineEpochMs) return finishBeforeSpawn(new Error('independent judge decision deadline elapsed during preparation before process launch'));

    let child: ChildProcess;
    try {
      writeFileSync(requestPath, requestBytes, { flag: 'wx', mode: 0o600 });
      child = this.spawnChild(process.execPath, [
        '--disable-warning=ExperimentalWarning', '--experimental-strip-types', this.childEntrypoint,
        requestPath, resultPath, requestSha256,
      ], {
        cwd: processRoot,
        env: { ...privateEnvironment(processRoot), CQ_PROTECTED_JUDGE_PLAN: namespace.planPath },
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return finishBeforeSpawn(new Error('independent judge child could not be launched'));
    }
    control.child = child;
    child.once('spawn', () => { control.spawnState = 'spawned'; recordPhase(control, 'host-spawn'); });
    child.once('error', () => {
      // Node emits an asynchronous error for a spawn failure before the
      // `spawn` event and with no pid. Other errors do not prove absence.
      if (control.spawnState === 'pending' && !child.pid) {
        control.spawnState = 'failed';
        resolveExit({ kind: 'spawn-error' });
      }
    });
    child.once('exit', (code, signalName) => {
      recordPhase(control, 'host-exit', { code: code ?? 'null', signal: signalName ?? 'none' });
      resolveExit({ kind: 'exit', code, signal: signalName });
    });
    child.once('close', (code, signalName) => recordPhase(control, 'host-close', {
      code: code ?? 'null', signal: signalName ?? 'none',
    }));
    this.active.set(request.identity.attemptId, control);
    const overflowController = new AbortController();
    const collect = (stream: NodeJS.ReadableStream | null, which: 'stdout' | 'stderr'): void => {
      stream?.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const totalKey = which === 'stdout' ? 'stdoutBytes' : 'stderrBytes';
        control[totalKey] += bytes.byteLength;
        if (which === 'stderr') {
          control.stderrTail = `${control.stderrTail}${bytes.toString('utf8')}`.slice(-8_192);
        }
        if (control[totalKey] > (which === 'stdout' ? MAX_STDOUT_BYTES : MAX_STDERR_BYTES)) {
          control.outputOverflow = true;
          overflowController.abort();
          return;
        }
      });
    };
    collect(child.stdout, 'stdout');
    collect(child.stderr, 'stderr');

    let stopCause: unknown;
    let stopPromise: Promise<IndependentJudgeSettlementProof> | null = null;
    let signalStop!: (value: void) => void;
    const stoppedSignal = new Promise<void>((resolveStop) => { signalStop = resolveStop; });
    const requestStop = (cause: unknown): void => {
      if (stopPromise) return;
      stopCause = cause;
      stopPromise = terminate(control, request.shutdownDeadlineEpochMs, this.groupGone);
      signalStop();
    };
    const stopForOverflow = () => requestStop(new Error('independent judge exceeded bounded stdout/stderr allowance'));
    overflowController.signal.addEventListener('abort', stopForOverflow, { once: true });
    if (control.outputOverflow) stopForOverflow();
    const abortListener = () => requestStop(signal.reason ?? new Error('independent judge cancelled'));
    signal.addEventListener('abort', abortListener, { once: true });
    const timer = setTimeout(() => requestStop(new Error('independent judge decision deadline exceeded')), positiveDeadlineMs(request.deadlineEpochMs));
    // Cancellation can land after the pre-launch check and before listener
    // installation. Recheck here before accepting any child completion.
    if (signal.aborted) requestStop(signal.reason ?? new Error('independent judge cancelled'));
    else if (Date.now() >= request.deadlineEpochMs) requestStop(new Error('independent judge decision deadline exceeded'));

    try {
      const first = await Promise.race([
        control.exit.then((exit) => ({ kind: 'exit' as const, exit })),
        stoppedSignal.then(() => ({ kind: 'stop' as const })),
      ]);
      if (first.kind === 'stop') {
        const hostProof = await stopPromise!;
        let namespaceResult: Awaited<ReturnType<typeof cleanupNamespace>> = null;
        try { namespaceResult = await cleanupNamespace(control, hostProof.processTree === 'stopped-and-reaped', request.shutdownDeadlineEpochMs); }
        catch { /* Keep the cancellation/deadline as the primary cause; proof remains unobserved. */ }
        const proof = settlementWithNamespace(request.identity, hostProof, namespace, namespaceResult?.proof ?? null, namespaceResult?.receipt);
        this.completed.set(request.identity.attemptId, proof);
        throw stopCause instanceof Error ? stopCause : new Error(String(stopCause));
      }
      const decisionUnavailable = (): string | null => signal.aborted
        ? 'independent judge was cancelled before its result was accepted'
        : Date.now() >= request.deadlineEpochMs
          ? 'independent judge result arrived after its decision deadline'
          : null;
      const initialDecisionFailure = decisionUnavailable();
      if (initialDecisionFailure) {
        requestStop(signal.reason ?? new Error('independent judge result arrived after its decision deadline'));
        const hostProof = await stopPromise!;
        let namespaceResult: Awaited<ReturnType<typeof cleanupNamespace>> = null;
        try { namespaceResult = await cleanupNamespace(control, hostProof.processTree === 'stopped-and-reaped', request.shutdownDeadlineEpochMs); }
        catch { /* Preserve deadline as the primary failure and retain unknown proof. */ }
        const proof = settlementWithNamespace(request.identity, hostProof, namespace, namespaceResult?.proof ?? null, namespaceResult?.receipt);
        this.completed.set(request.identity.attemptId, proof);
        throw new Error(initialDecisionFailure);
      }

      const naturalHostProof = first.exit.kind === 'spawn-error'
        ? stopProof(request.identity, true)
        : await terminate(control, Math.min(request.shutdownDeadlineEpochMs, Date.now() + 5_000), this.groupGone);
      const naturalNamespaceProof = await cleanupNamespace(control,
        naturalHostProof.processTree === 'stopped-and-reaped', request.shutdownDeadlineEpochMs);
      const naturalExitProof = settlementWithNamespace(request.identity, naturalHostProof, namespace,
        naturalNamespaceProof?.proof ?? null, naturalNamespaceProof?.receipt);
      this.completed.set(request.identity.attemptId, naturalExitProof);
      if (naturalExitProof.cleanup !== 'complete') throw new Error('independent judge or protected namespace cleanup could not be proven');
      const afterSettlementFailure = decisionUnavailable();
      if (afterSettlementFailure) throw new Error(afterSettlementFailure);
      if (first.exit.kind === 'spawn-error') throw new Error('independent judge child failed to spawn');
      if (first.exit.code !== 0) {
        const exitClass = first.exit.signal ? 'signal' : first.exit.code === null ? 'unknown' : 'nonzero';
        throw new Error(`independent judge child failed (${exitClass} exit)`);
      }
      if (control.outputOverflow) throw new Error('independent judge child exceeded the bounded stdout/stderr allowance');
      const stat = lstatSync(resultPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RESULT_BYTES) throw new Error('independent judge child result is missing or outside its size bound');
      const bytes = readFileSync(resultPath);
      const envelope = JSON.parse(bytes.toString('utf8')) as ReviewLoopJudgeProcessResult;
      const canonicalPayload = Buffer.from(JSON.stringify(envelope.payload));
      if (envelope.schemaVersion !== 1 || envelope.requestSha256 !== requestSha256
        || envelope.payload?.requestSha256 !== requestSha256 || envelope.payloadSha256 !== hash(canonicalPayload)
        || !sameIdentity(envelope.payload.identity, request.identity)
        || envelope.payload.selection.candidateSha256 !== request.candidate.sha256
        || envelope.payload.selection.judgePin !== request.oraclePin) {
        throw new Error('independent judge child result identity or content hash mismatch');
      }
      const row = envelope.payload.rows.find((item) => item.case === request.caseId);
      const outcome = row?.taskOutcome;
      const selected = outcome?.judgements.find((item) => item.judgementId === envelope.payload.selection.judgementId
        && item.version === envelope.payload.selection.version && item.candidateSha256 === request.candidate.sha256
        && item.judgePin === request.oraclePin);
      if (!outcome || !selected || outcome.judgements.filter((item) => item.judgementId === selected.judgementId
        && item.version === selected.version).length !== 1) throw new Error('independent judge child output does not contain the exact frozen judgement');
      const afterValidationFailure = decisionUnavailable();
      if (afterValidationFailure) throw new Error(afterValidationFailure);
      const serviceTimeMs = Math.max(0, performance.now() - startedAt);
      const evidence = {
        rows: envelope.payload.rows, tables: envelope.payload.tables, diagnostics: envelope.payload.diagnostics,
        selection: envelope.payload.selection, requestSha256, payloadSha256: envelope.payloadSha256,
        artifactRoot, processRoot, protectedOracleProof: naturalExitProof.protectedOracleProof!,
        protectedOracleCleanupReceipt: naturalExitProof.protectedOracleCleanupReceipt!,
      };
      return {
        result: {
          status: 'completed', usage: unknownUsage(), serviceTimeMs, launched: false,
          judgement: {
            status: outcome.candidateCorrectness === null ? 'unavailable' : 'valid',
            correctness: outcome.candidateCorrectness,
            detail: 'S1 child runSuite host oracle; deterministic candidate injection is not model usage.',
          },
        }, evidence,
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abortListener);
      overflowController.signal.removeEventListener('abort', stopForOverflow);
      try {
        const hostProof = control.proof
          ? await control.proof
          : await terminate(control, request.shutdownDeadlineEpochMs, this.groupGone);
        const namespaceResult = await cleanupNamespace(control,
          hostProof.processTree === 'stopped-and-reaped', request.shutdownDeadlineEpochMs);
        this.completed.set(request.identity.attemptId, settlementWithNamespace(request.identity, hostProof, namespace,
          namespaceResult?.proof ?? null, namespaceResult?.receipt));
      } catch {
        const hostProof = control.proof ? await control.proof.catch(() => stopProof(request.identity, false))
          : stopProof(request.identity, false);
        this.completed.set(request.identity.attemptId, settlementWithNamespace(request.identity, hostProof, namespace, null));
      }
      this.active.delete(request.identity.attemptId);
    }
  }

  async cancelAndWait(input: {
    identity: JudgeProcessIdentity;
    cause: unknown;
    deadlineEpochMs: number;
  }): Promise<IndependentJudgeSettlementProof> {
    const control = this.active.get(input.identity.attemptId);
    if (control) {
      if (!sameIdentity(control.identity, input.identity)) return stopProof(input.identity, false);
      const hostProof = await terminate(control, input.deadlineEpochMs, this.groupGone);
      let namespaceResult: Awaited<ReturnType<typeof cleanupNamespace>> = null;
      try { namespaceResult = await cleanupNamespace(control, hostProof.processTree === 'stopped-and-reaped', input.deadlineEpochMs); }
      catch { /* Preserve host settlement; missing immutable receipt keeps cleanup unobserved. */ }
      const proof = settlementWithNamespace(input.identity, hostProof, control.namespace,
        namespaceResult?.proof ?? null, namespaceResult?.receipt);
      this.completed.set(input.identity.attemptId, proof);
      return proof;
    }
    const proof = this.completed.get(input.identity.attemptId);
    return proof && sameIdentity(proof, input.identity) ? proof : stopProof(input.identity, false);
  }
}

export function createIndependentJudgeProcessSupervisor(options?: IndependentJudgeProcessSupervisorOptions): IndependentJudgeProcessSupervisor {
  return new IndependentJudgeProcessSupervisor(options);
}
