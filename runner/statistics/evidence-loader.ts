import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { precisionForecastPasses, precisionRecipeHash, precisionValidationPasses, type PrecisionForecastEvidence, type PrecisionValidation } from './precision.js';
const archiveSha = {
  validation: { native: '0f9f39761f978e4f6e047a8f0c038a3be8d88deb7ca93f3b9dbb72a7b16ecc9b', diagnostic: '2b875fb27177f6760e8f01ecdc746b3635de344417e8c35682d56bea5e59bd6d' },
  forecast: { native: '5cf7d8f3d94082bc4a9a6358681c8068b28e4411a889aae8a52433f44b806d2d', diagnostic: 'ed423d8c5330935dff1b4eb2016a6f1bb2013f0574410f9c0b18a7182970ede7' },
} as const;
function pinnedArchive(path: string | URL, kind: keyof typeof archiveSha): unknown {
  const bytes = readFileSync(path), digest = createHash('sha256').update(bytes).digest('hex');
  if (!Object.values(archiveSha[kind]).some(pin => pin === digest)) throw new Error(`unpinned ${kind} archive content`);
  return JSON.parse(bytes.toString('utf8')) as unknown;
}
export function loadPrecisionValidation(path: string | URL): PrecisionValidation {
  const v = (pinnedArchive(path, 'validation') as { validation: PrecisionValidation }).validation;
  if (!precisionValidationPasses(v, v.track)) throw new Error('failed or unpinned base validation');
  return v;
}
/** Historical forecast lacks recipeHash. Only an exact frozen archive may be
 * enriched; arbitrary caller input can never inherit this provenance. */
export function loadPrecisionForecast(path: string | URL): PrecisionForecastEvidence {
  const v = { ...(pinnedArchive(path, 'forecast') as PrecisionForecastEvidence), recipeHash: precisionRecipeHash };
  if (!precisionForecastPasses(v, v.track)) throw new Error('failed or unpinned forecast validation');
  return v;
}
