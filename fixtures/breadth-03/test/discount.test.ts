import { describe, expect, it } from 'vitest';
import { discountRate } from '../src/discount.ts';

describe('discountRate', () => {
  it('gives members the discounted rate', () => {
    expect(discountRate(true)).toBe(0.1);
  });

  it('charges non-members the full rate', () => {
    expect(discountRate(false)).toBe(0);
  });
});
