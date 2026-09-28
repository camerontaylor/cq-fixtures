#!/usr/bin/env node
/** One-route, visible-only G1 calibration through the verified runSuite corpus. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { createReviewLoopRepairTask } from '../../campaigns/cq-settings/corpus/review-loop-task.ts';
import { AggregateQuotaSource, CodexBarQuotaSource } from '../campaign/codexbar.ts';
import { CodexAppServerQuotaAdapter } from '../campaign/codex-app-server.ts';
import { FileCampaignQueueStore } from '../campaign/persistence.ts';
import { CampaignScheduler, type QuotaSource } from '../campaign/scheduler.ts';
import type { QuotaSnapshot } from '../campaign/quota.ts';
import { experimentId, suiteTaskId } from '../experiment.ts';
import { createReviewLoopRunSuiteBundle } from '../workflow-corpus/review-loop-suite.ts';
import type { ExperimentContext } from '../experiment.ts';
import { runNativeConformanceSuite } from './conformance.ts';
import { CodexExecDriver } from './codex.ts';
import { PiNativeDriver } from './pi.ts';
import { ZcodeAcpDriver } from './zcode.ts';
import { resolveNativeLaunchInventory, type LaunchProfile, type NativeLaunchInventory } from './index.ts';
import type { ObservedDriver } from './observation.ts';
import type { ObservedNativeDriver } from './observed-driver.ts';
import { sha256 } from '../artifacts/index.ts';
import { assertOutsideGlmBlackout } from './zcode.ts';

export type VisibleG1Route = 'codex' | 'pi-json' | 'pi-rpc' | 'glm';
type NativeRouteName = 'codex' | 'pi-opencode' | 'zcode';

export interface VisibleG1BoundaryEvidence {
  scope: 'visible-calibration';
  isolation: 'disabled';
  heldOut: false;
  evidenceRef: string;
}

export interface VisibleG1Options {
  route: VisibleG1Route;
  driver: ObservedNativeDriver;
  boundary: VisibleG1BoundaryEvidence;
  outputRoot: string;
  /** Tests inject a null quota source; live runs use both native read sources. */
  quotaSource?: QuotaSource;
  launchInventory?: NativeLaunchInventory;
  configPath?: string;
  now?: () => number;
}

export interface VisibleG1Result {
  experimentId: string;
  route: VisibleG1Route;
  runDirectory: string;
  reportPath: string;
  queueDirectory: string;
  rows: unknown[];
  tables: unknown[];
}

interface RouteSpec {
  transport: string;
  provider: 'codex' | 'opencodego' | 'zai';
  model: string;
  taskProvider: string;
  rowDriver: 'codex-exec' | 'pi-json' | 'pi-rpc' | 'zcode-acp';
  strategy: string;
  profileRoute: NativeRouteName;
  bridgeLabel: string;
}

