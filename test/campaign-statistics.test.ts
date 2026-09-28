import { describe, expect, it } from 'vitest';
import { analyzeFixedSample, designHash, validationDesignHash, type Assignment, type Observation, type Preregistration, type ValidationEvidence } from '../runner/statistics/inference.js';
import { simulateProcedure } from '../runner/statistics/simulation.js';

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
  return { designHash: validationDesignHash(reg), scenarios: 2000, marginalCoverage: 0.98, marginalCoverageLower95: 0.97,
    familywiseError: 0.02, familywiseErrorUpper95: 0.04, gatesPassed: true };
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
      expect(evidence.familywiseErrorUpper95).toBeLessThanOrEqual(0.07);
      expect(evidence.gatesPassed).toBe(true);
    }
  }, 180_000);
});
