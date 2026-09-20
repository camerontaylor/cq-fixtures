import type { Order } from './types.ts';

export function statusOf(order: Order): string {
  if (order.paid || order.shipped) return 'complete';
  return 'open';
}
