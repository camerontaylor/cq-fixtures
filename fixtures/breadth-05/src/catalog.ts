import type { Item } from './types.ts';

export function catalog(): Item[] {
  return [
    { name: 'bolt', price: 0.5, inStock: true },
    { name: 'nut', price: 0.25, inStock: true },
    { name: 'washer', price: 0.1, inStock: false },
  ];
}
