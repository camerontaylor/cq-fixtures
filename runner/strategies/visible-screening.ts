/** Visible-only same-model review-loop screening through S4 and the S1 runner. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Driver, OpInvocation } from '@camerontaylor/cq-toolkit';
import { createNativeStrategyExecutor, type NativeObservedDriver, type NativeSupervisorControl, type IndependentJudgeSettlementProof } from './executor.ts';
import { createIndependentJudgeProcessSupervisor, loadPinnedJudgeOwnership } from './judge-process.ts';
import type { IndependentJudgeExecution } from './executor.ts';
import type { ReviewLoopJudgeProcessRequest } from './judge-protocol.ts';
import {
  defineBudgetTiers, runStrategy, type Candidate, type ExecutorResult, type PerTaskBudgetTier,
  type StageRequest, type StrategyRoute, type StrategyResult, unknownUsage,
} from './index.ts';

export const VISIBLE_REVIEW_LOOP_LIMITS = Object.freeze({
  modelStageMs: 120_000,
  independentJudgeMs: 60_000,
  decisionDeadlineEnforced: true,
  totalWallClockEnforced: false,
  independentJudgeTotalEnforced: false,
  totalEnforcementReason: 'The strategy decision has a finite deadline; its cleanup window is separate and global external resource lifetime is not enforced.',
  boundedCleanupWindowMs: 30_000,
  globalResourceLifetimeEnforced: false,
  tokenEnforcement: 'unsupported' as const,
  tiers: defineBudgetTiers([
    { id: 'visible-small', maxAttempts: 4, maxStages: 6, wallClockMs: 480_000, judgementAllowanceMs: 60_000, shutdownAllowanceMs: 20_000, observationAllowanceMs: 20_000, captureAllowanceMs: 20_000 },
    { id: 'visible-medium', maxAttempts: 4, maxStages: 6, wallClockMs: 600_000, judgementAllowanceMs: 60_000, shutdownAllowanceMs: 30_000, observationAllowanceMs: 30_000, captureAllowanceMs: 30_000 },
    { id: 'visible-large', maxAttempts: 4, maxStages: 6, wallClockMs: 720_000, judgementAllowanceMs: 60_000, shutdownAllowanceMs: 30_000, observationAllowanceMs: 30_000, captureAllowanceMs: 30_000 },
  ]),
});

export interface VisibleReviewLoopOptions {
  /** Already configured native driver; this entrypoint never resolves credentials or launches by itself. */
  driver: Driver & NativeObservedDriver;
  supervisor: NativeSupervisorControl;
  route: StrategyRoute & { transport: 'codex-exec' | 'pi-json' | 'pi-rpc' | 'zcode-acp' };
  model: string;
  provider: string;
  effort: string;
  profileId: string;
  settingsId: string;
  evaluationBoundaryHash: string;
  toolsAssistanceHash: string;
  tierId: PerTaskBudgetTier['id'];
  assignmentId: string;
  /** Frozen parent run/repeat namespace; scopes stage IDs and report artifacts. */
  runNamespace: string;
  /** Optional pinned S1 source checkout for standalone strategy worktrees. */
  s1DependencyRoot?: string;
  outputRoot: string;
}

export interface VisibleReviewLoopResult {
  schemaVersion: 1;
  status: 'complete' | 'incomplete';
  visibleOnly: true;
  heldOut: false;
  experimentId: string;
  runIdentity: string;
  runNamespace: string;
  reportPath: string;
  strategy: StrategyResult;
  /** Authoritative S1 join of native strategy evidence and the frozen host judgement. */
  taskOutcome: unknown;
  rows: readonly unknown[];
  tables: readonly unknown[];
  pipelineEvidence: {
    mappingStatus: 'mapped';
    candidateCorrectness: boolean | null;
    formatCompliance: boolean | null;
    assignedStrategySuccess: boolean | null;
    operationalStatus: StrategyResult['operationalStatus'];
    execution: {
      launched: boolean | null;
      terminalCause: StrategyResult['operationalStatus'];
      sourceInvocationIds: readonly string[];
    };
    protectedOracleCleanup: {
      status: 'proven' | 'unobserved';
      planSha256: string | null;
      daemonVerified: boolean;
      ownershipVerified: boolean;
      containersAbsent: boolean;
      volumeDisposition: 'quarantined' | 'absent' | 'unproven';
      resourceIds: readonly string[];
      inventoryContentVerified: false;
      receipt: { path: string; sha256: string } | null;
    };
    stages: readonly {
      stageId: string; attemptId: string; invocationId: string | null; status: string;
      launched: boolean | null; terminalCause: string | null;
      transportException: { name: string; message: string } | null;
      usage: StrategyResult['stages'][number]['usage'];
    }[];
    usage: StrategyResult['accounting']['usage'];
  };
  localJudge: {
    evidenceClass: 'local-judge-only';
    pipelineCampaignEvidence: false;
    modelUsage: 'not-a-model-observation';
    outcome: S1TaskOutcome | null;
    rows: readonly S1Row[];
    tables: readonly unknown[];
    diagnostics: readonly string[];
  };
  limits: typeof VISIBLE_REVIEW_LOOP_LIMITS;
  resourceCleanup: 'complete' | 'quarantined' | 'unproven';
}

