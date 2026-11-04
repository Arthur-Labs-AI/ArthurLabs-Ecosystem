/**
 * HR-03B: deterministic routing policy contract.
 *
 * A RoutingPolicy is a small immutable/injectable preference table: per
 * reasoning profile, an ordered list of runtime modes from most to least
 * preferred, plus a ready-over-busy switch. It NEVER filters (filtering
 * is hard and policy-independent); it only orders already-eligible
 * candidates. No config/env loading here - HR-03F owns user-facing
 * profiles. One deterministic built-in default is provided.
 *
 * Omitted-mode semantics: every runtime_preference list MUST contain all
 * three modes exactly once. There is no implicit fallback position for
 * an omitted mode; validation rejects omission rather than guessing.
 */

import { HybridRegistryError } from "./errors";
import { isRuntimeMode, type RuntimeMode } from "../runtime_mode";
import type { ReasoningProfile } from "./routing_contracts";

export interface RuntimePreferenceTable {
  default: RuntimeMode[];
  fast?: RuntimeMode[];
  normal?: RuntimeMode[];
  deep?: RuntimeMode[];
}

export interface RoutingPolicy {
  runtime_preference: RuntimePreferenceTable;
  prefer_ready_over_busy: boolean;
}

const ALL_MODES: readonly RuntimeMode[] = ["cloud", "lan", "local"];

function assertPreferenceList(list: unknown, what: string): RuntimeMode[] {
  if (!Array.isArray(list)) {
    throw new HybridRegistryError("INVALID_ROUTING_REQUEST", what + " must be an array of runtime modes");
  }
  const modes = list as unknown[];
  const seen = new Set<string>();
  for (const mode of modes) {
    if (!isRuntimeMode(mode)) {
      throw new HybridRegistryError("INVALID_ROUTING_REQUEST", what + " contains an unknown runtime mode");
    }
    if (seen.has(mode as string)) {
      throw new HybridRegistryError("INVALID_ROUTING_REQUEST", what + " contains a duplicate runtime mode");
    }
    seen.add(mode as string);
  }
  for (const required of ALL_MODES) {
    if (!seen.has(required)) {
      throw new HybridRegistryError("INVALID_ROUTING_REQUEST", what + " must contain all runtime modes (missing " + required + ")");
    }
  }
  if (modes.length !== ALL_MODES.length) {
    throw new HybridRegistryError("INVALID_ROUTING_REQUEST", what + " must contain exactly all runtime modes");
  }
  return [...seen] as RuntimeMode[];
}

export function normalizeRoutingPolicy(policy: RoutingPolicy): RoutingPolicy {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new HybridRegistryError("INVALID_ROUTING_REQUEST", "routing policy must be an object");
  }
  const raw = policy as unknown as Record<string, unknown>;
  const table = raw["runtime_preference"];
  if (table === null || typeof table !== "object" || Array.isArray(table)) {
    throw new HybridRegistryError("INVALID_ROUTING_REQUEST", "routing policy runtime_preference must be an object");
  }
  const input = table as Record<string, unknown>;
  const out: RoutingPolicy = {
    runtime_preference: {
      default: assertPreferenceList(input["default"], "runtime_preference.default"),
    },
    prefer_ready_over_busy: true,
  };
  for (const profile of ["fast", "normal", "deep"] as const) {
    if (input[profile] !== undefined) {
      out.runtime_preference[profile] = assertPreferenceList(input[profile], "runtime_preference." + profile);
    }
  }
  if (raw["prefer_ready_over_busy"] !== undefined) {
    if (typeof raw["prefer_ready_over_busy"] !== "boolean") {
      throw new HybridRegistryError("INVALID_ROUTING_REQUEST", "prefer_ready_over_busy must be boolean");
    }
    out.prefer_ready_over_busy = raw["prefer_ready_over_busy"] as boolean;
  }
  return out;
}

/**
 * Conservative built-in default: local > lan > cloud for every profile.
 * HR-03B deliberately has no model-quality oracle: deep does NOT imply
 * cloud and cloud is NOT assumed strongest. Only context size, tools,
 * and reasoning-support metadata inform filtering; ranking stays local-first.
 */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  runtime_preference: {
    default: ["local", "lan", "cloud"],
    fast: ["local", "lan", "cloud"],
    normal: ["local", "lan", "cloud"],
    deep: ["local", "lan", "cloud"],
  },
  prefer_ready_over_busy: true,
};

export function preferenceListFor(policy: RoutingPolicy, profile: ReasoningProfile | undefined): readonly RuntimeMode[] {
  const normalized = normalizeRoutingPolicy(policy);
  if (profile !== undefined) {
    const specific = normalized.runtime_preference[profile];
    if (specific !== undefined) return [...specific];
  }
  return [...normalized.runtime_preference.default];
}

export function preferenceRankOf(modes: readonly RuntimeMode[], mode: RuntimeMode): number {
  const at = (modes as readonly string[]).indexOf(mode);
  return at === -1 ? Number.MAX_SAFE_INTEGER : at;
}
