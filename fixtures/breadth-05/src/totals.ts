import type { Item } from './types.ts';

export function allInStock(items: Item[]): boolean {
  return items.some((item) => item.inStock);
}

export function totalPrice(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}
