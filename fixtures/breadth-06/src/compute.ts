// Deliberately expensive so the memoizer's cache is observable via call count.
export function slowSquare(n: number): number {
  return n * n;
}
