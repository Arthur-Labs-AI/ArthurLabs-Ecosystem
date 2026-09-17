/**
 * Composition root.
 *
 * Both the HTTP server and the CLI build the same services here, so there is
 * exactly one implementation of orchestration. Provider selection comes from
 * configuration; ConversationService depends only on ModelGateway.
 *
 * The raw tool registry and secured execution facade are internal to this
 * composition: the App exposes only ConversationService (the secured facade),
 * never a raw executor handle (audit MEDIUM 7).
 */

import { randomBytes } from "node:crypto";

import { ConversationService, ConversationServiceDeps } from "./core/conversation/service";
import { PublicError, sanitizePublicError } from "./core/errors/errors";
import { ContextBuilder } from "./core/conversation/context_builder";
import { ModelGateway } from "./models/gateway";
import { HarnessAdapter } from "./tools/contracts";
import { ModelProvider } from "./models/contracts";
import { DeepSeekProvider, ProviderLogSink } from "./models/providers/deepseek";
import { FakeProvider } from "./models/providers/fake";
import { Logger } from "./observability/logging";
import { InMemoryMetrics, Metrics } from "./observability/metrics";
import { SessionStore } from "./sessions/store";
import { SecretSanitizer } from "./security/sanitize";
import { HarnessStubAdapter } from "./tools/adapters/harness_stub";
import { LocalSystemAdapter, NodeLocalSystemAdapter } from "./tools/adapters/local_system";
import { buildDefaultLocalHost, registerBuiltinTools } from "./tools/builtin";
import type { LocalCapabilityHost } from "./tools/local_host";
import { ToolOrchestrator } from "./tools/orchestrator";
import { PermissionService } from "./tools/permissions";
import { ToolRegistry } from "./tools/registry";
import { collectSecrets, loadSettings, Settings, SettingsOverrides } from "./config/settings";
import { validateSettings } from "./config/validation";
import { EmbeddingGatewayImpl } from "./memory/embeddings/gateway";
import { LocalMultilingualEmbeddingProvider } from "./memory/embeddings/providers/local_multilingual";
import { FakeEmbeddingProvider } from "./memory/embeddings/providers/fake";
import { BusinessMemoryStore, PersonalMemoryStore } from "./memory/stores/sqlite_memory_store";
import { MemoryGatewayImpl } from "./memory/gateway";
import { DedupeService } from "./memory/dedupe";
import { HybridRetriever } from "./memory/retrieval/hybrid_retriever";
import { MemoryContextSource } from "./memory/context_source";
import { MemoryService } from "./memory/service";
import { MemoryExtractor } from "./memory/extraction/memory_extractor";
import { TurnMemoryExtractor } from "./memory/extraction/turn_extractor";
import { FakeAudioCapture, LocalAudioCapture } from "./voice/audio/capture";
import { FakeAudioPlayback, LocalAudioPlayback } from "./voice/audio/playback";
import { FakeVadProvider } from "./voice/vad/fake";
import { LocalEnergyVadProvider } from "./voice/vad/local_provider";
import { VadGateway } from "./voice/vad/gateway";
import { FakeWakeWordProvider } from "./voice/wake/fake";
import { LocalWakeWordProvider } from "./voice/wake/local_provider";
import { SherpaWakeWordProvider } from "./voice/wake/sherpa_provider";
import { WakeWordGateway } from "./voice/wake/gateway";
import { FakeSttProvider } from "./voice/stt/fake";
import { LocalSttProvider } from "./voice/stt/local_provider";
import { OpenAiSttProvider } from "./voice/stt/openai_provider";
import { ParakeetSttProvider } from "./voice/stt/parakeet_provider";
import { SttGateway } from "./voice/stt/gateway";
import { FakeTtsProvider } from "./voice/tts/fake";
import { LocalTtsProvider } from "./voice/tts/local_provider";
import { OpenAiTtsProvider } from "./voice/tts/openai_provider";
import { TtsGateway } from "./voice/tts/gateway";
import { ModelRouter } from "./runtime/model_router";
import { SttRouter } from "./runtime/stt_router";
import { TtsRouter } from "./runtime/tts_router";
import { resolveLocalModelPaths } from "./runtime/local-models/provisioning/paths";
import { SystemHardwareProbe } from "./runtime/hardware/probe";
import { LocalModelStateStore } from "./runtime/local-models/state_store";
import { tryCreateLocalSttProvider, tryCreateLocalTtsProvider } from "./runtime/local-models/runtime/factory";
import { LazyLocalSttProvider, LazyLocalTtsProvider } from "./runtime/local-models/runtime/lazy";
import { SpeechFormatter } from "./voice/speech/formatter";
import { VoiceTurnController } from "./voice/controller";
import { RealtimeVoiceServer } from "./voice/realtime/websocket";
import type { VadConfig } from "./voice/contracts";
import type { AudioCapture } from "./voice/audio/capture";
import type { AudioPlayback } from "./voice/audio/playback";
import type { VadProvider } from "./voice/contracts";
import type { SttProvider } from "./voice/contracts";
import type { TtsProvider } from "./voice/contracts";
import type { WakeWordProvider } from "./voice/contracts";

