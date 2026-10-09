/**
 * HR-02.5E2: local voice runtime (resolution + managed providers +
 * factory + lazy composition legs). Routers/controllers consume the
 * HR-02 provider interfaces; nothing here routes, selects, or installs.
 */
export { resolveRuntimeTarget, type LocalRuntimeTarget, type ResolveRuntimeArgs, type RuntimeTargetKind } from './resolution';
export { ManagedParakeetSttProvider, type ManagedSttOptions } from './managed_stt';
export { ManagedLocalTtsProvider, makeOmniVoiceTtsProvider, makeBgTtsProvider, MANAGED_TTS_STARTUP_TIMEOUT_MS, MANAGED_TTS_SYNTH_TIMEOUT_MS, MANAGED_TTS_MAX_TEXT_CHARS, type ManagedTtsDeps } from './managed_tts';
export { createLocalSttProvider, createLocalTtsProvider, tryCreateLocalSttProvider, tryCreateLocalTtsProvider, type LocalVoiceFactoryDeps, type LocalSttProviderRef, type LocalTtsProviderRef } from './factory';
export { LazyLocalSttProvider, LazyLocalTtsProvider, type LazyResolve, type StableLegDeps } from './lazy';
export { peekSelectedModelId, providerIdForModel, PROVIDER_ID_BY_MODEL } from './selection_id';
