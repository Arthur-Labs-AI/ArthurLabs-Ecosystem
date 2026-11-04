import { findOrder } from '../src/db/orders.js';

export function printReceipt(orderId: string): string {
  const order = findOrder(orderId);
  if (order === undefined) throw new Error('unknown order');
  return 'receipt for ' + order.orderId;
}
