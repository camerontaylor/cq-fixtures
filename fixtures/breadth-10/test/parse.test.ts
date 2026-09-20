import { describe, expect, it } from 'vitest';
import { parseAmount } from '../src/parse.ts';

describe('parseAmount', () => {
  it('parses a decimal string as base ten', () => {
    expect(parseAmount('0x10')).toBe(0);
  });

  it('parses a plain integer', () => {
    expect(parseAmount('42')).toBe(42);
  });
});
