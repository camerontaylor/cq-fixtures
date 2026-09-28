/** Visible-only same-model review-loop screening through S4 and the S1 runner. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { createNativeStrategyExecutor, type NativeObservedDriver, type NativeSupervisorControl } from './executor.ts';
import {
  defineBudgetTiers, runStrategy, type Candidate, type ExecutorResult, type PerTaskBudgetTier,
  type StageRequest, type StrategyRoute, type StrategyResult, observedZeroUsage,
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
  outputRoot: string;
}

export interface VisibleReviewLoopResult {
  schemaVersion: 1;
  status: 'complete' | 'incomplete';
  visibleOnly: true;
  heldOut: false;
  experimentId: string;
  reportPath: string;
  strategy: StrategyResult;
  taskOutcome: S1TaskOutcome | null;
  rows: readonly S1Row[];
  tables: readonly unknown[];
  runSuiteDiagnostics: readonly string[];
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
const INTEGRATION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../cq-settings-integration');

/** Load the sibling S1 integration at runtime so this runner package keeps its own build boundary. */
async function loadS1Bindings(): Promise<S1Bindings> {
  const at = (path: string): string => pathToFileURL(join(INTEGRATION_ROOT, path)).href;
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

/**
 * Run one frozen review-loop assignment. The caller supplies the admitted native
 * driver and S2 stop proof; this module provides no public or live-call effect.
 */
export async function runVisibleReviewLoopScreening(options: VisibleReviewLoopOptions): Promise<VisibleReviewLoopResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.assignmentId)) throw new Error('assignmentId must be a path-safe frozen roster ID');
  if (options.route.tokenEnforcement !== 'unsupported') throw new Error('visible screening cannot claim whole-pipeline token enforcement');
  if (!options.route.supportedSettings?.effort?.includes(options.effort)) throw new Error(`route does not attest effort '${options.effort}'`);
  const tier = VISIBLE_REVIEW_LOOP_LIMITS.tiers.find((entry) => entry.id === options.tierId);
  if (!tier) throw new Error(`unknown frozen visible screening tier '${options.tierId}'`);
  const tempRoot = mkdtempSync(join(tmpdir(), 'cq-visible-strategy-'));
  const outputRoot = resolve(options.outputRoot);
  mkdirSync(outputRoot, { recursive: true });
  const artifactRoot = join(outputRoot, 'artifacts');
  mkdirSync(artifactRoot, { recursive: true });
  const s1 = await loadS1Bindings();
  const task = await s1.createReviewLoopRepairTask({ model: options.model, provider: options.provider }, tempRoot);
  let bundle: ReviewBundle | undefined;
  const workspaceByAttempt = new Map<string, CandidateWorkspace>();
  const runSuiteResults: S1RunSuiteResult[] = [];
  let seedTree = '';
  try {
    bundle = await s1.createReviewLoopRunSuiteBundle(task, tempRoot);
    stageJudgeManifest(bundle.repoRoot, bundle.oraclePin.dependencies);
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
        task: hash(readFileSync(join(INTEGRATION_ROOT, 'campaigns/cq-settings/corpus/review-loop-task.ts'))),
        suite: hash(readFileSync(join(INTEGRATION_ROOT, 'runner/workflow-corpus/review-loop-suite.ts'))),
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
            return { status: 'failed', usage: observedZeroUsage('local-judge-no-model'), serviceTimeMs: 0, launched: false,
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
              taskId: s1.suiteTaskId(bundle!.suite.name, substrateId), repeatId: identity.slice(4, 20),
              assignmentId: request.assignmentId, stageId: request.stageId, attemptId: request.attemptId,
              track: 'visible-review-loop-screening', strategyId: identity, settingsId: options.settingsId,
              budgetId: tier.id, profileId: options.profileId, frozenWeight: 1, substrateId, judgeManifest,
            },
          });
          runSuiteResults.push(result);
          const row = result.rows.find((entry) => entry.case === bundle!.suite.cases[0]?.id);
          const outcome = row?.taskOutcome;
          if (!outcome) return { status: 'failed', usage: observedZeroUsage('local-judge-no-model'), serviceTimeMs: performance.now() - started,
            launched: false, judgement: { status: 'unavailable', correctness: null, detail: 'S1 runSuite produced no TaskOutcome' } };
          return {
            status: 'completed', usage: observedZeroUsage('local-s1-host-judge'), serviceTimeMs: performance.now() - started,
            launched: false,
            judgement: { status: outcome.candidateCorrectness === null ? 'unavailable' : 'valid',
              correctness: outcome.candidateCorrectness, taskSuccess: outcome.assignedStrategySuccess,
              formatCompliance: outcome.formatConformance, detail: outcome.operationalStatus },
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
            usage: observedZeroUsage('native-observation-authoritative'), serviceTimeMs: performance.now() - started,
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
          return { status: 'failed', usage: observedZeroUsage('native-observation-authoritative'), serviceTimeMs: performance.now() - started,
            launched: true, operationalError: { name: 'ReviewLoopOperationFailure', message: String(detail) } };
        }
        return { status: 'completed', usage: observedZeroUsage('native-observation-authoritative'), serviceTimeMs: performance.now() - started,
          launched: true, output: operation.value };
      },
      captureCandidate(request) {
        if (request.kind !== 'draft' && request.kind !== 'repair') return null;
        const workspace = workspaceByAttempt.get(request.attemptId);
        if (!workspace) return null;
        const patch = execFileSync('git', ['diff', '--binary', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', workspace.baselineCommit], {
          cwd: workspace.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
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
      },
      requireFormatCompliance: true,
    };
    const strategy = await runStrategy(strategyTask, recipe, tier, executor, { assignmentId: options.assignmentId });
    const finalResult = runSuiteResults.at(-1);
    const finalOutcome = finalResult?.rows[0]?.taskOutcome;
    const status = strategy.operationalStatus === 'complete' && strategy.recipeCompleted && finalOutcome !== undefined ? 'complete' : 'incomplete';
    const report: VisibleReviewLoopResult = {
      schemaVersion: 1, status, visibleOnly: true, heldOut: false, experimentId: identity,
      reportPath: join(outputRoot, `visible-screening-${identity.slice(4, 20)}.json`),
      strategy, taskOutcome: finalOutcome ?? null,
      rows: finalResult?.rows ?? [], tables: finalResult?.tables ?? [],
      runSuiteDiagnostics: finalResult?.diagnostics ?? [], limits: VISIBLE_REVIEW_LOOP_LIMITS,
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
  bundleRoot: string,
  dependencies: readonly { path: string; sha256: string }[],
): void {
  for (const dependency of dependencies) {
    const source = join(INTEGRATION_ROOT, dependency.path);
    const content = readFileSync(source);
    if (hash(content) !== dependency.sha256) throw new Error(`review-loop judge dependency changed after pinning: ${dependency.path}`);
    const target = join(bundleRoot, dependency.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
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
