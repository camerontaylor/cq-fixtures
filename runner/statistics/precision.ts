import { createHash } from 'node:crypto';
import { analyzeFixedSample, designHash, wilsonBounds, type AnalysisResult, type Observation, type Preregistration } from './inference.js';
import { studentTCritical } from './student-t.js';

export const PRECISION_RECIPE = 'weighted-cluster-hc3-t-bonferroni-v1';
export interface GeneratorPoint {
  clusters: number;
  baseline: number;
  discordance: number;
  icc: number;
  effect: number;
  tasks: number;
  repeats: number;
  weights: 'equal' | 'cycle-1-2-3' | 'dominant';
  contrastEffects?: readonly [number, number, number];
}
export const CORE_POINTS: readonly GeneratorPoint[] = [40, 80, 160, 320, 640].flatMap(clusters =>
  [.2, .5, .8].flatMap(baseline => [.15, .35].flatMap(discordance => [0, .3, .6].flatMap(icc =>
    [0, .02, .05].flatMap(effect => [
      { clusters, baseline, discordance, icc, effect, tasks: 1, repeats: 1, weights: 'equal' as const },
      { clusters, baseline, discordance, icc, effect, tasks: 3, repeats: 3, weights: 'cycle-1-2-3' as const },
    ])))));
// Partial-null families are tested at every design/propensity/ICC anchor.
const mixedPoints = CORE_POINTS.filter(p => p.effect === .05).map(p => ({ ...p, contrastEffects: [0, .02, .05] as const }));
export const VALIDATION_POINTS: readonly GeneratorPoint[] = [...CORE_POINTS, ...mixedPoints];
export const pointEffects = (p: GeneratorPoint): readonly number[] => p.contrastEffects ?? [p.effect, p.effect, p.effect];
export const pointId = (p: GeneratorPoint): string => JSON.stringify({
  clusters: p.clusters, baseline: p.baseline, discordance: p.discordance, icc: p.icc, effect: p.effect,
  tasks: p.tasks, repeats: p.repeats, weights: p.weights,
  ...(p.contrastEffects === undefined ? {} : { contrastEffects: p.contrastEffects }),
});
const VALIDATION_IDS = new Set(VALIDATION_POINTS.map(pointId));
export const precisionRecipeHash = createHash('sha256').update(JSON.stringify({
  recipe: PRECISION_RECIPE, points: VALIDATION_POINTS, contrasts: 3, inflation: 1.15,
  variance: 'sum(a^2*(D-estimate)^2/(1-a)^2)', df: '1/sum(a^2)-1',
  generator: 'substrate-mixture-paired-Bernoulli-v1',
})).digest('hex');

export interface PrecisionInterval {
  estimate: number;
  standardError: number;
  effectiveClusters: number;
  df: number;
  interval: [number, number];
  degenerate: boolean;
}
/** Approximate HC3 intercept-only WLS sandwich, NOT CR2/Satterthwaite.
 * Task mass is a fixed estimand weight, not an inverse-variance weight.
 */
export function weightedClusterT(differences: readonly number[], weights: readonly number[], contrasts = 3): PrecisionInterval {
  if (differences.length < 2 || differences.length !== weights.length
    || differences.some(d => !Number.isFinite(d) || d < -1 || d > 1)
    || weights.some(w => !Number.isFinite(w) || w <= 0)) throw new Error('bounded cluster differences and matching positive weights required');
  const total = weights.reduce((s, w) => s + w, 0);
  if (!Number.isFinite(total)) throw new Error('cluster weight sum must be finite');
  const a = weights.map(w => w / total);
  const effectiveClusters = 1 / a.reduce((s, w) => s + w * w, 0);
  const df = effectiveClusters - 1;
  const estimate = differences.reduce((s, d, i) => s + a[i]! * d, 0);
  const variance = differences.reduce((s, d, i) => s + (a[i]! * (d - estimate) / (1 - a[i]!)) ** 2, 0);
  const standardError = Math.sqrt(variance);
  const half = 1.15 * studentTCritical(df, contrasts) * standardError;
  const degenerate = variance < 1e-20;
  // Raw candidate degeneracy is a failure in validation, never a zero-width claim.
  return { estimate, standardError, effectiveClusters, df, interval: [Math.max(-1, estimate - half), Math.min(1, estimate + half)], degenerate };
}
export interface PrecisionStratum {
  point: GeneratorPoint;
  datasets: number;
  jointCovered: number;
  perContrastCovered: number[];
  nullDatasets: number;
  anyNullRejected: number;
  degenerateDatasets: number;
  meanWidth: number;
  coverageLower95: number;
  fwerUpper95: number | null;
  passes: boolean;
}
export interface PrecisionValidation {
  recipe: typeof PRECISION_RECIPE;
  recipeHash: string;
  track: 'native' | 'diagnostic';
  seed: number;
  core: PrecisionStratum[];
  allCorePassed: boolean;
}

