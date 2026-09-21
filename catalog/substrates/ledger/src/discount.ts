export function applyPercent(amount: number, percent: number): number {
  return amount - (amount * percent) / 100;
}

export function withTax(amount: number, rate: number): number {
  return amount * (1 + rate);
}
