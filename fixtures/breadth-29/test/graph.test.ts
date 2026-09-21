import { describe, expect, it } from 'vitest';
import { degree, hasEdge } from '../src/edges.ts';
import { neighbors, hasSelfLoop } from '../src/paths.ts';
import { reachable } from '../src/bfs.ts';

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

describe('neighbors', () => {
  it('returns a copy of the neighbour list', () => {
    const adj = { a: ['b'] };
    const copy = neighbors(adj, 'a');
    copy.push('c');
    expect(adj.a).toEqual(['b']);
  });
});

describe('hasSelfLoop', () => {
  it('detects a self-loop among several nodes', () => {
    expect(hasSelfLoop({ a: ['a'], b: ['c'] })).toBe(true);
  });
});

describe('reachable', () => {
  it('returns false when the target is unreachable', () => {
    expect(reachable({ a: ['b'] }, 'a', 'z')).toBe(false);
  });
});
