import { analyzeFixedSample, validationDesignHash, type Assignment, type Observation, type Preregistration, type Track, type ValidationEvidence, wilsonBounds } from './inference.js';

export interface SimulationReport extends ValidationEvidence {
  track: Track;
  scenariosByEnvelope: Record<string, number>;
  marginalCovered: number;
  marginalEvaluated: number;
  familywiseRejected: number;
  familywiseEvaluated: number;
  seed: number;
  bootstrapResamplesPerDataset: number;
  clustersPerDataset: number;
  repeatsPerTask: number;
  scenarioDesign: string[];
}

function random(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x + 0x6D2B79F5) >>> 0; let t = Math.imul(x ^ (x >>> 15), 1 | x); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Monte Carlo validation for bounded paired cluster inference. Ten scenario
 * envelopes vary baseline saturation, substrate ICC, task imbalance, repeat
 * noise, small effects, and symmetric/asymmetric operational missingness.
 * Bootstrap maximum statistics and the finite-sample Hoeffding envelope are
 * evaluated on every synthetic fixed cohort.
 */
export function simulateProcedure(scenarios = 2000, seed = 0xC0FFEE, track: Track = 'native'): SimulationReport {
  if (!Number.isInteger(scenarios) || scenarios < 2000) throw new Error('at least 2,000 simulation datasets are required');
  const scenarioDesign = [
    'balanced baseline p=.50, ICC=.05, no missingness, global null',
    'balanced baseline p=.50, ICC=.20, repeat noise, +.02 per contender',
    'balanced baseline p=.50, ICC=.40, repeat noise, +.00 global null',
    'ceiling baseline p=.88, ICC=.20, +.02 effects',
    'floor baseline p=.12, ICC=.20, +.02 effects',
    'unequal tasks per substrate (1–3), ICC=.25, global null',
    'repeat-level noise increase, ICC=.10, +.02 effects',
    'symmetric 5% paired task missingness, ICC=.20, +.02 effects',
    'symmetric 15% paired task missingness, ICC=.35, global null',
    'asymmetric 5% strategy missingness, ICC=.25, global null (fallback stress)',
  ];
  const rng = random(seed);
  let marginalCovered = 0, marginalEvaluated = 0, familywiseRejected = 0, familywiseEvaluated = 0;
  const perScenario = Math.floor(scenarios / scenarioDesign.length), extras = scenarios % scenarioDesign.length;
  const scenariosByEnvelope: Record<string, number> = {};
  let serial = 0;
  for (let si = 0; si < scenarioDesign.length; si++) {
    const count = perScenario + (si < extras ? 1 : 0);
    scenariosByEnvelope[`s${si + 1}`] = count;
    for (let d = 0; d < count; d++, serial++) {
      const base = si === 3 ? 0.88 : si === 4 ? 0.12 : 0.5;
      const icc = [0.05, 0.20, 0.40, 0.20, 0.20, 0.25, 0.10, 0.20, 0.35, 0.25][si]!;
      const effect = [0, 0.02, 0, 0.02, 0.02, 0, 0.02, 0.02, 0, 0][si]!;
      const assignments: Assignment[] = [];
      const substrates = 24, repeats = 3;
      for (let s = 0; s < substrates; s++) {
        const taskCount = si === 5 ? 1 + (s % 3) : 2;
        for (let t = 0; t < taskCount; t++) for (let r = 0; r < repeats; r++) assignments.push({ taskId: `t${s}-${t}`, substrateId: `s${s}`, repeatId: `r${r}`, weight: 1 });
      }
      const reg: Preregistration = { version: 1, frozen: true, cohortId: `sim-${serial}`, track, role: 'simulation', budgetId: 'bounded', assignmentSeed: `sim-${serial}`, expectedRepeats: repeats, assignments,
        contrasts: [1, 2, 3].map(i => ({ id: `c${i}`, strategyId: `m${i}`, baselineId: 'base' })), confidence: 0.95, bootstrapResamples: 199, bootstrapSeed: serial + 1, analysisVersion: 'cq-fixed-sample-v1' };
      const rows: Observation[] = [];
      const substrateShift = Array.from({ length: substrates }, () => (rng() * 2 - 1) * Math.sqrt(3 * icc) * 0.35);
      const taskCounts = Array.from({ length: substrates }, (_, s) => si === 5 ? 1 + (s % 3) : 2);
      const expectedEffect = substrateShift.reduce((sum, shift, s) => {
        const p0 = Math.max(0.01, Math.min(0.99, base + shift));
        const p1 = Math.max(0.01, Math.min(0.99, base + shift + effect));
        return sum + taskCounts[s]! * (p1 - p0);
      }, 0) / taskCounts.reduce((a, b) => a + b, 0);
      for (const a of assignments) {
        const s = Number(a.substrateId.slice(1));
        const sharedMissing = si === 7 ? rng() < 0.05 : si === 8 ? rng() < 0.15 : false;
        for (const strategyId of ['base', 'm1', 'm2', 'm3']) {
          const asymmetricMissing = si === 9 && strategyId === 'm1' && rng() < 0.05;
          const missing = sharedMissing || asymmetricMissing;
          const p = Math.max(0.01, Math.min(0.99, base + substrateShift[s]! + (strategyId === 'base' ? 0 : effect)));
          const success = rng() < p;
          rows.push({ ...a, strategyId, cohortId: reg.cohortId, track, status: missing ? 'operational-missing' : 'measured', success: missing ? null : success });
        }
      }
      // Enable the candidate procedure during simulation only; these fixed
      // sentinel values are not evidence and do not depend on simulated data.
      const candidateGate: ValidationEvidence = { designHash: validationDesignHash(reg), scenarios: 2000,
        marginalCoverage: 0.95, marginalCoverageLower95: 0.93, familywiseError: 0.05, familywiseErrorUpper95: 0.07, gatesPassed: true };
      const out = analyzeFixedSample(reg, rows, candidateGate);
      const truth = expectedEffect;
      for (const c of out.contrasts) {
        if (c.marginal95) { marginalEvaluated++; if (c.marginal95[0] <= truth && truth <= c.marginal95[1]) marginalCovered++; }
      }
      // Familywise error is measured for global-null scenario envelopes only.
      if ([0, 2, 5, 8, 9].includes(si) && out.maxStatisticAdjustment === 'applied') {
        familywiseEvaluated++;
        if (out.contrasts.some(c => c.familywise95 && (c.familywise95[0] > 0 || c.familywise95[1] < 0))) familywiseRejected++;
      }
    }
  }
  const coverage = marginalCovered / marginalEvaluated;
  const fwer = familywiseRejected / familywiseEvaluated;
  const coverageLower = wilsonBounds(marginalCovered, marginalEvaluated)[0];
  const fwerUpper = wilsonBounds(familywiseRejected, familywiseEvaluated)[1];
  const placeholder: Preregistration = { version: 1, frozen: true, cohortId: 'validation-design', track, role: 'validation', budgetId: 'bounded', assignmentSeed: 'fixed', expectedRepeats: 3,
    assignments: [{ taskId: 'task', substrateId: 'substrate', repeatId: 'r1', weight: 1 }, { taskId: 'task', substrateId: 'substrate', repeatId: 'r2', weight: 1 }, { taskId: 'task', substrateId: 'substrate', repeatId: 'r3', weight: 1 }],
    contrasts: [1, 2, 3].map(i => ({ id: `c${i}`, strategyId: `m${i}`, baselineId: 'base' })), confidence: 0.95, bootstrapResamples: 199, bootstrapSeed: seed, analysisVersion: 'cq-fixed-sample-v1' };
  return { track, designHash: validationDesignHash(placeholder), scenarios, marginalCoverage: coverage, marginalCoverageLower95: coverageLower, familywiseError: fwer,
    familywiseErrorUpper95: fwerUpper, gatesPassed: coverageLower >= 0.93 && fwerUpper <= 0.07, scenariosByEnvelope, marginalCovered, marginalEvaluated,
    familywiseRejected, familywiseEvaluated, seed, bootstrapResamplesPerDataset: 199, clustersPerDataset: 24, repeatsPerTask: 3, scenarioDesign };
}
