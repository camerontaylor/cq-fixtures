import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadPrecisionValidation, loadPrecisionForecast } from '../runner/statistics/evidence-loader.js';
import { precisionMonteCarloReport } from '../runner/statistics/precision-monte-carlo.js';
import { simulatePrecisionPower } from '../runner/statistics/precision-power.js';
import { simulatePrecisionMissingness } from '../runner/statistics/precision-missingness.js';
import { describe, expect, it } from 'vitest';
import { analyzeFixedSample, designHash, validationDesignHash, type Assignment, type Observation, type Preregistration, type ValidationEvidence, wilsonBounds } from '../runner/statistics/inference.js';
import { simulateProcedure } from '../runner/statistics/simulation.js';
import { studentTCdf, studentTCritical } from '../runner/statistics/student-t.js';
import { CORE_POINTS, FORECAST_POINTS, precisionForecastPasses, PRECISION_RECIPE, precisionRecipeHash, weightedClusterT, precisionValidationPasses, analyzePrecisionSample, type PrecisionValidation } from '../runner/statistics/precision.js';
import { adaptTaskOutcomes, type TaskOutcomeInput, type OutcomeJoinRegistration } from '../runner/statistics/task-outcome-adapter.js';
import { forecastFivePointDesign } from '../runner/statistics/power.js';

function fixture(substrates = 24): { reg: Preregistration; rows: Observation[] } {
  const assignments: Assignment[] = [];
  for (let s = 0; s < substrates; s++) for (let t = 0; t < 2; t++) for (let r = 0; r < 2; r++) {
    assignments.push({ taskId: `task-${s}-${t}`, substrateId: `sub-${s}`, repeatId: `r${r}`, weight: 1 });
  }
  const reg: Preregistration = { version: 1, frozen: true, cohortId: 'cohort-a', track: 'native', role: 'fixer', budgetId: 'b1', assignmentSeed: 'seed-a', expectedRepeats: 2, assignments,
    contrasts: [{ id: 'candidate-v-baseline', strategyId: 'candidate', baselineId: 'baseline' }], confidence: 0.95, bootstrapResamples: 499, bootstrapSeed: 1, analysisVersion: 'cq-fixed-sample-v1' };
  const rows: Observation[] = [];
  for (const a of assignments) {
    const s = Number(a.substrateId.slice(4));
    for (const strategyId of ['candidate', 'baseline']) {
      const success = strategyId === 'candidate' ? (s % 3 !== 0 || a.repeatId === 'r1') : s % 3 !== 0;
      rows.push({ ...a, strategyId, track: 'native', cohortId: 'cohort-a', status: 'measured', success });
    }
  }
  return { reg, rows };
}

function passingValidation(reg: Preregistration): ValidationEvidence {
  return { designHash: validationDesignHash(reg), scenarios: 2000, marginalCoverage: 0.98, marginalCoverageLower95: 0.93,
    jointCovered: 1960, jointCoverage: 0.98, jointCoverageLower95: 0.93,
    perContrastCoverage: reg.contrasts.map(c => ({ contrastId: c.id, covered: 1960, datasets: 2000, coverage: 0.98, simultaneousLower95: 0.93 })),
    familywiseError: 0, familywiseErrorUpper95: 0.01, familywiseRejected: 0, familywiseEvaluated: 2000, gatesPassed: true };
}

