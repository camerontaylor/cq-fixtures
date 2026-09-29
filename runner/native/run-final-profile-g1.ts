#!/usr/bin/env -S node --experimental-transform-types
/** Bounded final HTTP-only Codex G1 through the pinned review-loop runSuite task. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { createReviewLoopRepairTask } from '../../campaigns/cq-settings/corpus/review-loop-task.ts';
import { AggregateQuotaSource, CodexBarQuotaSource, type CodexBarReader } from '../campaign/codexbar.ts';
import { CodexAppServerQuotaAdapter, type CodexAppServerSessionFactory } from '../campaign/codex-app-server.ts';
import type { QuotaSnapshot } from '../campaign/quota.ts';
import { FileCampaignQueueStore } from '../campaign/persistence.ts';
import { CampaignScheduler, type QuotaSource } from '../campaign/scheduler.ts';
import { canonicalJson, experimentId, suiteTaskId, type ExperimentContext } from '../experiment.ts';
import { sha256 } from '../artifacts/index.ts';
import { createReviewLoopRunSuiteBundle } from '../workflow-corpus/review-loop-suite.ts';
import { runNativeConformanceSuite } from './conformance.ts';
import { CodexExecDriver } from './codex.ts';
import type { ObservedDriver } from './observation.ts';
import type { InvocationIdentity } from './observation.ts';
import {
  CODEX_FINAL_BOOTSTRAP, FINAL_BROKER_IMAGE, FINAL_BROKER_IDENTITY, FINAL_NATIVE_IMAGE,
  createFinalCodexSpawnAdapter, finalCodexArguments, validateFinalCodexAuth,
} from '../boundary/codex-final-profile.ts';
import { compileContainerBoundary, type ContainerBoundarySpec } from '../boundary/container.ts';
import type { TaskStageReceipt } from '../boundary/task-staging.ts';
import type { FrozenFinalProfileApproval } from '../campaign/final-profile-admission.ts';
import { freezeFinalProfileAdmission } from '../campaign/final-profile-admission.ts';
import { compareLaunchProfiles, readExecutableVersion, resolveLaunchExecutable, type LaunchComparison, type LaunchProfile } from './launch-inventory.ts';
import { resolveNativeLaunchInventory, type NativeLaunchInventory } from './inventory.ts';
import type { NativeSpawnContext, NativeSpawnAdapter } from './process.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOTAL_ASSIGNMENT_MS = 240_000;
const SETUP_BUDGET_MS = 60_000;
const MODEL_BUDGET_MS = 90_000;
const TEARDOWN_BUDGET_MS = 30_000;
const JUDGE_BUDGET_MS = 60_000;
const SOURCE_FILES = [
  'campaigns/cq-settings/corpus/review-loop-task.ts',
  'runner/workflow-corpus/review-loop-suite.ts', 'runner/workflow-corpus/review-loop-judge.ts',
  'runner/workflow-corpus/review-loop-pin.ts', 'runner/campaign/scheduler.ts',
  'runner/campaign/persistence.ts', 'runner/campaign/codexbar.ts', 'runner/campaign/codex-app-server.ts',
  'runner/experiment.ts', 'runner/native/run-final-profile-g1.ts', 'runner/native/codex.ts',
  'runner/native/process.ts', 'runner/native/conformance.ts', 'runner/native/observation.ts',
  'runner/index.ts', 'schema/result-row.schema.json', 'schema/comparison-table.schema.json',
  'runner/boundary/codex-final-profile.ts', 'runner/boundary/container.ts',
  'runner/boundary/container-prepare.ts', 'runner/boundary/task-session.ts',
  'runner/boundary/task-staging.ts', 'runner/campaign/final-profile-admission.ts',
  'runner/boundary/final-g1-runtime.mjs', 'runner/boundary/prepare-final-g1-runtime.mjs',
  'runner/boundary/evidence/fallback/final-profile-public-inputs.json',
];

export interface FinalProfileInvocationSetup {
  specification: ContainerBoundarySpec;
  staging: TaskStageReceipt;
  broker: { containerId: string; imageId: string; configPath: string };
  hostTaskRoot: string;
  exportRoot: string;
}

export interface FinalProfileSetupCleanupProof {
  status: 'stopped-and-reaped' | 'quarantined';
  /** null means cleanup timed out before the runtime could enumerate its owned resources. */
  resourceIds: string[] | null;
  volumeDisposition: 'disposed' | 'quarantined';
}

export interface FinalProfileSetupCleanupRequest {
  identity: NativeSpawnContext['identity'];
  reason: string;
  deadlineEpochMs: number;
  signal: AbortSignal;
}

