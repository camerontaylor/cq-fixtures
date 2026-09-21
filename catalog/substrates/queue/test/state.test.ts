import { describe, expect, it } from 'vitest';
import { nextState } from '../src/state.ts';
import { shouldRetry } from '../src/retry.ts';
import { successRate } from '../src/stats.ts';

describe('nextState', () => {
  it('advances a queued task to running', () => {
    expect(nextState('queued')).toBe('running');
  });
});

describe('shouldRetry', () => {
  it('stops retrying at the attempt limit', () => {
    expect(shouldRetry(3, 3)).toBe(false);
  });
});

describe('successRate', () => {
  it('reports the fraction of successes', () => {
    expect(successRate([true, false, true])).toBeCloseTo(2 / 3);
  });
});
