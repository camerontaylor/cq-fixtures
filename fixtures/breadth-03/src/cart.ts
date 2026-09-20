import { discountRate } from './discount.ts';
import { applyDiscount } from './money.ts';

export function memberPrice(price: number, isMember: boolean): number {
  return applyDiscount(price, discountRate(isMember));
}
