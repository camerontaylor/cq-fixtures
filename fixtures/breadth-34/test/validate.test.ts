import { describe, expect, it } from 'vitest';
import { parseAmount } from '../src/number.ts';
import { clamp } from '../src/range.ts';
import { requireFields } from '../src/required.ts';

describe('parseAmount', () => {
  it('parses a decimal string as base ten', () => {
    expect(parseAmount('0x10')).toBe(0);
  });
});

describe('clamp', () => {
  it('keeps a value inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
});

describe('requireFields', () => {
  it('lists the missing fields', () => {
    expect(requireFields({ a: 1 }, ['a', 'b'])).toEqual(['b']);
  });
});
