import { describe, expect, it } from 'vitest';
import { addCents, formatCents } from '../src/money.ts';

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
