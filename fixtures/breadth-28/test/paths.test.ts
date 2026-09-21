import { describe, expect, it } from 'vitest';
import { neighbors } from '../src/paths.ts';
import { hasSelfLoop } from '../src/cycle.ts';
import { reachable } from '../src/bfs.ts';

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
