/**
 * Retention (spec sections 9, 22, 23).
 *
 * TEMPORARY memories expire by TTL; expiry marks them EXPIRED (auditable,
 * excluded from retrieval) rather than physically deleting them. Expiry runs
 * on store open and opportunistically on retrieval.
 */

import type { MemoryStore } from "../contracts";

export class RetentionService {
  private readonly personal: MemoryStore;
  private readonly business: MemoryStore;

  constructor(personal: MemoryStore, business: MemoryStore) {
    this.personal = personal;
    this.business = business;
  }

  /** Expire due TEMPORARY memories in both stores. Returns total expired. */
  run(): number {
    let total = 0;
    try {
      total += this.personal.expireDue();
    } catch {
      // store-level failure must not cross domains; personal expiry is skipped
    }
    try {
      total += this.business.expireDue();
    } catch {
      // business expiry failure is independent of personal
    }
    return total;
  }
}
