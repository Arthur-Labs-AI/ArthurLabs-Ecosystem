export interface PricedItem {
  readonly sku: string;
  readonly price: number;
}

export function total(items: readonly PricedItem[]): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}
