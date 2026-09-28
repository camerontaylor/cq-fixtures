/** Deterministic planning approximation for a five-point paired contrast.
 * This is not a quota forecast and is not evidence of achieved campaign power.
 */

export interface PowerScenarioForecast {
  baselineSuccess: number;
  targetDiscordance: number;
  feasibleDiscordance: number;
  pairedDifferenceIcc: number;
  tasksPerSubstrate: number;
  repeatsPerTask: number;
  clusterDifferenceVariance: number;
  substrateCountFor80PercentPower: number;
  substrateCountForFivePointHalfWidth: number;
  requiredSubstrates: number;
  requiredTasks: number;
  approximatePowerAtRequiredSubstrates: number;
}

export interface FivePointForecast {
  role: string;
  track: 'native' | 'diagnostic';
  targetDifference: 0.05;
  simultaneousContrasts: number;
  confidence: 0.95;
  targetPower: 0.8;
  targetHalfWidth: 0.05;
  method: 'normal-approximation-power-plus-weighted-Hoeffding-precision';
  scenarios: PowerScenarioForecast[];
  minRequiredSubstrates: number;
  medianRequiredSubstrates: number;
  maxRequiredSubstrates: number;
  medianApproximatePower: number;
  quotaOrRuntimeEstimate: null;
}

const DELTA = 0.05;
const POWER_Z_80 = 0.8416212335729143;
const FAMILY_ALPHA = 0.05;

function normalCdf(x: number): number {
  // Abramowitz–Stegun 7.1.26; error < 1.5e-7.
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

/**
 * Forecast the cluster count needed for a +5pp paired difference to have an
 * approximate 80% chance of clearing the simultaneous 95% lower Hoeffding
 * bound, while also attaining a five-point interval half-width. Task-repeat
 * discordance gives the paired Bernoulli variance; an explicit paired-
 * difference ICC supplies a cluster design effect. Unequal final weights or
 * missingness can only increase these requirements.
 */
export function forecastFivePointDesign(role: string, track: 'native' | 'diagnostic' = 'native', simultaneousContrasts = 3): FivePointForecast {
  if (!role.trim()) throw new Error('forecast role is required');
  if (track !== 'native' && track !== 'diagnostic') throw new Error('forecast track must be native or diagnostic');
  if (!Number.isInteger(simultaneousContrasts) || simultaneousContrasts < 1) throw new Error('simultaneousContrasts must be a positive integer');
  const familyRadiusConstant = Math.sqrt(2 * Math.log(2 * simultaneousContrasts / FAMILY_ALPHA));
  const precisionN = Math.ceil((familyRadiusConstant / DELTA) ** 2);
  const scenarios: PowerScenarioForecast[] = [];
  for (const baselineSuccess of [0.2, 0.5, 0.8]) {
    const contenderSuccess = baselineSuccess + DELTA;
    const maxDiscordance = Math.min(baselineSuccess + contenderSuccess, 2 - baselineSuccess - contenderSuccess);
    for (const targetDiscordance of [0.08, 0.25, 0.45]) {
      const feasibleDiscordance = Math.max(DELTA, Math.min(targetDiscordance, maxDiscordance));
      const oneRepeatVariance = feasibleDiscordance - DELTA * DELTA;
      for (const pairedDifferenceIcc of [0, 0.3, 0.6]) {
        for (const tasksPerSubstrate of [1, 2, 4]) {
          for (const repeatsPerTask of [1, 3]) {
            const designEffect = 1 + (tasksPerSubstrate - 1) * pairedDifferenceIcc;
            const clusterDifferenceVariance = oneRepeatVariance / (tasksPerSubstrate * repeatsPerTask) * designEffect;
            const powerN = Math.ceil(((familyRadiusConstant + POWER_Z_80 * Math.sqrt(clusterDifferenceVariance)) / DELTA) ** 2);
            const requiredSubstrates = Math.max(20, precisionN, powerN);
            const standardized = (DELTA * Math.sqrt(requiredSubstrates) - familyRadiusConstant) / Math.sqrt(clusterDifferenceVariance || Number.EPSILON);
            scenarios.push({ baselineSuccess, targetDiscordance, feasibleDiscordance, pairedDifferenceIcc, tasksPerSubstrate, repeatsPerTask,
              clusterDifferenceVariance, substrateCountFor80PercentPower: Math.max(20, powerN), substrateCountForFivePointHalfWidth: Math.max(20, precisionN),
              requiredSubstrates, requiredTasks: requiredSubstrates * tasksPerSubstrate,
              approximatePowerAtRequiredSubstrates: normalCdf(standardized) });
          }
        }
      }
    }
  }
  const ordered = scenarios.map(s => s.requiredSubstrates).sort((a, b) => a - b);
  const power = scenarios.map(s => s.approximatePowerAtRequiredSubstrates).sort((a, b) => a - b);
  return { role, track, targetDifference: DELTA, simultaneousContrasts, confidence: .95, targetPower: .8, targetHalfWidth: .05,
    method: 'normal-approximation-power-plus-weighted-Hoeffding-precision', scenarios,
    minRequiredSubstrates: ordered[0]!, medianRequiredSubstrates: ordered[Math.floor(ordered.length / 2)]!, maxRequiredSubstrates: ordered.at(-1)!,
    medianApproximatePower: power[Math.floor(power.length / 2)]!, quotaOrRuntimeEstimate: null };
}
