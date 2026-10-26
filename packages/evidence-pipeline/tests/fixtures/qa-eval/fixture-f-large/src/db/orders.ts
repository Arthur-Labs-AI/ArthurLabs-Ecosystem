export interface OrderRecord {
  readonly orderId: string;
  readonly chargeId: string;
}

const orders = new Map<string, OrderRecord>();

export function saveOrder(record: OrderRecord): void {
  orders.set(record.orderId, record);
}

export function findOrder(orderId: string): OrderRecord | undefined {
  return orders.get(orderId);
}
