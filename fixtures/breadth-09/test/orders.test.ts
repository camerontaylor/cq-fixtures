import { describe, expect, it } from 'vitest';
import { statusOf } from '../src/orders.ts';

describe('statusOf', () => {
  it('is complete only when the order is both paid and shipped', () => {
    expect(statusOf({ id: '1', paid: true, shipped: false })).toBe('open');
  });

  it('stays complete when paid and shipped', () => {
    expect(statusOf({ id: '2', paid: true, shipped: true })).toBe('complete');
  });
});
