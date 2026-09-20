import { Cache } from './cache.ts';
import { slowSquare } from './compute.ts';
import { keyOf } from './hash.ts';

export function memoizedSquare(cache: Cache<number>, computeCount: { value: number }, n: number): number {
  const key = keyOf([n]);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = slowSquare(n);
  computeCount.value += 1;
  return value;
}
