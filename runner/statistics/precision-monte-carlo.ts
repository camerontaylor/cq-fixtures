import { wilsonBounds } from './inference.js';
import { evidenceContentHash, type PrecisionValidation } from './precision.js';
/** Reporting only: immutable dataset counts, same z=4.5, unchanged gates.
 * Each dataset contributes once to each contrast and once to joint/FWER events.
 */
export function precisionMonteCarloReport(validation: PrecisionValidation) {
  const boundsCount = 4 * validation.core.length + validation.core.filter(s => s.nullDatasets > 0).length;
  // One-sided normal tail at 4.5 <3.4e-6; union bound for 3240 bounds <.012.
  if (boundsCount > 3240) throw new Error('Monte Carlo reporting family exceeds frozen bound count');
  return { validationContentSha256: evidenceContentHash(validation), track: validation.track,
    seed: validation.seed, z: 4.5, boundsCount, gatesChanged: false,
    strata: validation.core.map(s => ({ point: s.point, datasets: s.datasets,
      jointCovered: s.jointCovered, coverageLower: wilsonBounds(s.jointCovered, s.datasets, 4.5)[0],
      perContrast: s.perContrastCovered.map((covered, contrastIndex) => ({ contrastIndex, covered, datasets: s.datasets,
        coverage: covered / s.datasets, simultaneousLower95: wilsonBounds(covered, s.datasets, 4.5)[0] })),
      nullDatasets: s.nullDatasets, anyNullRejected: s.anyNullRejected,
      fwerUpper: s.nullDatasets ? wilsonBounds(s.anyNullRejected, s.nullDatasets, 4.5)[1] : null })) };
}
