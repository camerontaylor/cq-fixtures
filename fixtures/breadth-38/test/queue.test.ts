import { describe, expect, it } from 'vitest';
import { enqueue, dequeue } from '../src/queue.ts';

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
