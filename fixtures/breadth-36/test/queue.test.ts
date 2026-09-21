import { describe, expect, it } from 'vitest';
import { enqueue, dequeue } from '../src/queue.ts';
import { shouldRetry, nextState } from '../src/retry.ts';
import { successRate } from '../src/stats.ts';

describe('enqueue', () => {
  it('appends a value to the queue', () => {
    expect(enqueue([1, 2], 3)).toEqual([1, 2, 3]);
  });
});

describe('dequeue', () => {
  it('returns the first value', () => {
    expect(dequeue([1, 2, 3])).toBe(1);
  });
});

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
