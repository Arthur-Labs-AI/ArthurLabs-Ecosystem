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
import { DeepSeekProvider } from "./models/providers/deepseek";
import { FakeProvider } from "./models/providers/fake";
import { Logger } from "./observability/logging";
import { InMemoryMetrics, Metrics } from "./observability/metrics";
import { SessionStore } from "./sessions/store";
import { SecretSanitizer } from "./security/sanitize";
import { HarnessStubAdapter } from "./tools/adapters/harness_stub";
import { registerBuiltinTools } from "./tools/builtin";
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

export interface App {
  config: Settings;
  logger: Logger;
  metrics: Metrics;
  gateway: ModelGateway;
  store: SessionStore;
  conversation: ConversationService;
  /** Phase 2 session-aware memory facade (HTTP/CLI surface). */
  memory: MemoryService;
  sanitizePublicError(error: unknown): PublicError;
  close(): void;
}

export function createModelProvider(settings: Settings): ModelProvider {
  if (settings.modelProvider === "deepseek") {
    return new DeepSeekProvider({
      apiKey: settings.deepseekApiKey,
      model: settings.modelName,
      baseUrl: settings.deepseekBaseUrl,
      timeoutMs: settings.modelTimeoutSeconds * 1000,
      retryMaxAttempts: settings.retryMaxAttempts,
      retryBaseDelayMs: settings.retryBaseDelayMs,
      reasoningProfile: settings.reasoningProfile,
    });
  }
  return new FakeProvider({ modelName: settings.modelName || "fake-model" });
}

export interface BuildDeps {
  /** Override provider selection (used by tests to script a FakeProvider). */
  provider?: ModelProvider;
  /** Override the harness adapter (used by tests). */
  harness?: HarnessAdapter;
  /** App-level secret used to sign and verify approval tokens. */
  approvalSigningSecret?: string;
}

export function buildApp(overrides: SettingsOverrides = {}, deps: BuildDeps = {}): App {
  const settings = validateSettings(loadSettings(overrides));
  const secrets = collectSecrets(settings);
  const logger = new Logger(settings.logLevel, secrets);
  const metrics = new InMemoryMetrics();
  const sanitizer = new SecretSanitizer(secrets);
  const approvalSigningSecret = deps.approvalSigningSecret ?? randomBytes(32).toString("hex");

  const provider = deps.provider ?? createModelProvider(settings);
  const gateway = new ModelGateway(provider);
  const store = new SessionStore(settings.dbPath, sanitizer);

  const registry = new ToolRegistry();
  const harness = deps.harness ?? new HarnessStubAdapter({ verificationSecret: approvalSigningSecret });
  registerBuiltinTools(registry, harness);

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
    gateway,
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

  return {
    config: settings,
    logger,
    metrics,
    gateway,
    store,
    conversation,
    memory,
    sanitizePublicError: (error: unknown) => sanitizePublicError(error, sanitizer),
    close: () => {
      store.close();
      memory.close();
    },
  };
}