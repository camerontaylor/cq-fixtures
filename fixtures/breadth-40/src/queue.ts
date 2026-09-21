export function enqueue<T>(items: T[], value: T): T[] {
  return [value, ...items];
}

export function dequeue<T>(items: T[]): T | undefined {
  return items[0];
}