/** Recompute gates from counts; do not trust an outcome-dependent aggregate flag. */
export function precisionValidationPasses(v: PrecisionValidation, track: string): boolean {
  if (v.recipe !== PRECISION_RECIPE || v.recipeHash !== precisionRecipeHash || v.track !== track
    || v.core.length !== VALIDATION_POINTS.length || !Number.isSafeInteger(v.seed)) return false;
  const ids = new Set<string>();
  for (const s of v.core) {
    const id = pointId(s.point);
    if (ids.has(id) || !VALIDATION_IDS.has(id)) return false;
    ids.add(id);
    if (!stratumCountsPass(s)) return false;
  }
  return v.allCorePassed === true;
}
function stratumCountsPass(s: PrecisionStratum): boolean {
  if (!Number.isSafeInteger(s.datasets) || s.datasets < 2000 || !Number.isSafeInteger(s.jointCovered)
    || s.jointCovered < 0 || s.jointCovered > s.datasets || s.perContrastCovered.length !== 3
    || s.perContrastCovered.some(n => !Number.isSafeInteger(n) || n < s.jointCovered || n > s.datasets)
    || !Number.isSafeInteger(s.nullDatasets) || s.nullDatasets !== (pointEffects(s.point).includes(0) ? s.datasets : 0)
    || !Number.isSafeInteger(s.anyNullRejected) || s.anyNullRejected < 0 || s.anyNullRejected > s.nullDatasets
    || !Number.isSafeInteger(s.degenerateDatasets) || s.degenerateDatasets < 0 || s.degenerateDatasets > s.datasets
    || !Number.isFinite(s.meanWidth) || s.meanWidth < 0 || s.meanWidth > 2) return false;
  const lower = wilsonBounds(s.jointCovered, s.datasets)[0];
  const upper = s.nullDatasets ? wilsonBounds(s.anyNullRejected, s.nullDatasets)[1] : null;
  if (Math.abs(lower - s.coverageLower95) > 1e-12 || upper !== s.fwerUpper95
    || lower < .93 || (upper !== null && upper > .07) || !s.passes) return false;
  return true;
}

export const FORECAST_POINTS: readonly GeneratorPoint[] = [.15, .35].flatMap(discordance => [0, .3, .6].flatMap(icc =>
  (['equal', 'cycle-1-2-3'] as const).flatMap(weights => [80, 160, 320, 640, 1280, 2560].map(clusters =>
    ({ clusters, baseline: .5, discordance, icc, effect: .05, tasks: 3, repeats: 3, weights })))));
export interface PrecisionForecastEvidence {
  recipe: string;
  track: string;
  coreProcedureValidated: boolean;
  cells: Array<{ point: GeneratorPoint; datasets: number; conditionalPointGatesPassed: boolean; coverage: PrecisionStratum[] }>;
}
export function precisionForecastPasses(v: PrecisionForecastEvidence, track: string): boolean {
  if (v.recipe !== PRECISION_RECIPE || v.track !== track || v.coreProcedureValidated !== true || v.cells.length !== FORECAST_POINTS.length) return false;
  const ids = new Set<string>();
  for (const cell of v.cells) {
    const id = pointId(cell.point);
    if (ids.has(id) || !FORECAST_POINTS.some(p => pointId(p) === id) || !Number.isSafeInteger(cell.datasets) || cell.datasets < 2000
      || cell.coverage.length !== 4 || cell.conditionalPointGatesPassed !== true) return false;
    ids.add(id);
    const expected = [0, .02, .05].map(effect => ({ ...cell.point, effect }));
    expected.push({ ...cell.point, contrastEffects: [0, .02, .05] });
    if (cell.coverage.some((s, i) => pointId(s.point) !== pointId(expected[i]!) || !stratumCountsPass(s))) return false;
  }
  return true;
}

export interface PrecisionRegistration {
  frozen: true;
  recipe: typeof PRECISION_RECIPE;
  recipeHash: string;
  calibrationSha256: string;
  /** Exact calibration generator point; applicability is a scientific assumption.
   * This must be justified from visible calibration before held-out outcomes.
   */
  model: GeneratorPoint;
  calibrationArtifact: string;
  /** SHA-256 of ordinary registration; binds this extension to exact roster. */
  baseDesignHash: string;
}
export interface PrecisionAnalysis extends AnalysisResult {
  precision: { recipe: string; applied: boolean; reasons: string[]; extensionHash: string; validationHash: string | null; recipeHash: string; forecastValidationHash: string | null };
}
/** Explicit opt-in extension. Unknown or failed applicability retains legacy
 * conservative/descriptive outputs. Never selects a narrower interval by width.
 */
