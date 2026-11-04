/**
 * SC-04 storage capability helpers (spec section 11).
 *
 * system.storage reports ONLY the scopes ARTHUR may already use:
 * per-root total/free bytes via statfs-style probing. No physical
 * mount path ever reaches the model (root_id only).
 */

import { statfsSync } from "node:fs";

export interface RootStorageInfo {
  root_id: string;
  total_bytes: number;
  free_bytes: number;
}

/** Probe total/free bytes for one absolute path (best effort). */
export function probeStorage(absoluteRoot: string): { total_bytes: number; free_bytes: number } {
  try {
    const st = statfsSync(absoluteRoot);
    const block = typeof st.bsize === "number" && st.bsize > 0 ? st.bsize : 4096;
    const total = Math.max(0, Math.floor(Number(st.blocks) * block));
    const free = Math.max(0, Math.floor(Number(st.bfree) * block));
    if (Number.isSafeInteger(total) && Number.isSafeInteger(free)) {
      return { total_bytes: total, free_bytes: Math.min(free, total) };
    }
  } catch {
    // fall through to the bounded fallback below
  }
  return { total_bytes: 0, free_bytes: 0 };
}
