import type { Adjacency } from './edges.ts';

export function neighbors(adj: Adjacency, node: string): string[] {
  return [...(adj[node] ?? [])];
}