export interface FinalProfileG1Options {
  outputRoot: string;
  configPath?: string;
  /** Parent-chosen immutable run label; it is part of assignment identity. */
  runId: string;
  admissionLedgerRoot: string;
  /** Parent independently checks the private expected inputs before returning this frozen approval. */
  approve: (request: {
    stage: 'final-profile-G1'; assignmentId: string; attemptId: string;
    sourcePin: string; boundaryIdentity: string; invocationIdentity: string;
  }) => Promise<FrozenFinalProfileApproval>;
  /** Stages the exact runSuite workspace and returns private S5 receipts. Values stay in memory. */
  prepareInvocation: (input: NativeSpawnContext) => Promise<FinalProfileInvocationSetup>;
  /** Must stop all invocation-owned provisioning and namespaces before disposing or quarantining volumes. */
  cleanupInvocation: (input: FinalProfileSetupCleanupRequest) => Promise<FinalProfileSetupCleanupProof>;
  quotaSource?: QuotaSource | null;
  launchInventory?: NativeLaunchInventory;
  executable?: string;
  now?: () => number;
}

/** Fresh authenticated, read-only sources used by the native schedulers. */
export function createFinalProfileQuotaSource(options: {
  now?: () => number;
  appServerSessionFactory?: CodexAppServerSessionFactory;
  codexBarReader?: CodexBarReader;
} = {}): QuotaSource {
  const now = options.now ?? Date.now;
  return new AggregateQuotaSource([
    new CodexAppServerQuotaAdapter(options.appServerSessionFactory, now),
    new CodexBarQuotaSource(options.codexBarReader, now),
  ], now);
}

/** Null is almost always an accidental boundary override; omission selects the real aggregate. */
export function resolveFinalProfileQuotaSource(
  override: QuotaSource | null | undefined,
  createDefault: () => QuotaSource = () => createFinalProfileQuotaSource(),
): QuotaSource {
  if (override === null) {
    throw new Error('final-profile quotaSource cannot be null; omit it to use authenticated quota sources');
  }
  return override ?? createDefault();
}

export class FinalProfileSetupFailure extends Error {
  readonly cleanupProof: FinalProfileSetupCleanupProof | null;

  constructor(message: string, cleanupProof: FinalProfileSetupCleanupProof | null, cause?: unknown) {
    super(message, { cause });
    this.name = 'FinalProfileSetupFailure';
    this.cleanupProof = cleanupProof;
  }
}

/**
 * Bounds provisioning separately from the assignment decision deadline.
 * On every failure it aborts the exact signal given to S5, then awaits the
 * runtime's namespace/staging cleanup contract for the remaining shutdown time.
 */
