import { describe, expect, it } from 'vitest';
import { isEmail } from '../src/email.ts';

describe('isEmail', () => {
  it('rejects an address without a dotted domain', () => {
    expect(isEmail('a@b')).toBe(false);
  });
});
