/** Visible-only same-model review-loop screening through S4 and the S1 runner. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { createNativeStrategyExecutor, type NativeObservedDriver, type NativeSupervisorControl } from './executor.ts';
import {
  defineBudgetTiers, runStrategy, type Candidate, type ExecutorResult, type PerTaskBudgetTier,
  type StageRequest, type StrategyRoute, type StrategyResult, unknownUsage,
} from './index.ts';

export const VISIBLE_REVIEW_LOOP_LIMITS = Object.freeze({
  modelStageMs: 120_000,
  independentJudgeMs: 60_000,
  totalWallClockEnforced: false,
  independentJudgeTotalEnforced: false,
  totalEnforcementReason: 'S2 native whole-pipeline supervisor admission is pending',
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
  /** Pipeline-level S1 mapping is intentionally withheld until S4/S1 join validation exists. */
  taskOutcome: null;
  rows: readonly [];
  tables: readonly [];
  pipelineEvidence: {
    mappingStatus: 'strategy-ledger-only';
    candidateCorrectness: boolean | null;
    formatCompliance: boolean | null;
    assignedStrategySuccess: boolean | null;
    operationalStatus: StrategyResult['operationalStatus'];
    execution: {
      launched: boolean | null;
      terminalCause: StrategyResult['operationalStatus'];
      sourceInvocationIds: readonly string[];
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
}

interface S1TaskOutcome {
  candidateCorrectness: boolean | null;
  assignedStrategySuccess: boolean | null;
  formatConformance: boolean | null;
  operationalStatus: string;
  judgements: readonly { artifact?: { path: string; sha256: string } }[];
}
interface S1Row { case: string; taskOutcome?: S1TaskOutcome; [key: string]: unknown; }
interface S1RunSuiteResult { rows: S1Row[]; tables: unknown[]; diagnostics?: string[]; }
interface ReviewTask {
  worktreePath: string;
  baselineCommit: string;
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

/** Find a sibling/ancestor S1 checkout, or let standalone callers provide its pinned root. */
export function findS1DependencyRoot(startDirectory: string): string | null {
  let current = resolve(startDirectory);
  for (let depth = 0; depth < 12; depth += 1) {
    if (isS1DependencyRoot(current)) return current;
    try {
      for (const child of readdirSync(current, { withFileTypes: true })) {
        if (child.isDirectory()) {
          const candidate = join(current, child.name);
          if (isS1DependencyRoot(candidate)) return candidate;
        }
      }
    } catch { /* Continue toward the filesystem root. */ }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function isS1DependencyRoot(root: string): boolean {
  return existsSync(join(root, S1_TASK_SOURCE)) && existsSync(join(root, S1_SUITE_SOURCE));
}

export function resolveS1DependencyRoot(explicitRoot?: string): string {
  const root = explicitRoot ? resolve(explicitRoot) : findS1DependencyRoot(dirname(fileURLToPath(import.meta.url)));
  if (!root || !isS1DependencyRoot(root)) {
    throw new Error('S1 integration root unavailable; pass s1DependencyRoot to the visible runner');
  }
  return root;
}

/** Load the sibling S1 integration at runtime so this runner package keeps its own build boundary. */
async function loadS1Bindings(root: string): Promise<S1Bindings> {
  const at = (path: string): string => pathToFileURL(join(root, path)).href;
  const [corpus, runner, experiment, suite] = await Promise.all([
    import(at('campaigns/cq-settings/corpus/review-loop-task.ts')),
    import(at('runner/index.ts')),
    import(at('runner/experiment.ts')),
    import(at('runner/workflow-corpus/review-loop-suite.ts')),
  ]);
  return { ...corpus, ...runner, ...experiment, ...suite } as unknown as S1Bindings;
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
  mkdirSync(artifactRoot, { recursive: true });
  const s1Root = resolveS1DependencyRoot(options.s1DependencyRoot);
  const s1 = await loadS1Bindings(s1Root);
  const task = await s1.createReviewLoopRepairTask({ model: options.model, provider: options.provider }, tempRoot);
  let bundle: ReviewBundle | undefined;
  const workspaceByAttempt = new Map<string, CandidateWorkspace>();
  const runSuiteResults: S1RunSuiteResult[] = [];
  let seedTree = '';
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
          const candidate = request.inputCandidates[0];
          if (!candidate || typeof (candidate.value as { patch?: unknown })?.patch !== 'string') {
            return { status: 'failed', usage: unknownUsage(), serviceTimeMs: 0, launched: false,
              judgement: { status: 'invalid', correctness: null, detail: 'missing captured candidate patch' } };
          }
          const suiteDriver: Driver = {
            async run(invocation: OpInvocation): Promise<WorkerResult> {
              const workspace = workspaceFromPrompt(invocation.prompt);
              const actualTree = git(workspace, ['rev-parse', 'HEAD^{tree}']);
              if (actualTree !== seedTree) throw new Error('S1 judge workspace baseline tree differs from the frozen task seed');
              applyPatch(workspace, (candidate.value as { patch: string }).patch);
              return { structuredOutput: { fixed: true, notes: 'Apply captured strategy candidate for host judgement.' },
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, denials: [], stopReason: 'complete', model: options.model };
            },
          };
          const started = performance.now();
          const result = await s1.runSuite({
            suiteDir: bundle!.suiteDir,
            repoRoot: bundle!.repoRoot,
            artifactRoot,
            driver: bundle!.wrapDriver(suiteDriver),
            model: options.model,
            provider: options.provider,
            driverName: DRIVER_LABEL[options.route.transport],
            checkTimeoutMs: VISIBLE_REVIEW_LOOP_LIMITS.independentJudgeMs,
            hostCheckScoringEnvironment: (workspace: string, baseline: string) => bundle!.hostCheckScoringEnvironment(workspace, baseline),
            experiment: {
              campaignId: 'cq-settings-visible-screening', cohortId: 'visible-calibration', experimentId: experimentRunId,
              taskId: s1.suiteTaskId(bundle!.suite.name, substrateId), repeatId: hash(options.runNamespace).slice(0, 16),
              assignmentId: request.assignmentId, stageId: request.stageId, attemptId: request.attemptId,
              track: 'visible-review-loop-screening', strategyId: identity, settingsId: options.settingsId,
              budgetId: tier.id, profileId: options.profileId, frozenWeight: 1, substrateId, judgeManifest,
            },
          });
          runSuiteResults.push(result);
          const row = result.rows.find((entry) => entry.case === bundle!.suite.cases[0]?.id);
          const outcome = row?.taskOutcome;
          if (!outcome) return { status: 'failed', usage: unknownUsage(), serviceTimeMs: performance.now() - started,
            launched: false, judgement: { status: 'unavailable', correctness: null, detail: 'S1 runSuite produced no TaskOutcome' } };
          return {
            status: 'completed', usage: unknownUsage(), serviceTimeMs: performance.now() - started,
            launched: false,
            judgement: { status: outcome.candidateCorrectness === null ? 'unavailable' : 'valid',
              correctness: outcome.candidateCorrectness, detail: 'S1 local host-oracle correctness only; local format/task-success fields are not pipeline evidence.' },
          };
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
    const finalResult = runSuiteResults.at(-1);
    const localOutcome = finalResult?.rows[0]?.taskOutcome ?? null;
    const status = strategy.operationalStatus === 'complete' && strategy.recipeCompleted && localOutcome !== null ? 'complete' : 'incomplete';
    const runIdentity = visibleRunIdentity(identity, options.assignmentId, options.runNamespace);
    const modelStages = strategy.stages.filter((stage) => stage.routeId !== null);
    const report: VisibleReviewLoopResult = {
      schemaVersion: 1, status, visibleOnly: true, heldOut: false, experimentId: identity,
      runIdentity, runNamespace: options.runNamespace,
      reportPath: join(outputRoot, `visible-screening-${runIdentity}.json`),
      strategy, taskOutcome: null, rows: [], tables: [],
      pipelineEvidence: {
        mappingStatus: 'strategy-ledger-only',
        candidateCorrectness: strategy.candidateCorrectness,
        formatCompliance: strategy.formatCompliance,
        assignedStrategySuccess: strategy.assignedStrategySuccess,
        operationalStatus: strategy.operationalStatus,
        execution: {
          launched: modelStages.some((stage) => stage.launched === true) ? true
            : modelStages.some((stage) => stage.launched === null) ? null : false,
          terminalCause: strategy.operationalStatus,
          sourceInvocationIds: modelStages.flatMap((stage) => stage.invocationId ? [stage.invocationId] : []),
        },
        stages: modelStages.map(({ stageId, attemptId, invocationId, status: stageStatus, launched, terminalCause, transportException, usage }) => ({
          stageId, attemptId, invocationId, status: stageStatus, launched, terminalCause, transportException, usage,
        })),
        usage: strategy.accounting.usage,
      },
      localJudge: {
        evidenceClass: 'local-judge-only', pipelineCampaignEvidence: false,
        modelUsage: 'not-a-model-observation', outcome: localOutcome,
        rows: finalResult?.rows ?? [], tables: finalResult?.tables ?? [],
        diagnostics: finalResult?.diagnostics ?? [],
      },
      limits: VISIBLE_REVIEW_LOOP_LIMITS,
    };
    const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(report.reportPath, reportBytes, { flag: 'wx', mode: 0o600 });
    return report;
  } finally {
    await bundle?.cleanup();
    await task.cleanup();
    rmSync(tempRoot, { recursive: true, force: true });
  }
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

function workspaceFromPrompt(prompt: string): string {
  const match = prompt.match(/^workspace: (.+)$/mu);
  if (!match?.[1]) throw new Error('runSuite did not provide the judge workspace path');
  return match[1];
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
    trustedGit(['init', '-q']);
    const budget = { files: 0, bytes: 0 };
    copyCandidateTree(immutableBaselineWorkspace, trustedRepo, budget);
    trustedGit(['add', '--all']);
    trustedGit(['-c', 'user.name=S4 Capture', '-c', 'user.email=s4-capture@example.invalid', 'commit', '-q', '-m', 'Frozen candidate baseline']);
    if (trustedGit(['rev-parse', 'HEAD^{tree}']) !== expectedBaselineTree) throw new Error('trusted candidate baseline differs from frozen tree');
    clearCandidateTree(trustedRepo);
    copyCandidateTree(workspace, trustedRepo, budget);
    trustedGit(['add', '--all']);
    return execFileSync('git', ['-C', trustedRepo, '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null',
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
