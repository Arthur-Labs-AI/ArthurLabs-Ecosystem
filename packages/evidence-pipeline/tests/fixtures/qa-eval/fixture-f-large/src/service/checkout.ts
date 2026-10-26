import { charge } from '../billing/charge.js';
import { saveOrder } from '../db/orders.js';
import { total } from './pricing.js';

export interface CheckoutInput {
  readonly userId: string;
  readonly role: string;
  readonly items: ReadonlyArray<{ readonly sku: string; readonly price: number }>;
}

export interface CheckoutDeps {
  authorize(role: string): boolean;
  now(): string;
}

/**
 * PLANTED DEFECT (ORDER-OF-OPERATIONS): the card is charged BEFORE
 * authorization is verified. An unauthorized caller is charged and only
 * afterwards rejected, instead of being rejected before any charge.
 * Correct order: authorize -> price -> charge -> persist -> respond.
 */
export async function runCheckout(
  input: CheckoutInput,
  deps: CheckoutDeps,
): Promise<{ orderId: string }> {
  const amount = total(input.items);
  const receipt = await charge(amount);
  if (!deps.authorize(input.role)) throw new Error('forbidden');
  const orderId = 'order_' + deps.now();
  saveOrder({ orderId, chargeId: receipt.chargeId });
  return { orderId };
}
