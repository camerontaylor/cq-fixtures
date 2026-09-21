import { describe, expect, it } from 'vitest';
import { addCents, formatCents } from '../src/money.ts';
import { applyPercent, withTax } from '../src/discount.ts';
import { isOverdrawn } from '../src/balance.ts';

describe('addCents', () => {
  it('adds two cent amounts', () => {
    expect(addCents(250, 125)).toBe(375);
  });
});

describe('formatCents', () => {
  it('formats cents as a two-decimal amount', () => {
    expect(formatCents(1234)).toBe('12.34');
  });
});

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
