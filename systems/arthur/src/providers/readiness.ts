/**
 * FRS-02: provider-neutral readiness representation (§6).
 *
 * Setup configures; readiness validates. Runtime providers stay
 * provider-neutral: this module owns the ONE status vocabulary reusable by
 * FRS-04 (unified wizard) and FRS-05, while each provider keeps its own
 * explicit check implementation (deepseek.ts / openai_stt.ts /
 * openai_tts.ts under this directory).
 *
 * Status distinguishes at least: not_configured / ready / auth_failed /
 * unavailable / invalid_config / failed. Diagnostics are SAFE: provider
 * id, capability, stable failure category, maybe HTTP status class, and
 * bounded human guidance — never API keys, Authorization headers, raw
 * provider bodies, prompts, request payloads, or arbitrary provider text.
 *
 * Readiness checks are EXPLICIT setup/diagnostic actions. Nothing here runs
 * at startup: normal ARTHUR startup stays deterministic and offline-tolerant.
 */

export const READINESS_STATUSES = [
  'not_configured',
  'ready',
  'auth_failed',
  'unavailable',
  'invalid_config',
  'failed',
] as const;

export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

/** Stable bounded failure categories (never raw provider prose). */
export const READINESS_FAILURE_CATEGORIES = [
  'missing_credential',
  'auth',
  'network',
  'timeout',
  'rejected',
  'bad_response',
  'empty_result',
  'cancelled',
] as const;

export type ReadinessFailureCategory = (typeof READINESS_FAILURE_CATEGORIES)[number];

export interface ReadinessDiagnostic {
  /** Stable machine-readable failure category. */
  category: ReadinessFailureCategory;
  /** HTTP status when already known and safe (number only, no body). */
  httpStatus?: number;
  /** Bounded operator guidance (static text, never provider prose). */
  guidance: string;
}

export interface ProviderReadiness {
  /** Provider id, e.g. "deepseek", "openai-stt", "openai-tts". */
  id: string;
  /** Capability under test, e.g. "reasoning", "cloud_stt", "cloud_tts". */
  capability: string;
  /** True when a credential + required selection are effectively present. */
  configured: boolean;
  /** True only when the explicit check proved the provider callable. */
  ready: boolean;
  status: ReadinessStatus;
  /** Structural capabilities proven by the check (e.g. tools usable). */
  capabilities: string[];
  /** Safe diagnostics (empty when ready). Never secret-bearing. */
  diagnostics: ReadinessDiagnostic[];
}

function guidanceFor(category: ReadinessFailureCategory): string {
  switch (category) {
    case 'missing_credential':
      return 'No credential is configured. Run "arthur providers setup" to add one interactively.';
    case 'auth':
      return 'The provider rejected the credential. Re-enter it via "arthur providers setup".';
    case 'network':
      return 'The provider could not be reached. Check network access and retry.';
    case 'timeout':
      return 'The provider timed out. Retry; the check uses a bounded short request.';
    case 'rejected':
      return 'The provider rejected the validation request. Check the configured model id.';
    case 'bad_response':
      return 'The provider returned an unreadable response. Retry; transient protocol faults are retried.';
    case 'empty_result':
      return 'The provider returned no usable output. Retry the readiness check.';
    case 'cancelled':
      return 'The readiness check was cancelled before completion.';
  }
}

/** Constructor for safe diagnostics (static guidance, bounded shape). */
export function readinessDiagnostic(category: ReadinessFailureCategory, httpStatus?: number): ReadinessDiagnostic {
  const diagnostic: ReadinessDiagnostic = { category, guidance: guidanceFor(category) };
  if (typeof httpStatus === 'number' && Number.isFinite(httpStatus)) {
    diagnostic.httpStatus = Math.trunc(httpStatus);
  }
  return diagnostic;
}

/** not_configured result: no network call was made. */
export function notConfigured(id: string, capability: string): ProviderReadiness {
  return {
    id,
    capability,
    configured: false,
    ready: false,
    status: 'not_configured',
    capabilities: [],
    diagnostics: [readinessDiagnostic('missing_credential')],
  };
}

/** ready result: the explicit check proved the provider callable. */
export function readyResult(id: string, capability: string, capabilities: string[] = []): ProviderReadiness {
  return { id, capability, configured: true, ready: true, status: 'ready', capabilities: [...capabilities], diagnostics: [] };
}

/** Failure result with exactly one safe diagnostic. */
export function failedResult(
  id: string,
  capability: string,
  status: ReadinessStatus,
  category: ReadinessFailureCategory,
  httpStatus?: number,
): ProviderReadiness {
  return {
    id,
    capability,
    configured: true,
    ready: false,
    status,
    capabilities: [],
    diagnostics: [readinessDiagnostic(category, httpStatus)],
  };
}

/**
 * Assert a readiness value is secret-safe: JSON-serializes without the
 * given secrets appearing anywhere. Used by tests; structural by design
 * (values are never interpolated into readiness in the first place).
 */
export function readinessContainsSecret(readiness: ProviderReadiness, secrets: readonly string[]): boolean {
  const text = JSON.stringify(readiness);
  return secrets.some((secret) => typeof secret === 'string' && secret !== '' && text.includes(secret));
}