export interface App {
  config: Settings;
  logger: Logger;
  metrics: Metrics;
  gateway: ModelGateway;
  /** HR-01: provider-neutral routing seams (always resolve configured providers). */
  modelRouter: ModelRouter;
  sttRouter: SttRouter;
  ttsRouter: TtsRouter;
  store: SessionStore;
  /** SC-03 section 58: result of the automatic startup recovery scan. */
  startupRecovery?: { recovered: number };
  conversation: ConversationService;
  /** Phase 2 session-aware memory facade (HTTP/CLI surface). */
  memory: MemoryService;
  /** Phase 3 local voice layer (disabled unless configured/controlled). */
  voice: VoiceTurnController;
  realtime: RealtimeVoiceServer;
  sanitizePublicError(error: unknown): PublicError;
  close(): void;
}

export function createModelProvider(settings: Settings, logger?: ProviderLogSink): ModelProvider {
  if (settings.modelProvider === "deepseek") {
    return new DeepSeekProvider(
      {
        apiKey: settings.deepseekApiKey,
        model: settings.modelName,
        baseUrl: settings.deepseekBaseUrl,
        timeoutMs: settings.modelTimeoutSeconds * 1000,
        retryMaxAttempts: settings.retryMaxAttempts,
        retryBaseDelayMs: settings.retryBaseDelayMs,
        reasoningProfile: settings.reasoningProfile,
      },
      { logger },
    );
  }
  return new FakeProvider({ modelName: settings.modelName || "fake-model" });
}

export interface BuildDeps {
  /** Override provider selection (used by tests to script a FakeProvider). */
  provider?: ModelProvider;
  /** Override the harness adapter (used by tests). */
  harness?: HarnessAdapter;
  /**
   * Override the machine-local system capability adapter (used by tests to
   * inject a deterministic fake). Production defaults to NodeLocalSystemAdapter.
   */
  localSystem?: LocalSystemAdapter;
  /**
   * SC-04 full local capability host override (tests inject deterministic
   * filesystem/app/browser fakes). When omitted the host is composed from
   * localSystem + localConfig. Never exposed on the public App surface.
   */
  localHost?: LocalCapabilityHost;
  /**
   * SC-04 trusted local capability config (filesystem scopes, app catalog).
   * Tests inject this directly; production startup resolves it from the
   * ARTHUR_LOCAL_CONFIG file (Settings.localConfigPath) when no explicit
   * deps.localConfig is provided.
   */
  localConfig?: import("./tools/local_config").LocalCapabilityConfig;
  /**
   * SC-05 trusted git capability config (repository catalog). Absent = git
   * tools not registered. Tests inject this directly; production startup
   * resolves it from the ARTHUR_GIT_CONFIG file (Settings.gitConfigPath)
   * when no explicit deps.gitConfig is provided.
   */
  gitConfig?: import("./tools/git/repository_catalog").GitCapabilityConfig;
  /** App-level secret used to sign and verify approval tokens. */
  approvalSigningSecret?: string;
  /** SC-02 signing identity override (tests / persistent key file wiring). */
  approvalKeyProvider?: import("./tools/approval_keys").ApprovalKeyProvider;
  /** SC-02 trust ring override (key rotation tests). */
  approvalTrustedKeys?: import("./tools/approval_signer").ApprovalKeypair[];
  /** Phase 3 voice overrides (deterministic providers for tests). */
  voice?: {
    capture?: AudioCapture;
    playback?: AudioPlayback;
    wake?: WakeWordProvider;
    vad?: VadProvider;
    stt?: SttProvider;
    tts?: TtsProvider;
    now?: () => number;
  };
}

function repoRoot(): string {
  return process.cwd();
}

