import { analyzeFixedSample, validationDesignHash, type Assignment, type Observation, type Preregistration, type Track, type ValidationEvidence, wilsonBounds } from './inference.js';

export interface ScenarioCoverage {
  contrastId: string;
  covered: number;
  datasets: number;
  coverage: number;
  simultaneousLower95: number;
}

export interface SimulationReport extends ValidationEvidence {
  track: Track;
  jointMarginalCoverage: number;
  jointMarginalCoverageLower95: number;
  perContrastCoverage: ScenarioCoverage[];
  bootstrapOnly: {
    jointMarginalCoverage: number;
    jointMarginalCoverageLower95: number;
    perContrastCoverage: ScenarioCoverage[];
    familywiseError: number;
    familywiseErrorUpper95: number;
    familywiseRejected: number;
    familywiseEvaluated: number;
    meanMarginalWidth: number;
    conservativeMeanMarginalWidth: number;
    passesCoverageGates: boolean;
  };
  familywiseRejected: number;
  familywiseEvaluated: number;
  seed: number;
  bootstrapResamplesPerDataset: number;
  clustersPerDataset: number;
  repeatsPerTask: number;
  scenarioDesign: Array<{
    label: string;
    substrateShiftHalfWidth: number;
    taskShiftHalfWidth: number;
    repeatNoiseHalfWidth: number;
    meanPropensitySubstrateICC: number;
  }>;
}

interface Scenario {
  label: string;
  base: number;
  substrateShiftHalfWidth: number;
  taskShiftHalfWidth: number;
  repeatNoiseHalfWidth: number;
  effect: number;
  taskImbalance: boolean;
  symmetricMissingRate: number;
  asymmetricMissingRate: number;
}

const SCENARIOS: Scenario[] = [
  { label: 'balanced null; no task/repeat noise; small substrate probability shifts', base: .50, substrateShiftHalfWidth: .05, taskShiftHalfWidth: 0, repeatNoiseHalfWidth: 0, effect: 0, taskImbalance: false, symmetricMissingRate: 0, asymmetricMissingRate: 0 },
  { label: 'balanced +2pp; moderate substrate shifts and small repeat jitter', base: .50, substrateShiftHalfWidth: .15, taskShiftHalfWidth: 0, repeatNoiseHalfWidth: .03, effect: .02, taskImbalance: false, symmetricMissingRate: 0, asymmetricMissingRate: 0 },
  { label: 'balanced null; broad substrate shifts and larger repeat jitter', base: .50, substrateShiftHalfWidth: .30, taskShiftHalfWidth: 0, repeatNoiseHalfWidth: .08, effect: 0, taskImbalance: false, symmetricMissingRate: 0, asymmetricMissingRate: 0 },
  { label: 'ceiling baseline .88; +2pp; substrate, task, and repeat variation', base: .88, substrateShiftHalfWidth: .15, taskShiftHalfWidth: .02, repeatNoiseHalfWidth: .04, effect: .02, taskImbalance: false, symmetricMissingRate: 0, asymmetricMissingRate: 0 },
  { label: 'floor baseline .12; +2pp; substrate, task, and repeat variation', base: .12, substrateShiftHalfWidth: .15, taskShiftHalfWidth: .02, repeatNoiseHalfWidth: .04, effect: .02, taskImbalance: false, symmetricMissingRate: 0, asymmetricMissingRate: 0 },
  { label: 'null; unequal 1–3 tasks per substrate and all three variation levels', base: .50, substrateShiftHalfWidth: .20, taskShiftHalfWidth: .05, repeatNoiseHalfWidth: .08, effect: 0, taskImbalance: true, symmetricMissingRate: 0, asymmetricMissingRate: 0 },
  { label: '+2pp; large repeat-specific probability jitter', base: .50, substrateShiftHalfWidth: .10, taskShiftHalfWidth: .02, repeatNoiseHalfWidth: .20, effect: .02, taskImbalance: false, symmetricMissingRate: 0, asymmetricMissingRate: 0 },
  { label: '+2pp; 5% symmetric assignment missingness fallback', base: .50, substrateShiftHalfWidth: .15, taskShiftHalfWidth: .02, repeatNoiseHalfWidth: .08, effect: .02, taskImbalance: false, symmetricMissingRate: .05, asymmetricMissingRate: 0 },
  { label: 'null; 15% symmetric assignment missingness fallback', base: .50, substrateShiftHalfWidth: .30, taskShiftHalfWidth: .04, repeatNoiseHalfWidth: .15, effect: 0, taskImbalance: false, symmetricMissingRate: .15, asymmetricMissingRate: 0 },
  { label: 'null; 5% contender-only missingness triggers family suppression', base: .50, substrateShiftHalfWidth: .20, taskShiftHalfWidth: .03, repeatNoiseHalfWidth: .08, effect: 0, taskImbalance: false, symmetricMissingRate: 0, asymmetricMissingRate: .05 },
];

