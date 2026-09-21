import { describe, expect, it } from 'vitest';
import { applyPercent } from '../src/discount.ts';
import { withTax } from '../src/tax.ts';
import { isOverdrawn } from '../src/balance.ts';

describe('applyPercent', () => {
  it('subtracts the percentage from the amount', () => {
    expect(applyPercent(100, 20)).toBe(80);
  });
});

describe('withTax', () => {
  it('applies the rate on top of the amount', () => {
    expect(withTax(100, 0.2)).toBe(120);
  });
});

describe('isOverdrawn', () => {
  it('treats a zero balance as not overdrawn', () => {
    expect(isOverdrawn(0)).toBe(false);
  });
});
