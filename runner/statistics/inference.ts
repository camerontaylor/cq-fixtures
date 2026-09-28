import { createHash } from 'node:crypto';

/** Fixed-sample paired inference for standalone campaign observations.
 *
 * This deliberately does not adapt runner aggregate rows: an S1-owned
 * integration adapter must map its immutable observation envelope into this
 * explicit interface. All inference is kept separate by track and cohort.
 */

export type Track = 'native' | 'diagnostic' | (string & {});
export type OutcomeStatus = 'measured' | 'operational-missing';

export interface Assignment {
  taskId: string;
  substrateId: string;
  repeatId: string;
  /** Frozen task weight; must match exactly across paired strategies. */
  weight: number;
}

export interface Observation extends Assignment {
  strategyId: string;
  track: Track;
  cohortId: string;
  /** A launched, budget-exhausted/no-candidate assignment is a measured failure. */
  status: OutcomeStatus;
  success: boolean | null;
  cause?: string;
}

export interface ContrastRegistration {
  id: string;
  strategyId: string;
  baselineId: string;
}

export interface Preregistration {
  version: 1;
  frozen: true;
  cohortId: string;
  track: Track;
  role: string;
  budgetId: string;
  assignmentSeed: string;
  expectedRepeats: number;
  assignments: readonly Assignment[];
  contrasts: readonly ContrastRegistration[];
  confidence: 0.95;
  bootstrapResamples: number;
  bootstrapSeed: number;
  analysisVersion: 'cq-fixed-sample-v1';
}

export interface ValidationEvidence {
  designHash: string;
  scenarios: number;
  marginalCoverage: number;
  marginalCoverageLower95: number;
  jointCovered: number;
  jointCoverage: number;
  jointCoverageLower95: number;
  perContrastCoverage: Array<{ contrastId: string; covered: number; datasets: number; coverage: number; simultaneousLower95: number }>;
  familywiseError: number;
  familywiseErrorUpper95: number;
  familywiseRejected: number;
  familywiseEvaluated: number;
  gatesPassed: boolean;
}

export interface ContrastResult {
  id: string;
  estimate: number | null;
  marginal95: [number, number] | null;
  familywise95: [number, number] | null;
  /** Diagnostic only; never used for inferential status without the Hoeffding envelope. */
  bootstrapOnlyMarginal95: [number, number] | null;
  /** Diagnostic only; raw bootstrap max-statistic interval before analytic expansion. */
  bootstrapOnlyFamilywise95: [number, number] | null;
  status: 'inferential' | 'descriptive' | 'inconclusive';
  reasons: string[];
  substrates: number;
  tasks: number;
  pairedTasks: number;
  launchedBudgetFailures: number;
  operationalMissing: number;
  bootstrapResamples: number;
}

export interface AnalysisResult {
  version: 'cq-fixed-sample-v1';
  cohortId: string;
  track: Track;
  role: string;
  budgetId: string;
  preregistrationFrozen: true;
  designHash: string;
  validation: ValidationEvidence | null;
  maxStatisticAdjustment: 'applied' | 'withheld';
  contrasts: ContrastResult[];
}

const key = (a: Assignment): string => `${a.taskId}\u0000${a.repeatId}`;
const pairKey = (strategy: string, a: Assignment): string => `${strategy}\u0000${key(a)}`;

