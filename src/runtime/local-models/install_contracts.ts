/**
 * HR-02.5D1: trusted model installation lifecycle contracts.
 *
 * The service owns orchestration; concrete installers (D2+) own
 * model-specific side effects. Installers NEVER mutate persistent state
 * directly — they return structured evidence (ModelInstallArtifact) and
 * the service translates it into HR-02.5C store transitions.
 *
 * Trust boundary: the catalog carries at most a bounded installer id.
 * No commands, URLs, package names, checksums, or paths ever flow from
 * model metadata, LLM output, user prompts, persisted state, or remote
 * manifests into execution. Only in-process trusted code registered
 * under a known ModelInstallerId may act.
 *
 * Transient InstallationPhase (this operation) is distinct from persisted
 * installed/configured/ready (durable machine state, HR-02.5C).
 */

import type { HardwareProfile } from '../hardware/contracts';
import type { LocalModelDefinition, ModelInstallerId } from './contracts';

export type InstallationPhase =
  | 'preflight'
  | 'preparing'
  | 'installing'
  | 'configuring'
  | 'validating'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type InstallationOutcome =
  | 'completed'
  | 'already_ready'
  | 'already_in_progress'
  | 'failed'
  | 'cancelled'
  | 'auth_required'
  | 'incompatible'
  | 'unsupported';

export const INSTALLATION_PHASES = [
  'preflight',
  'preparing',
  'installing',
  'configuring',
  'validating',
  'completed',
  'failed',
  'cancelled',
] as const;

export const INSTALLATION_OUTCOMES = [
  'completed',
  'already_ready',
  'already_in_progress',
  'failed',
  'cancelled',
  'auth_required',
  'incompatible',
  'unsupported',
] as const;

export function isInstallationPhase(value: unknown): value is InstallationPhase {
  return typeof value === 'string' && (INSTALLATION_PHASES as readonly string[]).includes(value);
}

export function isInstallationOutcome(value: unknown): value is InstallationOutcome {
  return typeof value === 'string' && (INSTALLATION_OUTCOMES as readonly string[]).includes(value);
}

export interface InstallationProgressEvent {
  model_id: string;
  phase: InstallationPhase;
  message: string;
}

export type InstallationProgressCallback = (event: InstallationProgressEvent) => void;

export interface InstallationResult {
  model_id: string;
  outcome: InstallationOutcome;
  phase: InstallationPhase;
  reason: string;
}

// Minimal data a concrete installer may receive. No registries,
// providers, permissions, or settings cross this boundary.
export interface ModelInstallContext {
  model: LocalModelDefinition;
  hardware: HardwareProfile;
  managed_root: string;
  signal?: AbortSignal;
  reportProgress: InstallationProgressCallback;
}

// Structured evidence returned by a concrete installer. `installed` marks
// durable installation success; `configured` marks configuration success;
// `validation` carries the installer's own post-install verification
// evidence, which the service persists verbatim. Optional paths are
// opaque installer-chosen values recorded verbatim (never executed).
export interface ModelInstallArtifact {
  installed: boolean;
  configured: boolean;
  validation?: {
    status: 'passed' | 'failed';
    reason?: string;
  };
  install_path?: string;
  runtime_id?: string;
  detail?: string;
}

// Faithful lifecycle outcome of the installer's own work, before the
// service maps it onto persisted state + InstallationResult.
export type InstallerOutcome = 'succeeded' | 'failed' | 'cancelled' | 'auth_required';

export interface InstallerResult {
  outcome: InstallerOutcome;
  artifact?: ModelInstallArtifact;
  reason?: string;
}

export interface ModelInstaller {
  readonly id: ModelInstallerId;
  install(context: ModelInstallContext): Promise<InstallerResult>;
}

export interface InstallRequest {
  model_id: string;
  hardware: HardwareProfile;
  managed_root?: string;
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: InstallationProgressCallback;
}

// NOTE (HR-02.5D1 scope): no UninstallRequest exists here. Actual uninstall
// (artifact/runtime cleanup alongside state) belongs to D2.
