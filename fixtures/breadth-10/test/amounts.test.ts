import { describe, expect, it } from 'vitest';
import { isPositive } from '../src/amounts.ts';

describe('isPositive', () => {
  it('accepts a positive amount', () => {
    expect(isPositive(1)).toBe(true);
  });

  it('rejects zero and negatives', () => {
    expect(isPositive(0)).toBe(false);
    expect(isPositive(-2)).toBe(false);
  });
});