const ROUTES: Readonly<Record<VisibleG1Route, RouteSpec>> = {
  codex: {
    transport: 'codex-exec', provider: 'codex', model: 'gpt-6-luna', taskProvider: 'codex',
    rowDriver: 'codex-exec', strategy: 'codex-exec-visible-g1', profileRoute: 'codex', bridgeLabel: 'Codex native exec bridge',
  },
  'pi-json': {
    transport: 'pi-json', provider: 'opencodego', model: 'opencode-go/space-bunny-free', taskProvider: 'opencode-go',
    rowDriver: 'pi-json', strategy: 'pi-opencode-go-json-visible-g1', profileRoute: 'pi-opencode', bridgeLabel: 'Pi JSON bridge',
  },
  'pi-rpc': {
    transport: 'pi-rpc', provider: 'opencodego', model: 'opencode-go/space-bunny-free', taskProvider: 'opencode-go',
    rowDriver: 'pi-rpc', strategy: 'pi-opencode-go-rpc-visible-g1', profileRoute: 'pi-opencode', bridgeLabel: 'Pi RPC bridge',
  },
  glm: {
    transport: 'zcode-acp', provider: 'zai', model: 'GLM-5.3-Flash', taskProvider: 'zai',
    rowDriver: 'zcode-acp', strategy: 'zcode-glm-flash-visible-g1', profileRoute: 'zcode', bridgeLabel: 'ZCode ACP bridge',
  },
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_PINS = [
  'campaigns/cq-settings/corpus/review-loop-task.ts',
  'runner/workflow-corpus/review-loop-suite.ts',
  'runner/workflow-corpus/review-loop-judge.ts',
  'runner/workflow-corpus/review-loop-pin.ts',
  'runner/campaign/scheduler.ts',
  'runner/campaign/persistence.ts',
  'runner/campaign/codexbar.ts',
  'runner/campaign/codex-app-server.ts',
  'runner/experiment.ts',
  'runner/native/run-visible-g1.ts',
  'runner/native/visible-g1-codex-driver.ts',
  'runner/native/codex.ts',
  'runner/native/process.ts',
  'runner/native/launch-inventory.ts',
  'runner/native/conformance.ts',
  'runner/native/observation.ts',
  'runner/index.ts',
  'schema/result-row.schema.json',
  'schema/comparison-table.schema.json',
];

/** Fresh read-only telemetry. This deliberately has no reset-credit consumer. */
export function freshAggregateQuotaSource(clock: () => number = Date.now): QuotaSource {
  return new AggregateQuotaSource([
    new CodexAppServerQuotaAdapter(),
    new CodexBarQuotaSource(undefined, clock),
  ], clock);
}

/**
 * Run one immutable route assignment. The caller must provide a real configured
 * native bridge and a visible container boundary receipt; there is no ACP or
 * unconfined fallback hidden in this entrypoint.
 */
export async function runVisibleG1(options: VisibleG1Options): Promise<VisibleG1Result> {
  const spec = ROUTES[options.route];
  if (!spec) throw new Error(`unsupported visible G1 route '${String(options.route)}'`);
  if (options.boundary.scope !== 'visible-calibration' || options.boundary.isolation !== 'disabled' ||
      options.boundary.heldOut !== false || !options.boundary.evidenceRef.trim()) {
    throw new Error('visible G1 requires an explicitly admitted, visible-calibration lifecycle receipt');
  }
  if (options.driver.nativeTransport !== spec.transport) {
    throw new Error(`route ${options.route} requires native transport ${spec.transport}; received ${options.driver.nativeTransport}`);
  }
  if (options.route === 'glm') assertOutsideGlmBlackout(new Date(options.now?.() ?? Date.now()));

  const now = options.now ?? Date.now;
  const runKey = randomUUID();
  const modelSpec = { model: spec.model, provider: spec.taskProvider };
  const task = await createReviewLoopRepairTask(modelSpec);
  const bundle = await createReviewLoopRunSuiteBundle(task);
  await stageJudgeManifest(bundle.repoRoot, bundle.oraclePin);
  const runDirectory = join(resolve(options.outputRoot), options.route, runKey);
  const artifactRoot = join(runDirectory, 'artifacts');
  const queueDirectory = join(runDirectory, 'queue');
  const reportPath = join(runDirectory, 'visible-g1-report.json');
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  await mkdir(queueDirectory, { recursive: true, mode: 0o700 });

  const launchInventory = options.launchInventory ?? resolveNativeLaunchInventory(
    options.configPath ?? join(homedir(), '.paseo', 'config.json'),
  );
  const comparison = launchInventory.comparisons.find((item) => item.target === spec.bridgeLabel ||
    (options.route === 'pi-json' && item.target === 'Pi JSON bridge') ||
    (options.route === 'pi-rpc' && item.target === 'Pi RPC bridge'));
  if (!comparison) throw new Error(`launch inventory omitted the configured comparison for ${options.route}`);
  const bridgeProfile = launchInventory.proposedBridges.find((profile) => profile.label === comparison.target);
  const configuredProfile = launchInventory.configuredProfiles.find((profile) =>
    profile.providerRoute.split(' ')[0] === spec.profileRoute &&
    (spec.profileRoute !== 'pi-opencode' || profile.requestedModel?.toLowerCase().includes('space-bunny-free')) &&
    (spec.profileRoute !== 'zcode' || /glm-5\.3-flash/iu.test(profile.requestedModel ?? '')) &&
    (spec.profileRoute !== 'codex' || /gpt-6-luna/iu.test(profile.requestedModel ?? '')),
  );
  if (!bridgeProfile || !configuredProfile) throw new Error(`launch inventory could not resolve both selected profiles for ${options.route}`);

  const sourcePins = await hashSourcePins();
  const prompt = bundle.suite.cases[0]?.task.prompt;
  if (!prompt) throw new Error('review-loop runSuite bundle has no task prompt');
  const settings = {
    route: options.route,
    model: spec.model,
    requestedEffort: options.route === 'codex' ? 'low' : 'high',
    configuredProfile: configuredProfile.label,
    bridgeProfile: bridgeProfile.label,
    profileComparison: comparison.comparison,
    boundary: options.boundary,
  };
  const budget = { wallClockMs: 120_000, maxAttempts: 1, maxTokens: null, hardTokenCap: false };
  const identity = experimentId({
    track: 'visible-g1-calibration', sourcePins,
    corpusPin: `${task.sourceId}:${task.baselineId}:${task.baselineCommit}:${bundle.oraclePin.sha256}`,
    promptPin: sha256(prompt), judgePin: bundle.oraclePin.sha256,
    strategy: spec.strategy, settings, profile: comparison.comparison, budget,
  });
  const experimentRunId = `visible-g1-${identity.slice('exp-'.length, 'exp-'.length + 16)}-${runKey}`;
  const assignmentId = `${experimentRunId}-assignment`;
  const stageId = `${experimentRunId}-stage-1`;
  const attemptId = `${experimentRunId}-attempt-1`;
  const queueStore = new FileCampaignQueueStore(queueDirectory);
  const source = options.quotaSource ?? freshAggregateQuotaSource(now);
  const quotaReads: Array<ReturnType<typeof quotaDiagnostic>> = [];
  const recordingQuotaSource: QuotaSource = {
    async refresh() {
      let snapshot: QuotaSnapshot | null;
      try { snapshot = await source.refresh(); } catch { snapshot = null; }
      quotaReads.push(quotaDiagnostic(snapshot));
      return snapshot;
    },
  };
  const scheduler = new CampaignScheduler({
    store: queueStore,
    quota: recordingQuotaSource,
    clock: { now },
    config: {
      maxConcurrentPerProvider: 1,
      reservationTtlMs: 150_000,
      maxTelemetryAgeMs: 60_000,
      diagnostic: { maxAttempts: 1, maxEstimatedUnits: 0, usedAttempts: 0, usedEstimatedUnits: 0, allowUnknownUsage: true },
    },
  });
  await scheduler.enqueue({
    id: assignmentId, provider: spec.provider, kind: 'validity', state: 'queued', dependencies: [],
    estimatedRuntimeMs: 120_000, estimatedUsageUnits: null, estimatedUsageConfidence: null,
    createdAt: new Date(now()).toISOString(), deadlineAt: new Date(now() + 125_000).toISOString(),
    stageId, attemptId, attemptIds: [attemptId],
  });
  const admission = await scheduler.admitNext();
  if (!admission?.admitted || !admission.reservation?.diagnostic || admission.reason !== 'bounded-unknown-usage-diagnostic-no-capacity-claim') {
    throw new Error(`visible G1 assignment was not admitted as explicit unknown-usage diagnostic: ${admission?.reason ?? 'no decision'}`);
  }
  await scheduler.markRunning(assignmentId, admission.reservation.id);

  const caseId = bundle.suite.cases[0]!.id;
  const experiment: ExperimentContext = {
    campaignId: 'cq-settings-visible-g1', cohortId: 'visible-calibration', experimentId: identity,
    taskId: suiteTaskId(bundle.suite.name, task.substrateFamily), repeatId: runKey,
    assignmentId, stageId, attemptId, track: 'visible-g1-calibration', strategyId: spec.strategy,
    settingsId: sha256(JSON.stringify(settings)), budgetId: sha256(JSON.stringify(budget)),
    profileId: launchInventory.comparisons.find((item) => item.target === comparison.target)!.comparison.status,
    frozenWeight: 1,
    caseAssignments: { [caseId]: {
      assignmentId, stageId, attemptId,
      substrateId: `${task.sourceId}:${task.baselineId}:${task.substrateFamily}`,
      judgeManifest: { sourcePin: bundle.oraclePin.sha256, dependencies: bundle.oraclePin.dependencies },
    } },
    substrateId: `${task.sourceId}:${task.baselineId}:${task.substrateFamily}`,
    judgeManifest: { sourcePin: bundle.oraclePin.sha256, dependencies: bundle.oraclePin.dependencies },
  };

  // The corpus adapter must retain the S1 identity and retrieval seam. It also
  // establishes the pinned baseline/oracle host environment before scoring.
  const corpusWrapped = bundle.wrapDriver(options.driver);
  const workspaceEvidence = new Map<string, { baselineCommit: string; candidateCommit: string | null }>();
  const nativeDriver = new Proxy(corpusWrapped, {
    get(target, property) {
      if (property === 'beginInvocation') return (value: Parameters<typeof options.driver.beginInvocation>[0]) => options.driver.beginInvocation(value);
      if (property === 'getObservation') return (invocationId: string) => options.driver.getObservation(invocationId);
      if (property === 'cancelInvocationAndWait') return options.driver.cancelInvocationAndWait;
      if (property === 'campaignBudgetCapabilities') return options.driver.campaignBudgetCapabilities;
      if (property === 'nativeTransport') return options.driver.nativeTransport;
      if (property === 'configuredNativeTarget') return options.driver.configuredNativeTarget;
      if (property === 'run') return async (invocation: OpInvocation): Promise<WorkerResult> => {
      const workspacePath = invocation.prompt.match(/^workspace: (.+)$/mu)?.[1];
      if (!workspacePath) throw new Error('runSuite did not bind the case workspace to its native invocation');
      const result = await target.run(invocation);
      const baselineCommit = bundle.pinnedBaselineCommit(workspacePath);
      if (!baselineCommit) throw new Error('runSuite corpus wrapper did not pin a pristine baseline before native dispatch');
      workspaceEvidence.set(workspacePath, {
        baselineCommit,
        candidateCommit: bundle.pinnedCandidateCommit(workspacePath) ?? null,
      });
      return result;
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as typeof options.driver & Driver & ObservedDriver;

  let runFinished = false;
  try {
    const result = await runNativeConformanceSuite({
      suiteDir: bundle.suiteDir,
      repoRoot: bundle.repoRoot,
      artifactRoot,
      driver: nativeDriver,
      hostCheckScoringEnvironment: (workspacePath, baselineCommit) =>
        bundle.hostCheckScoringEnvironment(workspacePath, baselineCommit),
      model: spec.model,
      provider: spec.taskProvider,
      driverName: spec.rowDriver,
      checkTimeoutMs: 60_000,
      experiment,
      expectedCaseIds: [caseId],
      expectedInvocations: [{ assignmentId, stageId, attemptId }],
      expectedTransport: spec.transport,
    });
    const candidateCommit = [...workspaceEvidence.values()][0]?.candidateCommit ?? null;
    const observations = result.observations.map(({ observation, artifact }) => ({
      observation,
      observationArtifact: artifact,
      baselineCommit: observation.capture.baselineCommit,
      baselineTree: (observation.capture as typeof observation.capture & { baselineTree?: string | null }).baselineTree ?? null,
      candidateCommit,
    }));
    const launchEvidence = observations.flatMap(({ observation }) => {
      const launch = observation.model.settings.launch?.value;
      return launch && typeof launch === 'object' ? [launch] : [];
    });
    for (const evidence of launchEvidence) {
      const launch = evidence as { isolation?: unknown; scope?: unknown; heldOut?: unknown };
      if (launch.isolation !== 'disabled' || launch.scope !== 'visible-calibration' || launch.heldOut !== false) {
        throw new Error('visible G1 launch evidence must retain visible-calibration, isolation-disabled status');
      }
    }
    const report = {
      schemaVersion: 1,
      status: 'complete',
      visibleOnly: true,
      heldOut: false,
      createdAt: new Date(now()).toISOString(),
      route: options.route,
      transport: spec.transport,
      provider: spec.provider,
      model: spec.model,
      requestedEffort: settings.requestedEffort,
      requestedPermissionProfile: options.route === 'codex' ? 'configured Sol fullaccess' : options.route === 'glm' ? 'ZCode yolo' : 'Pi configured high',
      experimentId: identity,
      experimentRunId,
      assignment: { assignmentId, stageId, attemptId, admissionReason: admission.reason, diagnostic: admission.reservation.diagnostic },
      task: {
        taskId: task.id, substrateFamily: task.substrateFamily, sourceId: task.sourceId,
        baselineId: task.baselineId, sourceBaselineCommit: task.baselineCommit,
        pinnedBaselineCommits: observations.map((item) => ({ commit: item.baselineCommit, tree: item.baselineTree })),
        oraclePin: bundle.oraclePin,
      },
      pins: { sourcePins, promptSha256: sha256(prompt), judgeSha256: bundle.oraclePin.sha256, launchInventorySha256: sha256(JSON.stringify(launchInventory)) },
      budget: { ...budget, schedulerDiagnosticMaxAttempts: 1, usagePolicy: 'unknown-usage-no-capacity-claim' },
      quotaReads,
      boundary: { ...options.boundary, status: 'visible-only-unconfined', visibleOnly: true },
      profileComparison: comparison.comparison,
      launchProfiles: { configured: configuredProfile, bridge: bridgeProfile },
      runDestination: runDirectory,
      artifactDestination: artifactRoot,
      queueDestination: queueDirectory,
      rows: result.rows,
      tables: result.tables,
      observations,
      absences: result.absences,
      diagnostics: result.diagnostics,
    };
    await writeCreateOnly(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await scheduler.complete(assignmentId, `${reportPath}#sha256=${sha256(JSON.stringify(report))}`);
    runFinished = true;
    return { experimentId: identity, route: options.route, runDirectory, reportPath, queueDirectory, rows: result.rows, tables: result.tables };
  } catch (error) {
    if (!runFinished) {
      const failure = {
        schemaVersion: 1, status: 'failed', visibleOnly: true, heldOut: false,
        route: options.route, transport: spec.transport, experimentId: identity, experimentRunId,
        assignment: { assignmentId, stageId, attemptId, admissionReason: admission.reason },
        boundary: { ...options.boundary, status: 'visible-only-unconfined' },
        quotaReads, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        artifactDestination: artifactRoot,
      };
      await writeCreateOnly(reportPath, `${JSON.stringify(failure, null, 2)}\n`);
      const assignments = await queueStore.listAssignments();
      if (assignments.find((item) => item.id === assignmentId)?.state === 'running') {
        await scheduler.quarantine(assignmentId, {
          quarantinedAt: new Date(now()).toISOString(), reason: 'partial-invocation', unresolvedUsage: true,
          partialArtifactRefs: [reportPath], knownUsageUnits: null,
        });
      }
    }
    throw error;
  } finally {
    // The runner has already persisted rows, tables, observations and candidate
    // artifacts. Keep corpus materialization on failure for private diagnosis.
    if (runFinished) {
      await bundle.cleanup();
      await task.cleanup();
    }
  }
}

async function hashSourcePins(): Promise<Record<string, string>> {
  const pins: Record<string, string> = {};
  for (const relative of SOURCE_PINS) pins[relative] = sha256(await readFile(join(REPO_ROOT, relative)));
  return pins;
}

/** Stage only hash-verified judge dependencies where runSuite validates its manifest. */
async function stageJudgeManifest(
  bundleRepoRoot: string,
  manifest: { dependencies: ReadonlyArray<{ path: string; sha256: string }> },
): Promise<void> {
  for (const dependency of manifest.dependencies) {
    const source = join(REPO_ROOT, dependency.path);
    const contents = await readFile(source);
    if (sha256(contents) !== dependency.sha256) throw new Error(`review-loop judge dependency changed after pinning: ${dependency.path}`);
    const destination = join(bundleRepoRoot, dependency.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, contents, { flag: 'wx', mode: 0o600 });
  }
}

function quotaDiagnostic(snapshot: QuotaSnapshot | null) {
  return {
    fetchedAt: snapshot?.fetchedAt ?? null,
    providers: (snapshot?.providers ?? []).map((provider) => ({
      provider: provider.provider, observedAt: provider.observedAt, telemetryAvailable: provider.telemetryAvailable,
      source: provider.source,
      windows: provider.windows.map((window) => ({
        id: window.id, observedAt: window.observedAt, resetsAt: window.resetsAt,
        remainingFraction: window.remainingFraction, remainingUnits: window.remainingUnits,
        unit: window.unit, binding: window.binding, source: window.source,
      })),
    })),
  };
}

async function writeCreateOnly(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(contents); await handle.sync(); }
  finally { await handle.close(); }
}

async function main(argv: string[]): Promise<void> {
  const routeArg = readArg(argv, '--route') as VisibleG1Route | undefined;
  const moduleArg = readArg(argv, '--driver-module');
  const outputRoot = readArg(argv, '--output-root') ?? join(REPO_ROOT, 'research execution', 'visible-g1-runs');
  const configPath = readArg(argv, '--paseo-config') ?? join(homedir(), '.paseo', 'config.json');
  if (!routeArg || !Object.hasOwn(ROUTES, routeArg) || !moduleArg) {
    throw new Error('usage: node --experimental-strip-types runner/native/run-visible-g1.ts --route codex|pi-json|pi-rpc|glm --driver-module <trusted-boundary-module> [--output-root <dir>] [--paseo-config <file>]');
  }
  const modulePath = isAbsolute(moduleArg) ? moduleArg : resolve(process.cwd(), moduleArg);
  const loaded = await import(pathToFileURL(modulePath).href) as {
    createVisibleG1Driver(input: { route: VisibleG1Route; outputRoot: string }): Promise<{
      driver: ObservedNativeDriver;
      boundary: VisibleG1BoundaryEvidence;
      quotaSource?: QuotaSource;
      launchInventory?: NativeLaunchInventory;
    }>;
  };
  if (typeof loaded.createVisibleG1Driver !== 'function') throw new Error('driver module must export createVisibleG1Driver');
  const created = await loaded.createVisibleG1Driver({ route: routeArg, outputRoot });
  if ((routeArg === 'codex' && !(created.driver instanceof CodexExecDriver)) ||
      ((routeArg === 'pi-json' || routeArg === 'pi-rpc') && !(created.driver instanceof PiNativeDriver)) ||
      (routeArg === 'glm' && !(created.driver instanceof ZcodeAcpDriver))) {
    throw new Error(`--driver-module must return the configured native bridge for ${routeArg}; fake drivers are test-only`);
  }
  if (routeArg === 'pi-json' && created.driver.nativeTransport !== 'pi-json' ||
      routeArg === 'pi-rpc' && created.driver.nativeTransport !== 'pi-rpc') {
    throw new Error(`Pi route ${routeArg} does not match the configured native transport`);
  }
  const result = await runVisibleG1({
    route: routeArg, driver: created.driver, boundary: created.boundary,
    outputRoot, configPath,
    ...(created.quotaSource ? { quotaSource: created.quotaSource } : {}),
    ...(created.launchInventory ? { launchInventory: created.launchInventory } : {}),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function readArg(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function visibleG1TestInventory(profile: LaunchProfile): NativeLaunchInventory {
  const bridge = {
    ...profile,
    label: 'Codex native exec bridge',
    requestedModel: 'gpt-6-luna',
    effort: 'low',
    permissionPolicy: 'OpInvocation fixer allowlist',
    sandboxPolicy: 'per-invocation workspace-write',
    cwdBehavior: 'runner SessionStore workspace; Codex turn ephemeral',
    args: ['exec', '--json', '--ephemeral', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="low"'],
  };
  return {
    generatedAt: new Date(0).toISOString(), configuredProfiles: [profile], proposedBridges: [bridge],
    comparisons: [{ target: 'Codex native exec bridge', comparison: {
      status: 'intentionally-altered', changed: ['effort', 'permissionPolicy', 'sandboxPolicy'], unknown: [],
      configured: profile, bridge,
    } }],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
