/**
 * HR-01: runtime routing decision contract + turn-level ownership.
 *
 * The decision records which provider was selected, in which runtime mode,
 * and why (bounded reason code, never prose). HR-01 only ever emits
 * `configured_default`; the remaining codes exist so future phases can add
 * CLOUD/LAN/LOCAL switching without changing this shape. No connectivity
 * probing or automatic failover exists in HR-01.
 *
 * Turn-level ownership (SC-06 semantics, binding on future phases):
 * - A selected model provider owns an entire model round/turn boundary.
 *   Future routing must NEVER split one response across providers
 *   (half DeepSeek -> switch to Qwen -> continue the same response).
 * - Future STT must NEVER concatenate partial transcripts across providers
 *   (partial cloud transcript + partial local transcript).
 * - No provider switching during an active utterance/synthesis.
 * HR-01 performs no failover; the invariant is encoded here and enforced
 * by routers that resolve once per turn/utterance/synthesis.
 */

import type { RuntimeMode } from "./runtime_mode";

export const ROUTING_REASONS = [
  "configured_default",
  "cloud_preferred",
  "cloud_unavailable",
  "lan_preferred",
  "local_fallback",
  "forced_local",
] as const;

export type RoutingReason = (typeof ROUTING_REASONS)[number];

export function isRoutingReason(value: unknown): value is RoutingReason {
  return typeof value === "string" && (ROUTING_REASONS as readonly string[]).includes(value);
}

export interface RoutingDecision {
  provider_id: string;
  runtime_mode: RuntimeMode;
  reason: RoutingReason;
}

export function configuredDefaultDecision(provider_id: string, runtime_mode: RuntimeMode): RoutingDecision {
  return { provider_id, runtime_mode, reason: "configured_default" };
}