/** Stable SHA-256 hash used to bind the frozen preregistration to its output. */
export function designHash(reg: Preregistration): string {
  const canonical = JSON.stringify({
    version: reg.version, cohortId: reg.cohortId, track: reg.track, role: reg.role,
    budgetId: reg.budgetId, assignmentSeed: reg.assignmentSeed,
    expectedRepeats: reg.expectedRepeats,
    assignments: [...reg.assignments].sort((a, b) => key(a).localeCompare(key(b))),
    contrasts: [...reg.contrasts].sort((a, b) => a.id.localeCompare(b.id)),
    confidence: reg.confidence, bootstrapResamples: reg.bootstrapResamples,
    bootstrapSeed: reg.bootstrapSeed, analysisVersion: reg.analysisVersion,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Validation family key: pins the inferential recipe while allowing a fresh,
 * separately preregistered cohort to reuse its pre-run validation. */
export function validationDesignHash(reg: Preregistration): string {
  return [reg.analysisVersion, reg.track, reg.confidence, reg.expectedRepeats, reg.contrasts.length,
    'substrates>=20', 'binary-complete-pairs', 'task-weighted-cluster-means',
    'simulation:24-substrates,3-repeats,3-contrasts,10-scenarios,2000-datasets',
    'bootstrap-resamples-199..10000-diagnostic-only', 'weighted-hoeffding-envelope-v1'].join('|');
}

function validateRegistration(reg: Preregistration): void {
  if (reg.version !== 1 || reg.frozen !== true || reg.analysisVersion !== 'cq-fixed-sample-v1') throw new Error('registration must be frozen version 1');
  if (reg.track !== 'native' && reg.track !== 'diagnostic') throw new Error('track must be native or diagnostic');
  if (!reg.cohortId || !reg.role || !reg.budgetId || !reg.assignmentSeed) throw new Error('cohort, role, budget, and assignment seed are required');
  if (!Number.isInteger(reg.expectedRepeats) || reg.expectedRepeats < 1) throw new Error('expectedRepeats must be a positive integer');
  if (reg.confidence !== 0.95) throw new Error('only preregistered 95% confidence is supported');
  if (!Number.isSafeInteger(reg.bootstrapResamples) || reg.bootstrapResamples < 199 || reg.bootstrapResamples > 10_000) throw new Error('bootstrapResamples must be an integer from 199 through 10000');
  if (!Number.isSafeInteger(reg.bootstrapSeed)) throw new Error('bootstrapSeed must be a safe integer');
  const seen = new Set<string>();
  const taskWeights = new Map<string, number>();
  if (!Array.isArray(reg.assignments) || reg.assignments.length === 0) throw new Error('frozen assignment roster must not be empty');
  for (const a of reg.assignments) {
    if (!a.taskId || !a.substrateId || !a.repeatId || !Number.isFinite(a.weight) || a.weight <= 0) throw new Error('assignments need ids and a positive finite frozen weight');
    const k = key(a);
    if (seen.has(k)) throw new Error(`duplicate preregistered assignment ${a.taskId}/${a.repeatId}`);
    seen.add(k);
    if (taskWeights.has(a.taskId) && taskWeights.get(a.taskId) !== a.weight) throw new Error(`task ${a.taskId} has inconsistent frozen weights across repeats`);
    taskWeights.set(a.taskId, a.weight);
  }
  const taskSubstrates = new Map<string, string>();
  const repeats = new Map<string, Set<string>>();
  for (const a of reg.assignments) {
    if (taskSubstrates.has(a.taskId) && taskSubstrates.get(a.taskId) !== a.substrateId) throw new Error(`task ${a.taskId} maps to multiple substrates`);
    taskSubstrates.set(a.taskId, a.substrateId);
    const rs = repeats.get(a.taskId) ?? new Set<string>(); rs.add(a.repeatId); repeats.set(a.taskId, rs);
  }
  for (const [task, rs] of repeats) if (rs.size !== reg.expectedRepeats) throw new Error(`task ${task} has ${rs.size} repeats; preregistered ${reg.expectedRepeats}`);
  const contrastIds = new Set<string>();
  for (const c of reg.contrasts) {
    if (!c.id || !c.strategyId || !c.baselineId || c.strategyId === c.baselineId || contrastIds.has(c.id)) throw new Error('contrasts need unique ids and distinct strategy/baseline ids');
    contrastIds.add(c.id);
  }
  if (reg.contrasts.length === 0) throw new Error('at least one contrast is required');
}

function validateEvidence(evidence: ValidationEvidence): boolean {
  if (typeof evidence !== 'object' || evidence === null || typeof evidence.designHash !== 'string' || evidence.designHash.length === 0) throw new Error('validation evidence requires a designHash');
  if (!Number.isSafeInteger(evidence.scenarios) || evidence.scenarios < 0) throw new Error('validation evidence scenarios must be a nonnegative integer');
  for (const [name, value] of Object.entries({
    marginalCoverage: evidence.marginalCoverage,
    marginalCoverageLower95: evidence.marginalCoverageLower95,
    jointCoverage: evidence.jointCoverage,
    jointCoverageLower95: evidence.jointCoverageLower95,
    familywiseError: evidence.familywiseError,
    familywiseErrorUpper95: evidence.familywiseErrorUpper95,
  })) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`validation evidence ${name} must be finite and within [0,1]`);
  }
  if (evidence.marginalCoverageLower95 > evidence.marginalCoverage) throw new Error('marginal coverage lower bound exceeds its estimate');
  if (evidence.jointCoverageLower95 > evidence.jointCoverage) throw new Error('joint coverage lower bound exceeds its estimate');
  if (evidence.familywiseError > evidence.familywiseErrorUpper95) throw new Error('familywise error estimate exceeds its upper bound');
  if (!Array.isArray(evidence.perContrastCoverage) || evidence.perContrastCoverage.length === 0) throw new Error('validation evidence requires per-contrast denominators');
  const evidenceContrastIds = new Set<string>();
  for (const c of evidence.perContrastCoverage) {
    if (!c.contrastId || evidenceContrastIds.has(c.contrastId) || c.datasets !== evidence.scenarios
      || !Number.isSafeInteger(c.covered) || c.covered < 0 || c.covered > c.datasets
      || !Number.isFinite(c.coverage) || Math.abs(c.coverage - c.covered / c.datasets) > 1e-12
      || !Number.isFinite(c.simultaneousLower95)
      || c.coverage < 0 || c.coverage > 1 || c.simultaneousLower95 < 0 || c.simultaneousLower95 > c.coverage) {
      throw new Error('validation evidence per-contrast coverage is malformed or has a non-dataset denominator');
    }
    const perContrastWilson = wilsonLowerOneSided(c.covered, c.datasets, 2.128045234184984);
    if (c.simultaneousLower95 > perContrastWilson + 1e-12) throw new Error('validation evidence per-contrast lower bound is anti-conservative');
    evidenceContrastIds.add(c.contrastId);
  }
  if (!Number.isSafeInteger(evidence.jointCovered) || evidence.jointCovered < 0 || evidence.jointCovered > evidence.scenarios
    || Math.abs(evidence.jointCoverage - evidence.jointCovered / evidence.scenarios) > 1e-12) throw new Error('validation evidence joint coverage count and denominator are incoherent');
  if (evidence.jointCoverageLower95 > wilsonBounds(evidence.jointCovered, evidence.scenarios)[0] + 1e-12) throw new Error('validation evidence joint lower bound is anti-conservative');
  if (!Number.isSafeInteger(evidence.familywiseEvaluated) || evidence.familywiseEvaluated < 0 || evidence.familywiseEvaluated > evidence.scenarios) throw new Error('validation evidence familywise denominator is invalid');
  if (!Number.isSafeInteger(evidence.familywiseRejected) || evidence.familywiseRejected < 0 || evidence.familywiseRejected > evidence.familywiseEvaluated
    || evidence.familywiseEvaluated === 0 || Math.abs(evidence.familywiseError - evidence.familywiseRejected / evidence.familywiseEvaluated) > 1e-12) {
    throw new Error('validation evidence familywise numerator and denominator are incoherent');
  }
  if (evidence.familywiseErrorUpper95 + 1e-12 < wilsonBounds(evidence.familywiseRejected, evidence.familywiseEvaluated)[1]) throw new Error('validation evidence familywise upper bound is anti-conservative');
  const coverageLower = Math.min(evidence.jointCoverageLower95, ...evidence.perContrastCoverage.map(c => c.simultaneousLower95));
  const coverageEstimate = Math.min(evidence.jointCoverage, ...evidence.perContrastCoverage.map(c => c.coverage));
  if (Math.abs(evidence.marginalCoverageLower95 - coverageLower) > 1e-12 || Math.abs(evidence.marginalCoverage - coverageEstimate) > 1e-12) {
    throw new Error('validation evidence marginal coverage does not match joint and per-contrast summaries');
  }
  const gatesPass = evidence.scenarios >= 2000
    && coverageLower >= 0.93 && evidence.familywiseEvaluated > 0 && evidence.familywiseErrorUpper95 <= 0.07;
  if (typeof evidence.gatesPassed !== 'boolean' || evidence.gatesPassed !== gatesPass) throw new Error('validation evidence gatesPassed is incoherent with the reported bounds');
  return gatesPass;
}

/** SplitMix32 gives reproducible bootstrap draws without process-global RNG state. */
function rng(seed: number): () => number {
  let x = seed | 0;
  return () => {
    x = (x + 0x6D2B79F5) | 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(xs: number[], p: number): number {
  xs.sort((a, b) => a - b);
  const x = (xs.length - 1) * p, lo = Math.floor(x), hi = Math.ceil(x);
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (x - lo);
}

function mean(xs: readonly number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }

interface Prepared {
  clusterIds: string[];
  differences: number[];
  clusterWeights: number[];
  tasks: number;
  pairedTasks: number;
  failures: number;
  missing: number;
  reasons: string[];
}

function prepare(reg: Preregistration, rows: readonly Observation[], c: ContrastRegistration): Prepared {
  const expected = new Map(reg.assignments.map(a => [key(a), a]));
  const selected = new Map<string, Observation>();
  const reasons: string[] = [];
  for (const row of rows) {
    if (row.cohortId !== reg.cohortId || row.track !== reg.track) throw new Error('observations cannot pool cohorts or tracks');
    if (row.strategyId !== c.strategyId && row.strategyId !== c.baselineId) continue;
    const k = key(row), a = expected.get(k);
    if (!a) throw new Error(`observation outside preregistered assignment: ${row.taskId}/${row.repeatId}`);
    if (row.substrateId !== a.substrateId || row.weight !== a.weight) throw new Error(`identity/weight parity violation at ${row.taskId}/${row.repeatId}`);
    const pk = pairKey(row.strategyId, row);
    if (selected.has(pk)) throw new Error(`duplicate observation for ${row.strategyId}/${row.taskId}/${row.repeatId}`);
    if (row.status === 'measured' && typeof row.success !== 'boolean') throw new Error('measured observation requires boolean success');
    if (row.status === 'operational-missing' && row.success !== null) throw new Error('operational missingness must have null success');
    selected.set(pk, row);
  }
  const taskSide = new Map<string, Map<string, { substrate: string; weight: number; outcomes: Record<string, Array<boolean | null>> }>>();
  let failures = 0, missing = 0;
  for (const a of reg.assignments) {
    const rec = taskSide.get(a.taskId) ?? new Map();
    for (const s of [c.strategyId, c.baselineId]) {
      const row = selected.get(pairKey(s, a));
      if (!row) { reasons.push(`missing assigned row ${s}/${a.taskId}/${a.repeatId}`); missing++; }
      else if (row.status === 'operational-missing') { reasons.push(`operational missingness ${s}/${a.taskId}/${a.repeatId}`); missing++; }
      else {
        const outcome = row.success!;
        if (!outcome && /budget|exhaust/i.test(row.cause ?? '')) failures++;
        const sr = rec.get(s) ?? { substrate: a.substrateId, weight: a.weight, outcomes: {} };
        (sr.outcomes[a.repeatId] ??= []).push(outcome);
        rec.set(s, sr);
      }
    }
    taskSide.set(a.taskId, rec);
  }
  // No complete-case substitution: any missing outcome withholds inference.
  const taskValues = new Map<string, { substrate: string; weight: number; diff: number }>();
  for (const [task, sides] of taskSide) {
    const a = sides.get(c.strategyId), b = sides.get(c.baselineId);
    if (!a || !b || Object.keys(a.outcomes).length !== reg.expectedRepeats || Object.keys(b.outcomes).length !== reg.expectedRepeats) continue;
    const av = mean(Object.values(a.outcomes).flat().map(v => v ? 1 : 0));
    const bv = mean(Object.values(b.outcomes).flat().map(v => v ? 1 : 0));
    taskValues.set(task, { substrate: a.substrate, weight: a.weight, diff: av - bv });
  }
  const bySubstrate = new Map<string, Array<{ diff: number; weight: number }>>();
  for (const v of taskValues.values()) { const xs = bySubstrate.get(v.substrate) ?? []; xs.push({ diff: v.diff, weight: v.weight }); bySubstrate.set(v.substrate, xs); }
  const ids = [...bySubstrate.keys()].sort();
  const clusterWeights: number[] = [];
  const clusterDiffs = ids.map(id => {
    const ts = bySubstrate.get(id)!; const w = ts.reduce((s, x) => s + x.weight, 0);
    clusterWeights.push(w);
    return ts.reduce((s, x) => s + x.diff * x.weight, 0) / w;
  });
  if (missing > 0) reasons.push('paired operational coverage is incomplete; no inferential missingness assumption was preregistered');
  return { clusterIds: ids, differences: clusterDiffs, clusterWeights, tasks: reg.assignments.length / reg.expectedRepeats, pairedTasks: taskValues.size, failures, missing, reasons: [...new Set(reasons)] };
}

/**
 * Analyze one fixed cohort. Max-statistic intervals are returned only when
 * evidence matches this exact preregistered design and passes both simulation
 * gates. The bootstrap is paired by substrate; a simultaneous Hoeffding
 * envelope prevents anti-conservative finite-sample tails for bounded [-1,1]
 * cluster differences. This can be intentionally wide at small n.
 */
export function analyzeFixedSample(
  reg: Preregistration,
  rows: readonly Observation[],
  validation: ValidationEvidence | null = null,
): AnalysisResult {
  validateRegistration(reg);
  const hash = designHash(reg);
  const evidencePasses = validation === null ? false : validateEvidence(validation);
  const validated = validation !== null && validation.designHash === validationDesignHash(reg)
    && validation.perContrastCoverage.length === reg.contrasts.length
    && reg.contrasts.every(c => validation.perContrastCoverage.some(v => v.contrastId === c.id)) && evidencePasses;
  const registeredStrategies = new Set(reg.contrasts.flatMap(c => [c.strategyId, c.baselineId]));
  for (const row of rows) {
    if (row.cohortId !== reg.cohortId || row.track !== reg.track) throw new Error('observations cannot pool cohorts or tracks');
    if (!registeredStrategies.has(row.strategyId)) throw new Error(`observation uses unregistered strategy '${row.strategyId}'`);
    if (typeof row.taskId !== 'string' || !row.taskId || typeof row.substrateId !== 'string' || !row.substrateId || typeof row.repeatId !== 'string' || !row.repeatId) throw new Error('observation task, substrate, and repeat identities must be nonempty strings');
    if (!Number.isFinite(row.weight) || row.weight <= 0) throw new Error('observation weight must be finite and positive');
    if (row.status !== 'measured' && row.status !== 'operational-missing') throw new Error(`unknown observation status '${String(row.status)}'`);
    if (row.status === 'measured' && typeof row.success !== 'boolean') throw new Error('measured observation requires boolean success');
    if (row.status === 'operational-missing' && row.success !== null) throw new Error('operational missingness must have null success');
  }
  const prepared = reg.contrasts.map(c => prepare(reg, rows, c));
  const commonClusterIds = prepared[0]?.clusterIds ?? [];
  const sameClusterRoster = prepared.every(p => p.clusterIds.length === commonClusterIds.length && p.clusterIds.every((id, i) => id === commonClusterIds[i]));
  const usable = sameClusterRoster && prepared.every(p => p.reasons.length === 0 && p.clusterIds.length >= 20 && p.differences.length >= 20 && new Set(p.differences).size > 1);
  const resamples = reg.bootstrapResamples;
  const boot: number[][] = reg.contrasts.map(() => []);
  const maxStats: number[] = [];
  const random = rng(reg.bootstrapSeed);
  if (prepared.every(p => p.differences.length > 0)) {
    const sharedN = commonClusterIds.length;
    const positions = prepared.map(p => new Map(p.clusterIds.map((id, i) => [id, i])));
    for (let r = 0; r < resamples; r++) {
      const sampledIds = Array.from({ length: sharedN }, () => commonClusterIds[Math.floor(random() * sharedN)]!);
      const all: number[] = [];
      for (let j = 0; j < prepared.length; j++) {
        const p = prepared[j]!, ds = p.differences, ws = p.clusterWeights;
        const sample = sampledIds.map(id => positions[j]!.get(id)!).filter(i => i !== undefined);
        if (sample.length === 0) { all.push(0); continue; }
        const den = sample.reduce((sum, k) => sum + ws[k]!, 0);
        const m = sample.reduce((sum, k) => sum + ds[k]! * ws[k]!, 0) / den;
        const observed = ds.reduce((sum, x, k) => sum + x * ws[k]!, 0) / ws.reduce((a, b) => a + b, 0);
        boot[j]!.push(m); all.push(m - observed);
      }
      maxStats.push(Math.max(...all.map(Math.abs)));
    }
  }
  const familyCritical = maxStats.length ? quantile(maxStats, 0.95) : NaN;
  const results = prepared.map((p, i): ContrastResult => {
    const weightSum = p.clusterWeights.reduce((a, b) => a + b, 0);
    const estimate = p.differences.length ? p.differences.reduce((s, x, k) => s + x * p.clusterWeights[k]!, 0) / weightSum : null;
    const n = p.differences.length;
    const inferential = validated && usable && n >= 20;
    const reasons = [...p.reasons];
    if (n < 20) reasons.push(`fewer than 20 independent substrates (${n})`);
    if (new Set(p.differences).size <= 1) reasons.push('degenerate cluster variance');
    if (!validated) reasons.push('design-specific simulation validation gate did not pass');
    const marginal: [number, number] | null = estimate === null ? null : (() => {
      const raw = boot[i]!.length ? [quantile([...boot[i]!], 0.025), quantile([...boot[i]!], 0.975)] : [estimate, estimate];
      const ws = p.clusterWeights, sw = ws.reduce((a, b) => a + b, 0), sumSq = ws.reduce((a, b) => a + b * b, 0);
      const radius = Math.sqrt(2 * Math.log(2 / 0.05) * sumSq / (sw * sw));
      return [Math.max(-1, Math.min(raw[0]!, estimate - radius)), Math.min(1, Math.max(raw[1]!, estimate + radius))];
    })();
    const bootstrapOnlyMarginal: [number, number] | null = estimate === null || boot[i]!.length === 0
      ? null
      : [quantile([...boot[i]!], 0.025), quantile([...boot[i]!], 0.975)];
    const family: [number, number] | null = estimate === null ? null : (() => {
      const k = reg.contrasts.length;
      const ws = p.clusterWeights, sw = ws.reduce((a, b) => a + b, 0), sumSq = ws.reduce((a, b) => a + b * b, 0);
      const radius = Math.sqrt(2 * Math.log(2 * k / 0.05) * sumSq / (sw * sw));
      const raw = Number.isFinite(familyCritical) ? familyCritical : 2;
      const half = Math.max(raw, radius);
      return [Math.max(-1, estimate - half), Math.min(1, estimate + half)];
    })();
    const bootstrapOnlyFamily: [number, number] | null = estimate === null || !Number.isFinite(familyCritical)
      ? null
      : [Math.max(-1, estimate - familyCritical), Math.min(1, estimate + familyCritical)];
    return { id: reg.contrasts[i]!.id, estimate, marginal95: marginal, familywise95: inferential ? family : null,
      bootstrapOnlyMarginal95: bootstrapOnlyMarginal, bootstrapOnlyFamilywise95: bootstrapOnlyFamily,
      status: inferential ? 'inferential' : n === 0 ? 'inconclusive' : 'descriptive', reasons: [...new Set(reasons)],
      substrates: n, tasks: p.tasks, pairedTasks: p.pairedTasks, launchedBudgetFailures: p.failures,
      operationalMissing: p.missing, bootstrapResamples: resamples };
  });
  return { version: 'cq-fixed-sample-v1', cohortId: reg.cohortId, track: reg.track, role: reg.role, budgetId: reg.budgetId,
    preregistrationFrozen: true, designHash: hash, validation, maxStatisticAdjustment: validated && usable ? 'applied' : 'withheld', contrasts: results };
}

/** Wilson bounds for Monte Carlo proportions. */
export function wilsonBounds(successes: number, n: number, z = 1.959963984540054): [number, number] {
  if (n <= 0) return [0, 1];
  const p = successes / n, z2 = z * z, d = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / d;
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / d;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function wilsonLowerOneSided(successes: number, n: number, z: number): number {
  if (n <= 0) return 0;
  const p = successes / n, z2 = z * z, d = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / d;
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / d;
  return Math.max(0, center - half);
}
