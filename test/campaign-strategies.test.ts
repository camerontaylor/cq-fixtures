import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactStore } from '../../cq-settings-integration/runner/artifacts/index.ts';
import { judgeManifestHash } from '../../cq-settings-integration/runner/experiment.ts';
import { captureGitCandidatePatch, resolveS1DependencyRoot, runVisibleReviewLoopScreening, visibleRunIdentity } from '../runner/strategies/visible-screening.ts';
import { NativeSupervisorControl } from '../../cq-settings-integration/runner/native/process.ts';
import { createNativeStrategyExecutor, type NativeInvocationIdentity, type NativeStrategyObservation } from '../runner/strategies/executor.ts';
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

  it('keeps local S1 judge rows separate from same-model pipeline evidence', async () => {
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
        writeFileSync(join(workspace, 'src/settings.mjs'), source);
        execFileSync('git', ['add', 'src/settings.mjs'], { cwd: workspace });
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
        evaluationBoundaryHash: 'a'.repeat(64), toolsAssistanceHash: 'b'.repeat(64), tierId: 'visible-small',
        assignmentId: 'visible-review-assignment-01', runNamespace: 'review-repeat-01', outputRoot: join(root, 'run'),
        s1DependencyRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../../cq-settings-integration'),
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
      expect(result.taskOutcome).toBeNull();
      expect(result.pipelineEvidence.candidateCorrectness).toBe(result.strategy.candidateCorrectness);
      expect(result.pipelineEvidence.formatCompliance).toBeNull();
      expect(result.pipelineEvidence.assignedStrategySuccess).toBe(result.strategy.assignedStrategySuccess);
      expect(result.pipelineEvidence.execution.sourceInvocationIds).toHaveLength(4);
      expect(result.pipelineEvidence.stages.every((stage) => stage.invocationId?.startsWith('iv-'))).toBe(true);
      expect(result.pipelineEvidence.stages[0]?.usage.tokenTotal.value).toBe(6);
      expect(result.rows).toEqual([]);
      expect(result.tables).toEqual([]);
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
