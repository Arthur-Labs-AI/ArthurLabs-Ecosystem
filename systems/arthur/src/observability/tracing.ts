/**
 * Tracing helpers (spec section 17).
 *
 * A `trace_id` is generated per user turn and propagated through model and
 * tool calls. Phase 1 uses cryptographically random UUIDs only; no distributed
 * tracing backend is wired up yet.
 */

import { randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

export function newTraceId(): string {
  return newId();
}

export function newSessionId(): string {
  return newId();
}

export function newTurnId(): string {
  return newId();
}
