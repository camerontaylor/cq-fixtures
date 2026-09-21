import type { Adjacency } from './edges.ts';

export function neighbors(adj: Adjacency, node: string): string[] {
  return (adj[node] ?? []);
}

export function hasSelfLoop(adj: Adjacency): boolean {
  return Object.entries(adj).some(([node, next]) => next.includes(node));
}
