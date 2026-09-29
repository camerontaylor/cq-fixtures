import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ArtifactStore } from '../runner/artifacts/index.ts';
import { judgeManifestHash } from '../runner/experiment.ts';
import { captureGitCandidatePatch, resolveS1DependencyRoot, runVisibleReviewLoopScreening, visibleRunIdentity } from '../runner/strategies/visible-screening.ts';
import { NativeSupervisorControl } from '../runner/native/process.ts';
import { createNativeStrategyExecutor, type NativeInvocationIdentity, type NativeStrategyObservation } from '../runner/strategies/executor.ts';
import { createIndependentJudgeProcessSupervisor, loadPinnedJudgeOwnership } from '../runner/strategies/judge-process.ts';
import type { ChildProcess } from 'node:child_process';
import type { ReviewLoopJudgeProcessRequest } from '../runner/strategies/judge-protocol.ts';
import {
  createScreeningCatalog,
  createScreeningComparisonArtifact,
  freezeScreeningDesign,
  SCREENING_PROFILES,
  type ScreeningCatalogInputs,
} from '../runner/strategies/screening-catalog.ts';
import {
  defineBudgetTiers,
  observedZeroUsage,
  runStrategy,
  runStrategyTiers,
  strategyInvocationIdentity,
  unknownUsage,
  type Candidate,
  type ExecutorResult,
  type PerTaskBudgetTier,
  type StageExecutor,
  type StageRequest,
  type StrategyRoute,
} from '../runner/strategies/index.ts';

const task = { id: 'fixer:case-01:substrate-a', prompt: 'Repair the regression.', evaluationTrack: 'native' as const,
  workspace: { root: '/isolated/task' }, independentJudgeRoute: { id: 'parent-judge', transport: 'fake' as const, tokenEnforcement: 'hard' as const },
  campaignIdentity: { profileInventoryHash: 'profiles', evaluationBoundaryHash: 'boundary', scaffoldAssistanceHash: 'scaffold', corpusPin: 'corpus', judgePin: 'judge' } };
const codex: StrategyRoute = { id: 'codex-native-luna-high', transport: 'codex-exec', tokenEnforcement: 'hard', supportedSettings: { effort: ['low', 'high'] } };
const glm: StrategyRoute = { id: 'zcode-native-glm-high', transport: 'zcode-acp', tokenEnforcement: 'unsupported', supportedSettings: { effort: ['low', 'high'] } };
const tier: PerTaskBudgetTier = {
  id: 'medium', maxAttempts: 8, maxStages: 16, wallClockMs: 2_000, judgementAllowanceMs: 300,
  shutdownAllowanceMs: 100, observationAllowanceMs: 50, captureAllowanceMs: 100, tokenBudget: 1_000,
};

function candidate(id: string, workspaceId = 'task-workspace'): Candidate {
  return { id, sha256: createHash('sha256').update(id).digest('hex'), workspaceId, workspace: { id: workspaceId }, value: { patch: id } };
}

function result(overrides: Partial<ExecutorResult> = {}): ExecutorResult {
  return { status: 'completed', usage: observedZeroUsage(), serviceTimeMs: 10, launched: true, ...overrides };
}

function fixedIds(): { next(kind: 'assignment' | 'stage' | 'attempt'): string } {
  let next = 0;
  return { next: (kind) => `${kind}-${++next}` };
}

function judgeProcessRequest(): ReviewLoopJudgeProcessRequest {
  const sourcePin = 'c'.repeat(64);
  const patch = 'candidate-patch-bytes';
  const candidateSha = createHash('sha256').update(patch).digest('hex');
  const identity = { assignmentId: 'assignment-child-test', stageId: 'judge-stage', attemptId: 'judge-attempt' };
  const manifest = { sourcePin, dependencies: [{ path: 'runner/workflow-corpus/judge.ts', sha256: sourcePin }] };
  return {
    schemaVersion: 1, identity, deadlineEpochMs: Date.now() + 10_000, shutdownDeadlineEpochMs: Date.now() + 15_000,
    s1DependencyRoot: '/pinned/s1',
    task: { id: 'task', sourceId: 'source-v1', baselineId: 'baseline-v1', oracleId: 'oracle-v1', substrateFamily: 'test',
      worktreePath: '/private/task', baselineCommit: 'd'.repeat(40),
      modelSpec: { model: 'offline-test-model', provider: 'test' }, operationInput: {} },
    model: 'offline-test-model', provider: 'test', driverName: 'codex-exec', checkTimeoutMs: 1_000,
    taskSourceSha256: 'a'.repeat(64), suiteSourceSha256: 'b'.repeat(64), baselineCommit: 'd'.repeat(40), baselineTree: 'e'.repeat(64),
    sourceId: 'source-v1', baselineId: 'baseline-v1', suiteName: 'suite', caseId: 'case', promptSha256: 'f'.repeat(64),
    taskFixtureFiles: ['package.json', 'settings/module.js', 'settings/display.js', 'test/public-settings.test.mjs']
      .map((path) => ({ path, sha256: '1'.repeat(64) })),
    oraclePin: sourcePin, candidateInventoryHash: '9'.repeat(64), namespaceSlotCount: 1, judgeManifest: manifest,
    experiment: {
      campaignId: 'campaign', cohortId: 'calibration', experimentId: 'experiment', taskId: 'task', repeatId: 'repeat',
      ...identity, track: 'native', strategyId: 'strategy', settingsId: 'settings', budgetId: 'tier', profileId: 'profile',
      frozenWeight: 1, substrateId: 'substrate', judgeManifest: manifest,
    },
    candidate: { sha256: candidateSha, patch, baselineCommit: 'd'.repeat(40), baselineTree: 'e'.repeat(64) },
  };
}

function fakeJudgeOwnershipForTest(options: { failCleanup?: boolean; events?: string[] } = {}) {
  return {
    stableJudgeCandidateInventory(_module: string, bytes: Uint8Array) {
      return { inventoryHash: createHash('sha256').update(bytes).digest('hex') };
    },
    createJudgeNamespacePlan(input: { privateParentRoot: string; identity: ReviewLoopJudgeProcessRequest['identity']; candidateSha256: string;
      oraclePin: string; inventoryHashes: readonly string[] }) {
      options.events?.push('plan-created');
      const plan = { schemaVersion: 1, identity: input.identity, candidateSha256: input.candidateSha256, oraclePin: input.oraclePin,
        slots: input.inventoryHashes.map((inventoryHash) => ({ inventoryHash })) };
      const bytes = JSON.stringify(plan);
      const planPath = join(input.privateParentRoot, 'test-plan.json');
      writeFileSync(planPath, bytes, { flag: 'wx', mode: 0o600 });
      return { planPath, planSha256: createHash('sha256').update(bytes).digest('hex'), plan };
    },
    async cleanupJudgeNamespace(handle: { planSha256: string; plan: { identity: ReviewLoopJudgeProcessRequest['identity'] } },
      input: { hostProcessStopped: boolean; deadlineEpochMs: number }) {
      options.events?.push(input.hostProcessStopped ? 'namespace-cleaned' : 'cleanup-refused');
      const complete = input.hostProcessStopped && !options.failCleanup && Date.now() < input.deadlineEpochMs;
      return { identity: handle.plan.identity, planSha256: handle.planSha256,
        daemonVerified: complete, ownershipVerified: complete, containersAbsent: complete,
        processTree: complete ? 'stopped-and-reaped' as const : 'unproven' as const,
        volumeDisposition: complete ? 'quarantined' as const : 'unproven' as const,
        resourceIds: complete ? ['fake-container', 'fake-volume'] : [],
        cleanup: complete ? 'complete' as const : 'failed' as const, inventoryContentVerified: false as const };
    },
  };
}

function fakeChildProcess(pid?: number): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { pid?: number; stdout: PassThrough; stderr: PassThrough };
  if (pid !== undefined) child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child as unknown as ChildProcess;
}

