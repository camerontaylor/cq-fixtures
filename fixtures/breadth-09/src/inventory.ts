import type { Product } from './types.ts';

const stock: Product[] = [
  { sku: 'a', qty: 3 },
  { sku: 'b', qty: 5 },
];

export function snapshot(): Product[] {
  return stock;
}
