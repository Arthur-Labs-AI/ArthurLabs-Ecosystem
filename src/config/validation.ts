/**
 * Startup configuration validation (spec section 15).
 *
 * Fails with actionable messages before any service starts. Never echoes
 * secret values.
 */

import { resolve } from "node:path";

import { ArthurError } from "../core/errors/errors";
import { validateVoiceSettings } from "../voice/config";
import type { Settings } from "./settings";

const ENVS = ["development", "test", "production"];
const PROVIDERS = ["deepseek", "fake"];
const EMBEDDING_PROVIDERS = ["local_multilingual", "fake"];
const LOG_LEVELS = ["debug", "info", "warn", "error"];
const REASONING_PROFILES = ["fast", "normal", "deep"];

function fail(message: string): never {
  throw new ArthurError("INVALID_CONFIG", message);
}

/**
 * Canonical form used to prove the two memory databases are physically
 * distinct. Mirrors SqliteMemoryStore's ":memory:" special case (each
 * ":memory:" handle is its own private in-memory database), resolves the
 * path to an absolute form so different relative spellings of the same file
 * compare equal, and folds case on Windows where the filesystem is
 * case-insensitive.
 */
function canonicalMemoryDbPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === ":memory:") return trimmed;
  const absolute = resolve(trimmed);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export function validateSettings(settings: Settings): Settings {
  const problems: string[] = [];

  if (!ENVS.includes(settings.env)) {
    problems.push(`ARTHUR_ENV must be one of ${ENVS.join(", ")} (got "${settings.env}")`);
  }
  if (!settings.dbPath || settings.dbPath.trim() === "") {
    problems.push("ARTHUR_DB_PATH must be a non-empty path");
  }
  if (!PROVIDERS.includes(settings.modelProvider)) {
    problems.push(`ARTHUR_MODEL_PROVIDER must be one of ${PROVIDERS.join(", ")} (got "${settings.modelProvider}")`);
  }
  if (!LOG_LEVELS.includes(settings.logLevel)) {
    problems.push(`ARTHUR_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")} (got "${settings.logLevel}")`);
  }
  if (!REASONING_PROFILES.includes(settings.reasoningProfile)) {
    problems.push(`ARTHUR_REASONING_PROFILE must be one of ${REASONING_PROFILES.join(", ")}`);
  }
  if (!Number.isInteger(settings.bindPort) || settings.bindPort < 1 || settings.bindPort > 65535) {
    problems.push(`ARTHUR_BIND_PORT must be an integer between 1 and 65535 (got "${settings.bindPort}")`);
  }
  if (settings.modelTimeoutSeconds <= 0) {
    problems.push("ARTHUR_MODEL_TIMEOUT_SECONDS must be > 0");
  }
  if (settings.historyMaxTurns < 1) {
    problems.push("ARTHUR_HISTORY_MAX_TURNS must be >= 1");
  }
  if (settings.contextTokenBudget < 1) {
    problems.push("ARTHUR_CONTEXT_TOKEN_BUDGET must be >= 1");
  }
  if (settings.retryMaxAttempts < 0) {
    problems.push("ARTHUR_MODEL_RETRY_MAX_ATTEMPTS must be >= 0");
  }
  if (settings.retryBaseDelayMs < 0) {
    problems.push("ARTHUR_MODEL_RETRY_BASE_DELAY_MS must be >= 0");
  }
  if (settings.approvalTtlSeconds < 1) {
    problems.push("ARTHUR_APPROVAL_TTL_SECONDS must be >= 1");
  }
  if (settings.maxMessageChars < 1) {
    problems.push("ARTHUR_MAX_MESSAGE_CHARS must be >= 1");
  }
  if (!settings.memoryPersonalDbPath || settings.memoryPersonalDbPath.trim() === "") {
    problems.push("ARTHUR_MEMORY_PERSONAL_DB_PATH must be a non-empty path");
  }
  if (!settings.memoryBusinessDbPath || settings.memoryBusinessDbPath.trim() === "") {
    problems.push("ARTHUR_MEMORY_BUSINESS_DB_PATH must be a non-empty path");
  }
  // Physical isolation (Phase 2 audit): both stores open their configured
  // database file directly, and memory_sources / ingestion_requests carry no
  // domain column. If both paths resolve to the same canonical file, source
  // metadata and ingestion state silently cross the Personal/Business
  // boundary - fail startup instead.
  if (settings.memoryPersonalDbPath.trim() !== "" && settings.memoryBusinessDbPath.trim() !== "") {
    const personalDb = canonicalMemoryDbPath(settings.memoryPersonalDbPath);
    const businessDb = canonicalMemoryDbPath(settings.memoryBusinessDbPath);
    if (personalDb !== ":memory:" && businessDb !== ":memory:" && personalDb === businessDb) {
      problems.push(
        `ARTHUR_MEMORY_PERSONAL_DB_PATH and ARTHUR_MEMORY_BUSINESS_DB_PATH resolve to the same file (${personalDb}): Personal and Business memory databases must use different physical files`,
      );
    }
  }
  if (!EMBEDDING_PROVIDERS.includes(settings.embeddingProvider)) {
    problems.push(`ARTHUR_EMBEDDING_PROVIDER must be one of ${EMBEDDING_PROVIDERS.join(", ")} (got "${settings.embeddingProvider}")`);
  }
  if (!settings.embeddingModel || settings.embeddingModel.trim() === "") {
    problems.push("ARTHUR_EMBEDDING_MODEL must be a non-empty identifier");
  }
  if (!Number.isInteger(settings.embeddingDimensions) || settings.embeddingDimensions < 16 || settings.embeddingDimensions > 2048) {
    problems.push("ARTHUR_EMBEDDING_DIMENSIONS must be an integer between 16 and 2048");
  }
  if (settings.memoryMaxRetrievalCandidates < 1) {
    problems.push("ARTHUR_MEMORY_MAX_RETRIEVAL_CANDIDATES must be >= 1");
  }
  if (settings.memoryMaxRerankedResults < 1) {
    problems.push("ARTHUR_MEMORY_MAX_RERANKED_RESULTS must be >= 1");
  }
  if (settings.memoryMaxRetrievalCandidates < settings.memoryMaxRerankedResults) {
    problems.push("ARTHUR_MEMORY_MAX_RETRIEVAL_CANDIDATES must be >= ARTHUR_MEMORY_MAX_RERANKED_RESULTS");
  }
  if (settings.memoryMaxContextTokens < 1) {
    problems.push("ARTHUR_MEMORY_MAX_CONTEXT_TOKENS must be >= 1");
  }
  if (settings.memoryMaxSingleChunkTokens < 1) {
    problems.push("ARTHUR_MEMORY_MAX_SINGLE_CHUNK_TOKENS must be >= 1");
  }
  if (settings.memoryVectorMinSimilarity < 0 || settings.memoryVectorMinSimilarity > 1) {
    problems.push("ARTHUR_MEMORY_VECTOR_MIN_SIMILARITY must be within 0..1");
  }
  if (
    settings.memoryExtractionConfidenceThreshold < 0 ||
    settings.memoryExtractionConfidenceThreshold > 1 ||
    settings.memoryExtractionImportanceThreshold < 0 ||
    settings.memoryExtractionImportanceThreshold > 1
  ) {
    problems.push("ARTHUR_MEMORY_EXTRACTION_CONFIDENCE_THRESHOLD and ARTHUR_MEMORY_EXTRACTION_IMPORTANCE_THRESHOLD must be within 0..1");
  }
  if (settings.memoryTemporaryTtlSeconds < 1) {
    problems.push("ARTHUR_MEMORY_TEMPORARY_TTL_SECONDS must be >= 1");
  }

  // Phase 3 voice settings. Missing engines/devices never fail startup: the
  // voice layer reports component unavailability and degrades to text/PTT
  // (spec section 33 "Failure handling"). Only malformed configuration fails.
  if (settings.voice) {
    problems.push(...validateVoiceSettings(settings.voice));
  }

  // Provider-specific requirements (fail closed, spec section 3 "Fail closed").
  if (settings.modelProvider === "deepseek") {
    if (!settings.modelName || settings.modelName.trim() === "") {
      problems.push("ARTHUR_MODEL_NAME is required when ARTHUR_MODEL_PROVIDER=deepseek");
    }
    if (!settings.deepseekApiKey || settings.deepseekApiKey.trim() === "") {
      problems.push("DEEPSEEK_API_KEY is required when ARTHUR_MODEL_PROVIDER=deepseek (set it in the environment or .env)");
    }
  } else {
    if (!settings.modelName || settings.modelName.trim() === "") {
      settings.modelName = "fake-model";
    }
  }

  if (problems.length > 0) {
    fail(`Configuration validation failed:\n- ${problems.join("\n- ")}`);
  }

  return settings;
}