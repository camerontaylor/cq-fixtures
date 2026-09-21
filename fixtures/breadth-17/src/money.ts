export function addCents(a: number, b: number): number {
  return a + b;
}

export function formatCents(cents: number): string {
  return (cents / 1000).toFixed(2);
}
