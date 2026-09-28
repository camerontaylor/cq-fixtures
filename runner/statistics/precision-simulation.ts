import { VALIDATION_POINTS, pointEffects, PRECISION_RECIPE, precisionRecipeHash, weightedClusterT, type GeneratorPoint, type PrecisionStratum, type PrecisionValidation } from './precision.js';
import { wilsonBounds } from './inference.js';

function random(seed: number): () => number {
  let x = seed | 0;
  return () => { x = (x + 0x6D2B79F5) | 0; let t = Math.imul(x ^ (x >>> 15), 1 | x); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function clusterWeights(p: GeneratorPoint): number[] {
  return Array.from({ length: p.clusters }, (_, i) => p.weights === 'dominant' ? (i === 0 ? 100 : 1) : p.weights === 'equal' ? 1 : 1 + i % 3);
}
/** Generate the three paired differences together. A baseline draw is shared
 * by contenders; every copy retains the entire joint vector. ICC is rho,
 * not rho squared: the mixture indicator is drawn ONCE per substrate.
 */
export function generateClusters(p: GeneratorPoint, rng: () => number): number[][] {
  const effects = pointEffects(p);
  if (effects.some(effect => p.discordance < Math.abs(effect) || p.baseline + effect > 1 || p.baseline + effect < 0
    || p.discordance > 1e-12 + Math.min(2 * p.baseline + effect, 2 - 2 * p.baseline - effect))) throw new Error('infeasible paired Bernoulli margins');
  const columns: number[][] = [[], [], []];
  const pair = (): number[] => {
    const base = rng() < p.baseline;
    return effects.map(effect => {
      const probability = base ? 1 - (p.discordance - effect) / (2 * p.baseline) : (p.discordance + effect) / (2 * (1 - p.baseline));
      return Number(rng() < probability) - Number(base);
    });
  };
  for (let g = 0; g < p.clusters; g++) {
    const copied = rng() < p.icc;
    const sums = [0, 0, 0];
    if (copied) { const d = pair(); for (let c = 0; c < 3; c++) sums[c] = d[c]!; }
    else {
      const n = p.tasks * p.repeats;
      for (let j = 0; j < n; j++) { const d = pair(); for (let c = 0; c < 3; c++) sums[c]! += d[c]! / n; }
    }
    for (let c = 0; c < 3; c++) columns[c]!.push(Math.max(-1, Math.min(1, sums[c]!)));
  }
  return columns;
}
export function simulatePrecisionStratum(point: GeneratorPoint, seed: number, datasets = 2000): PrecisionStratum {
  if (!Number.isSafeInteger(datasets) || datasets < 2000 || !Number.isSafeInteger(seed)) throw new Error('seeded >=2000 datasets required per stratum');
  const rng = random(seed), weights = clusterWeights(point), effects = pointEffects(point);
  let jointCovered = 0, anyNullRejected = 0, degenerateDatasets = 0, width = 0;
  const perContrastCovered = [0, 0, 0];
  for (let d = 0; d < datasets; d++) {
    const differences = generateClusters(point, rng);
    let joint = true, rejected = false, degenerate = false;
    for (let c = 0; c < 3; c++) {
      const out = weightedClusterT(differences[c]!, weights);
      const [lo, hi] = out.interval;
      const covered = !out.degenerate && lo <= effects[c]! && hi >= effects[c]!;
      if (covered) perContrastCovered[c]!++;
      joint &&= covered;
      rejected ||= effects[c] === 0 && !out.degenerate && (lo > 0 || hi < 0);
      degenerate ||= out.degenerate;
      width += hi - lo;
    }
    if (joint) jointCovered++;
    if (effects.includes(0) && rejected) anyNullRejected++;
    if (degenerate) degenerateDatasets++;
  }
  const coverageLower95 = wilsonBounds(jointCovered, datasets)[0];
  const nullDatasets = effects.includes(0) ? datasets : 0;
  const fwerUpper95 = nullDatasets ? wilsonBounds(anyNullRejected, nullDatasets)[1] : null;
  return { point, datasets, jointCovered, perContrastCovered, nullDatasets, anyNullRejected, degenerateDatasets,
    meanWidth: width / (3 * datasets), coverageLower95, fwerUpper95,
    passes: coverageLower95 >= .93 && (fwerUpper95 === null || fwerUpper95 <= .07) };
}
export function simulatePrecision(track: 'native' | 'diagnostic', seed: number, datasets = 2000,
  progress?: (completed: number) => void): PrecisionValidation {
  const core = VALIDATION_POINTS.map((point, i) => { const s = simulatePrecisionStratum(point, seed + 104729 * i, datasets); progress?.(i + 1); return s; });
  return { recipe: PRECISION_RECIPE, recipeHash: precisionRecipeHash, track, seed, core, allCorePassed: core.every(s => s.passes) };
}
export function simulatePrecisionStress(seed: number): PrecisionStratum[] {
  const points: GeneratorPoint[] = [];
  for (const clusters of [20, 40, 80]) for (const effect of [0, .02]) {
    points.push({ clusters, baseline: .5, discordance: .15, icc: .6, effect, tasks: 3, repeats: 3, weights: 'equal' });
    points.push({ clusters, baseline: .98, discordance: .02, icc: .6, effect: 0, tasks: 3, repeats: 3, weights: 'equal' });
    points.push({ clusters, baseline: .01, discordance: .02, icc: 1, effect: 0, tasks: 1, repeats: 3, weights: 'equal' });
    points.push({ clusters, baseline: .5, discordance: .05, icc: .6, effect, tasks: 3, repeats: 3, weights: 'equal' });
    points.push({ clusters, baseline: .5, discordance: .35, icc: .3, effect, tasks: 3, repeats: 3, weights: 'dominant' });
  }
  return points.map((p, i) => simulatePrecisionStratum(p, seed + i * 65537));
}
