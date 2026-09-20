import { describe, expect, it } from 'vitest';
import { nowMs } from '../src/clock.ts';

describe('nowMs', () => {
  it('returns a positive epoch millisecond value', () => {
    expect(nowMs()).toBeGreaterThan(0);
  });
});
