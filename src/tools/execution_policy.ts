/**
 * Tool execution policy (SC-03 sections 22-26, 32-34, 45-49, 114-117).
 *
 * Policy is trusted registry metadata, never model/user input. It is part of
 * the tool definition fingerprint: any change to effects, timeouts,
 * idempotency, retry, cancellation, reconciliation or result persistence is a
 * meaningful ToolDefinition change and must follow versioning discipline.
 * User arguments may carry domain data (path/branch/query) but can never
 * override timeout, retry, risk, cancellation, or authorization policy.
 */
export type ToolEffects = "none" | "mutation";
export type ToolIdempotency = "intrinsic" | "operation_key" | "none";
export type ToolCancellation = "unsupported" | "cooperative";
export type ToolReconciliation = "none" | "authoritative";
export type ToolRetryStrategy = "transient" | "off";
export type ToolResultPersistence = "summary_only" | "bounded_json";

export interface ToolRetryPolicy {
  strategy: ToolRetryStrategy;
  max_attempts: number;
  base_delay_ms: number;
  max_delay_ms: number;
}

export interface ToolExecutionPolicy {
  effects: ToolEffects;
  attempt_timeout_ms: number;
  total_timeout_ms: number;
  abort_grace_ms: number;
  cancellation: ToolCancellation;
  idempotency: ToolIdempotency;
  retry: ToolRetryPolicy;
  reconciliation: ToolReconciliation;
  result_persistence: ToolResultPersistence;
}

export const DEFAULT_ATTEMPT_TIMEOUT_MS = 5000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 10000;
export const DEFAULT_ABORT_GRACE_MS = 1000;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 300000;
export const MIN_DELAY_MS = 0;
export const MAX_DELAY_MS = 60000;
export const MAX_ATTEMPTS = 10;

export const DEFAULT_READ_POLICY: ToolExecutionPolicy = {
  effects: "none",
  attempt_timeout_ms: DEFAULT_ATTEMPT_TIMEOUT_MS,
  total_timeout_ms: DEFAULT_TOTAL_TIMEOUT_MS,
  abort_grace_ms: DEFAULT_ABORT_GRACE_MS,
  cancellation: "cooperative",
  idempotency: "intrinsic",
  retry: { strategy: "transient", max_attempts: 3, base_delay_ms: 100, max_delay_ms: 2000 },
  reconciliation: "none",
  result_persistence: "summary_only",
};