interface S1TaskOutcome {
  identity: Record<string, unknown>;
  candidateCorrectness: boolean | null;
  assignedStrategySuccess: boolean | null;
  formatConformance: boolean | null;
  operationalStatus: string;
  judgements: readonly S1Judgement[];
}
interface S1Judgement {
  judgementId: string;
  version: number;
  judgePin: string;
  judgeManifest: { sourcePin: string; dependencies: readonly { path: string; sha256: string }[] };
  baselineCommit: string | null;
  baselineTree: string | null;
  candidateSha256: string;
  candidateCorrectness: boolean | null;
  formatConformance: boolean | null;
  assignedStrategySuccess: boolean | null;
  operationalStatus: string;
  artifact: { path: string; sha256: string };
}
interface S1Row { case: string; taskOutcome?: S1TaskOutcome; experiment?: Record<string, unknown>; [key: string]: unknown; }
interface S1RunSuiteResult { rows: S1Row[]; tables: unknown[]; diagnostics?: string[]; }
interface S1ExperimentContext {
  campaignId: string; cohortId: string; experimentId: string; taskId: string; repeatId: string;
  assignmentId: string; stageId: string; attemptId: string; track: string; strategyId: string;
  settingsId: string; budgetId: string; profileId: string; frozenWeight: number; substrateId: string;
  judgeManifest: { sourcePin: string; dependencies: readonly { path: string; sha256: string }[] };
}
interface S1MappingResult { taskOutcome: unknown; rows: unknown[]; tables: unknown[]; }
type PipelineCounter = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'tokenTotal';
interface S1PipelineUsageCounter {
  value: number | null;
  availability: string;
  semantics: string;
  inclusion: string | null;
}
interface S1PipelineStage {
  assignmentId: string; stageId: string; attemptId: string; invocationId: string | null;
  kind: string; routeId: string | null; status: string; launched: boolean | null;
  terminalCause: string | null; transportException: { name: string; message: string } | null;
  usage: Record<PipelineCounter, S1PipelineUsageCounter>;
}
interface S1PipelineMappingInput {
  strategy: {
    assignmentId: string; taskId: string; finalCandidate: { sha256: string | null } | null;
    candidateCorrectness: boolean | null; operationalStatus: StrategyResult['operationalStatus'];
    authorizedBudgetStop: boolean; stages: readonly S1PipelineStage[]; accounting: { endToEndMs: number };
  };
  judgeResult: S1RunSuiteResult;
  caseId: string;
  context: S1ExperimentContext;
  selection: { judgementId: string; version: number; judgePin: string; candidateSha256: string } | null;
  recipeEvidence: { formatConformance: boolean | null; assignedStrategySuccess: boolean | null };
  pipelineJudgementArtifact?: { judgementId: string; version: number; artifact: { path: string; sha256: string } };
  rowMetadata: { role: 'fixer-worker'; suite: string; case: string; model: string; driver: string; runId: string; timestamp: string; expectedCases: number };
  stageEvidence: Readonly<Record<string, { artifacts: readonly { kind: string; path: string; sha256: string }[]; observation?: { path: string; sha256: string } }>>;
}
interface ReviewTask {
  id: string;
  sourceId: string;
  baselineId: string;
  oracleId: string;
  substrateFamily: string;
  worktreePath: string;
  baselineCommit: string;
  modelSpec: { model: string; provider: string };
  operationInput: { item: { body: string }; [key: string]: unknown };
  cleanup(): Promise<void>;
}
interface ReviewBundle {
  suiteDir: string;
  repoRoot: string;
  suite: { name: string; cases: { id: string; task: { prompt: string } }[] };
  oraclePin: { sha256: string; dependencies: readonly { path: string; sha256: string }[] };
  wrapDriver(driver: Driver): Driver;
  hostCheckScoringEnvironment(workspace: string, baseline: string): unknown;
  cleanup(): Promise<void>;
}
interface S1Bindings {
  REVIEW_LOOP_SOURCE_ID: string;
  REVIEW_LOOP_BASELINE_ID: string;
  createReviewLoopRepairTask(input: { model: string; provider: string }, root: string): Promise<ReviewTask>;
  executeReviewLoopRepairTask(task: ReviewTask, driver: Driver): Promise<{ status: string; error?: unknown; reason?: unknown; value?: unknown }>;
  runSuite(input: Record<string, unknown>): Promise<S1RunSuiteResult>;
  mapPipelineCampaignEvidence(input: S1PipelineMappingInput): S1MappingResult;
  ArtifactStore: new (root: string) => { write(context: S1ExperimentContext, name: string, content: string | Buffer): { path: string; sha256: string } };
  experimentId(input: unknown): string;
  suiteTaskId(suite: string, task: string): string;
  createReviewLoopRunSuiteBundle(task: ReviewTask, root: string): Promise<ReviewBundle>;
}
interface CandidateWorkspace { path: string; baselineCommit: string; baselineTree: string; }

const DRIVER_LABEL: Record<VisibleReviewLoopOptions['route']['transport'], string> = {
  'codex-exec': 'codex-exec', 'pi-json': 'pi-json', 'pi-rpc': 'pi-rpc', 'zcode-acp': 'zcode-acp',
};
const S1_TASK_SOURCE = 'campaigns/cq-settings/corpus/review-loop-task.ts';
const S1_SUITE_SOURCE = 'runner/workflow-corpus/review-loop-suite.ts';

function isS1DependencyRoot(root: string): boolean {
  return existsSync(join(root, S1_TASK_SOURCE)) && existsSync(join(root, S1_SUITE_SOURCE));
}

export function resolveS1DependencyRoot(explicitRoot?: string): string {
  if (typeof explicitRoot !== 'string' || explicitRoot.trim().length === 0) {
    throw new Error('S1 integration root unavailable in this repository; pass a pinned s1DependencyRoot');
  }
  const root = resolve(explicitRoot);
  if (!isS1DependencyRoot(root)) {
    throw new Error('S1 integration root unavailable in this repository; pass a pinned s1DependencyRoot');
  }
  return root;
}

