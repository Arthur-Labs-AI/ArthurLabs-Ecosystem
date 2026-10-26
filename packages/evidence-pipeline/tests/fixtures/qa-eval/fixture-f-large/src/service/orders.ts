export function total(items: Array<{ price: number }>): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}