export const DEFAULT_MUTATION_POLICY: ToolExecutionPolicy = {
  effects: "mutation",
  attempt_timeout_ms: DEFAULT_ATTEMPT_TIMEOUT_MS,
  total_timeout_ms: DEFAULT_TOTAL_TIMEOUT_MS,
  abort_grace_ms: DEFAULT_ABORT_GRACE_MS,
  cancellation: "cooperative",
  idempotency: "none",
  retry: { strategy: "off", max_attempts: 1, base_delay_ms: 100, max_delay_ms: 2000 },
  reconciliation: "none",
  result_persistence: "summary_only",
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Fail-closed validation of a caller-supplied policy override. */
export function validateExecutionPolicy(policy: unknown): asserts policy is ToolExecutionPolicy {
  if (!isPlainRecord(policy)) throw new Error("Invalid execution policy: must be a plain object");
  const p = policy as Record<string, unknown>;
  if (p.effects !== "none" && p.effects !== "mutation") throw new Error("Invalid execution policy: effects");
  if (!Number.isSafeInteger(p.attempt_timeout_ms) || (p.attempt_timeout_ms as number) < MIN_TIMEOUT_MS || (p.attempt_timeout_ms as number) > MAX_TIMEOUT_MS) {
    throw new Error("Invalid execution policy: attempt_timeout_ms");
  }
  if (!Number.isSafeInteger(p.total_timeout_ms) || (p.total_timeout_ms as number) < MIN_TIMEOUT_MS || (p.total_timeout_ms as number) > MAX_TIMEOUT_MS) {
    throw new Error("Invalid execution policy: total_timeout_ms");
  }
  if ((p.total_timeout_ms as number) < (p.attempt_timeout_ms as number)) {
    throw new Error("Invalid execution policy: total_timeout_ms must cover attempt_timeout_ms");
  }
  if (!Number.isSafeInteger(p.abort_grace_ms) || (p.abort_grace_ms as number) < 0 || (p.abort_grace_ms as number) > MAX_TIMEOUT_MS) {
    throw new Error("Invalid execution policy: abort_grace_ms");
  }
  if (p.cancellation !== "unsupported" && p.cancellation !== "cooperative") throw new Error("Invalid execution policy: cancellation");
  if (p.idempotency !== "intrinsic" && p.idempotency !== "operation_key" && p.idempotency !== "none") throw new Error("Invalid execution policy: idempotency");
  if (p.reconciliation !== "none" && p.reconciliation !== "authoritative") throw new Error("Invalid execution policy: reconciliation");
  if (p.result_persistence !== "summary_only" && p.result_persistence !== "bounded_json") throw new Error("Invalid execution policy: result_persistence");
  if (!isPlainRecord(p.retry)) throw new Error("Invalid execution policy: retry");
  const r = p.retry as Record<string, unknown>;
  if (r.strategy !== "transient" && r.strategy !== "off") throw new Error("Invalid execution policy: retry.strategy");
  if (!Number.isSafeInteger(r.max_attempts) || (r.max_attempts as number) < 1 || (r.max_attempts as number) > MAX_ATTEMPTS) {
    throw new Error("Invalid execution policy: retry.max_attempts");
  }
  if (r.strategy === "off" && (r.max_attempts as number) !== 1) throw new Error("Invalid execution policy: retry off requires max_attempts 1");
  if (!Number.isSafeInteger(r.base_delay_ms) || (r.base_delay_ms as number) < MIN_DELAY_MS || (r.base_delay_ms as number) > MAX_DELAY_MS) {
    throw new Error("Invalid execution policy: retry.base_delay_ms");
  }
  if (!Number.isSafeInteger(r.max_delay_ms) || (r.max_delay_ms as number) < MIN_DELAY_MS || (r.max_delay_ms as number) > MAX_DELAY_MS) {
    throw new Error("Invalid execution policy: retry.max_delay_ms");
  }
  if ((r.max_delay_ms as number) < (r.base_delay_ms as number)) throw new Error("Invalid execution policy: retry.max_delay_ms < base_delay_ms");
}

/** Canonical snapshot fingerprinted into tool_definition_hash (SC-03 section 114). */
export function executionPolicyFingerprintSource(policy: ToolExecutionPolicy): Record<string, unknown> {
  return {
    abort_grace_ms: policy.abort_grace_ms,
    attempt_timeout_ms: policy.attempt_timeout_ms,
    cancellation: policy.cancellation,
    effects: policy.effects,
    idempotency: policy.idempotency,
    reconciliation: policy.reconciliation,
    result_persistence: policy.result_persistence,
    retry: {
      base_delay_ms: policy.retry.base_delay_ms,
      max_attempts: policy.retry.max_attempts,
      max_delay_ms: policy.retry.max_delay_ms,
      strategy: policy.retry.strategy,
    },
    total_timeout_ms: policy.total_timeout_ms,
  };
}

/** Exponential backoff with full jitter (SC-03 section 47). retryNumber is 1-based. */
export function computeRetryDelayMs(policy: ToolExecutionPolicy, retryNumber: number, random01: number): number {
  const base = policy.retry.base_delay_ms;
  const cap = Math.min(policy.retry.max_delay_ms, base * 2 ** retryNumber);
  const r = Number.isFinite(random01) ? Math.min(Math.max(random01, 0), 1) : 1;
  return Math.floor(r * cap);
}

/** Default policy derived from tool risk when registration omits overrides. */
export function defaultPolicyForRisk(risk: string): ToolExecutionPolicy {
  if (risk === "read") return structuredClone(DEFAULT_READ_POLICY);
  return structuredClone(DEFAULT_MUTATION_POLICY);
}
