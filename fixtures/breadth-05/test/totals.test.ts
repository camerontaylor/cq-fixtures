import { describe, expect, it } from 'vitest';
import { catalog } from '../src/catalog.ts';
import { allInStock, totalPrice } from '../src/totals.ts';

describe('allInStock', () => {
  it('is false when any item is out of stock', () => {
    expect(allInStock(catalog())).toBe(false);
  });

  it('is true when every item is in stock', () => {
    expect(allInStock([{ name: 'bolt', price: 0.5, inStock: true }])).toBe(true);
  });
});

describe('totalPrice', () => {
  it('sums the item prices', () => {
    expect(totalPrice(catalog())).toBeCloseTo(0.85);
  });
});
