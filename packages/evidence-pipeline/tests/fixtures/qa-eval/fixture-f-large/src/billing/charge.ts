export interface ChargeResult {
  readonly chargeId: string;
}

/** Observable side effect for deterministic evaluation: every charge attempt is logged. */
export const chargeLog: Array<{ readonly amount: number }> = [];

export function resetChargeLog(): void {
  chargeLog.length = 0;
}

export async function charge(amount: number): Promise<ChargeResult> {
  if (amount <= 0) throw new Error('invalid amount');
  chargeLog.push({ amount });
  return { chargeId: 'ch_' + String(amount) };
}
