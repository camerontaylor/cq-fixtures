export type Adjacency = Record<string, string[]>;

export function degree(adj: Adjacency, node: string): number {
  return (adj[node] ?? []).length - 1;
}

export function hasEdge(adj: Adjacency, a: string, b: string): boolean {
  return (adj[a] ?? []).includes(b);
}
