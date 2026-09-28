import { clusterWeights, generateClusters, simulatePrecisionStratum } from './precision-simulation.js';
import { weightedClusterT, type GeneratorPoint, type PrecisionValidation, precisionValidationPasses, precisionRecipeHash, PRECISION_RECIPE } from './precision.js';
import { persistentClusterVariance } from './power.js';
import { studentTCritical } from './student-t.js';
import { wilsonBounds } from './inference.js';

function random(seed: number): () => number {
  let x = seed | 0;
  return () => { x = (x + 0x6D2B79F5) | 0; let t = Math.imul(x ^ (x >>> 15), 1 | x); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export interface PrecisionPowerCell {
  point: GeneratorPoint;
  datasets: number;
  detectedFirstContrast: number;
  power: number;
  power95: [number, number];
  meanFamilyIntervalWidth: number;
  fivePointHalfWidthFraction: number;
  normalApproximationMde80: number;
  clusterVariance: number;
  conditionalPointGatesPassed: boolean;
  coverage: ReturnType<typeof simulatePrecisionStratum>[];
}
/** Simulation forecasts; inputs are sensitivity assumptions, NOT fitted role
 * pilot estimates. Every cell tests null, small effect, target and partial null.
 * Power is for a specified single contender clearing its family lower bound.
 */
export function simulatePrecisionPower(validation: PrecisionValidation, seed: number, progress?: (n: number) => void): {
  recipe: string; recipeHash: string; track: string; roles: string[]; seed: number; datasetsPerCell: number;
  coreProcedureValidated: boolean; roleCalibrated: false; quotaOrRuntimeEstimate: null;
  cells: PrecisionPowerCell[];
} {
  if (!precisionValidationPasses(validation, validation.track)) throw new Error('failed or unpinned base validation');
  if (seed !== validation.seed + 300000000) throw new Error('power seed must match preregistration');
  const datasets = 2000, cells: PrecisionPowerCell[] = [];
  let serial = 0;
  for (const discordance of [.15, .35]) for (const icc of [0, .3, .6]) for (const weights of ['equal', 'cycle-1-2-3'] as const) {
    for (const clusters of [80, 160, 320, 640, 1280, 2560]) {
      const point: GeneratorPoint = { clusters, baseline: .5, discordance, icc, effect: .05, tasks: 3, repeats: 3, weights };
      const rng = random(seed + serial * 104729), mass = clusterWeights(point);
      let detectedFirstContrast = 0, width = 0, narrow = 0;
      for (let d = 0; d < datasets; d++) {
        const columns = generateClusters(point, rng), intervals = columns.map(xs => weightedClusterT(xs, mass));
        if (!intervals[0]!.degenerate && intervals[0]!.interval[0] > 0) detectedFirstContrast++;
        for (const interval of intervals) {
          const w = interval.interval[1] - interval.interval[0]; width += w;
          if (w <= .1 && !interval.degenerate) narrow++;
        }
      }
      const total = mass.reduce((s, w) => s + w, 0), sumSq = mass.reduce((s, w) => s + (w / total) ** 2, 0);
      const clusterVariance = persistentClusterVariance(discordance, .05, icc, 3, 3);
      const mde = (1.15 * studentTCritical(1 / sumSq - 1, 3) + .8416212335729143) * Math.sqrt(clusterVariance * sumSq);
      const coverage = [0, .02, .05].map((effect, i) => simulatePrecisionStratum({ ...point, effect }, seed + 100000000 + serial * 65537 + i * 7919));
      coverage.push(simulatePrecisionStratum({ ...point, contrastEffects: [0, .02, .05] }, seed + 200000000 + serial * 65537));
      cells.push({ point, datasets, detectedFirstContrast, power: detectedFirstContrast / datasets,
        power95: wilsonBounds(detectedFirstContrast, datasets), meanFamilyIntervalWidth: width / (3 * datasets),
        fivePointHalfWidthFraction: narrow / (3 * datasets), normalApproximationMde80: mde,
        clusterVariance, conditionalPointGatesPassed: coverage.every(s => s.passes), coverage });
      serial++; progress?.(serial);
    }
  }
  return { recipe: PRECISION_RECIPE, recipeHash: precisionRecipeHash, track: validation.track, roles: ['fixer-worker', 'review-classifier'], seed, datasetsPerCell: datasets,
    coreProcedureValidated: precisionValidationPasses(validation, validation.track), roleCalibrated: false,
    quotaOrRuntimeEstimate: null, cells };
}