describe('fixed-sample campaign inference', () => {
  it('freezes design identity and averages repeats before equal-task cluster contrasts', () => {
    const { reg, rows } = fixture();
    const out = analyzeFixedSample(reg, rows, passingValidation(reg));
    expect(out.designHash).toBe(designHash(reg));
    expect(out.contrasts[0]!.tasks).toBe(48);
    expect(out.contrasts[0]!.pairedTasks).toBe(48);
    expect(out.contrasts[0]!.estimate).toBeGreaterThan(0);
    expect(out.maxStatisticAdjustment).toBe('applied');
    expect(out.contrasts[0]!.familywise95).not.toBeNull();
  });

  it('does not infer from fewer than 20 clusters or degenerate cluster variance', () => {
    const few = fixture(12);
    expect(analyzeFixedSample(few.reg, few.rows, passingValidation(few.reg)).contrasts[0]!.status).toBe('descriptive');
    const allSame = fixture();
    for (const row of allSame.rows) row.success = true;
    const c = analyzeFixedSample(allSame.reg, allSame.rows, passingValidation(allSame.reg)).contrasts[0]!;
    expect(c.status).toBe('descriptive');
    expect(c.familywise95).toBeNull();
    expect(c.reasons).toContain('degenerate cluster variance');
  });

  it('requires exact identity and frozen-weight parity, not equal valid-row counts', () => {
    const { reg, rows } = fixture();
    const target = rows.find(r => r.strategyId === 'candidate')!;
    target.weight = 2;
    expect(() => analyzeFixedSample(reg, rows)).toThrow(/identity\/weight parity/);
    const sample = fixture();
    const removed = sample.rows.findIndex(r => r.strategyId === 'candidate' && r.taskId === 'task-0-0' && r.repeatId === 'r0');
    sample.rows.splice(removed, 1);
    // A different, equally sized missing subset is still detected by identity.
    const other = sample.rows.findIndex(r => r.strategyId === 'candidate' && r.taskId === 'task-1-0' && r.repeatId === 'r0');
    sample.rows.splice(other, 1);
    const out = analyzeFixedSample(sample.reg, sample.rows, passingValidation(sample.reg)).contrasts[0]!;
    expect(out.status).toBe('descriptive');
    expect(out.operationalMissing).toBeGreaterThan(0);
  });

  it('rejects repeat-specific task weights before analysis', () => {
    const { reg } = fixture();
    reg.assignments[1]!.weight = 2;
    expect(() => analyzeFixedSample(reg, [])).toThrow(/inconsistent frozen weights/);
  });

  it('accepts analytic envelope expansion for frozen unequal task weights and resample counts above the minimum', () => {
    const { reg, rows } = fixture();
    reg.bootstrapResamples = 257;
    for (const a of reg.assignments) if (a.substrateId === 'sub-0') a.weight = 1000;
    for (const row of rows) if (row.substrateId === 'sub-0') row.weight = 1000;
    const out = analyzeFixedSample(reg, rows, passingValidation(reg));
    expect(out.maxStatisticAdjustment).toBe('applied');
    expect(out.contrasts[0]!.bootstrapResamples).toBe(257);
    const [lo, hi] = out.contrasts[0]!.marginal95!;
    expect(hi - lo).toBeGreaterThanOrEqual(2 * Math.abs(out.contrasts[0]!.estimate!));
    const excessive = fixture();
    excessive.reg.bootstrapResamples = 10_001;
    expect(() => analyzeFixedSample(excessive.reg, excessive.rows)).toThrow(/199 through 10000/);
  });

  it('rejects empty rosters, unknown statuses, unknown strategies and incoherent validation evidence', () => {
    const empty = fixture();
    empty.reg.assignments = [];
    expect(() => analyzeFixedSample(empty.reg, [])).toThrow(/must not be empty/);
    const unknown = fixture();
    (unknown.rows[0] as unknown as { status: string }).status = 'success';
    expect(() => analyzeFixedSample(unknown.reg, unknown.rows)).toThrow(/unknown observation status/);
    const unregistered = fixture();
    unregistered.rows[0]!.strategyId = 'other';
    expect(() => analyzeFixedSample(unregistered.reg, unregistered.rows)).toThrow(/unregistered strategy/);
    const malformed = fixture(), evidence = passingValidation(malformed.reg);
    evidence.perContrastCoverage[0]!.datasets = 6000;
    expect(() => analyzeFixedSample(malformed.reg, malformed.rows, evidence)).toThrow(/denominator/);
  });

  it('retains launched exhaustion as failure while keeping operational absence missing', () => {
    const { reg, rows } = fixture();
    const exhausted = rows.find(r => r.strategyId === 'candidate')!;
    exhausted.success = false; exhausted.cause = 'budget-exhausted';
    const missing = rows.find(r => r.strategyId === 'baseline')!;
    missing.success = null; missing.status = 'operational-missing';
    const out = analyzeFixedSample(reg, rows, passingValidation(reg)).contrasts[0]!;
    expect(out.launchedBudgetFailures).toBe(1);
    expect(out.operationalMissing).toBe(1);
    expect(out.status).toBe('descriptive');
  });

  it('rejects cross-track/cohort pooling and changed validation design', () => {
    const { reg, rows } = fixture();
    rows[0]!.track = 'diagnostic';
    expect(() => analyzeFixedSample(reg, rows)).toThrow(/cannot pool cohorts or tracks/);
    const same = fixture();
    const evidence = passingValidation(same.reg);
    evidence.designHash = 'wrong';
    expect(analyzeFixedSample(same.reg, same.rows, evidence).maxStatisticAdjustment).toBe('withheld');
  });

  it('validates at least 2,000 simulated datasets across the frozen scenario envelope', () => {
    for (const [track, seed] of [['native', 0xC0FFEE], ['diagnostic', 0xC0FFEF]] as const) {
      const evidence = simulateProcedure(2000, seed, track);
      console.log('CAMPAIGN_STATISTICS_SIMULATION=' + JSON.stringify(evidence));
      expect(evidence.scenarios).toBeGreaterThanOrEqual(2000);
      expect(evidence.marginalCoverageLower95).toBeGreaterThanOrEqual(0.93);
      expect(evidence.jointCoverageLower95).toBeGreaterThanOrEqual(0.93);
      expect(evidence.perContrastCoverage).toHaveLength(3);
      expect(evidence.perContrastCoverage.every(c => c.datasets === 2000)).toBe(true);
      expect(evidence.familywiseErrorUpper95).toBeLessThanOrEqual(0.07);
      expect(evidence.gatesPassed).toBe(true);
      expect(evidence.bootstrapOnly.passesCoverageGates).toBe(false);
    }
  }, 180_000);

  it('forecasts deterministic five-point power and precision across per-role planning scenarios', () => {
    const fixer = forecastFivePointDesign('fixer-worker');
    const reviewer = forecastFivePointDesign('review-classifier', 'diagnostic');
    console.log('CAMPAIGN_POWER_FORECAST=' + JSON.stringify({ fixer, reviewer }));
    expect(fixer.scenarios).toHaveLength(162);
    expect(reviewer.scenarios).toEqual(fixer.scenarios);
    expect(fixer.targetDifference).toBe(0.05);
    expect(fixer.maxRequiredSubstrates).toBeGreaterThan(1000);
    expect(fixer.quotaOrRuntimeEstimate).toBeNull();
  });
});


