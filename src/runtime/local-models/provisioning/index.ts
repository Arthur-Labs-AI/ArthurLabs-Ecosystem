/**
 * HR-02.5D2: provisioning infrastructure (public entry point).
 *
 * Reusable side-effect primitives for future concrete installers (E).
 * D1 ModelInstallationService remains the sole orchestration and
 * durable-state owner: nothing here mutates HR-02.5C state, touches
 * routers/controllers/providers, or installs any real model.
 */

export {
  NO_CREDENTIALS,
  isDownloadOutcome,
  isVerificationMode,
  type CleanupReport,
  type DownloadOutcome,
  type DownloadedArtifact,
  type PromotionResult,
  type PythonDiscovery,
  type PythonEnvironment,
  type RecoveryScan,
  type VerificationMode,
  type VerifiedArtifact,
} from './contracts';
export { DOWNLOAD_OUTCOMES, VERIFICATION_MODES } from './contracts';
export {
  DEFAULT_MANAGED_ROOT_SEGMENTS,
  HF_CACHE_DIRNAME,
  HF_HUB_DIRNAME,
  LOCAL_MODEL_DIRNAME,
  ManagedPathService,
  MAX_STORAGE_KEY_CHARS,
  STORAGE_KEY_PATTERN,
  assertInsideRoot,
  assertNoEscapeThroughLinks,
  canonicalizeRoot,
  defaultLocalModelRoot,
  isManagedEnvKey,
  memoryPathoscopy,
  nodePathoscopy,
  resolveAppDataRoot,
  resolveManagedRoot,
  toStorageKey,
  type ManagedLayout,
  type ModelCacheEnv,
  type Pathoscopy,
} from './paths';
export {
  cleanupPaths,
  commitStagedDirectory,
  createStagingArea,
  discardStagingArea,
  memoryProvisioningFs,
  nodeProvisioningFs,
  recoverLiveFromBackup,
  scanRecoveryNeeded,
  type CleanupOptions,
  type PromotionOptions,
  type ProvisioningFs,
  type StagingArea,
} from './staging';
export {
  RUNNER_DEFAULT_TIMEOUT_MS,
  RUNNER_MAX_STDERR_BYTES,
  RUNNER_MAX_STDOUT_BYTES,
  describeRun,
  nodeSpawnFn,
  runTrustedProcess,
  type RunResult,
  type RunSpec,
  type SpawnFn,
} from './process_runner';
export {
  DOWNLOADER_DEFAULT_MAX_BYTES,
  DOWNLOADER_DEFAULT_MAX_REDIRECTS,
  DOWNLOADER_DEFAULT_TIMEOUT_MS,
  downloadArtifact,
  memoryDownloadFs,
  nodeDownloadFs,
  nodeHttpTransport,
  type DownloadFs,
  type DownloadRequest,
  type HttpTransport,
  type TransportResponse,
  type TrustedArtifactSource,
} from './downloader';
export {
  SHA256_HEX_PATTERN,
  memoryVerifyFs,
  nodeVerifyFs,
  normalizeSha256,
  sha256OfFile,
  verifyArtifact,
  type VerifyFs,
  type VerifyRequest,
} from './verification';
export {
  checkVersionSpec,
  discoverSystemPython,
  ensureEnvironment,
  environmentPython,
  installPinnedPackages,
  nodeVenvFs,
  type EnsureEnvironmentArgs,
  type InstallPackagesArgs,
  type PinnedPackageSet,
  type PythonRuntimeSpec,
  type VenvFs,
} from './python';