/** Default Parakeet worker argv: python + bundled worker script (trusted, no shell). */
function defaultParakeetArgv(): string[] {
  const path = require("node:path") as typeof import("node:path");
  const worker = path.join(repoRoot(), "tools", "voice", "parakeet_worker.py");
  return ["python", worker];
}

/**
 * HR-02.5E2 managed-leg resolvers (async, non-fatal, no mutations).
 *
 * Each probes live hardware, loads persisted model state, and asks the
 * bounded E2 factory for the selected READY provider. Any failure
 * (no selection, not ready, missing artifacts, probe/state errors)
 * yields null so the pre-existing fallback leg stands. Never installs,
 * repairs, downloads, or constructs cloud providers.
 */
async function resolveManagedStt(managedRoot: string, managedStatePath: string): Promise<SttProvider | null> {
  try {
    const hardware = await new SystemHardwareProbe().detect();
    const store = LocalModelStateStore.load({ statePath: managedStatePath });
    const ref = tryCreateLocalSttProvider({ hardware, state: store.snapshot(), managedRoot });
    return ref ? ref.provider : null;
  } catch {
    return null;
  }
}

async function resolveManagedTts(managedRoot: string, managedStatePath: string): Promise<TtsProvider | null> {
  try {
    const hardware = await new SystemHardwareProbe().detect();
    const store = LocalModelStateStore.load({ statePath: managedStatePath });
    const ref = tryCreateLocalTtsProvider({ hardware, state: store.snapshot(), managedRoot });
    return ref ? ref.provider : null;
  } catch {
    return null;
  }
}

/**
 * Synchronous stable-identity snapshot for lazy legs (E2 §4): reads the
 * persisted state file (sync fs) so the leg advertises its managed id
 * from construction when a READY selection exists. Any read/parse
 * failure yields undefined (leg keeps fallback identity). Never probes
 * hardware, never mutates.
 */
function peekManagedState(managedStatePath: string): import("./runtime/local-models/state_contracts").LocalModelStateFile | undefined {
  try {
    const store = LocalModelStateStore.load({ statePath: managedStatePath });
    return store.snapshot();
  } catch {
    return undefined;
  }
}