/** Load the sibling S1 integration at runtime so this runner package keeps its own build boundary. */
async function loadS1Bindings(root: string): Promise<S1Bindings> {
  const at = (path: string): string => pathToFileURL(join(root, path)).href;
  const [corpus, runner, experiment, suite, artifacts] = await Promise.all([
    import(at('campaigns/cq-settings/corpus/review-loop-task.ts')),
    import(at('runner/index.ts')),
    import(at('runner/experiment.ts')),
    import(at('runner/workflow-corpus/review-loop-suite.ts')),
    import(at('runner/artifacts/index.ts')),
  ]);
  return { ...corpus, ...runner, ...experiment, ...suite, ...artifacts } as unknown as S1Bindings;
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function visibleRunIdentity(experimentId: string, assignmentId: string, runNamespace: string): string {
  return hash(`${experimentId}\0${assignmentId}\0${runNamespace}`);
}

/**
 * Run one frozen review-loop assignment. The caller supplies the admitted native
 * driver and S2 stop proof; this module provides no public or live-call effect.
 */
export async function runVisibleReviewLoopScreening(options: VisibleReviewLoopOptions): Promise<VisibleReviewLoopResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.assignmentId)) throw new Error('assignmentId must be a path-safe frozen roster ID');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.runNamespace)) throw new Error('runNamespace must be a path-safe frozen roster ID');
  if (options.route.tokenEnforcement !== 'unsupported') throw new Error('visible screening cannot claim whole-pipeline token enforcement');
  if (!options.route.supportedSettings?.effort?.includes(options.effort)) throw new Error(`route does not attest effort '${options.effort}'`);
  const tier = VISIBLE_REVIEW_LOOP_LIMITS.tiers.find((entry) => entry.id === options.tierId);
  if (!tier) throw new Error(`unknown frozen visible screening tier '${options.tierId}'`);
  const tempRoot = mkdtempSync(join(tmpdir(), 'cq-visible-strategy-'));
  const outputRoot = resolve(options.outputRoot);
  mkdirSync(outputRoot, { recursive: true });
  const artifactRoot = join(outputRoot, 'artifacts');
  const privateArtifactRoot = join(tempRoot, 's1-artifacts');
  mkdirSync(privateArtifactRoot, { recursive: true });
  const s1Root = resolveS1DependencyRoot(options.s1DependencyRoot);
  const s1 = await loadS1Bindings(s1Root);
  const artifactStore = new s1.ArtifactStore(artifactRoot);
  const independentJudgeSupervisor = createIndependentJudgeProcessSupervisor({ privateRoot: tempRoot });
  const task = await s1.createReviewLoopRepairTask({ model: options.model, provider: options.provider }, tempRoot);
  let bundle: ReviewBundle | undefined;
  const workspaceByAttempt = new Map<string, CandidateWorkspace>();
  const judgeResultsByAttempt = new Map<string, S1RunSuiteResult>();
  const judgeArtifactRoots: string[] = [];
  const judgeResultHashes = new Map<string, { requestSha256?: string; payloadSha256?: string;
    protectedOracleProof?: IndependentJudgeExecution['evidence']['protectedOracleProof'];
    protectedOracleCleanupReceipt?: { path: string; sha256: string; privatePath?: string } }>();
  let seedTree = '';
  let preserveForRecovery = false;
  let cleanupAttempted = false;
  try {
    bundle = await s1.createReviewLoopRunSuiteBundle(task, tempRoot);
    stageJudgeManifest(s1Root, bundle.repoRoot, bundle.oraclePin.dependencies);
    seedTree = git(task.worktreePath, ['rev-parse', `${task.baselineCommit}^{tree}`]);
    const prompt = bundle.suite.cases[0]?.task.prompt;
    if (!prompt) throw new Error('review-loop suite is missing its task prompt');
    const recipe = { kind: 'same-model-verify-repair' as const, route: { ...options.route, selectedEffort: options.effort }, maxRepairs: 1 };
    const budget = { ...tier, modelStageMs: VISIBLE_REVIEW_LOOP_LIMITS.modelStageMs,
      independentJudgeMs: VISIBLE_REVIEW_LOOP_LIMITS.independentJudgeMs, totalWallClockEnforced: false,
      tokenEnforcement: 'unsupported' as const };
    const identity = s1.experimentId({
      track: 'visible-review-loop-screening',
      sourcePins: {
        task: hash(readFileSync(join(s1Root, S1_TASK_SOURCE))),
        suite: hash(readFileSync(join(s1Root, S1_SUITE_SOURCE))),
        judge: bundle.oraclePin.sha256,
      },
      corpusPin: `${s1.REVIEW_LOOP_SOURCE_ID}:${s1.REVIEW_LOOP_BASELINE_ID}:${task.baselineCommit}:${seedTree}`,
      promptPin: hash(prompt), judgePin: bundle.oraclePin.sha256,
      strategy: recipe,
      settings: { route: options.route, model: options.model, provider: options.provider, effort: options.effort, settingsId: options.settingsId },
      profile: { profileId: options.profileId, boundaryHash: options.evaluationBoundaryHash, toolsAssistanceHash: options.toolsAssistanceHash },
      budget,
    });
    const experimentRunId = identity;
    const substrateId = `${s1.REVIEW_LOOP_SOURCE_ID}:${s1.REVIEW_LOOP_BASELINE_ID}:campaign-settings-module-v1`;
    const judgeManifest = { sourcePin: bundle.oraclePin.sha256, dependencies: bundle.oraclePin.dependencies };
    const judgeOwnership = await loadPinnedJudgeOwnership(s1Root, judgeManifest);
    if (bundle.suite.cases.length < 1 || bundle.suite.cases.length > 8) {
      throw new Error('protected judge suite exceeds the S5 namespace slot limit');
    }
    let frozenSelection: { judgementId: string; version: number; judgePin: string; candidateSha256: string } | null = null;

    const allocateClone = (workspaceId: string, attemptId: string): CandidateWorkspace => {
      const clonePath = join(tempRoot, `candidate-${safe(attemptId)}`);
      if (!existsSyncPath(clonePath)) execFileSync('git', ['clone', '--quiet', '--no-hardlinks', task.worktreePath, clonePath]);
      const baselineCommit = git(clonePath, ['rev-parse', 'HEAD']);
      const baselineTree = git(clonePath, ['rev-parse', `${baselineCommit}^{tree}`]);
      if (baselineCommit !== task.baselineCommit || baselineTree !== seedTree) throw new Error('candidate workspace did not preserve the exact frozen baseline seed');
      void workspaceId;
      return { path: clonePath, baselineCommit, baselineTree };
    };

    const executor = createNativeStrategyExecutor(options.driver as unknown as Parameters<typeof createNativeStrategyExecutor>[0], {
      async runStage(request, driver): Promise<ExecutorResult> {
        const modelDriver = driver as unknown as Driver;
        if (request.kind === 'independent-judge') {
          throw new Error('independent judge stages must use the serializable child process supervisor');
        }

        const workspace = allocateClone(request.workspaceId, request.attemptId);
        workspaceByAttempt.set(request.attemptId, workspace);
        const prior = request.inputCandidates[0];
        if (prior) applyPatch(workspace.path, patchOf(prior));
        if (request.kind === 'verify') {
          const promptText = [
            'Review the candidate in the supplied read-only workspace against the review request and visible tests.',
            'Return JSON with boolean "passed" and string "feedback". Do not edit files.',
            `Review request: ${task.operationInput.item.body}`,
            `Candidate patch SHA-256: ${prior?.sha256 ?? 'missing'}`,
            `workspace: ${workspace.path}`,
          ].join('\n\n');
          const started = performance.now();
          const invocation: OpInvocation = {
            prompt: promptText, modelSpec: { model: options.model, provider: options.provider },
            toolPolicy: { allow: [], mode: 'none' }, sandboxPolicy: { level: 'read-only' }, budget: {},
          };
          const response = await bounded(request, VISIBLE_REVIEW_LOOP_LIMITS.modelStageMs, () => modelDriver.run(invocation));
          const structured = response.structuredOutput as { passed?: unknown; feedback?: unknown } | undefined;
          const verification = typeof structured?.passed === 'boolean'
            ? { passed: structured.passed, feedback: typeof structured.feedback === 'string' ? structured.feedback : 'Verifier supplied no feedback.' }
            : undefined;
          return { status: response.stopReason === 'complete' ? 'completed' : response.stopReason === 'aborted' ? 'cancelled' : 'failed',
            usage: unknownUsage(), serviceTimeMs: performance.now() - started,
            launched: true, verification, output: response.structuredOutput };
        }

        const stageTask = {
          ...task,
          worktreePath: workspace.path,
          operationInput: {
            ...task.operationInput,
            item: { ...task.operationInput.item,
              body: `${task.operationInput.item.body}${request.kind === 'repair' ? `\n\nRepair feedback: ${request.feedback ?? 'Address remaining review concerns.'}` : ''}` },
            worktree: { path: workspace.path, branch: `s4/${safe(request.attemptId)}` },
            driver: { model: options.model, provider: options.provider },
          },
        };
        const started = performance.now();
        const operation = await bounded(request, VISIBLE_REVIEW_LOOP_LIMITS.modelStageMs,
          () => s1.executeReviewLoopRepairTask(stageTask, modelDriver));
        if (operation.status !== 'ok') {
          const detail = operation.status === 'failed' ? operation.error : operation.status === 'needs-human' ? operation.reason : 'operation returned no result';
          return { status: 'failed', usage: unknownUsage(), serviceTimeMs: performance.now() - started,
            launched: true, operationalError: { name: 'ReviewLoopOperationFailure', message: String(detail) } };
        }
        return { status: 'completed', usage: unknownUsage(), serviceTimeMs: performance.now() - started,
          launched: true, output: operation.value };
      },
      captureCandidate(request) {
        if (request.kind !== 'draft' && request.kind !== 'repair') return null;
        const workspace = workspaceByAttempt.get(request.attemptId);
        if (!workspace) return null;
        const patch = captureGitCandidatePatch(workspace.path, workspace.baselineCommit, workspace.baselineTree, task.worktreePath);
        if (!patch) return null;
        const digest = hash(patch);
        return { id: `candidate-${digest.slice(0, 24)}`, sha256: digest, workspaceId: request.workspaceId,
          workspace, value: { patch, baselineCommit: workspace.baselineCommit, baselineTree: workspace.baselineTree } };
      },
      createCandidateWorkspace(request, _index, stableWorkspaceId) {
        return { id: stableWorkspaceId, handle: allocateClone(stableWorkspaceId, request.attemptId) };
      },
      supervisor: options.supervisor,
      prepareIndependentJudgeRequest(request): ReviewLoopJudgeProcessRequest {
        const candidate = request.inputCandidates[0];
        const patch = candidate && (candidate.value as { patch?: unknown }).patch;
        if (!candidate || typeof patch !== 'string' || hash(patch) !== candidate.sha256) {
          throw new Error('independent judge requires a captured, hash-validated candidate patch');
        }
        const candidateWorkspace = candidate.workspace as CandidateWorkspace;
        const revalidatedPatch = captureGitCandidatePatch(candidateWorkspace.path, task.baselineCommit, seedTree, task.worktreePath);
        if (hash(revalidatedPatch) !== candidate.sha256) throw new Error('candidate workspace no longer matches its captured patch');
        const modulePath = join(candidateWorkspace.path, 'settings/module.js');
        const moduleStat = lstatSync(modulePath);
        if (!moduleStat.isFile() || moduleStat.isSymbolicLink()) throw new Error('candidate settings/module.js must be a regular file');
        const candidateInventoryHash = judgeOwnership.stableJudgeCandidateInventory('settings/module.js', readFileSync(modulePath)).inventoryHash;
        const experiment: S1ExperimentContext = {
          campaignId: 'cq-settings-visible-screening', cohortId: 'visible-calibration', experimentId: experimentRunId,
          taskId: s1.suiteTaskId(bundle!.suite.name, substrateId), repeatId: hash(options.runNamespace).slice(0, 16),
          assignmentId: request.assignmentId, stageId: request.stageId, attemptId: request.attemptId,
          track: 'visible-review-loop-screening', strategyId: identity, settingsId: options.settingsId,
          budgetId: tier.id, profileId: options.profileId, frozenWeight: 1, substrateId, judgeManifest,
        };
        const shutdownDeadlineEpochMs = request.deadlineEpochMs + request.tier.shutdownAllowanceMs;
        if (!Number.isSafeInteger(request.deadlineEpochMs) || !Number.isSafeInteger(request.tier.shutdownAllowanceMs)
          || request.tier.shutdownAllowanceMs <= 0 || !Number.isSafeInteger(shutdownDeadlineEpochMs)
          || shutdownDeadlineEpochMs <= request.deadlineEpochMs) {
          throw new Error('Independent judge deadlines must be ordered safe integer epoch milliseconds');
        }
        return {
          schemaVersion: 1, identity: { assignmentId: request.assignmentId, stageId: request.stageId, attemptId: request.attemptId },
          deadlineEpochMs: request.deadlineEpochMs,
          shutdownDeadlineEpochMs,
          s1DependencyRoot: s1Root,
          task: {
            id: task.id, sourceId: task.sourceId, baselineId: task.baselineId, oracleId: task.oracleId,
            substrateFamily: task.substrateFamily, worktreePath: task.worktreePath,
            baselineCommit: task.baselineCommit, modelSpec: task.modelSpec,
            operationInput: task.operationInput as unknown as Readonly<Record<string, unknown>>,
          },
          model: options.model, provider: options.provider,
          driverName: DRIVER_LABEL[options.route.transport], checkTimeoutMs: VISIBLE_REVIEW_LOOP_LIMITS.independentJudgeMs,
          taskSourceSha256: hash(readFileSync(join(s1Root, S1_TASK_SOURCE))),
          suiteSourceSha256: hash(readFileSync(join(s1Root, S1_SUITE_SOURCE))),
          baselineCommit: task.baselineCommit, baselineTree: seedTree,
          sourceId: s1.REVIEW_LOOP_SOURCE_ID, baselineId: s1.REVIEW_LOOP_BASELINE_ID,
          suiteName: bundle!.suite.name, caseId: bundle!.suite.cases[0]!.id,
          promptSha256: hash(bundle!.suite.cases[0]!.task.prompt), oraclePin: bundle!.oraclePin.sha256,
          taskFixtureFiles: ['package.json', 'settings/module.js', 'settings/display.js', 'test/public-settings.test.mjs']
            .map((path) => ({ path, sha256: hash(readFileSync(join(task.worktreePath, path))) })),
          judgeManifest, experiment, candidateInventoryHash, namespaceSlotCount: bundle!.suite.cases.length,
          candidate: { sha256: candidate.sha256, patch, baselineCommit: task.baselineCommit, baselineTree: seedTree },
        };
      },
      onIndependentJudgeEvidence(request, evidence) {
        const result: S1RunSuiteResult = {
          rows: evidence.rows as S1Row[], tables: [...evidence.tables], diagnostics: [...evidence.diagnostics],
        };
        frozenSelection = evidence.selection;
        judgeResultsByAttempt.set(request.attemptId, result);
        // Retain only the private child artifact root until S1 evidence is promoted below.
        judgeArtifactRoots.push(evidence.artifactRoot);
        judgeResultHashes.set(request.attemptId, { requestSha256: evidence.requestSha256, payloadSha256: evidence.payloadSha256,
          protectedOracleProof: evidence.protectedOracleProof,
          protectedOracleCleanupReceipt: evidence.protectedOracleCleanupReceipt });
      },
      onIndependentJudgeSettlement(identity, proof: IndependentJudgeSettlementProof) {
        judgeResultHashes.set(identity.attemptId, {
          ...(proof.protectedOracleProof ? { protectedOracleProof: {
            ...proof.protectedOracleProof, inventoryContentVerified: false as const,
          } } : {}),
          ...(proof.protectedOracleCleanupReceipt ? { protectedOracleCleanupReceipt: proof.protectedOracleCleanupReceipt } : {}),
        });
      },
      independentJudgeSupervisor,
    });

    const strategyTask = {
      id: `${s1.REVIEW_LOOP_SOURCE_ID}:${s1.REVIEW_LOOP_BASELINE_ID}`,
      prompt,
      evaluationTrack: 'native' as const,
      workspace: { path: task.worktreePath, baselineCommit: task.baselineCommit, baselineTree: seedTree },
      campaignIdentity: {
        profileInventoryHash: options.profileId, evaluationBoundaryHash: options.evaluationBoundaryHash,
        scaffoldAssistanceHash: options.toolsAssistanceHash, sourcePin: bundle.oraclePin.sha256,
        corpusPin: `${task.baselineCommit}:${seedTree}`, judgePin: bundle.oraclePin.sha256,
        runNamespace: options.runNamespace,
      },
      requireFormatCompliance: true,
    };
    const strategy = await runStrategy(strategyTask, recipe, tier, executor, { assignmentId: options.assignmentId });
    preserveForRecovery = strategy.stages.some((stage) => stage.quarantined);
    const judgeStage = strategy.stages.find((stage) => stage.kind === 'independent-judge');
    const cleanupReceipt = judgeStage ? judgeResultHashes.get(judgeStage.attemptId)?.protectedOracleCleanupReceipt : undefined;
    if (!preserveForRecovery) {
      promoteArtifactTree(privateArtifactRoot, artifactRoot);
      for (const judgeArtifactRoot of judgeArtifactRoots) promoteArtifactTree(judgeArtifactRoot, artifactRoot);
    }
    if (cleanupReceipt?.privatePath) promoteCleanupReceipt({ ...cleanupReceipt, privatePath: cleanupReceipt.privatePath }, outputRoot);
    const assignedCaseId = bundle!.suite.cases[0]!.id;
    const runIdentity = visibleRunIdentity(identity, options.assignmentId, options.runNamespace);
    const selectedHostJudgement = frozenSelection as { judgementId: string; version: number; judgePin: string; candidateSha256: string } | null;
    const modelStages = strategy.stages.filter((stage) => stage.routeId !== null);
    const finalResult = judgeStage ? judgeResultsByAttempt.get(judgeStage.attemptId) : undefined;
    const localOutcome = finalResult?.rows.find((row) => row.case === assignedCaseId)?.taskOutcome ?? null;
    const mappingContext: S1ExperimentContext = {
      campaignId: 'cq-settings-visible-screening', cohortId: 'visible-calibration', experimentId: experimentRunId,
      taskId: s1.suiteTaskId(bundle!.suite.name, substrateId), repeatId: hash(options.runNamespace).slice(0, 16),
      assignmentId: options.assignmentId,
      stageId: judgeStage?.stageId ?? `judge-${runIdentity.slice(0, 24)}`,
      attemptId: judgeStage?.attemptId ?? 'not-launched',
      track: 'visible-review-loop-screening', strategyId: identity, settingsId: options.settingsId,
      budgetId: tier.id, profileId: options.profileId, frozenWeight: 1, substrateId, judgeManifest,
    };
    const stageEvidence: Record<string, { artifacts: readonly { kind: string; path: string; sha256: string }[] }> = {};
    for (const stage of modelStages) {
      if (!stage.invocationId) throw new Error(`native stage ${stage.stageId}/${stage.attemptId} has no invocation ID`);
      stageEvidence[stage.invocationId] = { artifacts: [] };
    }
    const mapInput: S1PipelineMappingInput = {
      strategy: {
        assignmentId: strategy.assignmentId, taskId: strategy.taskId,
        finalCandidate: strategy.finalCandidate ? { sha256: strategy.finalCandidate.sha256 } : null,
        candidateCorrectness: strategy.candidateCorrectness, operationalStatus: strategy.operationalStatus,
        authorizedBudgetStop: strategy.authorizedBudgetStop,
        stages: strategy.stages.map((stage) => ({
          assignmentId: stage.assignmentId, stageId: stage.stageId, attemptId: stage.attemptId,
          invocationId: stage.invocationId, kind: stage.kind, routeId: stage.routeId, status: stage.status,
          launched: stage.launched, terminalCause: stage.terminalCause, transportException: stage.transportException,
          usage: Object.fromEntries((['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tokenTotal'] as const)
            .map((counter) => [counter, {
              value: stage.usage[counter].value, availability: stage.usage[counter].availability,
              semantics: stage.usage[counter].semantics, inclusion: stage.usage[counter].inclusion,
            }])) as Record<PipelineCounter, S1PipelineUsageCounter>,
        })),
        accounting: { endToEndMs: strategy.accounting.endToEndMs },
      },
      judgeResult: {
        rows: (judgeStage ? judgeResultsByAttempt.get(judgeStage.attemptId)?.rows : undefined) ?? [],
        tables: (judgeStage ? judgeResultsByAttempt.get(judgeStage.attemptId)?.tables : undefined) ?? [],
      },
      caseId: assignedCaseId, context: mappingContext, selection: selectedHostJudgement,
      recipeEvidence: { formatConformance: strategy.formatCompliance,
        assignedStrategySuccess: strategy.assignedStrategySuccess },
      rowMetadata: {
        role: 'fixer-worker' as const, suite: bundle!.suite.name, case: assignedCaseId,
        model: options.model, driver: DRIVER_LABEL[options.route.transport], runId: runIdentity,
        timestamp: new Date().toISOString(), expectedCases: bundle!.suite.cases.length,
      },
      stageEvidence,
    };
    let pipelineJudgementArtifact: { judgementId: string; version: number; artifact: { path: string; sha256: string } } | undefined;
    if (selectedHostJudgement && localOutcome) {
      const historical = localOutcome.judgements;
      const version = Math.max(0, ...historical.map((entry) => entry.version)) + 1;
      const judgementId = `recipe-${hash(`${runIdentity}\0${selectedHostJudgement.judgementId}\0${selectedHostJudgement.version}`).slice(0, 32)}`;
      const contents = `${JSON.stringify({
        schemaVersion: 1, assignmentId: options.assignmentId, runNamespace: options.runNamespace,
        recipeHash: strategy.recipeHash, candidateSha256: selectedHostJudgement.candidateSha256,
        selectedHostJudgement, formatConformance: strategy.formatCompliance,
        assignedStrategySuccess: strategy.assignedStrategySuccess, operationalStatus: strategy.operationalStatus,
        stageInvocationIds: modelStages.map((stage) => stage.invocationId),
        judgeProcess: judgeStage ? (() => {
          const process = judgeResultHashes.get(judgeStage.attemptId);
          return process ? { ...process, protectedOracleCleanupReceipt: publicReceipt(process.protectedOracleCleanupReceipt) } : null;
        })() : null,
      }, null, 2)}\n`;
      const digest = hash(contents);
      const artifact = { path: 'pending-recipe-judgement.json', sha256: digest };
      const pipelineJudgement = { judgementId, version, artifact };
      // Validate the full join before creating an immutable artifact, then map again to retain its real ref.
      s1.mapPipelineCampaignEvidence({ ...mapInput, pipelineJudgementArtifact: pipelineJudgement });
      const stored = artifactStore.write(mappingContext, `recipe-${hash(judgementId).slice(0, 24)}.json`, contents);
      pipelineJudgementArtifact = { judgementId, version, artifact: stored };
    }
    const mapped = s1.mapPipelineCampaignEvidence({ ...mapInput,
      ...(pipelineJudgementArtifact ? { pipelineJudgementArtifact } : {}) });
    const status = strategy.operationalStatus === 'complete' && strategy.recipeCompleted
      && mapped.taskOutcome !== null && (mapped.taskOutcome as { candidateCorrectness?: unknown }).candidateCorrectness !== null
      ? 'complete' : 'incomplete';
    const report: VisibleReviewLoopResult = {
      schemaVersion: 1, status, visibleOnly: true, heldOut: false, experimentId: identity,
      runIdentity, runNamespace: options.runNamespace,
      reportPath: join(outputRoot, `visible-screening-${runIdentity}.json`),
      strategy, taskOutcome: mapped.taskOutcome, rows: mapped.rows, tables: mapped.tables,
      pipelineEvidence: {
        mappingStatus: 'mapped',
        candidateCorrectness: (mapped.taskOutcome as { candidateCorrectness: boolean | null }).candidateCorrectness,
        formatCompliance: (mapped.taskOutcome as { formatConformance: boolean | null }).formatConformance,
        assignedStrategySuccess: (mapped.taskOutcome as { assignedStrategySuccess: boolean | null }).assignedStrategySuccess,
        operationalStatus: strategy.operationalStatus,
        execution: {
          launched: modelStages.some((stage) => stage.launched === true) ? true
            : modelStages.some((stage) => stage.launched === null) ? null : false,
          terminalCause: strategy.operationalStatus,
          sourceInvocationIds: modelStages.flatMap((stage) => stage.invocationId ? [stage.invocationId] : []),
        },
        protectedOracleCleanup: (() => {
          const evidence = judgeStage ? judgeResultHashes.get(judgeStage.attemptId) : undefined;
          const proof = evidence?.protectedOracleProof;
          const receipt = publicReceipt(evidence?.protectedOracleCleanupReceipt);
          return proof ? { status: 'proven' as const, planSha256: proof.planSha256,
            daemonVerified: proof.daemonVerified, ownershipVerified: proof.ownershipVerified,
            containersAbsent: proof.containersAbsent, volumeDisposition: proof.volumeDisposition,
            resourceIds: proof.resourceIds, inventoryContentVerified: false as const,
            receipt }
            : { status: 'unobserved' as const, planSha256: null, daemonVerified: false,
              ownershipVerified: false, containersAbsent: false, volumeDisposition: 'unproven' as const,
              resourceIds: [], inventoryContentVerified: false as const, receipt };
        })(),
        stages: modelStages.map(({ stageId, attemptId, invocationId, status: stageStatus, launched, terminalCause, transportException, usage }) => ({
          stageId, attemptId, invocationId, status: stageStatus, launched, terminalCause, transportException, usage,
        })),
        usage: strategy.accounting.usage,
      },
      localJudge: {
        evidenceClass: 'local-judge-only', pipelineCampaignEvidence: false,
        modelUsage: 'not-a-model-observation', outcome: localOutcome,
        rows: judgeStage ? judgeResultsByAttempt.get(judgeStage.attemptId)?.rows ?? [] : [],
        tables: judgeStage ? judgeResultsByAttempt.get(judgeStage.attemptId)?.tables ?? [] : [],
        diagnostics: judgeStage ? judgeResultsByAttempt.get(judgeStage.attemptId)?.diagnostics ?? [] : [],
      },
      limits: VISIBLE_REVIEW_LOOP_LIMITS,
      resourceCleanup: preserveForRecovery ? 'quarantined' : 'complete',
    };
    if (!preserveForRecovery) {
      cleanupAttempted = true;
      const cleanup = await cleanupWithinWindow(bundle, task, tempRoot, VISIBLE_REVIEW_LOOP_LIMITS.boundedCleanupWindowMs);
      if (cleanup !== 'complete') {
        preserveForRecovery = true;
        report.resourceCleanup = 'unproven';
        report.status = 'incomplete';
      }
    }
    const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(report.reportPath, reportBytes, { flag: 'wx', mode: 0o600 });
    return report;
  } finally {
    if (!cleanupAttempted && !preserveForRecovery) {
      cleanupAttempted = true;
      await cleanupWithinWindow(bundle, task, tempRoot, VISIBLE_REVIEW_LOOP_LIMITS.boundedCleanupWindowMs);
    }
  }
}

