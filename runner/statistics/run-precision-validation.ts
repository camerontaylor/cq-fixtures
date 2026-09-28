/** Bounded, seeded offline entry point. Build then run this file from dist.
 * Output uses exclusive create; reruns must choose a fresh path.
 */
import { writeFileSync } from 'node:fs';
import { simulatePrecision, simulatePrecisionStress } from './precision-simulation.js';
import { precisionValidationPasses } from './precision.js';
import { precisionMonteCarloReport } from './precision-monte-carlo.js';

const track = process.argv[2];
const output = process.argv[3];
if ((track !== 'native' && track !== 'diagnostic') || !output) throw new Error('usage: node dist/statistics/run-precision-validation.js native|diagnostic output.json');
const seed = track === 'native' ? 9274101 : 9274102;
const start = Date.now();
const validation = simulatePrecision(track, seed, 2000, n => { if (n % 10 === 0) process.stderr.write(`${track}: ${n} strata complete\n`); });
const stress = simulatePrecisionStress(seed + 90000000);
const simultaneousMonteCarlo = precisionMonteCarloReport(validation);
const boundsCount = simultaneousMonteCarlo.boundsCount;
writeFileSync(output, JSON.stringify({ validation, stress, simultaneousMonteCarlo, boundsCount,
  elapsedSeconds: (Date.now() - start) / 1000,
  validationRechecked: precisionValidationPasses(validation, track),
  failedCore: validation.core.filter(s => !s.passes).map(s => s.point),
}, null, 2) + '\n', { flag: 'wx' });
process.stderr.write(`${track}: finished; all core passed=${validation.allCorePassed}\n`);
