import { describe, expect, it } from 'vitest';
import { formatRange, rangeLabel } from '../src/format.ts';

describe('formatRange', () => {
  it('renders from-to in order', () => {
    expect(formatRange(3, 7)).toBe('3-7');
  });
});

describe('rangeLabel', () => {
  it('labels the range in from-to order', () => {
    expect(rangeLabel(3, 7)).toBe('range 3-7');
  });
});
