import type { Order } from './types.ts';

export function auditLine(order: Order): string {
  return `${order.id}:${order.paid ? 'paid' : 'unpaid'}`;
}
