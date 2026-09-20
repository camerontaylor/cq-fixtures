import { describe, expect, it } from 'vitest';
import { Cache } from '../src/cache.ts';
import { memoizedSquare } from '../src/memoize.ts';

describe('memoizedSquare', () => {
  it('reuses the cached value on a repeated argument', () => {
    const cache = new Cache<number>();
    const count = { value: 0 };
    memoizedSquare(cache, count, 4);
    memoizedSquare(cache, count, 4);
    expect(count.value).toBe(1);
  });

  it('computes each distinct argument once', () => {
    const cache = new Cache<number>();
    const count = { value: 0 };
    memoizedSquare(cache, count, 2);
    memoizedSquare(cache, count, 3);
    expect(count.value).toBe(2);
  });
});
