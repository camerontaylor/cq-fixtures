export function addCents(a: number, b: number): number {
  return a + b;
}

export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
