import { describe, expect, it } from 'vitest';
import { sumRange } from '../src/rangeSum.ts';

// Behavioral spec for sumRange: the sum is INCLUSIVE of both bounds.
describe('sumRange', () => {
  it('sums every integer from a through b, inclusive of both bounds', () => {
    expect(sumRange(1, 5)).toBe(15);
  });

  it('a single-element range sums to that element', () => {
    expect(sumRange(3, 3)).toBe(3);
  });

  it('a range spanning negative numbers stays inclusive', () => {
    expect(sumRange(-2, 2)).toBe(0);
  });
});