/** Tokenize a trusted engine command line into argv (no shell, mirrors process_util). */
function tokenizeEngineCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        inQuotes = false;
      } else if (ch === "\\" && command[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === " " || ch === "\t") {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
    i += 1;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

function vadConfigFrom(settings: Settings): VadConfig {
  const voice = settings.voice;
  return {
    speechStartThreshold: 0.6,
    speechEndThreshold: 0.35,
    speechStartFrames: 2,
    speechEndFrames: 8,
    minSpeechMs: 300,
    endSilenceMs: voice.vadEndSilenceMs,
    maxUtteranceMs: voice.maxUtteranceMs,
    noSpeechTimeoutMs: voice.noSpeechTimeoutMs,
    frameDurationMs: voice.frameDurationMs,
  };
}

/** Build the Phase 3 voice layer from configuration (engine-agnostic). */
export function createVoiceController(
  settings: Settings,
  conversation: ConversationService,
  store: SessionStore,
  logger: Logger,
  metrics: Metrics,
  sanitizer: SecretSanitizer,
  deps: BuildDeps,
): {
  controller: VoiceTurnController;
  realtime: RealtimeVoiceServer;
  sttRouter: SttRouter;
  ttsRouter: TtsRouter;
} {
  const voice = settings.voice;
  const capture: AudioCapture =
    deps.voice?.capture ??
    new LocalAudioCapture(voice.audioCaptureCommand, voice.sampleRateHz, voice.audioInputDevice, {
      frameDurationMs: voice.frameDurationMs,
      logger: logger.child("voice-capture"),
      sanitizer,
    });
  const playback: AudioPlayback =
    deps.voice?.playback ??
    new LocalAudioPlayback(voice.audioPlaybackCommand, {
      logger: logger.child("voice-playback"),
      sanitizer,
    });
  const vadConfig = vadConfigFrom(settings);
  const vad: VadProvider =
    deps.voice?.vad ??
    (voice.vadProvider === "fake"
      ? new FakeVadProvider(vadConfig)
      : new LocalEnergyVadProvider(vadConfig));
  // HR-02 local STT backend: explicit ARTHUR_LOCAL_STT_PROVIDER=parakeet selects
  // the Parakeet worker; any other value (including the legacy default empty)
  // keeps the existing local engine (whisper etc.); "fake" keeps the test double.
  // Default voice settings select the legacy local engine, so the default app
  // shape is unchanged from HR-01 (local-stt); operators opt into Parakeet by
  // setting ARTHUR_LOCAL_STT_PROVIDER=parakeet (documented in .env.example).
  // Parakeet command resolution: explicit ARTHUR_STT_ENGINE_COMMAND wins (trusted
  // startup config); otherwise the default worker argv (python + bundled script).
  const parakeetArgv = defaultParakeetArgv();
  // Pre-E2 fallback leg, unchanged: operator-configured engine/fake.
  const localSttFallback: SttProvider =
    voice.sttProvider === "fake"
      ? new FakeSttProvider()
      : voice.localSttProvider === "parakeet"
        ? new ParakeetSttProvider({
            command: voice.sttEngineCommand.trim() !== "" ? tokenizeEngineCommand(voice.sttEngineCommand) : parakeetArgv,
            model: voice.localSttModel,
            logger: logger.child("voice-stt"),
            // Opt-in HR-02 crash diagnostics (ARTHUR_PARAKEET_DEBUG=1). Reuses
            // the existing secret boundary; production logging is unchanged
            // while the switch is unset.
            sanitizer,
          })
        : new LocalSttProvider(voice.sttEngineCommand, voice.sttModelPath, voice.sttLanguage, {
            initialPrompt: voice.sttInitialPrompt,
            logger: logger.child("voice-stt"),
            sanitizer,
          });
  // HR-02 cloud STT backend (voice-only): OpenAI transcription. Unconfigured key
  // => available=false => SttRouter treats cloud as unavailable (startup succeeds).
  const cloudStt: SttProvider = new OpenAiSttProvider({
    apiKey: settings.openaiApiKey,
    model: voice.cloudSttModel,
    initialPrompt: voice.sttInitialPrompt,
    logger: logger.child("voice-stt"),
  });
  const localTtsBase: TtsProvider =
    voice.ttsProvider === "fake"
      ? new FakeTtsProvider()
      : new LocalTtsProvider(voice.ttsEngineCommand, voice.ttsVoice, {
          logger: logger.child("voice-tts"),
          sanitizer,
        });
  // HR-02.5E2 managed local voice legs (stable lifetime identity): the
  // persisted state file is peeked SYNCHRONOUSLY so each leg advertises
  // its managed provider id from construction when a READY model is
  // selected (override/manual/rank-first-auto + READY lifecycle).
  // Async hardware/artifact verification happens inside the first
  // request and fails closed there — the id never flips mid-utterance.
  // Without a READY selection the legs above stand unchanged.
  // Test-injected providers (deps.voice.stt/tts) bypass E2 entirely.
  // HR-02.5F: same canonical resolver as CLI/setup — explicit voice
  // config wins, otherwise ARTHUR_DATA_DIR -> stable OS user-data root.
  const resolved = resolveLocalModelPaths({
    managedRoot: voice.localModelRoot.trim() !== "" ? voice.localModelRoot : undefined,
    statePath: voice.localModelStatePath.trim() !== "" ? voice.localModelStatePath : undefined,
  });
  const managedRoot = resolved.managedRoot;
  const managedStatePath = resolved.statePath;
  const stableState = peekManagedState(managedStatePath);
  const localStt: SttProvider =
    deps.voice?.stt ??
    new LazyLocalSttProvider(
      () => resolveManagedStt(managedRoot, managedStatePath),
      localSttFallback,
      stableState ? { kind: "stt", state: stableState } : undefined,
    );
  const localTts: TtsProvider =
    deps.voice?.tts ??
    new LazyLocalTtsProvider(
      () => resolveManagedTts(managedRoot, managedStatePath),
      localTtsBase,
      stableState ? { kind: "tts", state: stableState } : undefined,
    );
  // HR-02 cloud TTS backend (speech renderer only): canonical final text in,
  // audio out. Never tools, never memory, never a second conversation.
  const cloudTts: TtsProvider = new OpenAiTtsProvider({
    apiKey: settings.openaiApiKey,
    model: voice.cloudTtsModel,
    voice: voice.cloudTtsVoice,
    logger: logger.child("voice-tts"),
  });
  const wakeProvider: WakeWordProvider =
    deps.voice?.wake ??
    (voice.wakeProvider === "fake"
      ? new FakeWakeWordProvider()
      : voice.wakeProvider === "sherpa"
        ? // True Wake Word v1 (TASK-0009): streaming sherpa-onnx KWS over the
          // same gateway-routed PCM frames. Unavailable models keep the
          // provider available=false and the controller falls back to PTT.
          new SherpaWakeWordProvider({
            modelDir: voice.wakeModelDir,
            keywordsFile: voice.wakeKeywordsFile,
            keywordsScore: voice.wakeKeywordsScore,
            keywordsThreshold: voice.wakeKeywordsThreshold,
            numThreads: voice.wakeNumThreads,
            logger: logger.child("voice-wake"),
          })
        : new LocalWakeWordProvider());
  const wake = new WakeWordGateway(wakeProvider, { frameBased: true });
  // HR-02 STT/TTS router seams: VoiceController -> SttRouter/TtsRouter ->
  // (cloud OpenAI | local Parakeet/engine) behind provider-neutral contracts.
  // The controller keeps no concrete provider knowledge. Locality is trusted
  // construction metadata (cloud = remote API, local = on-device engine) —
  // never inferred from ids, hosts, or the network. Reasoning stays on the
  // configured ModelProvider (DeepSeek today): voice providers never receive
  // tools, approvals, memory, or conversation ownership.
  const injectedStt = deps.voice?.stt;
  const sttRouter = injectedStt
    ? new SttRouter({ provider: new SttGateway(injectedStt, metrics), locality: "local" })
    : new SttRouter({
        cloud: new SttGateway(cloudStt, metrics),
        local: new SttGateway(localStt, metrics),
        policy: voice.sttPolicy,
        onEvent: (event) => {
          metrics.counter("voice.stt." + event.type.slice("voice.stt.".length), 1, {
            provider: event.provider_id,
            reason: event.routing_reason,
          });
          if (event.type === "voice.stt.fallback") {
            logger.child("voice-stt").warn("stt fallback to local", { routing_reason: event.routing_reason });
          }
        },
      });
  const injectedTts = deps.voice?.tts;
  const ttsRouter = injectedTts
    ? new TtsRouter({ provider: new TtsGateway(injectedTts, metrics), locality: "local" })
    : new TtsRouter({
        cloud: new TtsGateway(cloudTts, metrics),
        local: new TtsGateway(localTts, metrics),
        policy: voice.ttsPolicy,
        onEvent: (event) => {
          metrics.counter("voice.tts." + event.type.slice("voice.tts.".length), 1, {
            provider: event.provider_id,
            reason: event.routing_reason,
          });
          if (event.type === "voice.tts.fallback") {
            logger.child("voice-tts").warn("tts fallback to local", { routing_reason: event.routing_reason });
          }
        },
      });
  const controller = new VoiceTurnController({
    settings: voice,
    conversation,
    store,
    capture,
    playback,
    wake,
    vad: new VadGateway(vad),
    stt: sttRouter,
    tts: ttsRouter,
    formatter: new SpeechFormatter(),
    logger,
    metrics,
    sanitizer,
    now: deps.voice?.now,
  });
  const realtime = new RealtimeVoiceServer(controller, logger);
  return { controller, realtime, sttRouter, ttsRouter };
}

export function buildApp(overrides: SettingsOverrides = {}, deps: BuildDeps = {}): App {
  const settings = validateSettings(loadSettings(overrides));
  // TASK-0022 production path: resolve the trusted SC-05 catalog from the
  // ARTHUR_GIT_CONFIG file unless tests injected deps.gitConfig (or a full
  // deps.localHost). Absent = disabled; present-but-invalid fails closed
  // with INVALID_CONFIG out of buildApp (never silently disabled). Feeds
  // the same buildDefaultLocalHost -> LocalGitAdapter -> registerGitPack
  // path as the injected config; no second registry or CLI-only path.
  let gitConfig = deps.gitConfig;
  if (gitConfig === undefined && deps.localHost === undefined) {
    const { resolveGitCapabilityConfig } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./tools/git/config_file") as typeof import("./tools/git/config_file");
    gitConfig = resolveGitCapabilityConfig(settings.gitConfigPath);
  }
  // TASK-0025 production path: resolve the trusted SC-04 local capability
  // config from the ARTHUR_LOCAL_CONFIG file unless tests injected
  // deps.localConfig (or a full deps.localHost). Absent = existing default
  // local behavior; present-but-invalid fails closed with INVALID_CONFIG
  // out of buildApp (never silently disabled). Feeds the same
  // buildDefaultLocalHost -> NodeLocalApplicationAdapter ->
  // registerApplicationsPack path as the injected config; no second
  // registry, no auto-discovery, no model-provided paths.
  let localConfig = deps.localConfig;
  if (localConfig === undefined && deps.localHost === undefined) {
    const { resolveLocalCapabilityConfig } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./tools/local_config_file") as typeof import("./tools/local_config_file");
    localConfig = resolveLocalCapabilityConfig(settings.localConfigPath);
  }
  const secrets = collectSecrets(settings);
  const logger = new Logger(settings.logLevel, secrets);
  const metrics = new InMemoryMetrics();
  const sanitizer = new SecretSanitizer(secrets);
  const approvalSigningSecret = deps.approvalSigningSecret ?? randomBytes(32).toString("hex");

  const provider = deps.provider ?? createModelProvider(settings, logger.child("model-provider"));
  const gateway = new ModelGateway(provider);
  // HR-01 ModelRouter seam: ConversationService/ConversationLoopRunner ->
  // ModelRouter -> ModelProvider. Single configured provider today, so the
  // legacy single-provider form is used (id/capabilities/decision pass
  // through; configured_default). The hybrid multi-provider form
  // (HR-03C: nodes + providers + gateways + engine) activates when a
  // second model provider exists; it is covered by focused HR-03C tests.
  // Locality is trusted configuration metadata (settings.modelProvider) —
  // DeepSeek executes as a remote API ("cloud"), the in-process fake
  // executes on-device ("local"). Never inferred from ids/names/hosts.
  const modelRouter = new ModelRouter({
    gateway,
    locality: settings.modelProvider === "deepseek" ? "cloud" : "local",
  });
  const store = new SessionStore(settings.dbPath, sanitizer);

  const registry = new ToolRegistry();
  const harness = deps.harness ?? new HarnessStubAdapter({ verificationSecret: approvalSigningSecret });
  // SC-04 Local Capability Host: typed adapters bundled for registered tools
  // only. The host is NOT an alternate authorization or execution path and is
  // never exposed on the App surface - it is reachable solely through the
  // secured registry -> execution-service -> permission boundary.
  const localSystem = deps.localSystem ?? new NodeLocalSystemAdapter();
  const localHost: LocalCapabilityHost =
    deps.localHost ?? buildDefaultLocalHost(localSystem, localConfig, gitConfig);
  registerBuiltinTools(registry, harness, { host: localHost });

  const permissions = new PermissionService();
  const execution = registry.createExecutionService(permissions);
  const orchestrator = new ToolOrchestrator({
    registry,
    execution,
    store,
    permissions,
    sanitizer,
    approvalTtlSeconds: settings.approvalTtlSeconds,
    approvalSigningSecret,
    approvalKeyProvider: deps.approvalKeyProvider,
    approvalTrustedKeys: deps.approvalTrustedKeys,
    logger,
    metrics,
  });

  let contextBuilder = new ContextBuilder({
    historyMaxTurns: settings.historyMaxTurns,
    tokenBudget: settings.contextTokenBudget,
  });

  // ---- Phase 2: isolated memory + RAG (spec sections 5-7, 12-16) --------
  const embeddingProvider =
    settings.embeddingProvider === "fake"
      ? new FakeEmbeddingProvider({ dimensions: settings.embeddingDimensions })
      : new LocalMultilingualEmbeddingProvider({ dimensions: settings.embeddingDimensions });
  const embeddings = new EmbeddingGatewayImpl({
    provider: embeddingProvider,
    model: settings.embeddingModel,
    version: "1",
  });
  const personalStore = new PersonalMemoryStore(settings.memoryPersonalDbPath, sanitizer);
  const businessStore = new BusinessMemoryStore(settings.memoryBusinessDbPath, sanitizer);
  const dedupe = new DedupeService(embeddings);
  const retriever = new HybridRetriever({
    personal: personalStore,
    business: businessStore,
    embeddings,
    maxCandidates: settings.memoryMaxRetrievalCandidates,
    maxRerankedResults: settings.memoryMaxRerankedResults,
    maxContextTokens: settings.memoryMaxContextTokens,
    maxSingleChunkTokens: settings.memoryMaxSingleChunkTokens,
    minSimilarity: settings.memoryVectorMinSimilarity,
    logger,
    metrics,
  });
  const memoryGateway = new MemoryGatewayImpl({
    personal: personalStore,
    business: businessStore,
    embeddings,
    dedupe,
    retriever,
    sanitizer,
    config: {
      maxChunkTokens: settings.memoryMaxSingleChunkTokens,
      maxRetrievalCandidates: settings.memoryMaxRetrievalCandidates,
      maxRerankedResults: settings.memoryMaxRerankedResults,
      maxContextTokens: settings.memoryMaxContextTokens,
      maxSingleChunkTokens: settings.memoryMaxSingleChunkTokens,
      temporaryTtlSeconds: settings.memoryTemporaryTtlSeconds,
      maxRememberChars: settings.maxMessageChars,
      embeddingInfo: {
        provider: embeddingProvider.id(),
        model: settings.embeddingModel,
        version: "1",
        dimensions: settings.embeddingDimensions,
      },
    },
    logger,
    metrics,
  });
  const memory = new MemoryService(memoryGateway, store);
  contextBuilder = new ContextBuilder({
    historyMaxTurns: settings.historyMaxTurns,
    tokenBudget: settings.contextTokenBudget,
    sources: [
      new MemoryContextSource({
        gateway: memoryGateway,
        sessions: store,
        maxContextTokens: settings.memoryMaxContextTokens,
        maxSingleChunkTokens: settings.memoryMaxSingleChunkTokens,
        logger,
        metrics,
      }),
    ],
  });

  // Phase 2 automatic extraction (opt-in; runs through the existing gateway).
  let afterTurn: ConversationServiceDeps["afterTurn"];
  if (settings.memoryExtractionEnabled) {
    const extractor = new MemoryExtractor({
      gateway,
      model: settings.modelName,
      policy: {
        confidenceThreshold: settings.memoryExtractionConfidenceThreshold,
        importanceThreshold: settings.memoryExtractionImportanceThreshold,
        minCandidateChars: 12,
        maxCandidateChars: 2000,
      },
    });
    const turnExtractor = new TurnMemoryExtractor({
      extractor,
      gateway: memoryGateway,
      enabled: true,
      logger,
      metrics,
    });
    afterTurn = (input) => turnExtractor.run(input);
  }

  const conversation = new ConversationService({
    gateway: modelRouter,
    // Trusted construction metadata: DeepSeek executes remote ("cloud"),
    // the in-process fake executes on-device ("local"). Ignored while
    // gateway is already a ModelRouter; required for raw gateways.
    modelLocality: settings.modelProvider === "deepseek" ? "cloud" : "local",
    store,
    contextBuilder,
    orchestrator,
    registry,
    sanitizer,
    config: settings,
    logger,
    metrics,
    afterTurn,
  });

  const { controller, realtime, sttRouter, ttsRouter } = createVoiceController(
    settings,
    conversation,
    store,
    logger,
    metrics,
    sanitizer,
    deps,
  );

  // SC-03 section 58: startup recovery runs automatically on every production
  // startup (same production path tests exercise): scan non-terminal executions
  // left by a dead runtime and apply the deterministic policy matrix. Best
  // effort and synchronous-safe: recovery never throws out of buildApp and
  // never dispatches executors; stale RUNNING mutations quarantine to
  // OUTCOME_UNKNOWN, side-effect-free work resumes via retry_wait.
  let startupRecovery: { recovered: number } | undefined;
  try {
    startupRecovery = orchestrator.runStartupRecovery();
  } catch (err) {
    logger.error("startup execution recovery failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    startupRecovery = { recovered: 0 };
  }
  // SC-06 §102/F46: fail closed any loop left in an active (non-suspended,
  // non-terminal) state by a dead runtime. WAITING_APPROVAL rows survive —
  // the explicit human barrier is the only resumable continuation point.
  try {
    const failedClosed = store.failClosedActiveLoops();
    if (failedClosed > 0) logger.info("startup loop recovery failed closed", { failed_closed: failedClosed });
  } catch (err) {
    logger.error("startup loop recovery failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    config: settings,
    logger,
    metrics,
    gateway,
    modelRouter,
    sttRouter,
    ttsRouter,
    store,
    startupRecovery,
    conversation,
    memory,
    voice: controller,
    realtime,
    sanitizePublicError: (error: unknown) => sanitizePublicError(error, sanitizer),
    close: () => {
      void controller.close();
      realtime.close();
      store.close();
      memory.close();
    },
  };
}