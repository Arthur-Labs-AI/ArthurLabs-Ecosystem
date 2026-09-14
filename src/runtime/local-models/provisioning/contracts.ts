/**
 * HR-02.5D2: provisioning side-effect contracts (infrastructure only).
 *
 * Structured evidence for each primitive. D2 primitives NEVER mutate
 * HR-02.5C lifecycle state (no markInstalled/markConfigured/
 * markValidationPassed calls anywhere in provisioning/) and NEVER touch
 * routers, controllers, or providers. D1 ModelInstallationService owns
 * orchestration and durable state; concrete E installers call these
 * primitives and return evidence to D1.
 */

export type VerificationMode = 'required' | 'optional' | 'provider_verified';

export const VERIFICATION_MODES = ['required', 'optional', 'provider_verified'] as const;

export function isVerificationMode(value: unknown): value is VerificationMode {
  return typeof value === 'string' && (VERIFICATION_MODES as readonly string[]).includes(value);
}

export type DownloadOutcome = 'downloaded' | 'failed' | 'cancelled' | 'auth_required';

export const DOWNLOAD_OUTCOMES = ['downloaded', 'failed', 'cancelled', 'auth_required'] as const;

export function isDownloadOutcome(value: unknown): value is DownloadOutcome {
  return typeof value === 'string' && (DOWNLOAD_OUTCOMES as readonly string[]).includes(value);
}

export interface DownloadedArtifact {
  outcome: DownloadOutcome;
  /** Final staged path (only set when outcome is downloaded). */
  path?: string;
  bytes_written: number;
  reason?: string;
}

export interface VerifiedArtifact {
  path: string;
  sha256_hex: string;
  bytes: number;
}

export interface PythonDiscovery {
  status: 'found' | 'not_found' | 'unsupported_version';
  executable?: string;
  version?: string;
  reason?: string;
}

export interface PythonEnvironment {
  runtime_id: string;
  root: string;
  python_executable: string;
  version: string;
}

export interface PromotionResult {
  outcome: 'promoted' | 'failed';
  live_path: string;
  previous_preserved: boolean;
  reason?: string;
}

export interface CleanupReport {
  removed: string[];
  kept: string[];
  errors: string[];
}

export interface RecoveryScan {
  staging_dirs: string[];
  backup_dirs: string[];
  partial_files: string[];
  needs_attention: boolean;
}

// Auth boundary marker: provisioning detects auth-required conditions
// (401/403, gated models) and maps them to outcomes. Credentials are
// NEVER collected, persisted, logged, or stored in models.json — no
// field anywhere in D2 can carry a token by construction.
export const NO_CREDENTIALS = 'no-credentials-collected' as const;
