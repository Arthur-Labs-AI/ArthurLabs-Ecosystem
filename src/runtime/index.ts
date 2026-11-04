/**
 * HR-01 ARTHUR Hybrid Runtime foundation (architectural contracts only).
 *
 * Logical structure:
 *
 *                      ARTHUR Runtime
 *                            |
 *           +----------------+----------------+
 *           |                |                |
 *        STT Router       Model Router      TTS Router
 *           |                |                |
 *           v                v                v
 *      SttProvider      ModelProvider      TtsProvider
 *
 * Phase 1 routers resolve only to the existing configured providers, so
 * behavior is functionally identical to pre-HR-01. Future phases add
 * CLOUD/LAN/LOCAL switching, health supervision (SC-07), and new provider
 * backends (OpenAI/NVIDIA/Qwen/GPT-Live/Parakeet) behind these same seams.
 *
 * Explicitly out of scope in HR-01: provider integrations, connectivity or
 * internet detection, automatic failover, discovery/RPC/WebSockets, remote
 * tool proxies, model downloading, GPU detection, resource scheduling.
 */

export { RUNTIME_MODES, isRuntimeMode, parseRuntimeMode, type RuntimeMode } from "./runtime_mode";
export {
  RUNTIME_CAPABILITIES,
  isRuntimeCapability,
  type RuntimeCapability,
  type RuntimeCapabilitySet,
  type RuntimeProviderIdentity,
  type RuntimeProviderKind,
} from "./provider";
export {
  PROVIDER_STATES,
  PROVIDER_STATUS_REASONS,
  isProviderState,
  providerStatus,
  type ProviderState,
  type ProviderStatus,
  type ProviderStatusReason,
} from "./provider_status";
export {
  ROUTING_REASONS,
  configuredDefaultDecision,
  isRoutingReason,
  type RoutingDecision,
  type RoutingReason,
} from "./routing";
export { ModelRouter, type ModelRouterDeps } from "./model_router";
export { SttRouter, type SttResult, type SttRouterDeps } from "./stt_router";
export { TtsRouter, type TtsRouterDeps } from "./tts_router";
export {
  VOICE_FAILURE_CATEGORIES,
  VoiceProviderError,
  categorizeVoiceError,
  isFallbackSafe,
  isVoiceFailureCategory,
  type VoiceFailureCategory,
  type VoiceProviderFailure,
} from "./voice_errors";
export {
  HR02_DEFAULTS,
  type SttPolicy,
  type TtsPolicy,
  isSttPolicy,
  isTtsPolicy,
} from "./voice_policy";
export type {
  CapabilityState,
  GpuVendor,
  HardwareAccelerators,
  HardwareArch,
  HardwareGpu,
  HardwareOs,
  HardwareProbe,
  HardwareProfile,
  OsFacts,
  ProbeDeps,
} from "./hardware/index";
export {
  FakeHardwareProbe,
  SystemHardwareProbe,
  isCapabilityState,
  isGpuVendor,
  isHardwareArch,
  isHardwareOs,
  nodeOsFacts,
} from "./hardware/index";
export type {
  CompatibilityCheck,
  CompatibilityReason,
  CompatibilityResult,
  EffectiveModelSelection,
  InstalledModelState,
  InstallationOutcome,
  InstallationPhase,
  InstallationProgressCallback,
  InstallationProgressEvent,
  InstallationResult,
  InstallationServiceDeps,
  InstallRequest,
  InstallerOutcome,
  InstallerResult,
  LocalModelAccelerator,
  LocalModelDefinition,
  LocalModelId,
  LocalModelKind,
  LocalModelStateFile,
  ModelInstallArtifact,
  ModelInstallContext,
  ModelInstallationDescriptor,
  ModelInstaller,
  ModelInstallerId,
  ModelKindSelection,
  ModelQualityTier,
  ModelRecommendation,
  ModelRequirements,
  ModelValidationRecord,
  RecommendArgs,
  RecommendationCandidate,
  RecommendationProfile,
  ResolveSelectionArgs,
  RunnableModelSelection,
  SelectionMode,
  SelectionSource,
  StateFileSystem,
  StateStoreOptions,
  SupportMaturity,
  ValidationStatus,
} from "./local-models/index";
export {
  DEFAULT_LOCAL_MODEL_STATE_PATH,
  DEFAULT_MANAGED_ROOT,
  INSTALLATION_OUTCOMES,
  INSTALLATION_PHASES,
  LOCAL_MODEL_ENV_VARS,
  LOCAL_MODEL_IDS,
  LOCAL_MODEL_STATE_VERSION,
  LocalModelStateStore,
  MODEL_INSTALLER_IDS,
  ModelInstallationService,
  ModelInstallerRegistry,
  SELECTION_MODES,
  SELECTION_SOURCES,
  VALIDATION_STATUSES,
  defaultSelections,
  defaultStateFile,
  evaluateCompatibility,
  filterCompatible,
  findLocalModel,
  getLocalModelCatalog,
  isInstallationOutcome,
  isInstallationPhase,
  isLocalModelKind,
  isModelInstallerId,
  isModelQualityTier,
  isRecommendationProfile,
  isSelectionMode,
  isSelectionSource,
  isSupportMaturity,
  isValidationStatus,
  memoryStateFileSystem,
  nodeStateFileSystem,
  parseStateFile,
  recommendModel,
  resolveEffectiveSelection,
  resolveRunnableSelection,
  serializeStateFile,
  validateCatalog,
} from "./local-models/index";
