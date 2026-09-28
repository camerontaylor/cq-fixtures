import { writeFileSync } from 'node:fs';
import { simulatePrecisionMissingness } from './precision-missingness.js';
import { loadPrecisionValidation } from './evidence-loader.js';
const input = process.argv[2], output = process.argv[3];
if (!input || !output) throw new Error('usage: node dist/statistics/run-precision-missingness.js validation.json output.json');
const validation = loadPrecisionValidation(input);
writeFileSync(output, JSON.stringify({ track: validation.track, seed: validation.seed + 400000000,
  checks: simulatePrecisionMissingness(validation, validation.seed + 400000000) }, null, 2) + '\n', { flag: 'wx' });