export function analyzePrecisionSample(reg: Preregistration, rows: readonly Observation[], extension: PrecisionRegistration,
  validation: PrecisionValidation | null, forecastEvidence: PrecisionForecastEvidence | null = null): PrecisionAnalysis {
  // Existing parser proves exact roster, weights, repeat averaging and missingness.
  const result = analyzeFixedSample(reg, rows);
  const reasons: string[] = [];
  const finish = (applied: boolean): PrecisionAnalysis => {
    result.maxStatisticAdjustment = 'withheld';
    return { ...result, precision: { recipe: PRECISION_RECIPE, applied, reasons,
      recipeHash: precisionRecipeHash, forecastValidationHash: forecastEvidence ? createHash('sha256').update(JSON.stringify(forecastEvidence)).digest('hex') : null,
      validationHash: validation ? createHash('sha256').update(JSON.stringify(validation)).digest('hex') : null,
      extensionHash: createHash('sha256').update(JSON.stringify(extension)).digest('hex') } };
  };
  if (extension.frozen !== true || extension.recipe !== PRECISION_RECIPE || extension.recipeHash !== precisionRecipeHash
    || !/^[a-f0-9]{64}$/i.test(extension.calibrationSha256) || extension.baseDesignHash !== designHash(reg)
    || !extension.calibrationArtifact.trim()) throw new Error('precision extension must be frozen and bind the exact registration and calibration source');
  if (!validation || !precisionValidationPasses(validation, reg.track)) reasons.push('precision recipe lacks passing validation for every core stratum in this track');
  const corePoint = CORE_POINTS.some(p => pointId(p) === pointId(extension.model));
  const forecastPoint = forecastEvidence !== null && precisionForecastPasses(forecastEvidence, reg.track)
    && FORECAST_POINTS.some(p => pointId(p) === pointId({ ...extension.model, effect: .05 }))
    && [0, .02, .05].includes(extension.model.effect) && extension.model.contrastEffects === undefined;
  if (!corePoint && !forecastPoint) reasons.push('outside the preregistered finite generator grid or missing whole-grid forecast validation');
  if (reg.contrasts.length !== 3 || reg.expectedRepeats !== extension.model.repeats) reasons.push('contrast/repeat design does not match precision envelope');
  const roster = new Map<string, Map<string, number>>();
  for (const a of reg.assignments) { const tasks = roster.get(a.substrateId) ?? new Map<string, number>(); tasks.set(a.taskId, a.weight); roster.set(a.substrateId, tasks); }
  const masses = [...roster.values()].map(ts => [...ts.values()].reduce((s, w) => s + w, 0));
  if ([...roster.values()].some(ts => new Set(ts.values()).size !== 1)) reasons.push('within-substrate unequal task weights are outside the generator');
  if (roster.size !== extension.model.clusters || [...roster.values()].some(ts => ts.size !== extension.model.tasks)) reasons.push('cluster/task counts do not match precision envelope');
  // Require exact weight pattern up to a common scale, not merely a ratio bound.
  const sortedMasses = [...masses].sort((a, b) => a - b), minMass = sortedMasses[0]!;
  const expectedMasses = Array.from({ length: roster.size }, (_, i) => extension.model.weights === 'equal' ? 1 : 1 + i % 3).sort((a, b) => a - b);
  if (sortedMasses.some((w, i) => Math.abs(w / minMass - expectedMasses[i]!) > 1e-12)) reasons.push('frozen cluster masses do not match validated weight pattern');
  if (result.contrasts.some(c => c.operationalMissing > 0 || c.pairedTasks !== c.tasks)) reasons.push('missingness suppresses the entire precision family');
  if (reasons.length > 0) return finish(false);
  const byKey = new Map(rows.map(r => [`${r.strategyId}\0${r.taskId}\0${r.repeatId}`, r]));
  const intervals = reg.contrasts.map(c => {
    const sums = new Map<string, number>();
    for (const a of reg.assignments) {
      const x = byKey.get(`${c.strategyId}\0${a.taskId}\0${a.repeatId}`), y = byKey.get(`${c.baselineId}\0${a.taskId}\0${a.repeatId}`);
      if (x?.status !== 'measured' || y?.status !== 'measured') return null;
      sums.set(a.substrateId, (sums.get(a.substrateId) ?? 0) + a.weight * (Number(x.success) - Number(y.success)) / reg.expectedRepeats);
    }
    if (masses.length < 2) return null;
    return weightedClusterT([...roster.keys()].map((s, i) => Math.max(-1, Math.min(1, sums.get(s)! / masses[i]!))), masses, reg.contrasts.length);
  });
  if (intervals.some(x => !x || x.degenerate)) reasons.push('degenerate cluster variance suppresses the entire precision family');
  const applied = reasons.length === 0;
  if (applied) result.contrasts = result.contrasts.map((c, i) => ({ ...c, marginal95: intervals[i]!.interval,
    familywise95: intervals[i]!.interval, status: 'inferential', reasons: ['conditional simulation validation; HC3-t Bonferroni family (not bootstrap max-statistic)'] }));
  // This recipe never reports a bootstrap max-statistic adjustment.
  return finish(applied);
}
