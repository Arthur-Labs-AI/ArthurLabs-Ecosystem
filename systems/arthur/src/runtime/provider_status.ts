/**
 * HR-01: provider status/readiness contract (representation only).
 *
 * No active health checks or lifecycle supervision in HR-01 (those belong
 * to SC-07). This module defines the shape future supervision will fill.
 *
 * The reason/error category is bounded and machine-readable; raw stack
 * traces, secrets, paths, and commands must never appear in public status.
 */

import type { RuntimeMode } from "./runtime_mode";
import type { RuntimeProviderKind } from "./provider";

export const PROVIDER_STATES = [
  "uninitialized",
  "starting",
  "ready",
  "degraded",
  "unavailable",
  "failed",
  "stopping",
  "stopped",
] as const;

export type ProviderState = (typeof PROVIDER_STATES)[number];

export function isProviderState(value: unknown): value is ProviderState {
  return typeof value === "string" && (PROVIDER_STATES as readonly string[]).includes(value);
}

/** Bounded reason/error category (machine-readable, safe for status). */
export const PROVIDER_STATUS_REASONS = [
  "configured_default",
  "not_configured",
  "engine_unavailable",
  "dependency_down",
  "unknown",
] as const;

export type ProviderStatusReason = (typeof PROVIDER_STATUS_REASONS)[number];

export interface ProviderStatus {
  provider_id: string;
  provider_kind: RuntimeProviderKind;
  runtime_mode: RuntimeMode;
  state: ProviderState;
  reason?: ProviderStatusReason;
}

export function providerStatus(
  provider_id: string,
  provider_kind: RuntimeProviderKind,
  runtime_mode: RuntimeMode,
  state: ProviderState,
  reason?: ProviderStatusReason,
): ProviderStatus {
  return reason === undefined
    ? { provider_id, provider_kind, runtime_mode, state }
    : { provider_id, provider_kind, runtime_mode, state, reason };
}