function random(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x + 0x6D2B79F5) >>> 0; let t = Math.imul(x ^ (x >>> 15), 1 | x); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function wilsonLowerOneSided(successes: number, n: number, z: number): number {
  if (n <= 0) return 0;
  const p = successes / n, z2 = z * z, d = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / d;
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / d;
  return Math.max(0, center - half);
}

function mean(xs: readonly number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }

/**
 * Deterministic Monte Carlo validation of the inference recipe. Marginal
 * coverage is summarized both per contrast and per dataset (all contrasts
 * covered), avoiding an independence assumption across contrasts. The
 * per-contrast lower bounds use Bonferroni simultaneous one-sided Wilson
 * bounds. Bootstrap-only percentile/max-statistic candidates are measured
 * separately and never enable claims by themselves.
 */
export function simulateProcedure(scenarios = 2000, seed = 0xC0FFEE, track: Track = 'native'): SimulationReport {
  if (!Number.isInteger(scenarios) || scenarios < 2000) throw new Error('at least 2,000 simulation datasets are required');
  const rng = random(seed);
  const strategies = ['m1', 'm2', 'm3'] as const;
  const marginalCounts = strategies.map(() => 0), bootstrapMarginalCounts = strategies.map(() => 0);
  let jointCovered = 0, bootstrapJointCovered = 0, conservativeWidth = 0, bootstrapWidth = 0, widthN = 0;
  let familywiseRejected = 0, familywiseEvaluated = 0, bootstrapFwer = 0, bootstrapFwerEvaluated = 0;
  let serial = 0;
  const perScenario = Math.floor(scenarios / SCENARIOS.length), extras = scenarios % SCENARIOS.length;
  const scenarioDesign: SimulationReport['scenarioDesign'] = [];

  for (let si = 0; si < SCENARIOS.length; si++) {
    const spec = SCENARIOS[si]!;
    let measuredIccSum = 0;
    const count = perScenario + (si < extras ? 1 : 0);
    for (let d = 0; d < count; d++, serial++) {
      const assignments: Assignment[] = [];
      const substrates = 24, repeats = 3;
      for (let s = 0; s < substrates; s++) {
        const taskCount = spec.taskImbalance ? 1 + (s % 3) : 2;
        for (let t = 0; t < taskCount; t++) for (let r = 0; r < repeats; r++) assignments.push({ taskId: `t${s}-${t}`, substrateId: `s${s}`, repeatId: `r${r}`, weight: 1 });
      }
      const reg: Preregistration = { version: 1, frozen: true, cohortId: `sim-${serial}`, track, role: 'simulation', budgetId: 'bounded', assignmentSeed: `sim-${serial}`, expectedRepeats: repeats, assignments,
        contrasts: strategies.map(strategyId => ({ id: `${strategyId}-vs-base`, strategyId, baselineId: 'base' })), confidence: 0.95, bootstrapResamples: 199, bootstrapSeed: serial + 1, analysisVersion: 'cq-fixed-sample-v1' };
      const substrateShift = Array.from({ length: substrates }, () => (rng() * 2 - 1) * spec.substrateShiftHalfWidth);
      const taskShift = new Map<string, number>();
      for (const a of assignments) if (!taskShift.has(a.taskId)) taskShift.set(a.taskId, (rng() * 2 - 1) * spec.taskShiftHalfWidth);
      const repeatNoise = new Map<string, number>();
      for (const a of assignments) repeatNoise.set(`${a.taskId}\u0000${a.repeatId}`, (rng() * 2 - 1) * spec.repeatNoiseHalfWidth);
      const probabilities = new Map<string, { base: number; treated: number }>();
      const bySubstrateMean: number[] = [];
      let totalP = 0, totalN = 0, expectedEffectTotal = 0;
      for (const a of assignments) {
        const s = Number(a.substrateId.slice(1));
        const baseP = Math.max(.01, Math.min(.99, spec.base + substrateShift[s]! + taskShift.get(a.taskId)! + repeatNoise.get(`${a.taskId}\u0000${a.repeatId}`)!));
        const treatedP = Math.max(.01, Math.min(.99, spec.base + substrateShift[s]! + taskShift.get(a.taskId)! + repeatNoise.get(`${a.taskId}\u0000${a.repeatId}`)! + spec.effect));
        probabilities.set(`${a.taskId}\u0000${a.repeatId}`, { base: baseP, treated: treatedP });
        totalP += baseP; totalN++;
        expectedEffectTotal += treatedP - baseP;
      }
      for (let s = 0; s < substrates; s++) bySubstrateMean.push(mean(assignments.filter(a => a.substrateId === `s${s}`).map(a => probabilities.get(`${a.taskId}\u0000${a.repeatId}`)!.base)));
      const mu = totalP / totalN;
      const betweenVar = mean(bySubstrateMean.map(p => (p - mu) ** 2));
      measuredIccSum += betweenVar / Math.max(1e-9, mu * (1 - mu));
      const truth = expectedEffectTotal / assignments.length;
      const rows: Observation[] = [];
      for (const a of assignments) {
        const sharedMissing = rng() < spec.symmetricMissingRate;
        for (const strategyId of ['base', ...strategies]) {
          const asymmetricMissing = strategyId !== 'base' && rng() < spec.asymmetricMissingRate;
          const missing = sharedMissing || asymmetricMissing;
          const p = probabilities.get(`${a.taskId}\u0000${a.repeatId}`)![strategyId === 'base' ? 'base' : 'treated'];
          rows.push({ ...a, strategyId, cohortId: reg.cohortId, track, status: missing ? 'operational-missing' : 'measured', success: missing ? null : rng() < p });
        }
      }
      // Simulation-only activation lets us inspect the candidate procedure;
      // these sentinels are fixed and independent of the simulated outcomes.
      const candidateGate: ValidationEvidence = { designHash: validationDesignHash(reg), scenarios: 2000, marginalCoverage: .95, marginalCoverageLower95: .93,
        jointCovered: 1900, jointCoverage: .95, jointCoverageLower95: .93,
        perContrastCoverage: reg.contrasts.map(c => ({ contrastId: c.id, covered: 1900, datasets: 2000, coverage: .95, simultaneousLower95: .93 })),
        familywiseError: .05, familywiseErrorUpper95: .07, familywiseRejected: 100, familywiseEvaluated: 2000, gatesPassed: true };
      const out = analyzeFixedSample(reg, rows, candidateGate);
      let datasetCovered = true, datasetBootstrapCovered = true;
      for (let i = 0; i < out.contrasts.length; i++) {
        const c = out.contrasts[i]!;
        const covered = c.marginal95 !== null && c.marginal95[0] <= truth && truth <= c.marginal95[1];
        const bootstrapCovered = c.bootstrapOnlyMarginal95 !== null && c.bootstrapOnlyMarginal95[0] <= truth && truth <= c.bootstrapOnlyMarginal95[1];
        if (covered) marginalCounts[i]!++;
        if (bootstrapCovered) bootstrapMarginalCounts[i]!++;
        datasetCovered &&= covered;
        datasetBootstrapCovered &&= bootstrapCovered;
        if (c.marginal95 && c.bootstrapOnlyMarginal95) {
          conservativeWidth += c.marginal95[1] - c.marginal95[0];
          bootstrapWidth += c.bootstrapOnlyMarginal95[1] - c.bootstrapOnlyMarginal95[0];
          widthN++;
        }
      }
      if (datasetCovered) jointCovered++;
      if (datasetBootstrapCovered) bootstrapJointCovered++;
      if ([0, 2, 5, 8, 9].includes(si) && out.maxStatisticAdjustment === 'applied') {
        familywiseEvaluated++;
        if (out.contrasts.some(c => c.familywise95 && (c.familywise95[0] > 0 || c.familywise95[1] < 0))) familywiseRejected++;
        if (out.contrasts.some(c => c.bootstrapOnlyFamilywise95 && (c.bootstrapOnlyFamilywise95[0] > 0 || c.bootstrapOnlyFamilywise95[1] < 0))) bootstrapFwer++;
        bootstrapFwerEvaluated++;
      }
    }
    scenarioDesign.push({ label: spec.label, substrateShiftHalfWidth: spec.substrateShiftHalfWidth, taskShiftHalfWidth: spec.taskShiftHalfWidth,
      repeatNoiseHalfWidth: spec.repeatNoiseHalfWidth, meanPropensitySubstrateICC: measuredIccSum / count });
  }

  const perContrastCoverage = strategies.map((strategy, i) => ({
    contrastId: `${strategy}-vs-base`, covered: marginalCounts[i]!, datasets: scenarios,
    coverage: marginalCounts[i]! / scenarios,
    simultaneousLower95: wilsonLowerOneSided(marginalCounts[i]!, scenarios, 2.128045234184984),
  }));
  const bootstrapPerContrast = strategies.map((strategy, i) => ({
    contrastId: `${strategy}-vs-base`, covered: bootstrapMarginalCounts[i]!, datasets: scenarios,
    coverage: bootstrapMarginalCounts[i]! / scenarios,
    simultaneousLower95: wilsonLowerOneSided(bootstrapMarginalCounts[i]!, scenarios, 2.128045234184984),
  }));
  const jointMarginalCoverage = jointCovered / scenarios;
  const jointLower = wilsonBounds(jointCovered, scenarios)[0];
  const simultaneousMarginalLower = Math.min(jointLower, ...perContrastCoverage.map(c => c.simultaneousLower95));
  const marginalCoverage = Math.min(jointMarginalCoverage, ...perContrastCoverage.map(c => c.coverage));
  const familyRate = familywiseRejected / Math.max(1, familywiseEvaluated);
  const familyUpper = wilsonBounds(familywiseRejected, familywiseEvaluated)[1];
  const bootstrapJoint = bootstrapJointCovered / scenarios;
  const bootstrapJointLower = wilsonBounds(bootstrapJointCovered, scenarios)[0];
  const bootstrapMarginalLower = Math.min(bootstrapJointLower, ...bootstrapPerContrast.map(c => c.simultaneousLower95));
  const bootstrapFamilyRate = bootstrapFwer / Math.max(1, bootstrapFwerEvaluated);
  const bootstrapFamilyUpper = wilsonBounds(bootstrapFwer, bootstrapFwerEvaluated)[1];
  const bootstrapPasses = bootstrapMarginalLower >= .93 && bootstrapFamilyUpper <= .07;
  const placeholder: Preregistration = { version: 1, frozen: true, cohortId: 'validation-design', track, role: 'validation', budgetId: 'bounded', assignmentSeed: 'fixed', expectedRepeats: 3,
    assignments: [{ taskId: 'task', substrateId: 'substrate', repeatId: 'r1', weight: 1 }, { taskId: 'task', substrateId: 'substrate', repeatId: 'r2', weight: 1 }, { taskId: 'task', substrateId: 'substrate', repeatId: 'r3', weight: 1 }],
    contrasts: strategies.map(strategyId => ({ id: `${strategyId}-vs-base`, strategyId, baselineId: 'base' })), confidence: .95, bootstrapResamples: 199, bootstrapSeed: seed, analysisVersion: 'cq-fixed-sample-v1' };
  return { track, designHash: validationDesignHash(placeholder), scenarios, marginalCoverage, marginalCoverageLower95: simultaneousMarginalLower,
    jointCovered, jointCoverage: jointMarginalCoverage, jointCoverageLower95: jointLower,
    familywiseError: familyRate, familywiseErrorUpper95: familyUpper, familywiseRejected, familywiseEvaluated,
    gatesPassed: scenarios >= 2000 && simultaneousMarginalLower >= .93 && familywiseEvaluated > 0 && familyUpper <= .07,
    jointMarginalCoverage, jointMarginalCoverageLower95: jointLower, perContrastCoverage,
    bootstrapOnly: { jointMarginalCoverage: bootstrapJoint, jointMarginalCoverageLower95: bootstrapJointLower, perContrastCoverage: bootstrapPerContrast,
      familywiseError: bootstrapFamilyRate, familywiseErrorUpper95: bootstrapFamilyUpper, familywiseRejected: bootstrapFwer,
      familywiseEvaluated: bootstrapFwerEvaluated, meanMarginalWidth: bootstrapWidth / Math.max(1, widthN),
      conservativeMeanMarginalWidth: conservativeWidth / Math.max(1, widthN), passesCoverageGates: bootstrapPasses },
    seed, bootstrapResamplesPerDataset: 199, clustersPerDataset: 24, repeatsPerTask: 3, scenarioDesign };
}
