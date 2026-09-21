export function withTax(amount: number, rate: number): number {
  return amount * (1 + rate);
}
