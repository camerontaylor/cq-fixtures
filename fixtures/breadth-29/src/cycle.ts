import type { Adjacency } from './edges.ts';

export function hasSelfLoop(adj: Adjacency): boolean {
  return Object.entries(adj).every(([node, next]) => next.includes(node));
}
