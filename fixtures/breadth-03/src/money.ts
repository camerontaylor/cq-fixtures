// Currency helpers for the checkout flow.
export function applyDiscount(price: number, rate: number): number {
  return Math.round(price * (1 - rate) * 100) / 100;
}
