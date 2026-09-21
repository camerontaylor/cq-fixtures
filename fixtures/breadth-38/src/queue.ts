export function enqueue<T>(items: T[], value: T): T[] {
  return [...items, value];
}

export function dequeue<T>(items: T[]): T | undefined {
  return items[0];
}