export async function runBoundedFinalProfileSetup<T>(input: {
  context: NativeSpawnContext;
  setupBudgetMs: number;
  shutdownBudgetMs: number;
  run: (context: NativeSpawnContext) => Promise<T>;
  cleanup: (request: FinalProfileSetupCleanupRequest) => Promise<FinalProfileSetupCleanupProof>;
}): Promise<T> {
  if (!Number.isFinite(input.setupBudgetMs) || input.setupBudgetMs < 1 ||
      !Number.isFinite(input.shutdownBudgetMs) || input.shutdownBudgetMs < 1) throw new RangeError('finite setup and shutdown budgets required');
  const started = Date.now();
  const setupDeadlineEpochMs = Math.min(input.context.deadlineEpochMs, started + input.setupBudgetMs);
  const setupController = new AbortController();
  const signal = AbortSignal.any([input.context.signal, setupController.signal]);
  const context: NativeSpawnContext = { ...input.context, deadlineEpochMs: setupDeadlineEpochMs, signal };
  let rejectSetup!: (error: Error) => void;
  const setupDeadline = new Promise<never>((_, reject) => { rejectSetup = reject; });
  void setupDeadline.catch(() => undefined);
  const rejectForAbort = () => rejectSetup(new Error('final-profile setup cancelled by its assignment signal'));
  input.context.signal.addEventListener('abort', rejectForAbort, { once: true });
  const setupTimer = setTimeout(() => {
    const error = new Error('final-profile setup deadline elapsed');
    setupController.abort(error);
    rejectSetup(error);
  }, Math.max(1, setupDeadlineEpochMs - Date.now()));
  const work = Promise.resolve().then(() => {
    if (signal.aborted || Date.now() >= setupDeadlineEpochMs) throw new Error('final-profile setup began after its deadline');
    return input.run(context);
  });
  try {
    const value = await Promise.race([work, setupDeadline]);
    if (signal.aborted || Date.now() >= setupDeadlineEpochMs) throw new Error('final-profile setup completed after its deadline');
    return value;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    setupController.abort(cause);
    const shutdownDeadlineEpochMs = Math.min(input.context.deadlineEpochMs, Date.now() + input.shutdownBudgetMs);
    const cleanupController = new AbortController();
    const cleanupTimer = setTimeout(() => cleanupController.abort(new Error('final-profile setup cleanup deadline elapsed')),
      Math.max(1, shutdownDeadlineEpochMs - Date.now()));
    let proof: FinalProfileSetupCleanupProof | null = null;
    let cleanupFailure: unknown;
    const cleanup = Promise.resolve().then(() => input.cleanup({
      identity: input.context.identity, reason, deadlineEpochMs: shutdownDeadlineEpochMs, signal: cleanupController.signal,
    }));
    try {
      proof = await Promise.race([
        cleanup,
        new Promise<never>((_, reject) => cleanupController.signal.addEventListener('abort', () => reject(cleanupController.signal.reason ?? new Error('setup cleanup deadline elapsed')), { once: true })),
      ]);
      if (!Array.isArray(proof.resourceIds) || !['disposed', 'quarantined'].includes(proof.volumeDisposition) ||
          !['stopped-and-reaped', 'quarantined'].includes(proof.status)) {
        throw new Error('runtime did not prove setup resources stopped before volume disposition');
      }
    } catch (error) { cleanupFailure = error; }
    finally { clearTimeout(cleanupTimer); }
    if (cleanupFailure) {
      throw new FinalProfileSetupFailure(
        `final-profile setup failed and resources are quarantined under invocation ${input.context.identity.invocationId}`,
        { status: 'quarantined', resourceIds: null, volumeDisposition: 'quarantined' },
        new AggregateError([cause, cleanupFailure], 'setup and bounded cleanup both failed'),
      );
    }
    if (proof?.status !== 'stopped-and-reaped') {
      throw new FinalProfileSetupFailure(
        `final-profile setup failed; runtime quarantined resources for invocation ${input.context.identity.invocationId}`,
        proof, cause,
      );
    }
    throw new FinalProfileSetupFailure(`final-profile setup aborted after awaited cleanup: ${reason}`, proof, cause);
  } finally {
    clearTimeout(setupTimer);
    input.context.signal.removeEventListener('abort', rejectForAbort);
  }
}

export interface FinalProfileG1Result {
  experimentId: string;
  assignmentId: string;
  reportPath: string;
  reportSha256: string;
  rows: unknown[];
  tables: unknown[];
}

/** Public pin function for independent parent preregistration. */
export async function finalProfileG1SourcePins(
  oracleDependencies: ReadonlyArray<{ path: string; sha256: string }> = [],
): Promise<{ pins: Record<string, string>; sourcePin: string }> {
  const pins: Record<string, string> = {};
  const paths = await discoverSourceDependencyClosure([...SOURCE_FILES, ...oracleDependencies.map((dependency) => dependency.path)]);
  for (const path of paths) {
    const bytes = await readFile(join(ROOT, path));
    const actual = sha256(bytes);
    const declared = oracleDependencies.find((dependency) => dependency.path === path)?.sha256;
    if (declared !== undefined && declared !== actual) throw new Error(`oracle manifest source changed: ${path}`);
    pins[path] = actual;
  }
  return { pins, sourcePin: sha256(canonicalJson(pins)) };
}

async function discoverSourceDependencyClosure(initialPaths: readonly string[]): Promise<string[]> {
  const pending = [...new Set(initialPaths)].map((path) => resolve(ROOT, path));
  const visited = new Set<string>();
  while (pending.length) {
    const candidate = pending.pop()!;
    const actual = await realpath(candidate);
    const relative = resolve(ROOT) === actual ? '' : actual.slice(resolve(ROOT).length + 1).replaceAll('\\', '/');
    if (!relative || relative.startsWith('../') || relative.startsWith('/')) throw new Error('source pin dependency escaped repository root');
    if (visited.has(relative)) continue;
    visited.add(relative);
    const source = await readFile(actual, 'utf8');
    const imports = new Set<string>();
    for (const match of source.matchAll(/\b(?:import|export)\s+(?:type\s+)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gsu)) {
      if (match[1]?.startsWith('.')) imports.add(match[1]);
    }
    for (const match of source.matchAll(/\bimport\s*['"]([^'"]+)['"]/gu)) {
      if (match[1]?.startsWith('.')) imports.add(match[1]);
    }
    for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
      if (match[1]?.startsWith('.')) imports.add(match[1]);
    }
    for (const specifier of imports) {
      const base = resolve(dirname(actual), specifier);
      const sourceBase = base.replace(/\.(?:mjs|cjs|js)$/u, '');
      const candidates = [base, `${sourceBase}.ts`, `${sourceBase}.tsx`, `${sourceBase}.mts`, `${sourceBase}.cts`, `${sourceBase}.js`, `${sourceBase}.json`, join(base, 'index.ts'), join(base, 'index.js')];
      for (const path of candidates) {
        try { await realpath(path); pending.push(path); break; } catch { /* try the next source extension */ }
      }
    }
  }
  return [...visited].sort();
}

