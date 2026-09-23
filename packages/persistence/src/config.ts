/** Phase 7 canonical private-beta configuration model (§56).
 *
 *  One place for Sentry-owned settings: data root, default agents,
 *  timeouts, sandbox diagnostics, orphan hygiene, logging posture.
 *  Provider secrets are NEVER part of this model (§57) — they stay in
 *  environment/provider mechanisms, and every dump path redacts them.
 *
 *  Harness-owned turn timeouts (frozen AgentStacks) intentionally live
 *  with their adapters, not here; this model documents the values for
 *  `doctor.config` without touching frozen code.
 */
import { resolveSentryDataRoot } from './data-root.js';
import { ORPHAN_MIN_AGE_MS } from './storage-health.js';

export const SENTRY_DEFAULT_AGENTS = ['opencode', 'deepseek', 'glm'] as const;
export const SENTRY_PRODUCTION_RUN_TIMEOUT_MS = 1_800_000;
export const SENTRY_SIMULATION_RUN_TIMEOUT_MS = 2_000;
export const SENTRY_VERIFICATION_COMMAND_TIMEOUT_MS = 120_000;
export const SENTRY_SANDBOX_BACKEND = 'systemd' as const;
export const SENTRY_SUPPORTED_PLATFORMS = ['linux', 'wsl2'] as const;

export interface SentryConfig {
  readonly dataRoot: string;
  readonly defaultAgents: readonly string[];
  readonly productionRunTimeoutMs: number;
  readonly simulationRunTimeoutMs: number;
  readonly verificationCommandTimeoutMs: number;
  readonly orphanMinAgeMs: number;
  readonly sandboxBackend: string;
  readonly supportedPlatforms: readonly string[];
}

export function resolveSentryConfig(options: { dataRoot?: string } = {}): SentryConfig {
  return {
    dataRoot: options.dataRoot ?? resolveSentryDataRoot(),
    defaultAgents: [...SENTRY_DEFAULT_AGENTS],
    productionRunTimeoutMs: SENTRY_PRODUCTION_RUN_TIMEOUT_MS,
    simulationRunTimeoutMs: SENTRY_SIMULATION_RUN_TIMEOUT_MS,
    verificationCommandTimeoutMs: SENTRY_VERIFICATION_COMMAND_TIMEOUT_MS,
    orphanMinAgeMs: ORPHAN_MIN_AGE_MS,
    sandboxBackend: SENTRY_SANDBOX_BACKEND,
    supportedPlatforms: [...SENTRY_SUPPORTED_PLATFORMS],
  };
}