async function cleanupWithinWindow(
  bundle: ReviewBundle | undefined,
  task: ReviewTask,
  root: string,
  windowMs: number,
): Promise<'complete' | 'failed' | 'timed-out'> {
  const cleanup = (async () => {
    await bundle?.cleanup();
    await task.cleanup();
    await rm(root, { recursive: true, force: true });
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      cleanup.then(() => 'complete' as const, () => 'failed' as const),
      new Promise<'timed-out'>((resolve) => { timer = setTimeout(() => resolve('timed-out'), Math.max(0, windowMs)); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function promoteArtifactTree(sourceRoot: string, destinationRoot: string): void {
  const source = resolve(sourceRoot);
  const destination = resolve(destinationRoot);
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('private S1 artifact root must be a real directory');
  mkdirSync(destination, { recursive: true });
  assertRealDirectory(destination);
  const limits = { files: 10_000, bytes: 64 * 1024 * 1024 };
  const budget = { files: 0, bytes: 0 };
  const copyDirectory = (from: string, to: string): void => {
    for (const name of readdirSync(from)) {
      const input = join(from, name);
      const output = resolve(to, name);
      if (!output.startsWith(`${destination}${sep}`)) throw new Error('private S1 artifact path escaped its destination');
      const stat = lstatSync(input);
      if (stat.isSymbolicLink()) throw new Error('private S1 artifacts must not contain symlinks');
      if (stat.isDirectory()) {
        if (!existsSync(output)) mkdirSync(output, { recursive: false });
        assertRealDirectory(output);
        copyDirectory(input, output);
      } else if (stat.isFile()) {
        if (++budget.files > limits.files || (budget.bytes += stat.size) > limits.bytes) {
          throw new Error('private S1 artifact promotion exceeded its bounded file/byte limit');
        }
        assertRealDirectory(dirname(output));
        copyFileSync(input, output, fsConstants.COPYFILE_EXCL);
      } else throw new Error('private S1 artifact tree contains a non-regular entry');
    }
  };
  copyDirectory(source, destination);
}

function publicReceipt(receipt: { path: string; sha256: string; privatePath?: string } | undefined): { path: string; sha256: string } | null {
  return receipt ? { path: receipt.path, sha256: receipt.sha256 } : null;
}

function promoteCleanupReceipt(
  receipt: { path: string; sha256: string; privatePath: string },
  outputRoot: string,
): void {
  if (!receipt.path.startsWith('artifacts/') || receipt.path.split('/').some((part) => part === '..')
    || !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw new Error('protected-oracle cleanup receipt reference is malformed');
  const bytes = readFileSync(receipt.privatePath);
  if (hash(bytes) !== receipt.sha256) throw new Error('protected-oracle cleanup receipt source hash mismatch');
  const destination = resolve(outputRoot, receipt.path);
  if (!destination.startsWith(`${resolve(outputRoot)}${sep}`)) throw new Error('protected-oracle cleanup receipt escaped the output root');
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
  }
  if (hash(readFileSync(destination)) !== receipt.sha256) throw new Error('promoted protected-oracle cleanup receipt hash mismatch');
}

function assertRealDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`artifact destination is not a real directory: ${path}`);
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function patchOf(candidate: Candidate): string {
  const patch = (candidate.value as { patch?: unknown }).patch;
  if (typeof patch !== 'string' || hash(patch) !== candidate.sha256) throw new Error('candidate patch does not match its frozen content hash');
  return patch;
}

function applyPatch(workspace: string, patch: string): void {
  if (!patch) return;
  execFileSync('git', ['apply', '--binary', '--whitespace=nowarn', '-'], { cwd: workspace, input: patch, stdio: ['pipe', 'ignore', 'pipe'] });
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 96) || randomUUID();
}

function existsSyncPath(path: string): boolean { return existsSync(path); }

function stageJudgeManifest(
  s1Root: string,
  bundleRoot: string,
  dependencies: readonly { path: string; sha256: string }[],
): void {
  for (const dependency of dependencies) {
    const source = join(s1Root, dependency.path);
    const content = readFileSync(source);
    if (hash(content) !== dependency.sha256) throw new Error(`review-loop judge dependency changed after pinning: ${dependency.path}`);
    const target = join(bundleRoot, dependency.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
  }
}

const CANDIDATE_CAPTURE_LIMITS = Object.freeze({ files: 10_000, bytes: 32 * 1024 * 1024, fileBytes: 8 * 1024 * 1024 });

/**
 * Capture a full-content candidate without consulting the worker's mutable Git metadata.
 * The baseline source must be parent-owned and immutable for the duration of capture.
 */
export function captureGitCandidatePatch(
  workspace: string,
  baselineCommit: string,
  expectedBaselineTree: string | undefined,
  immutableBaselineWorkspace: string,
): string {
  if (!/^[a-f0-9]{40,64}$/.test(baselineCommit)) throw new Error('candidate baseline commit is not canonical');
  if (!expectedBaselineTree || !/^[a-f0-9]{40,64}$/.test(expectedBaselineTree)) throw new Error('candidate baseline tree is not canonical');
  const captureRoot = mkdtempSync(join(tmpdir(), 'cq-candidate-capture-'));
  const trustedRepo = join(captureRoot, 'repo');
  mkdirSync(trustedRepo);
  const cleanGitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const env = { ...cleanGitEnvironment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' };
  const trustedGit = (args: string[]): string => execFileSync('git', ['-C', trustedRepo, '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  try {
    const verifiedCommit = execFileSync('git', ['-C', immutableBaselineWorkspace, 'rev-parse', '--verify', `${baselineCommit}^{commit}`], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const verifiedTree = execFileSync('git', ['-C', immutableBaselineWorkspace, 'rev-parse', '--verify', `${baselineCommit}^{tree}`], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (verifiedCommit !== baselineCommit || verifiedTree !== expectedBaselineTree) throw new Error('candidate baseline commit/tree does not match the parent-owned seed');
    trustedGit(['init', '-q']);
    writeFileSync(join(trustedRepo, '.git', 'info', 'attributes'), '* -filter -text -eol\n');
    trustedGit(['config', 'core.fsmonitor', 'false']);
    trustedGit(['config', 'core.autocrlf', 'false']);
    trustedGit(['config', 'core.filemode', 'true']);
    const budget = { files: 0, bytes: 0 };
    copyCandidateTree(immutableBaselineWorkspace, trustedRepo, budget);
    trustedGit(['add', '--all']);
    trustedGit(['-c', 'user.name=S4 Capture', '-c', 'user.email=s4-capture@example.invalid', 'commit', '-q', '-m', 'Frozen candidate baseline']);
    if (trustedGit(['rev-parse', 'HEAD^{tree}']) !== expectedBaselineTree) throw new Error('trusted candidate baseline differs from frozen tree');
    clearCandidateTree(trustedRepo);
    copyCandidateTree(workspace, trustedRepo, budget);
    trustedGit(['add', '--all']);
    return execFileSync('git', ['-C', trustedRepo, '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null',
      '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false',
      'diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '--binary', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD', '--'], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally { rmSync(captureRoot, { recursive: true, force: true }); }
}

function copyCandidateTree(source: string, destination: string, budget: { files: number; bytes: number }): void {
  const copy = (from: string, to: string): void => {
    for (const entry of readdirSync(from)) {
      if (entry === '.git') continue;
      const sourcePath = join(from, entry);
      const targetPath = join(to, entry);
      const info = lstatSync(sourcePath);
      if (info.isDirectory()) {
        mkdirSync(targetPath, { recursive: true });
        copy(sourcePath, targetPath);
      } else if (info.isSymbolicLink()) {
        if (++budget.files > CANDIDATE_CAPTURE_LIMITS.files) throw new Error('candidate capture file-count limit exceeded');
        const target = readlinkSync(sourcePath);
        budget.bytes += Buffer.byteLength(target);
        if (budget.bytes > CANDIDATE_CAPTURE_LIMITS.bytes) throw new Error('candidate capture byte limit exceeded');
        symlinkSync(target, targetPath);
      } else if (info.isFile()) {
        if (info.size > CANDIDATE_CAPTURE_LIMITS.fileBytes) throw new Error(`candidate capture file limit exceeded: ${entry}`);
        if (++budget.files > CANDIDATE_CAPTURE_LIMITS.files) throw new Error('candidate capture file-count limit exceeded');
        budget.bytes += info.size;
        if (budget.bytes > CANDIDATE_CAPTURE_LIMITS.bytes) throw new Error('candidate capture byte limit exceeded');
        writeFileSync(targetPath, readFileSync(sourcePath), { mode: info.mode & 0o777 });
      }
    }
  };
  copy(source, destination);
}

function clearCandidateTree(workspace: string): void {
  for (const entry of readdirSync(workspace)) {
    if (entry === '.git') continue;
    rmSync(join(workspace, entry), { recursive: true, force: true });
  }
}

async function bounded<T>(request: StageRequest, durationMs: number, action: () => Promise<T>): Promise<T> {
  if (request.signal.aborted) throw new Error('cancelled before stage dispatch');
  const stageDeadline = Math.min(request.deadlineEpochMs, Date.now() + durationMs);
  const delay = Math.max(0, stageDeadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('model stage deadline exceeded')), delay); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
