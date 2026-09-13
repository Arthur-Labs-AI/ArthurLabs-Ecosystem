/**
 * HR-02.5B: local model inventory/selection subsystem (public entry point).
 *
 * HardwareProfile (HR-02.5A) -> Catalog -> Compatibility -> Recommendation.
 * Pure selection logic: no downloading, installation, provisioning,
 * persistence, provider construction, or router wiring.
 */

export {
  LOCAL_MODEL_ACCELERATORS,
  LOCAL_MODEL_KINDS,
  MODEL_QUALITY_TIERS,
  RECOMMENDATION_PROFILES,
  SUPPORT_MATURITIES,
  isLocalModelAccelerator,
  isLocalModelKind,
  isModelQualityTier,
  isRecommendationProfile,
  isSupportMaturity,
  type LocalModelAccelerator,
  type LocalModelDefinition,
  type LocalModelKind,
  type ModelQualityTier,
  type ModelRequirements,
  type RecommendationProfile,
  type SupportMaturity,
} from './contracts';
export {
  LOCAL_MODEL_IDS,
  findLocalModel,
  getLocalModelCatalog,
  validateCatalog,
  type LocalModelId,
} from './catalog';
export {
  evaluateCompatibility,
  filterCompatible,
  type CompatibilityCheck,
  type CompatibilityReason,
  type CompatibilityResult,
} from './compatibility';
export {
  recommendModel,
  type ModelRecommendation,
  type RecommendArgs,
  type RecommendationCandidate,
} from './recommendation';
