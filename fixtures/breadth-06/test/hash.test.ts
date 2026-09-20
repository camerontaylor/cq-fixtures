import { describe, expect, it } from 'vitest';
import { keyOf } from '../src/hash.ts';

describe('keyOf', () => {
  it('joins arguments into a stable key', () => {
    expect(keyOf([1, 2, 3])).toBe('1,2,3');
  });
});
