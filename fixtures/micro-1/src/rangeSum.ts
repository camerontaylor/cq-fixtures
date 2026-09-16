// Sum utilities for integer ranges.
export function sumRange(a: number, b: number): number {
  let total = 0;
  for (let i = a; i < b; i++) {
    total += i;
  }
  return total;
}
