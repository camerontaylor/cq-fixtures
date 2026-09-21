import { describe, expect, it } from 'vitest';
import { degree, hasEdge } from '../src/edges.ts';

describe('degree', () => {
  it('counts the neighbours of a node', () => {
    expect(degree({ a: ['b', 'c'] }, 'a')).toBe(2);
  });
});

describe('hasEdge', () => {
  it('finds a directed edge', () => {
    expect(hasEdge({ a: ['b'] }, 'a', 'b')).toBe(true);
  });
});
