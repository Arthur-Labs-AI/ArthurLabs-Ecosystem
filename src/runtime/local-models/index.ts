/**
 * HR-02.5B/C: local model inventory/selection subsystem (public entry point).
 *
 * HardwareProfile (HR-02.5A) -> Catalog -> Compatibility -> Recommendation
 * -> Persistent State + Selection Resolver (HR-02.5C). Pure selection
 * logic plus durable lifecycle/selection state: no downloading,
 * installation, provisioning, provider construction, or router wiring.
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
export {
  DEFAULT_LOCAL_MODEL_STATE_PATH,
  LOCAL_MODEL_STATE_VERSION,
  SELECTION_MODES,
  SELECTION_SOURCES,
  VALIDATION_STATUSES,
  defaultSelections,
  defaultStateFile,
  isSelectionMode,
  isSelectionSource,
  isValidationStatus,
  parseStateFile,
  serializeStateFile,
  type InstalledModelState,
  type LocalModelStateFile,
  type ModelKindSelection,
  type ModelValidationRecord,
  type SelectionMode,
  type SelectionSource,
  type ValidationStatus,
} from './state_contracts';
export {
  LocalModelStateStore,
  memoryStateFileSystem,
  nodeStateFileSystem,
  type StateFileSystem,
  type StateStoreOptions,
} from './state_store';
export {
  LOCAL_MODEL_ENV_VARS,
  resolveEffectiveSelection,
  resolveRunnableSelection,
  type EffectiveModelSelection,
  type ResolveSelectionArgs,
  type RunnableModelSelection,
} from './selection';