describe('bounded precision candidate and S1 outcome adapter', () => {
  it('computes Student t tails against published quantiles including small df', () => {
    expect(studentTCritical(1)).toBeCloseTo(12.7062047364, 8);
    expect(studentTCritical(10)).toBeCloseTo(2.228138852, 8);
    expect(studentTCdf(0, 4.5)).toBeCloseTo(.5, 12);
    expect(studentTCdf(-2, 7)).toBeCloseTo(1 - studentTCdf(2, 7), 12);
  });

  it('retains weighted task estimand, persistent variance and leverage correction', () => {
    const result = weightedClusterT([-.5, .5, 1], [1, 2, 3]);
    expect(result.estimate).toBeCloseTo(3.5 / 6);
    expect(result.effectiveClusters).toBeCloseTo(36 / 14);
    expect(result.standardError).toBeGreaterThan(0);
    expect(weightedClusterT([0, 0], [1, 1]).degenerate).toBe(true);
    const scenario = forecastFivePointDesign('fixer-worker').scenarios;
    const one = scenario.find(s => s.pairedDifferenceIcc === .6 && s.tasksPerSubstrate === 1 && s.repeatsPerTask === 1)!;
    const three = scenario.find(s => s.pairedDifferenceIcc === .6 && s.tasksPerSubstrate === 1 && s.repeatsPerTask === 3)!;
    expect(three.clusterDifferenceVariance / one.clusterDifferenceVariance).toBeCloseTo(.6 + .4 / 3);
  });

  function validation(): PrecisionValidation {
    return loadPrecisionValidation(new URL('../runner/statistics/precision-validation-native-v1.json', import.meta.url));
  }

  it('checks every stratum and exact track rather than trusting a pooled pass flag', () => {
    const v = validation();
    expect(precisionValidationPasses(v, 'native')).toBe(true);
    expect(precisionValidationPasses(v, 'diagnostic')).toBe(false);
    v.core[0]!.jointCovered = 1800;
    expect(precisionValidationPasses(v, 'native')).toBe(false);
    expect(precisionValidationPasses({ ...validation(), core: validation().core.slice(1) }, 'native')).toBe(false);
  });

  it('uses narrow intervals only for the frozen validated envelope and suppresses missingness family', () => {
    const { reg, rows } = fixture(40);
    reg.expectedRepeats = 1;
    reg.assignments = reg.assignments.filter(a => a.repeatId === 'r1' && a.taskId.endsWith('-0'));
    reg.contrasts = [1, 2, 3].map(n => ({ id: `c${n}`, strategyId: `candidate${n}`, baselineId: 'baseline' }));
    const selected = rows.filter(r => r.repeatId === 'r1' && r.taskId.endsWith('-0'));
    const adapted = selected.flatMap(r => r.strategyId === 'baseline' ? [r] : [1, 2, 3].map(n => ({ ...r, strategyId: `candidate${n}` })));
    const extension = { frozen: true as const, recipe: PRECISION_RECIPE, recipeHash: precisionRecipeHash, calibrationSha256: 'a'.repeat(64), model: CORE_POINTS[0]!, calibrationArtifact: 'calibration/immutable-model.json', baseDesignHash: designHash(reg) } as const;
    const out = analyzePrecisionSample(reg, adapted, extension, validation());
    expect(out.precision.applied).toBe(true);
    expect(out.maxStatisticAdjustment).toBe('withheld');
    const missing = adapted[0]!;
    missing.status = 'operational-missing'; missing.success = null;
    expect(analyzePrecisionSample(reg, adapted, extension, validation()).precision.applied).toBe(false);
    expect(analyzePrecisionSample(reg, adapted, extension, null).contrasts.every(c => c.status !== 'inferential')).toBe(true);
    missing.status = 'measured'; missing.success = true;
    for (const a of reg.assignments) if (a.substrateId === 'sub-0') a.weight = 1e12;
    for (const row of adapted) if (row.substrateId === 'sub-0') row.weight = 1e12;
    expect(analyzePrecisionSample(reg, adapted, { ...extension, baseDesignHash: designHash(reg) }, validation()).precision.applied).toBe(false);
  });

  it('requires all forecast point gates before extending to larger calibrated designs', () => {
    const evidence = loadPrecisionForecast(new URL('../runner/statistics/precision-power-native-v1.json', import.meta.url));
    expect(precisionForecastPasses(evidence, 'native')).toBe(true);
    expect(precisionForecastPasses(evidence, 'diagnostic')).toBe(false);
    const model = FORECAST_POINTS.find(p => p.clusters === 1280 && p.weights === 'cycle-1-2-3' && p.icc === .6 && p.discordance === .35)!;
    const assignments: Assignment[] = [];
    for (let g = 0; g < 1280; g++) for (let t = 0; t < 3; t++) for (let r = 0; r < 3; r++) assignments.push({ taskId: `g${g}-t${t}`, substrateId: `g${g}`, repeatId: `r${r}`, weight: 1 + g % 3 });
    const reg = fixture().reg;
    reg.expectedRepeats = 3; reg.assignments = assignments; reg.bootstrapResamples = 199;
    reg.contrasts = [1, 2, 3].map(n => ({ id: `c${n}`, strategyId: `m${n}`, baselineId: 'base' }));
    const rows: Observation[] = assignments.flatMap(a => ['base', 'm1', 'm2', 'm3'].map(strategyId => ({ ...a,
      strategyId, track: reg.track, cohortId: reg.cohortId, status: 'measured' as const,
      success: strategyId === 'base' ? Number(a.substrateId.slice(1)) % 3 !== 0 : true })));
    const extension = { frozen: true as const, recipe: PRECISION_RECIPE, recipeHash: precisionRecipeHash,
      calibrationSha256: 'a'.repeat(64), model, calibrationArtifact: 'visible-calibration', baseDesignHash: designHash(reg) } as const;
    expect(analyzePrecisionSample(reg, rows, extension, validation()).precision.applied).toBe(false);
    expect(analyzePrecisionSample(reg, rows, extension, validation(), evidence).precision.applied).toBe(true);
    evidence.cells[0]!.coverage[0]!.jointCovered = 1800;
    expect(precisionForecastPasses(evidence, 'native')).toBe(false);
  });

  function outcomeFixture() {
    const { reg } = fixture();
    const join: OutcomeJoinRegistration = { frozen: true, baseDesignHash: designHash(reg), campaignId: 'campaign', assignments: [] };
    const assignments = reg.assignments.flatMap(a => ['candidate', 'baseline'].map(strategyId => ({ assignmentId: `${strategyId}/${a.taskId}/${a.repeatId}`,
      experimentId: `exp-${strategyId}`, strategyId, taskId: a.taskId, repeatId: a.repeatId, substrateId: a.substrateId,
      frozenWeight: a.weight, judgementId: `judge-${strategyId}/${a.taskId}/${a.repeatId}`, judgementVersion: 1, judgePin: 'pin' })));
    join.assignments = assignments;
    const hash = 'a'.repeat(64);
    const outcomes: TaskOutcomeInput[] = assignments.map(a => ({ identity: { campaignId: 'campaign', cohortId: reg.cohortId,
      experimentId: a.experimentId, taskId: a.taskId, repeatId: a.repeatId, assignmentId: a.assignmentId,
      strategyId: a.strategyId, role: reg.role, budgetId: reg.budgetId, frozenWeight: a.frozenWeight },
      candidateCorrectness: true, formatConformance: false, assignedStrategySuccess: false, operationalStatus: 'measured-failure',
      stages: [1, 2].map(n => ({ stageId: 'generate', attemptId: `retry${n}`, invocationId: `${a.assignmentId}/invoke${n}`, artifacts: [{ kind: 'patch', path: 'patch', sha256: hash }] })),
      judgements: [{ judgementId: a.judgementId, version: 1, judgePin: 'pin', candidateSha256: hash,
        candidateCorrectness: true, formatConformance: false, assignedStrategySuccess: false, operationalStatus: 'measured-failure', artifact: { path: 'judgement', sha256: hash } }] }));
    return { reg, join, outcomes };
  }

  it('maps authoritative assigned success once per assignment and retains every retry reference', () => {
    const { reg, join, outcomes } = outcomeFixture();
    const mapped = adaptTaskOutcomes(reg, join, outcomes);
    expect(mapped.observations).toHaveLength(join.assignments.length);
    expect(mapped.observations.every(o => o.success === false)).toBe(true);
    expect(mapped.audit[0]!.stages).toHaveLength(2);
    const interrupted = outcomes[0]!;
    interrupted.assignedStrategySuccess = null; interrupted.operationalStatus = 'interrupted';
    interrupted.judgements[0]!.assignedStrategySuccess = null; interrupted.judgements[0]!.operationalStatus = 'interrupted';
    const row = adaptTaskOutcomes(reg, join, outcomes).observations[0]!;
    expect(row.status).toBe('operational-missing');
    expect(row.success).toBeNull();
    interrupted.judgements = [];
    expect(adaptTaskOutcomes(reg, join, outcomes).audit[0]!.judgementArtifact).toBeNull();
    interrupted.candidateCorrectness = null; interrupted.assignedStrategySuccess = false; interrupted.operationalStatus = 'measured-failure';
    const budgetStop = adaptTaskOutcomes(reg, join, outcomes).observations[0]!;
    expect(budgetStop.status).toBe('measured');
    expect(budgetStop.success).toBe(false);
    expect(() => adaptTaskOutcomes(reg, join, [...outcomes, outcomes[0]!])).toThrow(/duplicate retry/);
    outcomes[1]!.identity.frozenWeight = 2;
    expect(() => adaptTaskOutcomes(reg, join, outcomes)).toThrow(/parity/);
  });

  it('requires frozen judge version and full assigned roster, without best-retry selection', () => {
    const { reg, join, outcomes } = outcomeFixture();
    join.assignments[0]!.judgementVersion = 2;
    expect(() => adaptTaskOutcomes(reg, join, outcomes)).toThrow(/selection is absent/);
    outcomes[0]!.identity.track = 'diagnostic';
    expect(() => adaptTaskOutcomes(reg, { ...join, assignments: join.assignments.map((a, i) => i === 0 ? { ...a, judgementVersion: 1 } : a) }, outcomes)).toThrow(/parity/);
    join.assignments = join.assignments.slice(1);
    expect(() => adaptTaskOutcomes(reg, join, outcomes)).toThrow(/full assigned/);
  });
  it('rejects coherent fabricated evidence, seed changes and recipe substitution', () => {
    const v = validation();
    for (const stratum of v.core) {
      stratum.jointCovered = stratum.datasets;
      stratum.perContrastCovered = [stratum.datasets, stratum.datasets, stratum.datasets];
      stratum.anyNullRejected = 0;
      stratum.coverageLower95 = wilsonBounds(stratum.datasets, stratum.datasets)[0];
      stratum.fwerUpper95 = stratum.nullDatasets ? wilsonBounds(0, stratum.nullDatasets)[1] : null;
    }
    expect(precisionValidationPasses(v, 'native')).toBe(false);
    expect(precisionValidationPasses({ ...validation(), seed: 1 }, 'native')).toBe(false);
    const forecast = loadPrecisionForecast(new URL('../runner/statistics/precision-power-native-v1.json', import.meta.url));
    expect(precisionForecastPasses({ ...forecast, recipeHash: 'a'.repeat(64) }, 'native')).toBe(false);
    forecast.cells[0]!.coverage[0]!.meanWidth += .001;
    expect(precisionForecastPasses(forecast, 'native')).toBe(false);
    const reordered = Object.fromEntries(Object.entries(validation()).reverse()) as unknown as PrecisionValidation;
    expect(precisionValidationPasses(reordered, 'native')).toBe(true);
  });

  it('refuses unpinned and failed base evidence before CLI or function simulations', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 's6-pins-'));
    try {
      for (const failed of [false, true]) {
        const v = validation();
        if (failed) { v.allCorePassed = false; v.core[0]!.jointCovered = 1800; }
        else v.seed = 7;
        const input = pathJoin(dir, 'validation.json');
        writeFileSync(input, JSON.stringify({ validation: v }));
        expect(() => loadPrecisionValidation(input)).toThrow(/unpinned/);
        expect(() => simulatePrecisionPower(v, v.seed + 300000000)).toThrow(/failed or unpinned/);
        expect(() => simulatePrecisionMissingness(v, v.seed + 400000000)).toThrow(/failed or unpinned/);
        for (const cli of ['power', 'missingness']) {
          const output = pathJoin(dir, cli + '.json');
          const result = spawnSync(process.execPath, [`dist/statistics/run-precision-${cli}.js`, input, output], { encoding: 'utf8', timeout: 10000 });
          expect(result.status).toBe(1);
          expect(result.stderr).toMatch(/unpinned validation archive/);
          expect(existsSync(output)).toBe(false);
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports simultaneous Monte Carlo coverage per contrast with dataset denominators', () => {
    const v = validation(), report = precisionMonteCarloReport(v);
    expect(report.boundsCount).toBe(3240);
    expect(report.gatesChanged).toBe(false);
    expect(report.strata).toHaveLength(720);
    for (let i = 0; i < report.strata.length; i++) {
      const stratum = report.strata[i]!, source = v.core[i]!;
      expect(stratum.perContrast).toHaveLength(3);
      for (const c of stratum.perContrast) {
        expect(c.datasets).toBe(source.datasets);
        expect(c.covered).toBe(source.perContrastCovered[c.contrastIndex]);
        expect(c.simultaneousLower95).toBe(wilsonBounds(c.covered, source.datasets, 4.5)[0]);
        expect(c.simultaneousLower95).toBeGreaterThanOrEqual(stratum.coverageLower);
      }
    }
  });

  it('rejects duplicate and nonpositive registration before adapter roster maps', () => {
    for (const invalid of ['duplicate', 'zero', 'negative']) {
      const { reg, join, outcomes } = outcomeFixture();
      reg.assignments = invalid === 'duplicate' ? [...reg.assignments, { ...reg.assignments[0]! }]
        : reg.assignments.map((a, i) => i === 0 ? { ...a, weight: invalid === 'zero' ? 0 : -1 } : a);
      join.baseDesignHash = designHash(reg);
      expect(() => adaptTaskOutcomes(reg, join, outcomes)).toThrow(/duplicate|weight/);
    }
  });

  it('accounts assignment budget causes once, preserves failures and reports unknown totals', () => {
    const { reg, join, outcomes } = outcomeFixture();
    const analyze = () => analyzeFixedSample(reg, adaptTaskOutcomes(reg, join, outcomes).observations).contrasts[0]!;
    expect(analyze().launchedBudgetFailures).toBeNull();
    expect(analyze().knownLaunchedBudgetFailures).toBe(0);
    for (const o of outcomes) o.execution = { launched: true, terminalCause: 'complete', sourceInvocationIds: o.stages.map(s => s.invocationId) };
    for (const terminalCause of ['complete', 'transport-error', 'provider-cancelled', 'operator-cancelled'] as const) {
      outcomes[0]!.execution!.terminalCause = terminalCause;
      expect(analyze().launchedBudgetFailures).toBe(0);
    }
    outcomes[0]!.execution!.terminalCause = 'budget-exhausted';
    expect(analyze().launchedBudgetFailures).toBe(1);
    expect(adaptTaskOutcomes(reg, join, outcomes).audit[0]!.execution).toEqual(outcomes[0]!.execution);
    expect(adaptTaskOutcomes(reg, join, outcomes).observations.every(o => o.success === false)).toBe(true);
    outcomes[1]!.execution!.terminalCause = 'unknown';
    expect(analyze().launchedBudgetFailures).toBeNull();
    expect(analyze().knownLaunchedBudgetFailures).toBe(1);
    outcomes[1]!.execution = { launched: false, terminalCause: 'prelaunch-failure', sourceInvocationIds: [] };
    expect(analyze().launchedBudgetFailures).toBe(1);
    outcomes[1]!.execution = { launched: null, terminalCause: 'complete', sourceInvocationIds: [] };
    expect(analyze().launchedBudgetFailures).toBeNull();
    outcomes[0]!.execution!.sourceInvocationIds = ['unretained-invocation'];
    expect(() => adaptTaskOutcomes(reg, join, outcomes)).toThrow(/provenance/);
    outcomes[0]!.execution!.sourceInvocationIds = [];
    expect(() => adaptTaskOutcomes(reg, join, outcomes)).toThrow(/provenance/);
  });

});
