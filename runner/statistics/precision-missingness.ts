import { analyzePrecisionSample, precisionRecipeHash, CORE_POINTS, PRECISION_RECIPE, type PrecisionValidation } from './precision.js';
import { designHash, type Assignment, type Observation, type Preregistration } from './inference.js';
/** Suppression checks are operational assertions, never treated as coverage. */
export function simulatePrecisionMissingness(validation: PrecisionValidation, seed: number): Array<{
  clusters: number; mode: string; datasets: number; suppressed: number; gate: boolean;
}> {
  let x = seed | 0;
  const random = () => { x = (x + 0x6D2B79F5) | 0; let t = Math.imul(x ^ (x >>> 15), 1 | x); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return [40, 80].flatMap(clusters => ['paired-5-percent', 'strategy-only-15-percent'].map(mode => {
    let suppressed = 0;
    const assignments: Assignment[] = [];
    for (let g = 0; g < clusters; g++) for (let t = 0; t < 3; t++) for (let r = 0; r < 3; r++) assignments.push({ taskId: `s${g}-t${t}`, substrateId: `s${g}`, repeatId: `r${r}`, weight: 1 + g % 3 });
    const reg: Preregistration = { version: 1, frozen: true, cohortId: 'missingness-sim', track: validation.track,
      role: 'fixer-worker', budgetId: 'bounded', assignmentSeed: String(seed), expectedRepeats: 3, assignments,
      contrasts: [1, 2, 3].map(n => ({ id: `c${n}`, strategyId: `m${n}`, baselineId: 'base' })), confidence: .95,
      bootstrapResamples: 199, bootstrapSeed: seed, analysisVersion: 'cq-fixed-sample-v1' };
    const extension = { frozen: true as const, recipe: PRECISION_RECIPE, recipeHash: precisionRecipeHash, calibrationSha256: 'a'.repeat(64), baseDesignHash: designHash(reg),
      model: CORE_POINTS.find(p => p.clusters === clusters && p.tasks === 3)!, calibrationArtifact: 'simulation-only' } as const;
    for (let d = 0; d < 2000; d++) {
      const rows: Observation[] = [];
      for (let i = 0; i < assignments.length; i++) {
        const a = assignments[i]!, pairMissing = mode.startsWith('paired') && (i === 0 || random() < .05);
        for (const strategyId of ['base', 'm1', 'm2', 'm3']) {
          const missing = pairMissing || (mode.startsWith('strategy') && strategyId === 'm1' && (i === 0 || random() < .15));
          rows.push({ ...a, strategyId, cohortId: reg.cohortId, track: reg.track, status: missing ? 'operational-missing' : 'measured', success: missing ? null : random() < .5 });
        }
      }
      const out = analyzePrecisionSample(reg, rows, extension, validation);
      if (!out.precision.applied && out.contrasts.every(c => c.status !== 'inferential' && c.familywise95 === null)) suppressed++;
    }
    return { clusters, mode: mode + '; conditioned on at least one absence', datasets: 2000, suppressed, gate: suppressed === 2000 };
  }));
}
