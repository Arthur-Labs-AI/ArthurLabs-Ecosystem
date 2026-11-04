import { handleCheckout } from './checkout.js';

export const routes: Record<string, unknown> = {
  'POST /checkout': handleCheckout,
};
