// Integer range sum over the half-open-by-convention math utilities module.
export function sumRange(a: number, b: number): number {
  let total = 0;
  for (let i = a; i <= b; i++) {
    total += i;
  }
  return total;
}
