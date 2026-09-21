import { describe, expect, it } from 'vitest';
import { isValidRetries } from '../src/validate.ts';

describe('isValidRetries', () => {
  it('accepts zero and positive integers', () => {
    expect(isValidRetries(0)).toBe(true);
    expect(isValidRetries(3)).toBe(true);
  });

  it('rejects negative and fractional counts', () => {
    expect(isValidRetries(-1)).toBe(false);
    expect(isValidRetries(1.5)).toBe(false);
  });
});
