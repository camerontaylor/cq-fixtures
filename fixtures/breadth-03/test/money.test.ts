import { describe, expect, it } from 'vitest';
import { applyDiscount } from '../src/money.ts';

describe('applyDiscount', () => {
  it('rounds to cents', () => {
    expect(applyDiscount(19.99, 0.1)).toBe(17.99);
  });
});
