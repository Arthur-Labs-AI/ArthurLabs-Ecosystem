/**
 * HR-02.5B: local model inventory/selection contracts.
 *
 * Pure selection metadata. This subsystem describes WHICH local models
 * exist and WHAT they require — never how to download, install, store,
 * authenticate, or execute them. No install/readiness state
 * (installed/configured/ready/downloaded/auth_required) lives here;
 * those belong to HR-02.5C/D. No provider construction or router wiring.
 *
 * Distinction from src/models/: that layer executes LLM/provider calls.
 * This layer is inventory + compatibility + recommendation metadata.
 */

import type { HardwareArch, HardwareOs } from '../hardware/contracts';

export type LocalModelKind = 'stt' | 'tts' | 'model';

export type ModelQualityTier = 'lightweight' | 'balanced' | 'high';

export type SupportMaturity = 'experimental' | 'validated';

export type RecommendationProfile = 'quality' | 'balanced' | 'lightweight';

export type LocalModelAccelerator = 'cuda' | 'rocm' | 'vulkan' | 'directml' | 'cpu';

export type ModelInstallerId = 'python-worker' | 'native-artifact' | 'huggingface-snapshot' | 'bundled' | 'test-fake';

export interface ModelInstallationDescriptor {
  installer_id: ModelInstallerId;
}

export interface ModelRequirements {
  architectures?: HardwareArch[];
  operating_systems?: HardwareOs[];
  min_ram_mb?: number;
  min_vram_mb?: number;
  accelerator?: LocalModelAccelerator;
}

export interface LocalModelDefinition {
  id: string;
  kind: LocalModelKind;
  provider_id: string;
  quality_tier: ModelQualityTier;
  languages: string[];
  requirements: ModelRequirements;
  support: {
    maturity: SupportMaturity;
    validated_platforms?: string[];
  };
  /**
   * Future trusted installer identity (HR-02.5D1+). Absent = installation
   * unavailable: the service resolves to `unsupported` without side
   * effects. Only a bounded installer id may appear here — never package
   * names, URLs, checksums, versions, paths, or commands.
   */
  installation?: ModelInstallationDescriptor;
}

export const LOCAL_MODEL_KINDS = ['stt', 'tts', 'model'] as const;
export const MODEL_QUALITY_TIERS = ['lightweight', 'balanced', 'high'] as const;
export const SUPPORT_MATURITIES = ['experimental', 'validated'] as const;
export const RECOMMENDATION_PROFILES = ['quality', 'balanced', 'lightweight'] as const;
export const LOCAL_MODEL_ACCELERATORS = ['cuda', 'rocm', 'vulkan', 'directml', 'cpu'] as const;

export const MODEL_INSTALLER_IDS = ['python-worker', 'native-artifact', 'huggingface-snapshot', 'bundled', 'test-fake'] as const;

export function isLocalModelKind(value: unknown): value is LocalModelKind {
  return typeof value === 'string' && (LOCAL_MODEL_KINDS as readonly string[]).includes(value);
}

export function isModelQualityTier(value: unknown): value is ModelQualityTier {
  return typeof value === 'string' && (MODEL_QUALITY_TIERS as readonly string[]).includes(value);
}

export function isSupportMaturity(value: unknown): value is SupportMaturity {
  return typeof value === 'string' && (SUPPORT_MATURITIES as readonly string[]).includes(value);
}

export function isRecommendationProfile(value: unknown): value is RecommendationProfile {
  return typeof value === 'string' && (RECOMMENDATION_PROFILES as readonly string[]).includes(value);
}

export function isLocalModelAccelerator(value: unknown): value is LocalModelAccelerator {
  return typeof value === 'string' && (LOCAL_MODEL_ACCELERATORS as readonly string[]).includes(value);
}

export function isModelInstallerId(value: unknown): value is ModelInstallerId {
  return typeof value === 'string' && (MODEL_INSTALLER_IDS as readonly string[]).includes(value);
}
