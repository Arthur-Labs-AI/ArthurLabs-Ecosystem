/** HR-02.5E1: installer public surface aggregator (no logic). */
export { makeParakeetInstaller, PARAKEET_MODEL_ID, PARAKEET_HF_REPO, PARAKEET_RUNTIME_ID, PARAKEET_PACKAGES, PARAKEET_CUDA_PACKAGES, PARAKEET_CUDA_INDEX_URL, PARAKEET_WORKER_FILE } from './parakeet';
export { makeOmniVoiceBgInstaller, OMNIVOICE_MODEL_ID, OMNIVOICE_HF_REPO, OMNIVOICE_RUNTIME_ID, OMNIVOICE_PACKAGES, OMNIVOICE_CUDA_PACKAGES, OMNIVOICE_CUDA_INDEX_URL, OMNIVOICE_WORKER_FILE } from './omnivoice_bg';
export { makeBgTts38mInstaller, BGTTS_MODEL_ID, BGTTS_HF_REPO, BGTTS_RUNTIME_ID, BGTTS_PACKAGES, BGTTS_CUDA_PACKAGES, BGTTS_CUDA_INDEX_URL, BGTTS_MIOCODEC_ARCHIVE_URL, BGTTS_MIOCODEC_ARCHIVE_SHA256, BGTTS_MIOCODEC_ARCHIVE_LABEL, BGTTS_MIOCODEC_VERSION, BGTTS_WORKER_FILE } from './bgtts_38m';
export { createDefaultModelInstallerRegistry, DEFAULT_INSTALLER_MODEL_IDS } from './registry';
export { smokeSilenceB64, smokeSttRequest, SMOKE_BG_PHRASE, smokeReferenceToneBytes, isValidSttSmokeResponse } from './smoke_fixtures';
export type { InstalledModelRuntimeDescriptor, InstallManifest } from './shared';
export { INSTALL_MANIFEST_FILENAME, writeInstallManifest } from './shared';
