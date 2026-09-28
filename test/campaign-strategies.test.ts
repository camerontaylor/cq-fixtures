import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../cq-settings-integration/runner/artifacts/index.ts';
import { createNativeStrategyExecutor, type NativeInvocationIdentity, type NativeStrategyObservation } from '../runner/strategies/executor.ts';
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
      const context = {
        campaignId: 'campaign-approved', cohortId: 'cohort-visible', experimentId: 'exp-fixed',
        taskId: 'task-review-loop', repeatId: 'repeat-01', assignmentId: 'assignment-fixed-01',
        stageId: retry.stageId, attemptId: retry.attemptId, track: 'native', strategyId: 'repair',
        settingsId: 'settings-fixed', budgetId: 'medium', profileId: 'profile-native',
      };
      const ref = store.write(context, 'candidate.patch', 'captured edits');
      expect(ref.sha256).toBe(createHash('sha256').update('captured edits').digest('hex'));
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
            tokenTotal: { value: 17, availability: 'observed', source: 'native-token-total' },
            inclusion: { input: 'disjoint', output: 'reasoning-in-output', cache: 'disjoint-from-input', reasoning: 'included-in-output' },
          },
          terminal: { cause: 'transport-exception', cancelled: false, transportException: { name: 'Error', message: 'after edit' } },
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
    expect(outcome.finalCandidate?.id).toBe('native-partial-edit');
    expect(outcome.candidateCorrectness).toBe(true);
    expect(outcome.assignedStrategySuccess).toBe(false);
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
