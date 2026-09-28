/** Bounded, seeded offline entry point. Build then run this file from dist.
 * Output uses exclusive create; reruns must choose a fresh path.
 */
import { writeFileSync } from 'node:fs';
import { simulatePrecision, simulatePrecisionStress } from './precision-simulation.js';
import { precisionValidationPasses } from './precision.js';
import { wilsonBounds } from './inference.js';

const track = process.argv[2];
const output = process.argv[3];
if ((track !== 'native' && track !== 'diagnostic') || !output) throw new Error('usage: node dist/statistics/run-precision-validation.js native|diagnostic output.json');
const seed = track === 'native' ? 9274101 : 9274102;
const start = Date.now();
const validation = simulatePrecision(track, seed, 2000, n => { if (n % 10 === 0) process.stderr.write(`${track}: ${n} strata complete\n`); });
const stress = simulatePrecisionStress(seed + 90000000);
// Bonferroni simultaneous Monte Carlo intervals across every coverage and null
// error stratum. Each uses datasets, never contrast-pooled Bernoulli counts.
const boundsCount = validation.core.length + validation.core.filter(s => s.nullDatasets > 0).length;
// Conservative normal quantile 4.5: one-sided tail < 3.4e-6, so even 1080
// bounds have total tail <.0025 (<.05); avoid a new numerical dependency.
const simultaneousMonteCarlo = validation.core.map(s => ({ point: s.point,
  coverageLower: wilsonBounds(s.jointCovered, s.datasets, 4.5)[0],
  fwerUpper: s.nullDatasets ? wilsonBounds(s.anyNullRejected, s.nullDatasets, 4.5)[1] : null }));
writeFileSync(output, JSON.stringify({ validation, stress, simultaneousMonteCarlo, boundsCount,
  elapsedSeconds: (Date.now() - start) / 1000,
  validationRechecked: precisionValidationPasses(validation, track),
  failedCore: validation.core.filter(s => !s.passes).map(s => s.point),
}, null, 2) + '\n', { flag: 'wx' });
process.stderr.write(`${track}: finished; all core passed=${validation.allCorePassed}\n`);
