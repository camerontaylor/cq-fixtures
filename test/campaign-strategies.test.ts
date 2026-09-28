import { describe, expect, it } from 'vitest';
import {
  defineBudgetTiers,
  observedZeroUsage,
  runStrategy,
  runStrategyTiers,
  unknownUsage,
  type Candidate,
  type ExecutorResult,
  type PerTaskBudgetTier,
  type StageExecutor,
  type StageRequest,
  type StrategyRoute,
} from '../runner/strategies/index.ts';

const task = { id: 'fixer:case-01:substrate-a', prompt: 'Repair the regression.', evaluationTrack: 'native' as const, workspace: { root: '/isolated/task' } };
const codex: StrategyRoute = { id: 'codex-native-luna-high', tokenEnforcement: 'hard' };
const glm: StrategyRoute = { id: 'zcode-native-glm-high', tokenEnforcement: 'unsupported' };
const tier: PerTaskBudgetTier = {
  id: 'medium', maxAttempts: 8, maxStages: 16, wallClockMs: 2_000, judgementAllowanceMs: 300, tokenBudget: 1_000,
};

function candidate(id: string): Candidate {
  return { id, sha256: `hash-${id}`, value: { patch: id } };
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
  handler: (request: StageRequest) => Promise<ExecutorResult> | ExecutorResult = (request) => {
    if (request.kind === 'draft') return result({ candidate: candidate('draft-1') });
    if (request.kind === 'verify') return result({ verification: { passed: true, feedback: 'Verified.' } });
    if (request.kind === 'select') return result({ selectedCandidateId: request.inputCandidates[0]?.id });
    if (request.kind === 'independent-judge') return result({ judgement: { status: 'valid', correctness: true } });
    return result({ candidate: candidate('repair-1') });
  };

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
    expect(new Set(results.map((entry) => entry.recipeHash)).size).toBe(1);
  });

  it('charges draft, every verification and repair, and final independent judging', async () => {
    const executor = new FakeExecutor();
    let stageNumber = 0;
    executor.handler = (request) => {
      stageNumber += 1;
      const usage = Object.fromEntries(
        (['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tokenTotal'] as const)
          .map((key) => [key, { value: stageNumber, availability: 'observed' as const, source: `fake-${key}`, semantics: key }]),
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
    executor.captureCandidate = (_request, state) => state.error ? edited : null;
    const outcome = await runStrategy(task, { kind: 'one-shot', route: codex }, tier, executor, { ids: fixedIds() });

    expect(outcome.finalCandidate).toEqual(edited);
    expect(outcome.candidateCorrectness).toBe(true);
    expect(outcome.assignedStrategySuccess).toBe(true);
    expect(outcome.stages[0]?.status).toBe('failed');
    expect(outcome.stages[0]?.operationalError?.message).toContain('after write');
    expect(outcome.incompleteReasons.some((reason) => reason.startsWith('stage-threw:'))).toBe(true);
    expect(outcome.accounting.usage.input).toBeNull();
  });

  it('accounts for model and judge candidate selection without external effects', async () => {
    const executor = new FakeExecutor();
    executor.handler = (request) => {
      if (request.kind === 'draft') return result({ candidate: candidate(`candidate-${executor.requests.filter((item) => item.kind === 'draft').length}`) });
      if (request.kind === 'select') return result({
        selectedCandidateId: request.inputCandidates[1]?.id,
        usage: Object.fromEntries(
          (['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tokenTotal'] as const)
            .map((key) => [key, { value: 5, availability: 'observed' as const, source: 'selector', semantics: key }]),
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
          input: { value: 7, availability: 'observed', source: 'event', semantics: 'input' },
          output: { value: null, availability: 'unavailable', source: 'event', semantics: 'output' },
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
    expect(outcome.stages.map((stage) => stage.routeId)).toEqual([codex.id, glm.id, codex.id, null]);
    expect(outcome.accounting.tokenBudgetMode).toBe('unsupported');
  });

  it('bounds a hung executor by the per-task wall clock', async () => {
    const executor = new FakeExecutor();
    executor.handler = () => new Promise<ExecutorResult>(() => {});
    const outcome = await runStrategy(task, { kind: 'one-shot', route: codex }, {
      ...tier, wallClockMs: 80, judgementAllowanceMs: 20,
    }, executor, { ids: fixedIds() });
    expect(outcome.stages[0]?.status).toBe('timed-out');
    expect(outcome.operationalStatus).toBe('timed-out');
    expect(outcome.accounting.endToEndMs).toBeLessThan(500);
    expect(outcome.candidateCorrectness).toBeNull();
  });
});