export function finalProfileInvocationIdentity(input: {
  specification: ContainerBoundarySpec; cwd: string; budgetSeconds: number;
}): { boundaryIdentity: string; invocationIdentity: string; finalArgs: string[] } {
  const boundaryIdentity = compileContainerBoundary(input.specification).identity;
  const hostArgs = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'danger-full-access',
    '-C', resolve(input.cwd), '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort="low"', '-'];
  const finalArgs = finalCodexArguments(hostArgs, input.cwd);
  const invocationIdentity = createHash('sha256').update(JSON.stringify({
    boundaryIdentity, stage: 'final-profile-G1', executable: '/usr/local/bin/codex', args: finalArgs,
    bootstrap: sha256(CODEX_FINAL_BOOTSTRAP), budget: input.budgetSeconds,
  })).digest('hex');
  return { boundaryIdentity, invocationIdentity, finalArgs };
}

/** Exactly one diagnostic assignment. No adapter exists until parent approval is frozen. */
export async function runFinalProfileG1(options: FinalProfileG1Options): Promise<FinalProfileG1Result> {
  const now = options.now ?? Date.now;
  const started = now();
  const deadlineEpochMs = started + TOTAL_ASSIGNMENT_MS;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,95}$/u.test(options.runId)) throw new Error('parent runId must be a stable safe identity');
  const source = resolveFinalProfileQuotaSource(options.quotaSource, () => createFinalProfileQuotaSource({ now }));
  const abort = new AbortController();
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  void deadline.catch(() => undefined);
  const timeout = setTimeout(() => {
    const error = new Error('whole final-profile G1 assignment deadline elapsed');
    abort.abort(error); rejectDeadline(error);
  }, Math.max(1, deadlineEpochMs - Date.now()));
  const withinAssignment = <T>(work: Promise<T>): Promise<T> => Promise.race([work, deadline]);
  try {
  const outputRoot = resolve(options.outputRoot);
  const runDirectory = join(outputRoot, 'final-profile-g1', options.runId);
  const artifactRoot = join(runDirectory, 'artifacts');
  const queueDirectory = join(runDirectory, 'queue');
  const reportPath = join(runDirectory, 'final-profile-g1-report.json');
  await withinAssignment(Promise.all([
    mkdir(artifactRoot, { recursive: true, mode: 0o700 }), mkdir(queueDirectory, { recursive: true, mode: 0o700 }),
  ]).then(() => undefined));
  const taskPromise = createReviewLoopRepairTask({ model: 'gpt-6-sol', provider: 'codex' });
  const task = await withinAssignment(taskPromise).catch((error: unknown) => {
    void taskPromise.then((lateTask) => lateTask.cleanup()).catch(() => undefined); throw error;
  });
  const bundlePromise = createReviewLoopRunSuiteBundle(task);
  const bundle = await withinAssignment(bundlePromise).catch((error: unknown) => {
    void bundlePromise.then((lateBundle) => lateBundle.cleanup()).catch(() => undefined); throw error;
  });
  const quotaReads: Array<{ fetchedAt: string | null; providers: readonly unknown[] }> = [];
  const quotaSource: QuotaSource = { async refresh() {
    let snapshot: QuotaSnapshot | null = null;
    try { snapshot = await source.refresh(); } catch { /* represented as unknown telemetry */ }
    quotaReads.push({ fetchedAt: snapshot?.fetchedAt ?? null, providers: snapshot?.providers ?? [] });
    return snapshot;
  } };
  const queueStore = new FileCampaignQueueStore(queueDirectory);
  const scheduler = new CampaignScheduler({ store: queueStore, quota: quotaSource, clock: { now }, config: {
    maxConcurrentPerProvider: 1, reservationTtlMs: TOTAL_ASSIGNMENT_MS,
    maxTelemetryAgeMs: 60_000,
    diagnostic: { maxAttempts: 1, maxEstimatedUnits: 0, usedAttempts: 0, usedEstimatedUnits: 0, allowUnknownUsage: true },
  } });
  const prompt = bundle.suite.cases[0]?.task.prompt;
  if (!prompt) throw new Error('review-loop corpus did not provide a task prompt');
  const { pins: sourcePins, sourcePin } = await withinAssignment(finalProfileG1SourcePins(bundle.oraclePin.dependencies));
  const experiment = experimentId({
    track: 'final-profile-G1', sourcePins,
    corpusPin: `${task.sourceId}:${task.baselineId}:${task.baselineCommit}:${bundle.oraclePin.sha256}`,
    promptPin: sha256(prompt), judgePin: bundle.oraclePin.sha256,
    strategy: 'codex-exec-final-http-only-g1',
    settings: { model: 'gpt-6-sol', effort: 'low', provider: 'cq-subscription-http', sandbox: 'danger-full-access', scope: 'boundary', isolation: 'unverified' },
    profile: 'cq-subscription-http',
    budget: { totalWallClockMs: TOTAL_ASSIGNMENT_MS, setupMs: SETUP_BUDGET_MS, modelMs: MODEL_BUDGET_MS, teardownMs: TEARDOWN_BUDGET_MS, judgeMs: JUDGE_BUDGET_MS, maxAttempts: 1, maxTokens: null, hardTokenCap: false },
  });
  const assignmentId = `final-profile-g1-${options.runId}`;
  const stageId = `${assignmentId}-stage-1`;
  const attemptId = `${assignmentId}-attempt-1`;
  const caseId = bundle.suite.cases[0]!.id;
  await withinAssignment(scheduler.enqueue({ id: assignmentId, provider: 'codex', kind: 'validity', state: 'queued', dependencies: [],
    estimatedRuntimeMs: TOTAL_ASSIGNMENT_MS, estimatedUsageUnits: null, estimatedUsageConfidence: null,
    createdAt: new Date(now()).toISOString(), deadlineAt: new Date(deadlineEpochMs).toISOString(), stageId, attemptId, attemptIds: [attemptId] }));
  const decision = await withinAssignment(scheduler.admitNext());
  if (!decision?.admitted || !decision.reservation?.diagnostic || decision.reason !== 'bounded-unknown-usage-diagnostic-no-capacity-claim') {
    await bundle.cleanup(); await task.cleanup();
    throw new Error(`final-profile G1 was not admitted as one unknown-usage diagnostic: ${decision?.reason ?? 'no decision'}`);
  }
  
  const admission = decision.reservation.diagnostic;
  const identityContext: ExperimentContext = {
    campaignId: 'cq-settings-final-profile-g1', cohortId: 'final-profile-G1', experimentId: experiment,
    taskId: suiteTaskId(bundle.suite.name, task.substrateFamily), repeatId: options.runId,
    assignmentId, stageId, attemptId, track: 'final-profile-G1', strategyId: 'codex-exec-final-http-only-g1',
    settingsId: sha256('codex/gpt-6-sol/low/cq-subscription-http'),
    budgetId: sha256(canonicalJson({ totalWallClockMs: TOTAL_ASSIGNMENT_MS, setupMs: SETUP_BUDGET_MS, modelMs: MODEL_BUDGET_MS, teardownMs: TEARDOWN_BUDGET_MS, judgeMs: JUDGE_BUDGET_MS })),
    profileId: 'cq-subscription-http:boundary-unverified', frozenWeight: 1,
    substrateId: `${task.sourceId}:${task.baselineId}:${task.substrateFamily}`,
    judgeManifest: { sourcePin: bundle.oraclePin.sha256, dependencies: bundle.oraclePin.dependencies },
    caseAssignments: { [caseId]: { assignmentId, stageId, attemptId,
      substrateId: `${task.sourceId}:${task.baselineId}:${task.substrateFamily}`,
      judgeManifest: { sourcePin: bundle.oraclePin.sha256, dependencies: bundle.oraclePin.dependencies } } },
  };
  const executable = options.executable ?? '/usr/local/bin/codex';
  if (resolveLaunchExecutable(executable) !== '/usr/local/bin/codex') throw new Error('final-profile G1 requires the exact inventoried /usr/local/bin/codex executable');
  const accessProfile = options.launchInventory ?? resolveNativeLaunchInventory(options.configPath ?? join(homedir(), '.paseo', 'config.json'));
  const configured = accessProfile.configuredProfiles.find((profile) => profile.providerRoute.split(' ')[0] === 'codex' && profile.requestedModel?.toLowerCase() === 'gpt-6-sol');
  if (!configured) throw new Error('safe launch inventory lacks the configured Codex gpt-6-sol profile');
  const effective: LaunchProfile = {
    label: 'Final HTTP-only subscription G1', executable: '/usr/local/bin/codex', version: readExecutableVersion('/usr/local/bin/codex'),
    args: ['exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'danger-full-access', '-m', 'gpt-6-sol', 'effort=low', 'provider=cq-subscription-http'],
    envKeys: ['HOME', 'CODEX_HOME', 'LANG', 'PATH', 'TMPDIR'], cwdBehavior: 'isolated /task mapped from exact runSuite workspace',
    providerRoute: 'cq-subscription-http (HTTP-only managed subscription)', requestedModel: 'gpt-6-sol', authClass: 'managed-subscription access-only',
    effort: 'low', permissionPolicy: 'danger-full-access', sandboxPolicy: 'dedicated nonprivileged S5 container; isolation unverified',
    systemContext: null, tools: null, extensions: null, assistance: null, sessionBehavior: 'ephemeral Codex turn; runner workspace binding', feedbackBehavior: null,
  };
  const comparison: LaunchComparison = compareLaunchProfiles(configured, effective);
  let expectedTaskBaselineCommit: string | undefined;
  const driver = new CodexExecDriver({ executable, version: configured.version, profile: configured.label,
    model: 'gpt-6-sol', effort: 'low', hardWallClockMs: MODEL_BUDGET_MS,
    artifactDirectory: join(artifactRoot, 'native-events'), invocationStage: 'final-profile-G1', assignmentDeadlineEpochMs: deadlineEpochMs, signal: abort.signal,
    expectedTaskBaselineCommit: () => expectedTaskBaselineCommit,
    spawnAdapterFactory: (context) => runBoundedFinalProfileSetup({ context,
      setupBudgetMs: SETUP_BUDGET_MS, shutdownBudgetMs: TEARDOWN_BUDGET_MS,
      cleanup: options.cleanupInvocation,
      run: async (setupContext) => {
      if (setupContext.identity.assignmentId !== assignmentId || setupContext.identity.attemptId !== attemptId || setupContext.stage !== 'final-profile-G1') throw new Error('native invocation differs from the frozen G1 assignment');
      const setup = await options.prepareInvocation(setupContext);
      if (setupContext.signal.aborted || Date.now() >= setupContext.deadlineEpochMs) throw new Error('assignment setup budget elapsed during final-profile preparation');
      if (resolve(setup.hostTaskRoot) !== resolve(context.cwd)) throw new Error('S5 staged workspace must be the exact runSuite host workspace');
      if (setup.specification.image !== FINAL_NATIVE_IMAGE || setup.broker.imageId !== FINAL_BROKER_IMAGE ||
          setup.specification.network.brokerIdentity !== FINAL_BROKER_IDENTITY || setup.specification.taskVolume !== setup.staging.taskVolume ||
          setup.specification.contextVolume !== setup.staging.contextVolume || setup.specification.stagingEvidence !== setup.staging.receiptHash) {
        throw new Error('S5 runtime receipts differ from the frozen public final-profile inputs');
      }
      const sourceHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: context.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (sourceHead !== setup.staging.baselineCommit) throw new Error('S5 stage baseline differs from the runSuite workspace baseline');
      expectedTaskBaselineCommit = setup.staging.baselineCommit;
      const privateAuth = setup.staging.context.entries.find((entry) => entry.path === 'auth.json');
      if (!privateAuth || privateAuth.kind !== 'file' || typeof privateAuth.data !== 'string') throw new Error('private staged access-only auth is unavailable');
      validateFinalCodexAuth(Buffer.from(privateAuth.data, 'base64').toString('utf8'), Math.ceil((deadlineEpochMs - Date.now()) / 1000));
      const computed = finalProfileInvocationIdentity({ specification: setup.specification, cwd: context.cwd, budgetSeconds: MODEL_BUDGET_MS / 1000 });
      const approval = await withinAssignment(options.approve({ stage: 'final-profile-G1', assignmentId, attemptId, sourcePin,
        boundaryIdentity: computed.boundaryIdentity, invocationIdentity: computed.invocationIdentity }));
      
      if (approval.assignmentId !== assignmentId || approval.attemptId !== attemptId || approval.sourcePin !== sourcePin ||
          approval.receipt.stage !== 'final-profile-G1' || approval.receipt.boundaryIdentity !== computed.boundaryIdentity ||
          approval.receipt.invocationIdentity !== computed.invocationIdentity) throw new Error('parent frozen approval does not match this source, assignment and exact S5 launch');
      const admit = await withinAssignment(freezeFinalProfileAdmission(options.admissionLedgerRoot, approval));
      const finalAdapter = createFinalCodexSpawnAdapter({ ...setup, budgetSeconds: MODEL_BUDGET_MS / 1000,
        stage: 'final-profile-G1', admit: async (request) => {
      if (setupContext.signal.aborted || Date.now() >= setupContext.deadlineEpochMs) throw new Error('assignment deadline elapsed before final-profile admission');
          return admit(request);
        } });
      const adapter: NativeSpawnAdapter = async (command, args, launchContext) => {
        if (setupContext.signal.aborted || Date.now() >= deadlineEpochMs) throw new Error('assignment deadline elapsed before native transport');
        return finalAdapter(command, args, launchContext);
      };
      const wrappedAdapter: NativeSpawnAdapter = async (command, args, launchContext) => ({
        ...await adapter(command, args, launchContext), profileInvocationIdentity: computed.invocationIdentity,
      });
      return wrappedAdapter;
    } }),
  });
  const capture = new Map<string, { workspace: string; baselineCommit: string; candidateCommit: string | null }>();
  const corpusWrapped = bundle.wrapDriver(driver);
  const wrapped = new Proxy(corpusWrapped, {
    get(target, property) {
      if (property === 'beginInvocation') return (identity: InvocationIdentity) => driver.beginInvocation(identity);
      if (property === 'getObservation') return (id: string) => driver.getObservation(id);
      if (property === 'cancelInvocationAndWait') return driver.cancelInvocationAndWait;
      if (property === 'campaignBudgetCapabilities') return driver.campaignBudgetCapabilities;
      if (property === 'nativeTransport') return driver.nativeTransport;
      if (property === 'configuredNativeTarget') return driver.configuredNativeTarget;
      if (property === 'run') return async (invocation: OpInvocation): Promise<WorkerResult> => {
        const workspace = invocation.prompt.match(/^workspace: (.+)$/mu)?.[1];
        if (!workspace) throw new Error('runSuite did not bind a workspace to final-profile G1');
        const result = await target.run(invocation);
        if (abort.signal.aborted || Date.now() >= deadlineEpochMs) throw new Error('whole-assignment deadline elapsed before runSuite candidate capture');
        const baselineCommit = bundle.pinnedBaselineCommit(workspace);
        if (!baselineCommit) throw new Error('review-loop host baseline pin was not captured');
        capture.set(workspace, { workspace, baselineCommit, candidateCommit: bundle.pinnedCandidateCommit(workspace) ?? null });
        return result;
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as typeof driver & Driver & ObservedDriver;
  let finished = false;
  try {
    await withinAssignment(scheduler.markRunning(assignmentId, decision.reservation.id));
    const run = runNativeConformanceSuite({
      suiteDir: bundle.suiteDir, repoRoot: bundle.repoRoot, artifactRoot, driver: wrapped,
      hostCheckScoringEnvironment: (workspace, baseline) => bundle.hostCheckScoringEnvironment(workspace, baseline),
      model: 'gpt-6-sol', provider: 'codex', driverName: 'codex-exec', checkTimeoutMs: JUDGE_BUDGET_MS,
      experiment: identityContext, expectedCaseIds: [caseId], expectedInvocations: [{ assignmentId, stageId, attemptId }], expectedTransport: 'codex-exec',
    });
    const result = await withinAssignment(run);
    if (Date.now() > deadlineEpochMs) throw new Error('whole-assignment deadline elapsed before final-profile report');
    const observations = result.observations.map(({ observation, artifact }) => ({ observation, observationArtifact: artifact,
      baselineCommit: observation.capture.baselineCommit, baselineTree: observation.capture.baselineTree,
      candidateCommit: [...capture.values()][0]?.candidateCommit ?? null }));
    const launchEvidence = observations.map(({ observation }) => observation.model.settings.launch?.value).filter(Boolean);
    for (const item of launchEvidence) {
      const launch = item as { scope?: unknown; isolation?: unknown; heldOut?: unknown; taskExport?: {
        inventoryHash?: unknown; head?: unknown; publication?: { destination?: unknown; baselineCommit?: unknown; baselineTree?: unknown;
          hostUnchanged?: unknown; afterTeardown?: unknown; captureEligible?: unknown };
      } };
      if (launch.scope !== 'boundary' || launch.isolation !== 'unverified' || launch.heldOut !== false ||
          !/^[a-f0-9]{64}$/u.test(String(launch.taskExport?.inventoryHash ?? '')) || !/^[a-f0-9]{40,64}$/u.test(String(launch.taskExport?.head ?? '')) ||
          resolve(String(launch.taskExport?.publication?.destination ?? '')) !== resolve([...capture.values()][0]?.workspace ?? '') ||
          launch.taskExport?.publication?.baselineCommit !== observations[0]?.baselineCommit ||
          !/^[a-f0-9]{40,64}$/u.test(String(launch.taskExport?.publication?.baselineTree ?? '')) ||
          launch.taskExport?.publication?.hostUnchanged !== true || launch.taskExport?.publication?.afterTeardown !== true ||
          launch.taskExport?.publication?.captureEligible !== true) {
        throw new Error('final-profile G1 lacks completed stop, exact-workspace publication, and baseline evidence');
      }
    }
    if (launchEvidence.length !== 1) throw new Error('final-profile G1 requires exactly one native boundary observation');
    const report = {
      schemaVersion: 1, status: 'complete', visibleOnly: false, heldOut: false, stage: 'final-profile-G1',
      createdAt: new Date(now()).toISOString(), experimentId: experiment, runId: options.runId,
      assignment: { assignmentId, stageId, attemptId, admissionReason: decision.reason, diagnostic: admission,
        finalAdmissionId: (launchEvidence[0] as { admissionId?: string }).admissionId ?? null },
      profile: { model: 'gpt-6-sol', effort: 'low', provider: 'cq-subscription-http', sandbox: 'danger-full-access',
        launchScope: 'boundary', isolation: 'unverified' },
      task: { taskId: task.id, sourceId: task.sourceId, baselineId: task.baselineId, sourceBaselineCommit: task.baselineCommit,
        pinnedBaselines: observations.map(({ baselineCommit, baselineTree }) => ({ baselineCommit, baselineTree })), oraclePin: bundle.oraclePin },
      pins: { sourcePins, sourcePin, promptSha256: sha256(prompt), oracleSha256: bundle.oraclePin.sha256,
        publicFinalProfileInputsSha256: sha256(await readFile(join(ROOT, 'runner/boundary/evidence/fallback/final-profile-public-inputs.json'))) },
      budget: { totalWallClockMs: TOTAL_ASSIGNMENT_MS, setupMs: SETUP_BUDGET_MS, modelMs: MODEL_BUDGET_MS, teardownMs: TEARDOWN_BUDGET_MS, judgeMs: JUDGE_BUDGET_MS,
        hardDecisionDeadline: true, wholeAssignmentResourceLifetimeEnforced: false,
        lateWorkDisposition: 'decision-cutoff; assignment quarantined; candidate capture and complete report forbidden after cutoff',
        frozenLaneEligible: false, schedulerMaxAttempts: 1, maxTokens: null, hardTokenCap: false, usage: 'unknown-usage-no-capacity-claim' },
      quotaReads, profileComparison: comparison,
      launchProfiles: { configured, effective },
      runDirectory, artifactRoot, queueDirectory, rows: result.rows, tables: result.tables,
      observations, absences: result.absences, diagnostics: result.diagnostics,
    };
    const bytes = `${JSON.stringify(report, null, 2)}\n`;
    await withinAssignment(writeCreateOnly(reportPath, bytes));
    const reportSha256 = sha256(bytes);
    await withinAssignment(scheduler.complete(assignmentId, `${reportPath}#sha256=${reportSha256}`));
    finished = true;
    return { experimentId: experiment, assignmentId, reportPath, reportSha256, rows: result.rows, tables: result.tables };
  } catch (error) {
    if (!finished) {
      const failure = { schemaVersion: 1, status: 'failed', heldOut: false, stage: 'final-profile-G1',
        assignment: { assignmentId, stageId, attemptId }, quotaReads,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), artifacts: artifactRoot };
      await writeCreateOnly(reportPath, `${JSON.stringify(failure, null, 2)}\n`).catch(() => undefined);
      const assignments = await queueStore.listAssignments();
      if (assignments.find((item) => item.id === assignmentId)?.state === 'running') {
        await scheduler.quarantine(assignmentId, { quarantinedAt: new Date(now()).toISOString(), reason: 'partial-invocation',
          unresolvedUsage: true, partialArtifactRefs: [reportPath, artifactRoot], knownUsageUnits: null });
      }
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    abort.abort();
    if (finished) { await bundle.cleanup(); await task.cleanup(); }
  }
  } finally {
    if (timeout) clearTimeout(timeout);
    abort.abort();
  }
}

async function writeCreateOnly(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  const parent = await open(dirname(path), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}

export async function runFinalProfileG1Cli(modulePath: string): Promise<FinalProfileG1Result> {
  if (!modulePath || modulePath.startsWith('-')) throw new Error('trusted private runtime module path required');
  const imported = await import(pathToFileURL(resolve(modulePath)).href) as { createFinalProfileG1Runtime?: () => Promise<FinalProfileG1Options> | FinalProfileG1Options };
  if (typeof imported.createFinalProfileG1Runtime !== 'function') throw new Error('runtime module must export createFinalProfileG1Runtime()');
  return runFinalProfileG1(await imported.createFinalProfileG1Runtime());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const modulePath = process.argv[2];
  if (modulePath === undefined) throw new Error('usage: node --experimental-transform-types runner/native/run-final-profile-g1.ts <private-runtime-module.mjs>');
  runFinalProfileG1Cli(modulePath).then((result) => process.stdout.write(`${JSON.stringify({ ...result, rows: result.rows.length, tables: result.tables.length })}\n`))
    .catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