async function withJudgeChild<T>(
  mode: 'success' | 'mismatch' | 'late-descendant' | 'stderr-failure',
  run: (entrypoint: string, request: ReviewLoopJudgeProcessRequest, root: string, marker: string) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 's4-judge-child-test-'));
  const entrypoint = join(root, 'fixture.mjs');
  const marker = join(root, 'late-descendant.txt');
  const fixture = `import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const [requestPath, resultPath, requestSha256] = process.argv.slice(2);
const request = JSON.parse(await (await import('node:fs/promises')).readFile(requestPath, 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
if (!process.env.CQ_PROTECTED_JUDGE_PLAN || request.namespacePlanSha256 !== hash(readFileSync(process.env.CQ_PROTECTED_JUDGE_PLAN))
  || JSON.stringify(request).includes(process.env.CQ_PROTECTED_JUDGE_PLAN)) process.exit(8);
if (${JSON.stringify(mode)} === 'late-descendant') {
  const marker = ${JSON.stringify(marker)};
  const late = "process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(" + JSON.stringify(marker) + ",'late'),1500)";
  spawn(process.execPath, ['-e', late], { stdio: 'ignore' });
  process.on('SIGTERM',()=>{});
  setTimeout(()=>writeFileSync(resultPath,'late-result'),1400);
  await new Promise(()=>{});
} else if (${JSON.stringify(mode)} === 'stderr-failure') {
  process.stderr.write('PRIVATE_SENTINEL_ORACLE_DETAIL');
  process.exit(7);
} else {
  const selection = { judgementId:'j-frozen', version:1, judgePin:request.oraclePin, candidateSha256:request.candidate.sha256 };
  const judgement = { ...selection, candidateCorrectness:true, artifact:{path:'judge-artifact.json',sha256:'a'.repeat(64)} };
  const payload = { schemaVersion:1, identity:request.identity, requestSha256,
    rows:[{case:request.caseId,taskOutcome:{identity:{},candidateCorrectness:true,assignedStrategySuccess:true,
      formatConformance:null,operationalStatus:'complete',judgements:[judgement]}}], tables:[], diagnostics:[], selection };
  const bytes = Buffer.from(JSON.stringify(payload));
  const envelope = { schemaVersion:1, requestSha256:${JSON.stringify(mode === 'mismatch' ? '0'.repeat(64) : null)} ?? requestSha256,
    payloadSha256:hash(bytes), payload };
  writeFileSync(resultPath, JSON.stringify(envelope));
}
`;
  writeFileSync(entrypoint, fixture, { mode: 0o600 });
  try { return await run(entrypoint, judgeProcessRequest(), root, marker); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

class FakeExecutor implements StageExecutor {
  requests: StageRequest[] = [];
  capture?: StageExecutor['captureCandidate'];
  observation?: StageExecutor['getObservation'];
  stopped = false;
  async getObservation(request: StageRequest) {
    return await this.observation?.(request) ?? null;
  }
  handler: (request: StageRequest) => Promise<ExecutorResult> | ExecutorResult = (request) => {
    if (request.kind === 'draft') return result({ candidate: candidate('draft-1', request.workspaceId) });
    if (request.kind === 'verify') return result({ verification: { passed: true, feedback: 'Verified.' } });
    if (request.kind === 'select') return result({ selectedCandidateId: request.inputCandidates[0]?.id });
    if (request.kind === 'independent-judge') return result({ judgement: { status: 'valid', correctness: true } });
    return result({ candidate: candidate('repair-1', request.workspaceId) });
  };

  async stopAndWait(_request: StageRequest, _execution: Promise<ExecutorResult>): Promise<{ stopped: boolean; executionSettled: boolean }> {
    void _request; void _execution;
    this.stopped = true;
    return { stopped: false, executionSettled: false };
  }

  async createCandidateWorkspace(_request: Omit<StageRequest, 'workspace' | 'workspaceId'>, index: number): Promise<{ id: string; handle: unknown }> {
    return { id: `draft-workspace-${index + 1}`, handle: { root: `/isolated/draft-${index + 1}` } };
  }

  async captureCandidate(request: StageRequest, state: { result: ExecutorResult | null; error: unknown | null }): Promise<Candidate | null> {
    return await this.capture?.(request, state) ?? null;
  }

  async execute(request: StageRequest): Promise<ExecutorResult> {
    this.requests.push(request);
    return await this.handler(request);
  }
}

describe('bounded campaign strategy engine', () => {
  it.skipIf(!process.env.S4_SINGLE_JUDGE_PROBE_MODE)('runs one frozen real S1/S5 judge process fixture', async () => {
    const mode = process.env.S4_SINGLE_JUDGE_PROBE_MODE;
    const probeRoot = process.env.S4_SINGLE_JUDGE_PROBE_ROOT;
    const s1Root = process.env.CQ_S1_DEPENDENCY_ROOT;
    if (!probeRoot || !s1Root || (mode !== 'prepare' && mode !== 'execute')) throw new Error('single-judge probe environment is incomplete');
    const preparedPath = join(probeRoot, 'frozen-request.json');
    const reportPath = join(probeRoot, 'single-judge-report.json');
    const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

    if (mode === 'prepare') {
      mkdirSync(probeRoot, { recursive: false, mode: 0o700 });
      const pinnedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: s1Root, encoding: 'utf8' }).trim();
      if (pinnedCommit !== 'a1d2b6f0d444fcca5985766f8ea5d32181028f10') throw new Error('S1 dependency root is not the authorized frozen integration');
      const corpus = await import(pathToFileURL(join(s1Root, 'campaigns/cq-settings/corpus/review-loop-task.ts')).href);
      const suiteModule = await import(pathToFileURL(join(s1Root, 'runner/workflow-corpus/review-loop-suite.ts')).href);
      const experimentModule = await import(pathToFileURL(join(s1Root, 'runner/experiment.ts')).href);
      const fixtureRoot = join(probeRoot, 'fixture');
      mkdirSync(fixtureRoot, { mode: 0o700 });
      const task = await corpus.createReviewLoopRepairTask({ model: 'gpt-6-sol', provider: 'codex' }, fixtureRoot);
      const bundle = await suiteModule.createReviewLoopRunSuiteBundle(task, fixtureRoot);
      try {
        if (bundle.suite.cases.length !== 1) throw new Error('single-judge probe requires exactly one frozen suite case');
        const candidateRoot = join(probeRoot, 'candidate');
        execFileSync('git', ['clone', '--quiet', '--no-hardlinks', task.worktreePath, candidateRoot]);
        const candidateBytes = Buffer.from('export function isValidCampaignLabel(label) { return true; }\n');
        writeFileSync(join(candidateRoot, 'settings/module.js'), candidateBytes);
        const baselineTree = execFileSync('git', ['rev-parse', `${task.baselineCommit}^{tree}`], { cwd: task.worktreePath, encoding: 'utf8' }).trim();
        const patch = captureGitCandidatePatch(candidateRoot, task.baselineCommit, baselineTree, task.worktreePath);
        const candidateSha256 = hash(patch);
        const dependencyManifest = { sourcePin: bundle.oraclePin.sha256, dependencies: bundle.oraclePin.dependencies };
        const ownership = await loadPinnedJudgeOwnership(s1Root, dependencyManifest);
        const candidateInventoryHash = ownership.stableJudgeCandidateInventory('settings/module.js', candidateBytes).inventoryHash;
        const sourceTask = readFileSync(join(s1Root, 'campaigns/cq-settings/corpus/review-loop-task.ts'));
        const sourceSuite = readFileSync(join(s1Root, 'runner/workflow-corpus/review-loop-suite.ts'));
        const prompt = bundle.suite.cases[0]!.task.prompt;
        const identityHash = hash(JSON.stringify({ s1: pinnedCommit, baseline: task.baselineCommit,
          oraclePin: bundle.oraclePin.sha256, candidateSha256, assignment: 's4-single-judge-probe-01' }));
        const substrateId = `${task.sourceId}:${task.baselineId}:campaign-settings-module-v1`;
        const identity = { assignmentId: 's4-single-judge-probe-01', stageId: 's4-single-judge-stage-01', attemptId: 's4-single-judge-attempt-01' };
        const experiment = {
          campaignId: 'cq-settings-visible-screening', cohortId: 'visible-calibration', experimentId: identityHash,
          taskId: experimentModule.suiteTaskId(bundle.suite.name, substrateId), repeatId: 's4-probe-repeat-01', ...identity,
          track: 'visible-review-loop-screening', strategyId: identityHash, settingsId: 'captured-candidate-fixture',
          budgetId: 'single-judge-45s', profileId: 'offline-captured-fixture', frozenWeight: 1, substrateId,
          judgeManifest: dependencyManifest,
        };
        const taskFixtureFiles = ['package.json', 'settings/module.js', 'settings/display.js', 'test/public-settings.test.mjs']
          .map((path) => ({ path, sha256: hash(readFileSync(join(task.worktreePath, path))) }));
        const frozen = {
          schemaVersion: 1 as const, identity, deadlineEpochMs: 0, shutdownDeadlineEpochMs: 0, s1DependencyRoot: s1Root,
          task: { id: task.id, sourceId: task.sourceId, baselineId: task.baselineId, oracleId: task.oracleId,
            substrateFamily: task.substrateFamily, worktreePath: task.worktreePath, baselineCommit: task.baselineCommit,
            modelSpec: task.modelSpec, operationInput: task.operationInput },
          model: 'gpt-6-sol', provider: 'codex', driverName: 'codex-exec', checkTimeoutMs: 35_000,
          taskSourceSha256: hash(sourceTask), suiteSourceSha256: hash(sourceSuite), baselineCommit: task.baselineCommit,
          baselineTree, sourceId: task.sourceId, baselineId: task.baselineId, suiteName: bundle.suite.name,
          caseId: bundle.suite.cases[0]!.id, promptSha256: hash(prompt), taskFixtureFiles,
          oraclePin: bundle.oraclePin.sha256, candidateInventoryHash, namespaceSlotCount: 1,
          judgeManifest: dependencyManifest, experiment,
          candidate: { sha256: candidateSha256, patch, baselineCommit: task.baselineCommit, baselineTree },
        };
        writeFileSync(preparedPath, `${JSON.stringify(frozen)}\n`, { flag: 'wx', mode: 0o600 });
      } finally {
        await bundle.cleanup();
      }
      console.log(JSON.stringify({ probe: 'prepared', fixtureSha256: hash(readFileSync(preparedPath)), suiteCases: 1 }));
      return;
    }

    const frozen = JSON.parse(readFileSync(preparedPath, 'utf8')) as ReviewLoopJudgeProcessRequest;
    const ownership = await loadPinnedJudgeOwnership(s1Root, frozen.judgeManifest) as unknown as {
      stableJudgeCandidateInventory(module: string, bytes: Uint8Array): { inventoryHash: string };
      createJudgeNamespacePlan(input: { privateParentRoot: string; identity: ReviewLoopJudgeProcessRequest['identity'];
        candidateSha256: string; oraclePin: string; inventoryHashes: readonly string[] }): { planPath: string; planSha256: string; plan: { identity: ReviewLoopJudgeProcessRequest['identity'] } };
      cleanupJudgeNamespace(handle: never, input: { hostProcessStopped: boolean; deadlineEpochMs: number }): Promise<{
        cleanup: string; containersAbsent: boolean; volumeDisposition: string; inventoryContentVerified: false;
      }>;
    };
    let namespace: ReturnType<typeof ownership.createJudgeNamespacePlan> | undefined;
    const liveOwnership = {
      stableJudgeCandidateInventory: ownership.stableJudgeCandidateInventory,
      createJudgeNamespacePlan(input: Parameters<typeof ownership.createJudgeNamespacePlan>[0]) {
        namespace = ownership.createJudgeNamespacePlan(input);
        return namespace;
      },
      cleanupJudgeNamespace: ownership.cleanupJudgeNamespace,
    };
    const phases: { phase: string; timestamp: string; monotonicMs: number; fields?: Readonly<Record<string, string | number | boolean>> }[] = [];
    const observe = (phase: string, fields?: Readonly<Record<string, string | number | boolean>>): void => {
      phases.push({ phase, timestamp: new Date().toISOString(), monotonicMs: performance.now(), ...(fields ? { fields } : {}) });
    };
    const privateRoot = join(probeRoot, 'process');
    mkdirSync(privateRoot, { mode: 0o700 });
    const executionStartEpochMs = Date.now();
    const request: ReviewLoopJudgeProcessRequest = {
      ...frozen, deadlineEpochMs: executionStartEpochMs + 45_000,
      shutdownDeadlineEpochMs: executionStartEpochMs + 75_000,
    };
    observe('execution-start', { decisionDeadlineEpochMs: request.deadlineEpochMs,
      shutdownDeadlineEpochMs: request.shutdownDeadlineEpochMs, fixtureSha256: hash(readFileSync(preparedPath)) });
    let report: Record<string, unknown> = { executionStartEpochMs, deadlineEpochMs: request.deadlineEpochMs,
      shutdownDeadlineEpochMs: request.shutdownDeadlineEpochMs, phases };
    try {
      const supervisor = createIndependentJudgeProcessSupervisor({ privateRoot,
        ownershipForTest: liveOwnership as never,
        phaseObserverForTest: observe,
      });
      const execution = await supervisor.run(request, new AbortController().signal);
      const evidence = execution.evidence;
      if (!namespace) throw new Error('S5 parent namespace handle was not retained');
      const planBytes = readFileSync(namespace.planPath);
      const receipt = evidence.protectedOracleCleanupReceipt;
      if (!receipt?.privatePath) throw new Error('S5 cleanup receipt reference is missing');
      const receiptBytes = readFileSync(receipt.privatePath);
      const receiptRecord = JSON.parse(receiptBytes.toString('utf8')) as {
        identity: ReviewLoopJudgeProcessRequest['identity']; planSha256: string;
        proof: { identity: ReviewLoopJudgeProcessRequest['identity']; planSha256: string; daemonVerified: boolean;
          ownershipVerified: boolean; containersAbsent: boolean; processTree: string; volumeDisposition: string;
          cleanup: string; inventoryContentVerified: false; resourceIds: string[] };
      };
      const identityMatches = JSON.stringify(receiptRecord.identity) === JSON.stringify(request.identity)
        && JSON.stringify(receiptRecord.proof.identity) === JSON.stringify(request.identity);
      const receiptSha256 = hash(receiptBytes);
      const planSha256 = hash(planBytes);
      const selectionMatches = evidence.selection.candidateSha256 === request.candidate.sha256
        && evidence.selection.judgePin === request.oraclePin;
      const childResultPath = join(evidence.processRoot, 'result.json');
      const childResultSha256 = hash(readFileSync(childResultPath));
      if (execution.result.status !== 'completed' || planSha256 !== namespace.planSha256
        || receiptSha256 !== receipt.sha256 || receiptRecord.planSha256 !== namespace.planSha256
        || receiptRecord.proof.planSha256 !== namespace.planSha256 || !identityMatches
        || receiptRecord.proof.cleanup !== 'complete' || !receiptRecord.proof.daemonVerified
        || !receiptRecord.proof.ownershipVerified || !receiptRecord.proof.containersAbsent
        || receiptRecord.proof.processTree !== 'stopped-and-reaped'
        || !['quarantined', 'absent'].includes(receiptRecord.proof.volumeDisposition)
        || receiptRecord.proof.inventoryContentVerified !== false || !selectionMatches) {
        throw new Error('single-judge conformance evidence failed a frozen reference check');
      }
      const phasesView = phases.map(({ phase, timestamp, monotonicMs, fields }) => ({ phase, timestamp, monotonicMs, ...(fields ? { fields } : {}) }));
      const ordering = ['host-spawn', 'host-exit', 'host-group-stopped', 'namespace-cleanup-start',
        'namespace-cleanup-end', 'cleanup-receipt-persisted'];
      if (ordering.some((phase) => !phases.some((entry) => entry.phase === phase))) throw new Error('single-judge phase timeline is incomplete');
      report = { ...report, status: 'completed', s1DependencyRoot: s1Root, s1Commit: 'a1d2b6f0d444fcca5985766f8ea5d32181028f10',
        oraclePin: request.oraclePin, candidateSha256: request.candidate.sha256, requestSha256: evidence.requestSha256,
        payloadSha256: evidence.payloadSha256, childResultSha256, selection: evidence.selection,
        candidateCorrectness: execution.result.judgement?.correctness ?? null,
        planPath: namespace.planPath, planSha256: namespace.planSha256, cleanupReceiptPath: receipt.path,
        cleanupReceiptSha256: receipt.sha256, cleanupProof: receiptRecord.proof,
        phases: phasesView, hostCloseObserved: phases.some((entry) => entry.phase === 'host-close') };
    } catch {
      report = { ...report, status: 'failed-or-incomplete', planSha256: namespace?.planSha256 ?? null,
        phases: phases.map(({ phase, timestamp, monotonicMs, fields }) => ({ phase, timestamp, monotonicMs, ...(fields ? { fields } : {}) })) };
      writeFileSync(reportPath, `${JSON.stringify(report)}\n`, { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ probe: 'incomplete', reportPath, phases: phases.map(({ phase }) => phase) }));
      throw new Error('single-judge probe did not establish the required S1/S5 evidence');
    }
    writeFileSync(reportPath, `${JSON.stringify(report)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ probe: 'completed', reportPath, candidateSha256: request.candidate.sha256,
      correctness: report.candidateCorrectness, planSha256: namespace!.planSha256,
      cleanupReceiptSha256: (report.cleanupReceiptSha256 as string) }));
  }, 80_000);

  it('requires an explicit pinned S1 root outside its own repository', () => {
    const root = mkdtempSync(join(tmpdir(), 's1-root-discovery-'));
    const dependencyRoot = join(root, 'pinned-integration');
    mkdirSync(join(dependencyRoot, 'campaigns/cq-settings/corpus'), { recursive: true });
    mkdirSync(join(dependencyRoot, 'runner/workflow-corpus'), { recursive: true });
    writeFileSync(join(dependencyRoot, 'campaigns/cq-settings/corpus/review-loop-task.ts'), 'pinned task');
    writeFileSync(join(dependencyRoot, 'runner/workflow-corpus/review-loop-suite.ts'), 'pinned suite');
    try {
      expect(resolveS1DependencyRoot(dependencyRoot)).toBe(dependencyRoot);
      expect(() => resolveS1DependencyRoot(join(root, 'missing-integration'))).toThrow(/S1 integration root unavailable/);
      expect(() => resolveS1DependencyRoot()).toThrow(/pass a pinned s1DependencyRoot/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('captures committed edits and untracked additions without changing the worker index', () => {
    const root = mkdtempSync(join(tmpdir(), 'candidate-full-capture-'));
    const baselineRepo = join(root, 'baseline');
    const source = join(root, 'source');
    mkdirSync(baselineRepo);
    mkdirSync(source);
    const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    try {
      git(baselineRepo, ['init', '-q']);
      writeFileSync(join(baselineRepo, 'tracked.txt'), 'seed\n');
      git(baselineRepo, ['add', 'tracked.txt']);
      git(baselineRepo, ['-c', 'user.name=Capture Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'seed']);
      const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baselineRepo, encoding: 'utf8' }).trim();
      const baselineTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: baselineRepo, encoding: 'utf8' }).trim();
      git(source, ['init', '-q']);
      writeFileSync(join(source, 'tracked.txt'), 'seed\n');
      git(source, ['add', 'tracked.txt']);
      git(source, ['-c', 'user.name=Capture Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'worker seed']);
      const workerSeed = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
      writeFileSync(join(source, 'tracked.txt'), 'committed edit\n');
      git(source, ['add', 'tracked.txt']);
      git(source, ['-c', 'user.name=Capture Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'candidate edit']);
      writeFileSync(join(source, 'new-file.txt'), 'untracked addition\n');
      writeFileSync(join(source, '.gitattributes'), '* filter=unexpected text eol=crlf\n');
      const indexBefore = execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' });
      const patch = captureGitCandidatePatch(source, baseline, baselineTree, baselineRepo);
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' })).toBe(indexBefore);
      git(source, ['reset', '--hard', '-q', workerSeed]);
      git(source, ['clean', '-fdq']);
      execFileSync('git', ['apply', '--binary', '-'], { cwd: source, input: patch, stdio: ['pipe', 'ignore', 'pipe'] });
      expect(readFileSync(join(source, 'tracked.txt'), 'utf8')).toBe('committed edit\n');
      expect(readFileSync(join(source, 'new-file.txt'), 'utf8')).toBe('untracked addition\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);

  it('scopes run identities by frozen assignment and run namespace', () => {
    const first = visibleRunIdentity('experiment-a', 'assignment-a', 'repeat-a');
    expect(visibleRunIdentity('experiment-a', 'assignment-b', 'repeat-a')).not.toBe(first);
    expect(visibleRunIdentity('experiment-a', 'assignment-a', 'repeat-b')).not.toBe(first);
  });

  it('maps a completed visible run onto the frozen S1 judgement and preserves local diagnostics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'visible-strategy-screen-'));
    let active: { invocationId: string; assignmentId: string; stageId: string; attemptId: string } | undefined;
    const observations = new Map<string, unknown>();
    const counter = (name: string, value: number) => ({ value, availability: 'observed', source: `simulated-${name}`, semantics: name });
    let modelRuns = 0;
    let verifyRuns = 0;
    const driver = {
      beginInvocation(identity: typeof active) { active = identity; },
      getObservation(invocationId: string) { return observations.get(invocationId) as never; },
      async run(invocation: { prompt: string }) {
        const workspace = invocation.prompt.match(/^workspace: (.+)$/mu)?.[1]
          ?? invocation.prompt.match(/^Worktree: (.+) \(/mu)?.[1];
        if (!workspace) throw new Error('simulated native invocation omitted workspace');
        const identity = active;
        if (!identity) throw new Error('simulated native invocation omitted S1 identity');
        const baselineCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
        if (invocation.prompt.includes('Review the candidate in the supplied read-only workspace')) {
          verifyRuns += 1;
          observations.set(identity.invocationId, {
            schemaVersion: 1, identity,
            usage: { counters: { input: counter('input', 4), output: counter('output', 2), cacheRead: counter('cacheRead', 0), cacheWrite: counter('cacheWrite', 0), reasoning: counter('reasoning', 1) },
              tokenTotal: { value: 6, availability: 'observed', source: 'simulated-total', semantics: 'authoritative-total' },
              inclusion: { input: 'disjoint', output: 'reasoning-in-output', cache: 'disjoint', reasoning: 'included-in-output' } },
            terminal: { cause: null, cancelled: false, transportException: null },
            capture: { status: 'captured', baselineCommit, patchSha256: null, workspaceSha256: null },
            timing: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), stages: { run: 1 } },
          });
          return { structuredOutput: { passed: verifyRuns > 1, feedback: verifyRuns === 1 ? 'Add a Unicode code point length limit.' : 'Candidate meets the request.' },
            usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 }, denials: [], stopReason: 'complete', model: 'gpt-6-sol' };
        }

        modelRuns += 1;
        const source = modelRuns === 1
          ? `export function isValidCampaignLabel(label) {\n  if (typeof label !== 'string') return false;\n  const normalized = label.trim();\n  return normalized.length > 0 && [...normalized].length <= 40;\n}\n`
          : `export function isValidCampaignLabel(label) {\n  if (typeof label !== 'string') return false;\n  const count = Array.from(label.trim()).length;\n  return count >= 1 && count <= 40;\n}\n`;
        writeFileSync(join(workspace, 'settings/module.js'), source);
        execFileSync('git', ['add', 'settings/module.js'], { cwd: workspace });
        try { execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: workspace }); }
        catch { execFileSync('git', ['-c', 'user.name=Screening Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'Simulated review-loop candidate'], { cwd: workspace }); }
        const candidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
        observations.set(identity.invocationId, {
          schemaVersion: 1, identity,
          usage: { counters: { input: counter('input', 4), output: counter('output', 2), cacheRead: counter('cacheRead', 0), cacheWrite: counter('cacheWrite', 0), reasoning: counter('reasoning', 1) },
            tokenTotal: { value: 6, availability: 'observed', source: 'simulated-total', semantics: 'authoritative-total' },
            inclusion: { input: 'disjoint', output: 'reasoning-in-output', cache: 'disjoint', reasoning: 'included-in-output' } },
          terminal: { cause: null, cancelled: false, transportException: null },
          capture: { status: 'captured', baselineCommit, patchSha256: null, workspaceSha256: candidateCommit },
          timing: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), stages: { run: 1 } },
        });
        return { structuredOutput: { changed: true, summary: 'Bound campaign labels to 40 Unicode code points.', commits: [candidateCommit] },
          usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 }, denials: [], stopReason: 'complete', model: 'gpt-6-sol' };
      },
    };
    try {
      const result = await runVisibleReviewLoopScreening({
      driver: driver as never,
      supervisor: { async cancelInvocationAndWait({ identity }) {
          return { invocationId: identity.invocationId, stageId: identity.stageId, attemptId: identity.attemptId,
            processTree: 'stopped-and-reaped', invocation: 'settled' };
      } },
        route: { id: 'codex-sol-simulated', transport: 'codex-exec', tokenEnforcement: 'unsupported', supportedSettings: { effort: ['high'] } },
        model: 'gpt-6-sol', provider: 'codex', effort: 'high', profileId: 'test-codex-sol', settingsId: 'effort-high',
        evaluationBoundaryHash: 'a'.repeat(64), toolsAssistanceHash: 'b'.repeat(64), tierId: 'visible-large',
        assignmentId: 'visible-review-assignment-01', runNamespace: 'review-repeat-01', outputRoot: join(root, 'run'),
        s1DependencyRoot: process.env.CQ_S1_DEPENDENCY_ROOT
          ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../cq-settings-integration'),
      });
      expect(result.status, JSON.stringify({ operationalStatus: result.strategy.operationalStatus,
        recipeCompleted: result.strategy.recipeCompleted, correctness: result.pipelineEvidence.candidateCorrectness,
        format: result.pipelineEvidence.formatCompliance, reasons: result.strategy.incompleteReasons,
        stages: result.strategy.stages.map(({ kind, status, detail, operationalError }) => ({ kind, status, detail, operationalError })) })).toBe('complete');
      expect(result.strategy.recipeKind).toBe('same-model-verify-repair');
      expect(result.strategy.stages.map((stage) => stage.kind)).toEqual(['draft', 'verify', 'repair', 'verify', 'independent-judge']);
      expect(result.strategy.stages[0]?.baselineCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(result.strategy.stages[0]?.baselineCommit).toBe(result.strategy.stages[2]?.baselineCommit);
      expect(result.strategy.stages.filter((stage) => stage.kind !== 'independent-judge')
        .every((stage) => stage.tokenCapMode === 'not-configured')).toBe(true);
      expect(result.strategy.accounting.usage.tokenTotal).toBeNull();
      expect(result.strategy.accounting.knownUsageSubtotals.tokenTotal).toBe(24);
      expect(result.taskOutcome).not.toBeNull();
      expect(result.pipelineEvidence.candidateCorrectness).toBe(result.strategy.candidateCorrectness);
      expect(result.pipelineEvidence.protectedOracleCleanup.status).toBe('proven');
      const cleanupReceipt = result.pipelineEvidence.protectedOracleCleanup.receipt;
      expect(cleanupReceipt).not.toBeNull();
      const cleanupBytes = readFileSync(join(root, 'run', cleanupReceipt!.path));
      expect(createHash('sha256').update(cleanupBytes).digest('hex')).toBe(cleanupReceipt!.sha256);
      const cleanupRecord = JSON.parse(cleanupBytes.toString('utf8')) as { planSha256: string; proof: Record<string, unknown> };
      expect(cleanupRecord).toMatchObject({ planSha256: result.pipelineEvidence.protectedOracleCleanup.planSha256,
        proof: { daemonVerified: true, ownershipVerified: true, containersAbsent: true,
          processTree: 'stopped-and-reaped', cleanup: 'complete', volumeDisposition: 'quarantined', inventoryContentVerified: false } });
      expect(result.pipelineEvidence.formatCompliance).toBeNull();
      expect(result.pipelineEvidence.assignedStrategySuccess).toBe(result.strategy.assignedStrategySuccess);
      expect(result.pipelineEvidence.execution.sourceInvocationIds).toHaveLength(4);
      expect(result.pipelineEvidence.stages.every((stage) => stage.invocationId?.startsWith('iv-'))).toBe(true);
      expect(result.pipelineEvidence.stages[0]?.usage.tokenTotal.value).toBe(6);
      expect(result.pipelineEvidence.stages.every((stage) => stage.usage.input.availability === 'observed'
        && stage.usage.input.inclusion === 'disjoint')).toBe(true);
      expect(result.rows).toHaveLength(1);
      expect(result.tables.length).toBeGreaterThan(0);
      const mappedOutcome = result.taskOutcome as {
        candidateCorrectness: boolean | null; formatConformance: boolean | null; assignedStrategySuccess: boolean | null;
        stages: readonly { stageId: string; attemptId: string; invocationId: string; artifacts: readonly unknown[] }[];
        judgements: readonly { judgementId: string; artifact: { path: string; sha256: string } }[];
      };
      expect(mappedOutcome.candidateCorrectness, JSON.stringify({ localDiagnostics: result.localJudge.diagnostics,
        outcome: result.localJudge.outcome, stages: result.strategy.stages.map((stage) => ({ kind: stage.kind, status: stage.status, detail: stage.detail })) })).toBe(false);
      expect(mappedOutcome.formatConformance).toBeNull();
      expect(mappedOutcome.assignedStrategySuccess).toBe(result.strategy.assignedStrategySuccess);
      expect(mappedOutcome.judgements).toHaveLength(2);
      expect(mappedOutcome.judgements[0]).toEqual(result.localJudge.outcome?.judgements[0]);
      expect(mappedOutcome.judgements[0]?.judgementId).toBe(result.localJudge.outcome?.judgements[0]?.judgementId);
      expect(mappedOutcome.judgements[1]?.judgementId).not.toBe(mappedOutcome.judgements[0]?.judgementId);
      expect(mappedOutcome.judgements[1]?.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      const appendedArtifact = readFileSync(join(root, 'run', 'artifacts', mappedOutcome.judgements[1]!.artifact.path));
      expect(createHash('sha256').update(appendedArtifact).digest('hex')).toBe(mappedOutcome.judgements[1]?.artifact.sha256);
      expect(mappedOutcome.stages.map((stage) => stage.invocationId)).toEqual(result.pipelineEvidence.stages.map((stage) => stage.invocationId));
      expect(mappedOutcome.stages.every((stage) => stage.artifacts.length === 0)).toBe(true);
      expect((result.rows[0] as { taskOutcome: unknown }).taskOutcome).toEqual(result.taskOutcome);
      expect(result.localJudge.pipelineCampaignEvidence).toBe(false);
      expect(result.localJudge.modelUsage).toBe('not-a-model-observation');
      expect(result.localJudge.rows).toHaveLength(1);
      expect(result.localJudge.tables.length).toBeGreaterThan(0);
      expect(result.localJudge.outcome?.formatConformance).toBe(true);
      expect(result.runIdentity).toMatch(/^[a-f0-9]{64}$/);
      expect(result.reportPath).toContain(result.runIdentity);
      const artifact = result.localJudge.outcome?.judgements[0]?.artifact;
      expect(artifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(readFileSync(join(root, 'run', 'artifacts', artifact!.path))).toBeTruthy();
      expect(result.limits.totalWallClockEnforced).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 180_000);

  it('requires three configurable tiers and runs a frozen recipe at each tier', async () => {
    expect(() => defineBudgetTiers([tier])).toThrow(/at least three/);
    const tiers = defineBudgetTiers([
      { ...tier, id: 'small', maxAttempts: 2, wallClockMs: 500, judgementAllowanceMs: 100 },
      { ...tier, id: 'medium' },
      { ...tier, id: 'large', maxAttempts: 12, wallClockMs: 5_000, judgementAllowanceMs: 500 },
    ]);
    const executor = new FakeExecutor();
    const results = await runStrategyTiers(task, { kind: 'one-shot', route: codex }, tiers, executor, { ids: fixedIds() });
    expect(results.map((entry) => entry.tierId)).toEqual(['small', 'medium', 'large']);
    expect(results.every((entry) => entry.assignedStrategySuccess === true)).toBe(true);
    expect(new Set(results.map((entry) => entry.recipeHash)).size).toBe(3);
  });

  it('uses S1-safe immutable stage and attempt IDs and keeps the stage ID on retry', () => {
    const first = strategyInvocationIdentity('assignment-fixed-01', 'a'.repeat(64), 'draft-primary', 1);
    const retry = strategyInvocationIdentity('assignment-fixed-01', 'a'.repeat(64), 'draft-primary', 2);
    expect(first.stageId).toBe(retry.stageId);
    expect(first.attemptId).not.toBe(retry.attemptId);
    const root = mkdtempSync(join(tmpdir(), 'strategy-artifact-id-'));
    try {
      const store = new ArtifactStore(root);
      const judgePath = 'fixtures/micro-1/check.mjs';
      const judgeBytes = readFileSync(join(process.cwd(), judgePath));
      const context = {
        campaignId: 'campaign-approved', cohortId: 'cohort-visible', experimentId: 'exp-fixed',
        taskId: 'micro-1', repeatId: 'repeat-01', assignmentId: 'assignment-fixed-01',
        stageId: retry.stageId, attemptId: retry.attemptId, track: 'native', strategyId: 'repair',
        settingsId: 'settings-fixed', budgetId: 'medium', profileId: 'profile-native', frozenWeight: 1,
        substrateId: 'micro-1:src/rangeSum.ts',
        judgeManifest: {
          sourcePin: 'micro-1-judge-v1',
          dependencies: [{ path: judgePath, sha256: createHash('sha256').update(judgeBytes).digest('hex') }],
        },
      };
      const ref = store.write(context, 'candidate.patch', 'captured edits');
      expect(ref.sha256).toBe(createHash('sha256').update('captured edits').digest('hex'));
      expect(ref.path).toContain('/task/micro-1/');
      expect(judgeManifestHash(context.judgeManifest)).toMatch(/^[a-f0-9]{64}$/);
      expect(context.judgeManifest.dependencies[0]?.sha256).toBe(createHash('sha256').update(judgeBytes).digest('hex'));
      expect(() => store.write({ ...context, stageId: 'bad:stage' }, 'candidate.patch', 'x')).toThrow(/unsafe path segment/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retrieves authoritative S1 usage and captures workspace edits after a native operation throws', async () => {
    let handedOff: NativeInvocationIdentity | undefined;
    const counter = (name: string, value: number) => ({ value, availability: 'observed' as const, source: `native-${name}`, semantics: name });
    const nativeDriver = {
      beginInvocation(identity: NativeInvocationIdentity) { handedOff = identity; },
      getObservation(invocationId: string): NativeStrategyObservation | undefined {
        if (!handedOff || handedOff.invocationId !== invocationId) return undefined;
        return {
          schemaVersion: 1,
          identity: handedOff,
          usage: {
            counters: {
              input: counter('input', 3), output: counter('output', 5), cacheRead: counter('cacheRead', 2),
              cacheWrite: counter('cacheWrite', 1), reasoning: counter('reasoning', 4),
            },
            tokenTotal: { value: 17, availability: 'observed', source: 'native-token-total', semantics: 'authoritative-total' },
            inclusion: { input: 'disjoint', output: 'reasoning-in-output', cache: 'disjoint-from-input', reasoning: 'included-in-output' },
          },
          terminal: { cause: 'transport-exception', cancelled: false, transportException: { name: 'Error', message: 'after edit' } },
          capture: { status: 'captured', baselineCommit: 'a'.repeat(40), patchSha256: 'b'.repeat(64), workspaceSha256: null },
          timing: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), stages: { run: 11 } },
        };
      },
    };
    const executor = createNativeStrategyExecutor(nativeDriver, {
      async runStage(request) {
        if (request.kind === 'draft') throw new Error('native transport failed after edit');
        return result({ judgement: { status: 'valid', correctness: true } });
      },
      captureCandidate(request, state) {
        expect(state.error).toBeInstanceOf(Error);
        return candidate('native-partial-edit', request.workspaceId);
      },
      createCandidateWorkspace(_request, _index, stableWorkspaceId) {
        return { id: stableWorkspaceId, handle: { id: stableWorkspaceId } };
      },
      supervisor: {
        async cancelInvocationAndWait({ identity }) {
          return { invocationId: identity.invocationId, stageId: identity.stageId, attemptId: identity.attemptId,
            processTree: 'stopped-and-reaped', invocation: 'settled' };
        },
      },
    });

    const outcome = await runStrategy(task, { kind: 'one-shot', route: codex }, tier, executor, {
      assignmentId: 'assignment-fixed-01', ids: fixedIds(),
    });
    const draft = outcome.stages.find((stage) => stage.kind === 'draft');
    expect(draft?.status).toBe('failed');
    expect(draft?.stageId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(draft?.usage.tokenTotal.value).toBe(17);
    expect(draft?.usage.tokenTotal.source).toBe('native-token-total');
    expect(draft?.baselineCommit).toBe('a'.repeat(40));
    expect(outcome.finalCandidate?.id).toBe('native-partial-edit');
    expect(outcome.candidateCorrectness).toBe(true);
    expect(outcome.assignedStrategySuccess).toBe(false);
  });

  it('uses the integrated native supervisor stop proof before candidate capture', async () => {
    const supervisor = new NativeSupervisorControl();
    let handedOff: NativeInvocationIdentity | undefined;
    const nativeDriver = {
      beginInvocation(identity: NativeInvocationIdentity) {
        handedOff = identity;
        supervisor.beginInvocation(identity);
      },
      getObservation() { return undefined; },
    };
    let captured = false;
    const executor = createNativeStrategyExecutor(nativeDriver, {
      async runStage(request) {
        const identity = handedOff!;
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        supervisor.settleInvocation(identity);
        return result({ status: 'cancelled' });
      },
      captureCandidate() { captured = true; return null; },
      createCandidateWorkspace(_request, _index, stableWorkspaceId) { return { id: stableWorkspaceId, handle: {} }; },
      supervisor,
    });
    const shortTier = {
      ...tier, wallClockMs: 500, judgementAllowanceMs: 100, shutdownAllowanceMs: 60,
      observationAllowanceMs: 30, captureAllowanceMs: 30,
    };
    const outcome = await runStrategy(task, { kind: 'one-shot', route: codex }, shortTier, executor, {
      assignmentId: 'assignment-native-stop', ids: fixedIds(),
    });
    expect(outcome.operationalStatus).toBe('timed-out');
    expect(outcome.stages[0]?.quarantined).toBe(false);
    expect(captured).toBe(true);
  });

  it('runs a serializable judge request in a real child and validates the durable hash-bound result', async () => {
    await withJudgeChild('success', async (childEntrypoint, request, root) => {
      const events: string[] = [];
      const supervisor = createIndependentJudgeProcessSupervisor({ childEntrypoint, privateRoot: root, ownershipForTest: fakeJudgeOwnershipForTest({ events }) });
      const execution = await supervisor.run(request, new AbortController().signal);
      expect(execution.result.judgement?.correctness).toBe(true);
      expect(execution.evidence.selection).toEqual({ judgementId: 'j-frozen', version: 1,
        judgePin: request.oraclePin, candidateSha256: request.candidate.sha256 });
      expect(execution.evidence.requestSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(execution.evidence.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(execution.evidence.processRoot.startsWith(root)).toBe(true);
      expect(execution.evidence.protectedOracleProof).toMatchObject({ daemonVerified: true, ownershipVerified: true,
        containersAbsent: true, volumeDisposition: 'quarantined', inventoryContentVerified: false });
      const receipt = execution.evidence.protectedOracleCleanupReceipt;
      const receiptPath = join(execution.evidence.artifactRoot, receipt.path.replace(/^artifacts\//, ''));
      const receiptBytes = readFileSync(receiptPath);
      expect(createHash('sha256').update(receiptBytes).digest('hex')).toBe(receipt.sha256);
      expect(JSON.parse(receiptBytes.toString('utf8'))).toMatchObject({ schemaVersion: 1,
        identity: request.identity, planSha256: execution.evidence.protectedOracleProof.planSha256,
        proof: { identity: request.identity, planSha256: execution.evidence.protectedOracleProof.planSha256,
          daemonVerified: true, ownershipVerified: true, containersAbsent: true,
          processTree: 'stopped-and-reaped', volumeDisposition: 'quarantined',
          resourceIds: ['fake-container', 'fake-volume'], cleanup: 'complete', inventoryContentVerified: false } });
      expect(events).toEqual(['plan-created', 'namespace-cleaned']);
      const proof = await supervisor.cancelAndWait({ identity: request.identity, cause: 'post-result-check',
        deadlineEpochMs: Date.now() + 100 });
      expect(proof).toMatchObject({ processTree: 'stopped-and-reaped', execution: 'settled',
        protectedOracleCleanup: 'proven', cleanup: 'complete' });
      await expect(supervisor.run(request, new AbortController().signal)).rejects.toThrow(/already admitted/);
    });
  });

  it('settles an asynchronous pre-spawn error with no pid and records exact-plan cleanup', async () => {
    await withJudgeChild('success', async (_entrypoint, request, root) => {
      const events: string[] = [];
      const supervisor = createIndependentJudgeProcessSupervisor({ privateRoot: root,
        ownershipForTest: fakeJudgeOwnershipForTest({ events }),
        spawnChildForTest: (() => {
          const child = fakeChildProcess();
          queueMicrotask(() => child.emit('error', Object.assign(new Error('missing executable'), { code: 'ENOENT' })));
          return child;
        }) as never,
      });
      await expect(supervisor.run(request, new AbortController().signal)).rejects.toThrow('independent judge child failed to spawn');
      const proof = await supervisor.cancelAndWait({ identity: request.identity, cause: 'inspect-spawn-error', deadlineEpochMs: Date.now() + 100 });
      expect(proof).toMatchObject({ processTree: 'stopped-and-reaped', protectedOracleCleanup: 'proven', cleanup: 'complete',
        protectedOracleCleanupReceipt: { path: expect.stringContaining('protected-oracle-cleanup.json'), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      expect(events).toEqual(['plan-created', 'namespace-cleaned']);
    });
  });

  it('does not claim host absence or invoke namespace cleanup after an error with unknown host state', async () => {
    await withJudgeChild('success', async (_entrypoint, request, root) => {
      const events: string[] = [];
      const supervisor = createIndependentJudgeProcessSupervisor({ privateRoot: root,
        ownershipForTest: fakeJudgeOwnershipForTest({ events }), groupGone: async () => false,
        spawnChildForTest: (() => {
          const child = fakeChildProcess(2_000_000_000);
          queueMicrotask(() => {
            child.emit('spawn');
            child.emit('error', new Error('post-spawn process error'));
          });
          return child;
        }) as never,
      });
      const bounded = { ...request, deadlineEpochMs: Date.now() + 80, shutdownDeadlineEpochMs: Date.now() + 850 };
      await expect(supervisor.run(bounded, new AbortController().signal)).rejects.toThrow(/decision deadline/);
      const proof = await supervisor.cancelAndWait({ identity: request.identity, cause: 'unknown-host', deadlineEpochMs: Date.now() + 100 });
      expect(proof).toMatchObject({ processTree: 'running-or-unknown', execution: 'unsettled',
        protectedOracleCleanup: 'unobserved', cleanup: 'quarantined' });
      expect(proof.protectedOracleCleanupReceipt).toBeUndefined();
      expect(events).toEqual(['plan-created']);
    });
  }, 5_000);

  it('rechecks cancellation after namespace preparation and cleans the unlaunched plan', async () => {
    await withJudgeChild('success', async (_entrypoint, request, root) => {
      const events: string[] = [];
      const controller = new AbortController();
      const supervisor = createIndependentJudgeProcessSupervisor({ privateRoot: root,
        ownershipForTest: fakeJudgeOwnershipForTest({ events }),
        beforeSpawnForTest: async () => { controller.abort(new Error('cancelled while preparing')); },
      });
      await expect(supervisor.run(request, controller.signal)).rejects.toThrow('independent judge cancelled during preparation');
      const proof = await supervisor.cancelAndWait({ identity: request.identity, cause: 'inspect-preparation-cancel', deadlineEpochMs: Date.now() + 100 });
      expect(proof).toMatchObject({ processTree: 'stopped-and-reaped', protectedOracleCleanup: 'proven', cleanup: 'complete',
        protectedOracleCleanupReceipt: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      expect(events).toEqual(['plan-created', 'namespace-cleaned']);
    });
  });

  it('rechecks the decision deadline after awaited namespace preparation', async () => {
    await withJudgeChild('success', async (_entrypoint, request, root) => {
      const events: string[] = [];
      const supervisor = createIndependentJudgeProcessSupervisor({ privateRoot: root,
        ownershipForTest: fakeJudgeOwnershipForTest({ events }),
        beforeSpawnForTest: async () => new Promise((resolveWait) => setTimeout(resolveWait, 35)),
      });
      const bounded = { ...request, deadlineEpochMs: Date.now() + 20 };
      await expect(supervisor.run(bounded, new AbortController().signal)).rejects.toThrow('decision deadline elapsed during preparation');
      const proof = await supervisor.cancelAndWait({ identity: request.identity, cause: 'inspect-preparation-deadline', deadlineEpochMs: Date.now() + 100 });
      expect(proof).toMatchObject({ processTree: 'stopped-and-reaped', protectedOracleCleanup: 'proven', cleanup: 'complete' });
      expect(events).toEqual(['plan-created', 'namespace-cleaned']);
    });
  });

  it('suppresses a valid result when immutable cleanup receipt recording fails', async () => {
    await withJudgeChild('success', async (childEntrypoint, request, root) => {
      const events: string[] = [];
      const supervisor = createIndependentJudgeProcessSupervisor({ childEntrypoint, privateRoot: root,
        ownershipForTest: fakeJudgeOwnershipForTest({ events }),
        receiptWriteHookForTest: () => { throw new Error('private recorder detail'); },
      });
      await expect(supervisor.run(request, new AbortController().signal)).rejects.toThrow('protected-oracle cleanup receipt could not be persisted');
      const proof = await supervisor.cancelAndWait({ identity: request.identity, cause: 'inspect-receipt-failure', deadlineEpochMs: Date.now() + 100 });
      expect(proof).toMatchObject({ protectedOracleCleanup: 'unobserved', cleanup: 'quarantined' });
      expect(proof.protectedOracleCleanupReceipt).toBeUndefined();
      expect(events).toEqual(['plan-created', 'namespace-cleaned']);
    });
  });

  it('keeps the primary cleanup receipt error when phase diagnostics throw', async () => {
    await withJudgeChild('success', async (childEntrypoint, request, root) => {
      const supervisor = createIndependentJudgeProcessSupervisor({ childEntrypoint, privateRoot: root,
        ownershipForTest: fakeJudgeOwnershipForTest(),
        receiptWriteHookForTest: () => { throw new Error('private recorder detail'); },
        phaseObserverForTest: (phase) => {
          if (phase === 'namespace-cleanup-failed') throw new Error('observer sentinel must be ignored');
        },
      });
      let caught: unknown;
      try { await supervisor.run(request, new AbortController().signal); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('protected-oracle cleanup receipt could not be persisted');
      expect((caught as Error).message).not.toContain('observer sentinel');
      const proof = await supervisor.cancelAndWait({ identity: request.identity, cause: 'inspect-observer-failure', deadlineEpochMs: Date.now() + 100 });
      expect(proof).toMatchObject({ protectedOracleCleanup: 'unobserved', cleanup: 'quarantined' });
      expect(proof.protectedOracleCleanupReceipt).toBeUndefined();
    });
  });

  it('rejects a cleanup receipt whose bytes change before hash validation', async () => {
    await withJudgeChild('success', async (childEntrypoint, request, root) => {
      const supervisor = createIndependentJudgeProcessSupervisor({ childEntrypoint, privateRoot: root,
        ownershipForTest: fakeJudgeOwnershipForTest(),
        receiptWriteHookForTest: (path) => { writeFileSync(path, 'tampered'); },
      });
      await expect(supervisor.run(request, new AbortController().signal)).rejects.toThrow('protected-oracle cleanup receipt integrity check failed');
      const proof = await supervisor.cancelAndWait({ identity: request.identity, cause: 'inspect-receipt-tamper', deadlineEpochMs: Date.now() + 100 });
      expect(proof.protectedOracleCleanup).toBe('unobserved');
      expect(proof.protectedOracleCleanupReceipt).toBeUndefined();
    });
  });

  it('does not expose private child stderr in public failures', async () => {
    await withJudgeChild('stderr-failure', async (childEntrypoint, request, root) => {
      const supervisor = createIndependentJudgeProcessSupervisor({ childEntrypoint, privateRoot: root, ownershipForTest: fakeJudgeOwnershipForTest() });
      let message = '';
      try { await supervisor.run(request, new AbortController().signal); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message).toBe('independent judge child failed (nonzero exit)');
      expect(message).not.toContain('PRIVATE_SENTINEL_ORACLE_DETAIL');
    });
  });

  it('rejects a valid host result and retains quarantine when exact S5 cleanup proof fails', async () => {
    await withJudgeChild('success', async (childEntrypoint, request, root) => {
      const events: string[] = [];
      const supervisor = createIndependentJudgeProcessSupervisor({ childEntrypoint, privateRoot: root,
        ownershipForTest: fakeJudgeOwnershipForTest({ failCleanup: true, events }) });
      await expect(supervisor.run(request, new AbortController().signal)).rejects.toThrow(/protected namespace cleanup could not be proven/);
      const proof = await supervisor.cancelAndWait({ identity: request.identity, cause: 'inspect-failed-cleanup',
        deadlineEpochMs: Date.now() + 100 });
      expect(proof).toMatchObject({ processTree: 'running-or-unknown', execution: 'settled',
        protectedOracleCleanup: 'unobserved', cleanup: 'quarantined' });
      expect(events).toEqual(['plan-created', 'namespace-cleaned']);
      expect(readdirSync(root).some((name) => name.startsWith('s4-judge-'))).toBe(true);
    });
  });

  it('rejects a valid result when process settlement crosses the decision deadline', async () => {
    await withJudgeChild('success', async (childEntrypoint, request, root) => {
      let cleanupObserved = false;
      const supervisor = createIndependentJudgeProcessSupervisor({ childEntrypoint, privateRoot: root,
        ownershipForTest: fakeJudgeOwnershipForTest(), groupGone: async () => {
          cleanupObserved = true;
          await new Promise((resolveWait) => setTimeout(resolveWait, 1_200));
          return true;
        } });
      const bounded = { ...request, deadlineEpochMs: Date.now() + 900, shutdownDeadlineEpochMs: Date.now() + 3_000 };
      await expect(supervisor.run(bounded, new AbortController().signal)).rejects.toThrow(/decision deadline/);
      expect(cleanupObserved).toBe(true);
    });
  }, 10_000);

  it('rejects a valid result when cancellation arrives during process settlement', async () => {
    await withJudgeChild('success', async (childEntrypoint, request, root) => {
      const controller = new AbortController();
      const supervisor = createIndependentJudgeProcessSupervisor({ childEntrypoint, privateRoot: root,
        ownershipForTest: fakeJudgeOwnershipForTest(), groupGone: async () => {
          controller.abort(new Error('cancelled during process settlement'));
          return true;
        } });
      await expect(supervisor.run(request, controller.signal)).rejects.toThrow(/cancelled before its result was accepted/);
    });
  });

  it('kills a timed-out judge process group before a descendant can publish a late result', async () => {
    await withJudgeChild('late-descendant', async (childEntrypoint, request, root, marker) => {
      const supervisor = createIndependentJudgeProcessSupervisor({ childEntrypoint, privateRoot: root, ownershipForTest: fakeJudgeOwnershipForTest() });
      const short = { ...request, deadlineEpochMs: Date.now() + 250, shutdownDeadlineEpochMs: Date.now() + 3_000 };
      await expect(supervisor.run(short, new AbortController().signal)).rejects.toThrow(/deadline/i);
      const proof = await supervisor.cancelAndWait({ identity: request.identity, cause: 'deadline',
        deadlineEpochMs: Date.now() + 100 });
      expect(proof).toMatchObject({ processTree: 'stopped-and-reaped', execution: 'settled',
        protectedOracleCleanup: 'proven', cleanup: 'complete' });
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_300));
      expect(existsSync(marker)).toBe(false);
      const processDirectory = readdirSync(root).find((name) => name.startsWith('s4-judge-'));
      expect(processDirectory).toBeDefined();
      expect(existsSync(join(root, processDirectory!, 'result.json'))).toBe(false);
    });
  }, 10_000);

  it('rejects a child result whose frozen request identity hash does not match', async () => {
    await withJudgeChild('mismatch', async (childEntrypoint, request, root) => {
      const supervisor = createIndependentJudgeProcessSupervisor({ childEntrypoint, privateRoot: root, ownershipForTest: fakeJudgeOwnershipForTest() });
      await expect(supervisor.run(request, new AbortController().signal)).rejects.toThrow(/identity or content hash mismatch/);
      const proof = await supervisor.cancelAndWait({ identity: request.identity, cause: 'result-mismatch',
        deadlineEpochMs: Date.now() + 100 });
      expect(proof.cleanup).toBe('complete');
    });
  });

  it('fails closed when the process-group cleanup proof is unavailable', async () => {
    await withJudgeChild('success', async (childEntrypoint, request, root) => {
      const events: string[] = [];
      const supervisor = createIndependentJudgeProcessSupervisor({ childEntrypoint, privateRoot: root,
        groupGone: async () => false, ownershipForTest: fakeJudgeOwnershipForTest({ events }) });
      const short = { ...request, shutdownDeadlineEpochMs: Date.now() + 700 };
      await expect(supervisor.run(short, new AbortController().signal)).rejects.toThrow(/cleanup could not be proven/);
      const proof = await supervisor.cancelAndWait({ identity: request.identity, cause: 'cleanup-test', deadlineEpochMs: Date.now() + 1 });
      expect(proof).toMatchObject({ processTree: 'running-or-unknown', execution: 'unsettled', cleanup: 'quarantined',
        protectedOracleCleanup: 'unobserved' });
      expect(events).toEqual(['plan-created', 'cleanup-refused']);
    });
  }, 10_000);

  it('charges draft, every verification and repair, and final independent judging', async () => {
    const executor = new FakeExecutor();
    let stageNumber = 0;
    executor.handler = (request) => {
      stageNumber += 1;
      const usage = Object.fromEntries(
        (['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tokenTotal'] as const)
          .map((key) => [key, { value: stageNumber, availability: 'observed' as const, source: `fake-${key}`, semantics: key, inclusion: 'disjoint-from-input' }]),
      ) as ExecutorResult['usage'];
      if (request.kind === 'draft') return result({ usage, candidate: candidate('first') });
      if (request.kind === 'verify' && stageNumber === 2) return result({ usage, verification: { passed: false, feedback: 'Fix the missing guard.' } });
      if (request.kind === 'repair') return result({ usage, candidate: candidate('repaired') });
      if (request.kind === 'verify') return result({ usage, verification: { passed: true, feedback: 'Good.' } });
      if (request.kind === 'independent-judge') return result({ usage, judgement: { status: 'valid', correctness: true } });
      return result({ usage });
    };
    const outcome = await runStrategy(task, { kind: 'same-model-verify-repair', route: codex, maxRepairs: 2 }, tier, executor, { ids: fixedIds() });

    expect(outcome.stages.map((stage) => stage.kind)).toEqual(['draft', 'verify', 'repair', 'verify', 'independent-judge']);
    expect(outcome.accounting.attempts).toBe(4);
    expect(outcome.accounting.stages).toBe(5);
    expect(outcome.accounting.usage.input).toBe(15);
    expect(outcome.accounting.usage.tokenTotal).toBe(15);
    expect(outcome.accounting.verificationMs).toBeGreaterThan(0);
    expect(outcome.candidates.map((item) => item.id)).toEqual(['first', 'repaired']);
    expect(outcome.finalCandidate?.id).toBe('repaired');
    expect(outcome.candidateCorrectness).toBe(true);
    expect(outcome.assignedStrategySuccess).toBe(true);
  });

  it('captures edits in finally when a transport throws and keeps the throw visible', async () => {
    const edited = candidate('edited-before-throw');
    const executor = new FakeExecutor();
    executor.handler = (request) => {
      if (request.kind === 'draft') throw new Error('transport disconnected after write');
      if (request.kind === 'independent-judge') return result({ judgement: { status: 'valid', correctness: true } });
      return result();
    };
    executor.capture = (_request, state) => state.error ? edited : null;
    executor.observation = (request) => {
      if (request.kind !== 'draft') return null;
      const usage = unknownUsage();
      return { usage: { ...usage,
        input: { value: 9, availability: 'observed', source: 'native-envelope', semantics: 'input', inclusion: 'disjoint-from-input' },
        tokenTotal: { value: 12, availability: 'observed', source: 'native-envelope', semantics: 'tokenTotal', inclusion: null },
      }, launched: true, serviceTimeMs: 17 };
    };
    const outcome = await runStrategy(task, { kind: 'one-shot', route: codex }, tier, executor, { ids: fixedIds() });

    expect(outcome.finalCandidate).toEqual(edited);
    expect(outcome.candidateCorrectness).toBe(true);
    expect(outcome.assignedStrategySuccess).toBe(false);
    expect(outcome.accounting.usage.input).toBe(9);
    expect(outcome.accounting.usage.tokenTotal).toBe(12);
    expect(outcome.stages[0]?.status).toBe('failed');
    expect(outcome.stages[0]?.operationalError?.message).toContain('after write');
    expect(outcome.incompleteReasons.some((reason) => reason.startsWith('stage-threw:'))).toBe(true);
  });

  it('aborts, proves supervisor settlement, then captures timeout edits before judging', async () => {
    const executor = new FakeExecutor();
    const timeoutCandidate = candidate('timeout-edit');
    const order: string[] = [];
    let settleExecution!: (value: ExecutorResult) => void;
    executor.handler = (request) => request.kind === 'draft'
      ? new Promise<ExecutorResult>((resolve) => { settleExecution = resolve; request.signal.addEventListener('abort', () => order.push('aborted'), { once: true }); })
      : result({ judgement: { status: 'valid', correctness: true, taskSuccess: true } });
    executor.stopAndWait = async (request, execution) => {
      order.push('stopped'); executor.stopped = true;
      settleExecution(result({ status: 'cancelled', usage: unknownUsage(), serviceTimeMs: null }));
      await execution;
      return { stopped: true, executionSettled: true };
    };
    executor.capture = () => { order.push('captured'); return timeoutCandidate; };
    const outcome = await runStrategy(task, { kind: 'one-shot', route: codex }, {
      ...tier, wallClockMs: 180, judgementAllowanceMs: 30, shutdownAllowanceMs: 40, observationAllowanceMs: 20, captureAllowanceMs: 40,
    }, executor, { ids: fixedIds() });
    expect(order.slice(0, 3)).toEqual(['aborted', 'stopped', 'captured']);
    expect(outcome.candidateCorrectness).toBe(true);
    expect(outcome.assignedStrategySuccess).toBe(false);
    expect(outcome.operationalStatus).toBe('timed-out');
    expect(outcome.finalCandidate?.id).toBe('timeout-edit');
  });

  it('quarantines a workspace when the supervisor cannot prove settlement', async () => {
    const executor = new FakeExecutor();
    let captures = 0;
    executor.handler = () => new Promise<ExecutorResult>(() => {});
    executor.stopAndWait = async () => ({ stopped: false, executionSettled: false });
    executor.capture = () => { captures += 1; return candidate('unsafe'); };
    const outcome = await runStrategy(task, { kind: 'one-shot', route: codex }, {
      ...tier, wallClockMs: 100, judgementAllowanceMs: 20, shutdownAllowanceMs: 10, observationAllowanceMs: 10, captureAllowanceMs: 10,
    }, executor, { ids: fixedIds() });
    expect(outcome.stages[0]?.quarantined).toBe(true);
    expect(outcome.finalCandidate).toBeNull();
    expect(captures).toBe(0);
    expect(executor.requests.some((request) => request.kind === 'independent-judge')).toBe(false);
  });

  it('allows independent judging after cancellation but marks assigned success as failure', async () => {
    const executor = new FakeExecutor();
    const controller = new AbortController();
    let settleExecution!: (value: ExecutorResult) => void;
    executor.handler = (request) => request.kind === 'draft'
      ? new Promise<ExecutorResult>((resolve) => { settleExecution = resolve; setTimeout(() => controller.abort(new Error('operator cancelled')), 5); })
      : request.kind === 'independent-judge'
        ? result({ judgement: { status: 'valid', correctness: true, taskSuccess: true, formatCompliance: true } })
        : result();
    executor.stopAndWait = async (_request, execution) => {
      settleExecution(result({ status: 'cancelled', usage: unknownUsage(), serviceTimeMs: null }));
      await execution;
      return { stopped: true, executionSettled: true };
    };
    executor.capture = (request) => request.kind === 'draft' ? candidate('cancelled-edit', request.workspaceId) : null;
    const outcome = await runStrategy(task, { kind: 'one-shot', route: codex }, tier, executor, { ids: fixedIds(), signal: controller.signal });
    expect(executor.requests.some((request) => request.kind === 'independent-judge')).toBe(true);
    expect(outcome.candidateCorrectness).toBe(true);
    expect(outcome.formatCompliance).toBe(true);
    expect(outcome.assignedStrategySuccess).toBe(false);
    expect(outcome.operationalStatus).toBe('cancelled');
  });

  it('keeps a format miss separate from a mechanically correct candidate', async () => {
    const executor = new FakeExecutor();
    executor.handler = (request) => request.kind === 'draft'
      ? result({ candidate: candidate('mechanically-correct', request.workspaceId) })
      : request.kind === 'independent-judge'
        ? result({ judgement: { status: 'valid', correctness: true, formatCompliance: false } })
        : result();
    const outcome = await runStrategy({ ...task, requireFormatCompliance: true }, { kind: 'one-shot', route: codex }, tier, executor, { ids: fixedIds() });
    expect(outcome.candidateCorrectness).toBe(true);
    expect(outcome.formatCompliance).toBe(false);
    expect(outcome.assignedStrategySuccess).toBe(false);
    expect(outcome.operationalStatus).toBe('complete');
  });

  it('does not launch a pre-cancelled stage and fails closed after hard-required token uncertainty', async () => {
    const preCancelled = new FakeExecutor();
    const controller = new AbortController(); controller.abort(new Error('already cancelled'));
    const cancelled = await runStrategy(task, { kind: 'one-shot', route: codex }, tier, preCancelled, { ids: fixedIds(), signal: controller.signal });
    expect(preCancelled.requests).toHaveLength(0);
    expect(cancelled.operationalStatus).toBe('cancelled');
    expect(cancelled.candidateCorrectness).toBeNull();

    const unknown = new FakeExecutor();
    unknown.handler = (request) => request.kind === 'draft'
      ? result({ candidate: candidate('uncertain-token', request.workspaceId), usage: unknownUsage() })
      : request.kind === 'independent-judge' ? result({ judgement: { status: 'valid', correctness: true } }) : result();
    const failedClosed = await runStrategy(task, { kind: 'same-model-verify-repair', route: codex, maxRepairs: 1 },
      { ...tier, tokenPolicy: 'hard-required' }, unknown, { ids: fixedIds() });
    expect(unknown.requests.filter((request) => request.kind === 'verify' || request.kind === 'repair')).toHaveLength(0);
    expect(unknown.requests[0]?.hardTokenCap).toBe(1_000);
    expect(failedClosed.candidateCorrectness).toBe(true);
    expect(failedClosed.assignedStrategySuccess).toBe(false);
    expect(failedClosed.operationalStatus).toBe('operational-failure');
  });

  it('does not accept a passing verification attached to a failed stage', async () => {
    const executor = new FakeExecutor();
    executor.handler = (request) => request.kind === 'draft'
      ? result({ candidate: candidate('unverified', request.workspaceId) })
      : request.kind === 'verify'
        ? result({ status: 'failed', verification: { passed: true, feedback: 'untrusted failed-stage result' } })
        : request.kind === 'independent-judge'
          ? result({ judgement: { status: 'valid', correctness: true } })
          : result({ candidate: candidate('repair', request.workspaceId) });
    const outcome = await runStrategy(task, { kind: 'same-model-verify-repair', route: codex, maxRepairs: 1 }, tier, executor, { ids: fixedIds() });
    expect(outcome.recipeCompleted).toBe(false);
    expect(outcome.assignedStrategySuccess).toBe(false);
  });

  it('accounts for model and judge candidate selection without external effects', async () => {
    const executor = new FakeExecutor();
    executor.handler = (request) => {
      if (request.kind === 'draft') return result({ candidate: candidate(`candidate-${executor.requests.filter((item) => item.kind === 'draft').length}`, request.workspaceId) });
      if (request.kind === 'select') return result({
        selectedCandidateId: request.inputCandidates[1]?.id,
        usage: Object.fromEntries(
          (['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tokenTotal'] as const)
            .map((key) => [key, { value: 5, availability: 'observed' as const, source: 'selector', semantics: key, inclusion: null }]),
        ) as ExecutorResult['usage'],
      });
      if (request.kind === 'independent-judge') return result({ judgement: { status: 'valid', correctness: false } });
      return result();
    };
    const outcome = await runStrategy(task, {
      kind: 'candidate-selection', route: codex, candidateCount: 2, selector: { kind: 'judge', route: glm },
    }, tier, executor, { ids: fixedIds() });

    const selection = executor.requests.find((request) => request.kind === 'select');
    expect(selection?.purpose).toBe('selection');
    expect(selection?.selectionPolicy).toBe('judge');
    expect(selection?.route).toEqual(glm);
    expect(selection?.allowedExternalEffects).toEqual([]);
    const drafts = executor.requests.filter((request) => request.kind === 'draft');
    expect(new Set(drafts.map((request) => request.workspaceId)).size).toBe(2);
    expect(drafts.every((request) => request.inputCandidates.length === 0)).toBe(true);
    expect(outcome.accounting.attempts).toBe(3);
    expect(outcome.stages.map((stage) => stage.kind)).toEqual(['draft', 'draft', 'select', 'independent-judge']);
    expect(outcome.selectedCandidateId).toBe('candidate-2');
    expect(outcome.accounting.stages).toBe(4);
    expect(outcome.accounting.usage.tokenTotal).toBe(5);
    expect(outcome.assignedStrategySuccess).toBe(false);
  });

  it('keeps known usage subtotals and makes a whole-pipeline counter unknown', async () => {
    const executor = new FakeExecutor();
    executor.handler = (request) => {
      if (request.kind === 'draft') {
        const usage = unknownUsage();
        return result({ candidate: candidate('partial-usage'), usage: {
          ...usage,
          input: { value: 7, availability: 'observed', source: 'event', semantics: 'input', inclusion: 'disjoint-from-input' },
          output: { value: null, availability: 'unavailable', source: 'event', semantics: 'output', inclusion: 'disjoint-from-input' },
        } });
      }
      if (request.kind === 'independent-judge') return result({ judgement: { status: 'valid', correctness: true } });
      return result();
    };
    const outcome = await runStrategy(task, { kind: 'one-shot', route: glm }, tier, executor, { ids: fixedIds() });

    expect(outcome.accounting.tokenBudgetMode).toBe('unsupported');
    expect(executor.requests[0]?.hardTokenCap).toBeNull();
    expect(executor.requests[0]?.tokenCapMode).toBe('unsupported');
    expect(outcome.accounting.usage.input).toBe(7);
    expect(outcome.accounting.knownUsageSubtotals.output).toBe(0);
    expect(outcome.accounting.usage.output).toBeNull();
    expect(outcome.accounting.usage.tokenTotal).toBeNull();
    expect(outcome.accounting.usageComplete.output).toBe(false);
  });

  it('distinguishes a launched budget failure from an unavailable independent judge', async () => {
    const noCandidate = new FakeExecutor();
    noCandidate.handler = (request) => request.kind === 'draft'
      ? result({ status: 'completed', candidate: null, launched: true })
      : result();
    const exhausted = await runStrategy(task, {
      kind: 'cheap-first-escalation', tiers: [{ route: codex, effort: 'low' }, { route: glm, effort: 'high' }],
      promoteWhen: 'no-candidate',
    }, { ...tier, maxAttempts: 1 }, noCandidate, { ids: fixedIds() });
    expect(exhausted.candidateCorrectness).toBe(false);
    expect(exhausted.assignedStrategySuccess).toBe(false);
    expect(exhausted.operationalStatus).toBe('budget-exhausted');
    expect(exhausted.accounting.attempts).toBe(1);

    const judgeMissing = new FakeExecutor();
    judgeMissing.handler = (request) => request.kind === 'draft'
      ? result({ candidate: candidate('needs-judge') })
      : request.kind === 'independent-judge'
        ? result({ judgement: { status: 'unavailable', correctness: null, detail: 'judge host unavailable' } })
        : result();
    const missing = await runStrategy(task, { kind: 'one-shot', route: codex }, tier, judgeMissing, { ids: fixedIds() });
    expect(missing.candidateCorrectness).toBeNull();
    expect(missing.assignedStrategySuccess).toBeNull();
    expect(missing.operationalStatus).toBe('judge-unavailable');
  });

  it('keeps the final oracle result out of verifier feedback and records mixed routes', async () => {
    const executor = new FakeExecutor();
    executor.handler = (request) => {
      if (request.kind === 'draft') return result({ candidate: candidate('mixed-draft') });
      if (request.kind === 'verify') return result({ verification: { passed: false, feedback: 'Missing null guard.' } });
      if (request.kind === 'repair') return result({ candidate: candidate('mixed-repair') });
      if (request.kind === 'independent-judge') return result({ judgement: { status: 'valid', correctness: true, detail: 'oracle pass' } });
      return result();
    };
    const outcome = await runStrategy(task, {
      kind: 'mixed-model-verify-repair', draftRoute: codex, verifyRoute: glm, repairRoute: codex, maxRepairs: 1,
    }, tier, executor, { ids: fixedIds() });
    const repair = executor.requests.find((request) => request.kind === 'repair');
    expect(repair?.feedback).toBe('Missing null guard.');
    expect(repair?.feedback).not.toContain('oracle pass');
    expect(outcome.stages.map((stage) => stage.routeId)).toEqual([codex.id, glm.id, codex.id, glm.id, task.independentJudgeRoute.id]);
    expect(outcome.accounting.tokenBudgetMode).toBe('unsupported');
  });

  it('skips unneeded verification for no-candidate promotion and marks required verification omitted by limits', async () => {
    const noCandidate = new FakeExecutor();
    noCandidate.handler = (request) => request.kind === 'draft'
      ? result({ candidate: candidate('cheap-success', request.workspaceId) })
      : request.kind === 'independent-judge' ? result({ judgement: { status: 'valid', correctness: true } }) : result();
    const cheap = await runStrategy(task, {
      kind: 'cheap-first-escalation', tiers: [{ route: codex, effort: 'low' }, { route: glm, effort: 'high' }], promoteWhen: 'no-candidate',
    }, tier, noCandidate, { ids: fixedIds() });
    expect(cheap.stages.map((stage) => stage.kind)).toEqual(['draft', 'independent-judge']);
    expect(cheap.recipeCompleted).toBe(true);

    const exhausted = await runStrategy(task, { kind: 'same-model-verify-repair', route: codex, maxRepairs: 1 },
      { ...tier, maxAttempts: 1 }, noCandidate, { ids: fixedIds() });
    expect(exhausted.recipeCompleted).toBe(false);
    expect(exhausted.incompleteReasons).toContain('required-final-verification-not-admitted');
    expect(exhausted.operationalStatus).toBe('budget-exhausted');
    expect(exhausted.authorizedBudgetStop).toBe(true);
  });

  it('bounds a hung executor by the per-task wall clock', async () => {
    const executor = new FakeExecutor();
    executor.handler = () => new Promise<ExecutorResult>(() => {});
    const outcome = await runStrategy(task, { kind: 'one-shot', route: codex }, {
      ...tier, wallClockMs: 100, judgementAllowanceMs: 20, shutdownAllowanceMs: 10, observationAllowanceMs: 10, captureAllowanceMs: 10,
    }, executor, { ids: fixedIds() });
    expect(outcome.stages[0]?.status).toBe('timed-out');
    expect(outcome.operationalStatus).toBe('timed-out');
    expect(outcome.accounting.endToEndMs).toBeLessThan(500);
    expect(outcome.candidateCorrectness).toBeNull();
  });

  it('rejects a late successful judge and gives settlement its separate bounded reserve', async () => {
    const executor = new FakeExecutor();
    let finishJudge!: (value: ExecutorResult) => void;
    executor.handler = (request) => request.kind === 'draft'
      ? result({ candidate: candidate('deadline-candidate', request.workspaceId) })
      : request.kind === 'independent-judge'
        ? new Promise<ExecutorResult>((resolve) => { finishJudge = resolve; })
        : result();
    executor.stopAndWait = async (request, execution) => {
      expect(request.kind).toBe('independent-judge');
      finishJudge(result({ judgement: { status: 'valid', correctness: true } }));
      await execution;
      executor.stopped = true;
      return { stopped: true, executionSettled: true };
    };
    const started = performance.now();
    const outcome = await runStrategy(task, { kind: 'one-shot', route: codex }, {
      ...tier, wallClockMs: 260, judgementAllowanceMs: 90, shutdownAllowanceMs: 35,
      observationAllowanceMs: 15, captureAllowanceMs: 20,
    }, executor, { ids: fixedIds() });
    const judge = outcome.stages.find((stage) => stage.kind === 'independent-judge');
    expect(executor.stopped).toBe(true);
    expect(judge?.status).toBe('timed-out');
    expect(judge?.quarantined).toBe(false);
    expect(outcome.candidateCorrectness).toBeNull();
    expect(outcome.accounting.endToEndMs).toBeLessThan(300);
    expect(performance.now() - started).toBeLessThan(350);
  });

  it('quarantines a judge when its supervisor cannot prove cleanup', async () => {
    const executor = new FakeExecutor();
    executor.handler = (request) => request.kind === 'draft'
      ? result({ candidate: candidate('unclean-judge-candidate', request.workspaceId) })
      : request.kind === 'independent-judge' ? new Promise<ExecutorResult>(() => {}) : result();
    executor.stopAndWait = async () => ({ stopped: false, executionSettled: false });
    const outcome = await runStrategy(task, { kind: 'one-shot', route: codex }, {
      ...tier, wallClockMs: 240, judgementAllowanceMs: 80, shutdownAllowanceMs: 30,
      observationAllowanceMs: 10, captureAllowanceMs: 20,
    }, executor, { ids: fixedIds() });
    const judge = outcome.stages.find((stage) => stage.kind === 'independent-judge');
    expect(judge?.quarantined).toBe(true);
    expect(outcome.finalCandidate?.sha256).toBe(candidate('unclean-judge-candidate', 'task-workspace').sha256);
    expect(outcome.candidateCorrectness).toBeNull();
    expect(outcome.incompleteReasons).toContain(`executor-not-settled:${judge?.stageId}`);
  });
});

describe('outcome-blind broad screening catalog', () => {
  const digest = (letter: string) => letter.repeat(64);
  const screeningInputs = (overrides: Partial<ScreeningCatalogInputs> = {}): ScreeningCatalogInputs => ({
    budgetTiers: [
      { id: 'screen-small', maxAttempts: 8, maxStages: 12, wallClockMs: 60_000, judgementAllowanceMs: 5_000,
        shutdownAllowanceMs: 2_000, observationAllowanceMs: 1_000, captureAllowanceMs: 2_000, tokenPolicy: 'advisory' },
      { id: 'screen-medium', maxAttempts: 12, maxStages: 18, wallClockMs: 180_000, judgementAllowanceMs: 8_000,
        shutdownAllowanceMs: 3_000, observationAllowanceMs: 2_000, captureAllowanceMs: 3_000, tokenPolicy: 'advisory' },
      { id: 'screen-large', maxAttempts: 20, maxStages: 28, wallClockMs: 480_000, judgementAllowanceMs: 12_000,
        shutdownAllowanceMs: 5_000, observationAllowanceMs: 3_000, captureAllowanceMs: 5_000, tokenPolicy: 'advisory' },
    ],
    boundaryHashes: { native: digest('a'), diagnostic: digest('b') },
    toolsAssistanceHashes: { native: digest('c'), diagnostic: digest('d') },
    sourcePin: 'fixtures:abc123', corpusPin: 'review-loop:v2', judgePin: 'judge:sha256:123',
    ...overrides,
  });

  it('covers verified effort levels with all five recipes and three tiers on separate tracks', () => {
    const catalog = createScreeningCatalog(screeningInputs());
    expect(createScreeningCatalog(screeningInputs()).catalogId).toBe(catalog.catalogId);
    const native = catalog.candidates.filter((candidate) => candidate.track === 'native');
    const diagnostic = catalog.candidates.filter((candidate) => candidate.track === 'diagnostic');
    expect(catalog.candidateCount).toBeLessThan(140);
    expect(catalog.trackCandidateCounts).toEqual({ native: 90, diagnostic: 24 });
    expect(native.length).toBeGreaterThan(0);
    expect(diagnostic.length).toBeGreaterThan(0);
    for (const track of ['native', 'diagnostic'] as const) {
      const cells = catalog.candidates.filter((candidate) => candidate.track === track);
      expect(new Set(cells.map((candidate) => candidate.recipeId))).toEqual(new Set([
        'one-shot', 'same-model-verify-repair', 'candidate-selection', 'mixed-model-verify-repair', 'cheap-first-escalation',
      ]));
      for (const kind of new Set(cells.map((candidate) => candidate.recipeId))) {
        expect(new Set(cells.filter((candidate) => candidate.recipeId === kind).map((candidate) => candidate.budgetTier.id)))
          .toEqual(new Set(['screen-small', 'screen-medium', 'screen-large']));
      }
    }
    expect(SCREENING_PROFILES.find((profile) => profile.id === 'codex-sol')?.supportedEfforts)
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(SCREENING_PROFILES.find((profile) => profile.id === 'codex-luna')?.supportedEfforts)
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(SCREENING_PROFILES.find((profile) => profile.id === 'zcode-glm-flash')?.supportedEfforts)
      .toEqual(['low', 'high', 'max']);
    expect(SCREENING_PROFILES.find((profile) => profile.id === 'pi-space-bunny')?.supportedEfforts).toEqual([]);
    expect(catalog.unsupportedSettings).toContainEqual(expect.objectContaining({
      profileId: 'pi-space-bunny', setting: 'effort', value: 'high', status: 'not-exposed',
    }));
    expect(catalog.candidates.every((candidate) => candidate.plannedCandidateOnly && candidate.status === 'planned')).toBe(true);
    expect(catalog.candidates.every((candidate) => candidate.chargedStageEnvelope.tokenCapClaim === 'none')).toBe(true);
    const diagnosticBaseline = catalog.candidates.find((candidate) => candidate.track === 'diagnostic' && candidate.recipe.kind === 'one-shot');
    expect(diagnosticBaseline?.recipe.kind === 'one-shot' ? diagnosticBaseline.recipe.route.transport : null).toBe('shared-diagnostic');
  });

  it('binds effective profile, evaluation boundary, assistance and all cumulative tier limits into identity', async () => {
    const first = createScreeningCatalog(screeningInputs());
    const changed = createScreeningCatalog(screeningInputs({
      toolsAssistanceHashes: { native: digest('e'), diagnostic: digest('d') },
    }));
    const firstCell = first.candidates.find((candidate) => candidate.track === 'native' && candidate.recipeId === 'one-shot' && candidate.selectedEfforts[0] === 'low' && candidate.budgetTier.id === 'screen-small')!;
    const changedCell = changed.candidates.find((candidate) => candidate.track === 'native' && candidate.recipeId === 'one-shot' && candidate.selectedEfforts[0] === 'low' && candidate.budgetTier.id === 'screen-small')!;
    expect(firstCell.strategyId).not.toBe(changedCell.strategyId);
    expect(firstCell.chargedStageEnvelope).toMatchObject({
      chargedAttempts: 2, chargedStages: 2, tierAttemptCap: 8, tierStageCap: 12,
      independentJudgeReserveMs: 5_000, tokenBudget: null, tokenCapClaim: 'none',
    });
    const selection = first.candidates.find((candidate) => candidate.recipeId === 'candidate-selection' && candidate.budgetTier.id === 'screen-small')!;
    expect(selection.chargedStageEnvelope.chargedStages).toBe(4); // two drafts + selector + independent judge
    expect(Object.isFrozen(selection.recipe)).toBe(true);
    expect(first.candidates.find((candidate) => candidate.recipeId === 'same-model-verify-repair' && candidate.budgetTier.id === 'screen-small')?.chargedStageEnvelope.chargedStages)
      .toBe(5); // draft, verify, repair, final verify, independent judge
    expect(first.candidates.find((candidate) => candidate.recipeId === 'mixed-model-verify-repair' && candidate.budgetTier.id === 'screen-small')?.chargedStageEnvelope.chargedStages)
      .toBe(5);
    expect(first.candidates.find((candidate) => candidate.recipeId === 'cheap-first-escalation' && candidate.budgetTier.id === 'screen-small')?.chargedStageEnvelope.chargedStages)
      .toBe(4); // low draft + verify + high escalation + independent judge
    const lowEffortBaseline = first.candidates.find((candidate) => candidate.track === 'native' && candidate.recipe.kind === 'one-shot'
      && candidate.profileIds[0] === 'codex-sol' && candidate.selectedEfforts[0] === 'low' && candidate.budgetTier.id === 'screen-small')!;
    expect(lowEffortBaseline.recipe.kind === 'one-shot' ? lowEffortBaseline.recipe.route.selectedEffort : null).toBe('low');
    const executor = new FakeExecutor();
    await runStrategy(task, lowEffortBaseline.recipe, lowEffortBaseline.budgetTier, executor, { assignmentId: 'catalog-assignment-01' });
    expect(executor.requests.find((request) => request.kind === 'draft')?.effort).toBe('low');
  });

  it('rejects token-cap claims for routes without verified enforcement', () => {
    const inputs = screeningInputs({ budgetTiers: screeningInputs().budgetTiers.map((tier, index) => index === 0 ? { ...tier, tokenBudget: 500 } : tier) });
    expect(() => createScreeningCatalog(inputs)).toThrow(/no verified hard token caps/);
  });

  it('freezes tunable calibration rules and a separate sealed held-out manifest before outcomes', () => {
    const catalog = createScreeningCatalog(screeningInputs());
    const design = freezeScreeningDesign(catalog, {
      designId: 'visible-screen-v1', frozenAtUTC: '2026-09-29T01:00:00Z',
      calibration: { cohortId: 'calibration-01', taskManifestHash: digest('1'), substrateManifestHash: digest('2'), pilotEvidenceHash: digest('3') },
      heldOut: { cohortId: 'heldout-01', taskManifestHash: digest('4'), substrateManifestHash: digest('5'), reservedBeforeOutcomes: true },
      promotionPolicy: { minimumPairedSubstrates: 8, promisingSuccessDifference: 0.05, uncertaintyConfidence: 0.95,
        retainIfUncertaintyHalfWidthAtLeast: 0.1, alwaysRetainIndividualModelBaselines: true, calibrationOnly: true },
      tuningInputs: { budgetPilotManifestHash: digest('6'), variancePilotManifestHash: digest('7'), budgetsDerivedFromPilot: true },
    });
    expect(design).toMatchObject({
      heldOutSealedFromPromotion: true, cohortPoolingAllowed: false,
      tracks: ['native', 'diagnostic'], catalogId: catalog.catalogId,
    });
    expect(design.candidateIds).toHaveLength(catalog.candidateCount);
    expect(design.designHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => freezeScreeningDesign(catalog, {
      designId: 'bad-design', frozenAtUTC: '2026-09-29T01:00:00Z',
      calibration: { ...design.calibration }, heldOut: { ...design.heldOut, cohortId: design.calibration.cohortId },
      promotionPolicy: { ...design.promotionPolicy }, tuningInputs: { ...design.tuningInputs },
    })).toThrow(/cohorts must be distinct/);
    const comparison = createScreeningComparisonArtifact(catalog, design, 'native', digest('8'),
      catalog.candidates.filter((candidate) => candidate.track === 'native').map((candidate) => ({
        candidateId: candidate.candidateId, assignmentCount: 0, launchCount: 0, validOutcomeCount: 0,
        operationalCompletionRate: null, conditionalCorrectness: null, assignedStrategySuccess: null,
        pairedSubstrateCount: 0, uncertaintyInterval95: null, disposition: 'unscreened' as const,
        dispositionReason: 'planned candidate has no calibration assignments yet',
      })));
    expect(comparison).toMatchObject({ cohortId: 'calibration-01', track: 'native', heldOutOutcomeManifestHash: null, cohortPoolingAllowed: false });
    expect(comparison.comparisons).toHaveLength(catalog.trackCandidateCounts.native);
    const diagnosticCandidateId = catalog.candidates.find((candidate) => candidate.track === 'diagnostic')!.candidateId;
    expect(() => createScreeningComparisonArtifact(catalog, design, 'native', digest('8'), [
      { ...comparison.comparisons[0]!, candidateId: diagnosticCandidateId },
      ...comparison.comparisons.slice(1),
    ])).toThrow(/outside the frozen native design/);
  });
});
