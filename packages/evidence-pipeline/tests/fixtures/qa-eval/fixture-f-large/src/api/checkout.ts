import { authorize } from '../auth/policy.js';
import { runCheckout } from '../service/checkout.js';

export interface CheckoutRequest {
  readonly userId: string;
  readonly role: string;
  readonly items: ReadonlyArray<{ readonly sku: string; readonly price: number }>;
}

export async function handleCheckout(request: CheckoutRequest): Promise<{ orderId: string }> {
  return runCheckout(request, { authorize, now: () => new Date().toISOString() });
}
