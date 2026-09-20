import { describe, expect, it } from 'vitest';
import { BACKOFF_FACTOR, backoffDelay } from '../src/backoff.ts';
import { retryPlan } from '../src/retry.ts';

describe('backoffDelay', () => {
  it('doubles the delay each attempt', () => {
    expect(backoffDelay(100, 3)).toBe(800);
  });

  it('uses the base delay on the first attempt', () => {
    expect(backoffDelay(100, 0)).toBe(100);
  });

  it('exposes a factor of two', () => {
    expect(BACKOFF_FACTOR).toBe(2);
  });
});

describe('retryPlan', () => {
  it('starts every retry plan with the base delay', () => {
    expect(retryPlan(100, 3)[0]).toBe(100);
  });
});
