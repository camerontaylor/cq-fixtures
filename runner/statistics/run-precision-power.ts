import { writeFileSync } from 'node:fs';
import { simulatePrecisionPower } from './precision-power.js';
import { loadPrecisionValidation } from './evidence-loader.js';
const input = process.argv[2], output = process.argv[3];
if (!input || !output) throw new Error('usage: node dist/statistics/run-precision-power.js validation.json output.json');
const validation = loadPrecisionValidation(input);
const result = simulatePrecisionPower(validation, validation.seed + 300000000, n => process.stderr.write(`${validation.track}: power cell ${n}/72\n`));
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
