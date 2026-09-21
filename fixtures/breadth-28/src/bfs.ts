import type { Adjacency } from './edges.ts';

export function reachable(adj: Adjacency, start: string, target: string): boolean {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node !== target) return true;
    for (const next of adj[node] ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}
