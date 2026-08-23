/**
 * Configuration loading (spec section 15).
 *
 * All values come from environment variables (optionally seeded from `.env`).
 * Secrets are held in memory only and are never logged.
 */

import type { ReasoningProfile } from "../models/contracts";
import { DEFAULT_VOICE_SETTINGS, loadVoiceSettings, VoiceSettings, VoiceSettingsOverrides } from "../voice/config";

export type ModelProviderId = "deepseek" | "fake";
export type EmbeddingProviderId = "local_multilingual" | "fake";

export interface Settings {
  env: string;
  dbPath: string;
  modelProvider: ModelProviderId;
  modelName: string;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  modelTimeoutSeconds: number;
  historyMaxTurns: number;
  reasoningProfile: ReasoningProfile;
  contextTokenBudget: number;
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  approvalTtlSeconds: number;
  logLevel: string;
  bindHost: string;
  bindPort: number;
  maxMessageChars: number;
  version: string;
  // ---- Phase 2 memory / RAG ----
  memoryPersonalDbPath: string;
  memoryBusinessDbPath: string;
  embeddingProvider: EmbeddingProviderId;
  embeddingModel: string;
  embeddingDimensions: number;
  memoryMaxRetrievalCandidates: number;
  memoryMaxRerankedResults: number;
  memoryMaxContextTokens: number;
  memoryMaxSingleChunkTokens: number;
  memoryVectorMinSimilarity: number;
  memoryExtractionEnabled: boolean;
  memoryExtractionConfidenceThreshold: number;
  memoryExtractionImportanceThreshold: number;
  memoryTemporaryTtlSeconds: number;
  // ---- Phase 3 local voice layer ----
  voice: VoiceSettings;
}

const DEFAULTS_MAP: Settings = {
  env: "development",
  dbPath: "./data/arthur.db",
  modelProvider: "fake",
  modelName: "",
  deepseekApiKey: "",
  deepseekBaseUrl: "https://api.deepseek.com",
  modelTimeoutSeconds: 60,
  historyMaxTurns: 20,
  reasoningProfile: "normal",
  contextTokenBudget: 8000,
  retryMaxAttempts: 3,
  retryBaseDelayMs: 250,
  approvalTtlSeconds: 300,
  logLevel: "info",
  bindHost: "127.0.0.1",
  bindPort: 8080,
  maxMessageChars: 8000,
  version: "0.1.0",
  memoryPersonalDbPath: "./data/memory-personal.db",
  memoryBusinessDbPath: "./data/memory-business.db",
  embeddingProvider: "local_multilingual",
  embeddingModel: "arthur-ngram-v1",
  embeddingDimensions: 384,
  memoryMaxRetrievalCandidates: 40,
  memoryMaxRerankedResults: 12,
  memoryMaxContextTokens: 1200,
  memoryMaxSingleChunkTokens: 300,
  memoryVectorMinSimilarity: 0.5,
  memoryExtractionEnabled: false,
  memoryExtractionConfidenceThreshold: 0.6,
  memoryExtractionImportanceThreshold: 0.2,
  memoryTemporaryTtlSeconds: 86400,
  voice: DEFAULT_VOICE_SETTINGS,
};

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return v;
}

function envInt(key: string, fallback: number): number {
  const raw = envStr(key, String(fallback));
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return n;
}

function envFloat(key: string, fallback: number): number {
  const raw = envStr(key, String(fallback));
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) return fallback;
  return n;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = envStr(key, "").toLowerCase();
  if (raw === "") return fallback;
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

/**
 * Optionally load a `.env` file from `cwd` if present. Missing file is not an
 * error (env may be provided by the process environment directly).
 */
export function loadDotEnv(path = ".env"): void {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    if (fs.existsSync(path)) {
      (process as unknown as { loadEnvFile(p: string): void }).loadEnvFile(path);
    }
  } catch {
    // .env is optional; ignore any load error.
  }
}

export type SettingsOverrides = {
  [key: string]: string | number | boolean | undefined | VoiceSettingsOverrides;
  env?: string;
  dbPath?: string;
  modelProvider?: string;
  modelName?: string;
  deepseekApiKey?: string;
  deepseekBaseUrl?: string;
  modelTimeoutSeconds?: number;
  historyMaxTurns?: number;
  reasoningProfile?: string;
  contextTokenBudget?: number;
  retryMaxAttempts?: number;
  retryBaseDelayMs?: number;
  approvalTtlSeconds?: number;
  logLevel?: string;
  bindHost?: string;
  bindPort?: number;
  maxMessageChars?: number;
  memoryPersonalDbPath?: string;
  memoryBusinessDbPath?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  memoryMaxRetrievalCandidates?: number;
  memoryMaxRerankedResults?: number;
  memoryMaxContextTokens?: number;
  memoryMaxSingleChunkTokens?: number;
  memoryVectorMinSimilarity?: number;
  memoryExtractionEnabled?: boolean;
  memoryExtractionConfidenceThreshold?: number;
  memoryExtractionImportanceThreshold?: number;
  memoryTemporaryTtlSeconds?: number;
  /** Phase 3 voice settings (nested override object; flattened env in .env). */
  voice?: VoiceSettingsOverrides;
}

export function loadSettings(overrides: SettingsOverrides = {}): Settings {
  const raw: Record<string, string | number> = {
    ARTHUR_ENV: envStr("ARTHUR_ENV", DEFAULTS_MAP.env),
    ARTHUR_DB_PATH: envStr("ARTHUR_DB_PATH", DEFAULTS_MAP.dbPath),
    ARTHUR_MODEL_PROVIDER: envStr("ARTHUR_MODEL_PROVIDER", DEFAULTS_MAP.modelProvider),
    ARTHUR_MODEL_NAME: envStr("ARTHUR_MODEL_NAME", DEFAULTS_MAP.modelName),
    DEEPSEEK_API_KEY: envStr("DEEPSEEK_API_KEY", DEFAULTS_MAP.deepseekApiKey),
    DEEPSEEK_BASE_URL: envStr("DEEPSEEK_BASE_URL", DEFAULTS_MAP.deepseekBaseUrl),
    ARTHUR_MODEL_TIMEOUT_SECONDS: envInt("ARTHUR_MODEL_TIMEOUT_SECONDS", DEFAULTS_MAP.modelTimeoutSeconds),
    ARTHUR_HISTORY_MAX_TURNS: envInt("ARTHUR_HISTORY_MAX_TURNS", DEFAULTS_MAP.historyMaxTurns),
    ARTHUR_REASONING_PROFILE: envStr("ARTHUR_REASONING_PROFILE", DEFAULTS_MAP.reasoningProfile),
    ARTHUR_CONTEXT_TOKEN_BUDGET: envInt("ARTHUR_CONTEXT_TOKEN_BUDGET", DEFAULTS_MAP.contextTokenBudget),
    ARTHUR_MODEL_RETRY_MAX_ATTEMPTS: envInt("ARTHUR_MODEL_RETRY_MAX_ATTEMPTS", DEFAULTS_MAP.retryMaxAttempts),
    ARTHUR_MODEL_RETRY_BASE_DELAY_MS: envInt("ARTHUR_MODEL_RETRY_BASE_DELAY_MS", DEFAULTS_MAP.retryBaseDelayMs),
    ARTHUR_APPROVAL_TTL_SECONDS: envInt("ARTHUR_APPROVAL_TTL_SECONDS", DEFAULTS_MAP.approvalTtlSeconds),
    ARTHUR_LOG_LEVEL: envStr("ARTHUR_LOG_LEVEL", DEFAULTS_MAP.logLevel),
    ARTHUR_BIND_HOST: envStr("ARTHUR_BIND_HOST", DEFAULTS_MAP.bindHost),
    ARTHUR_BIND_PORT: envInt("ARTHUR_BIND_PORT", DEFAULTS_MAP.bindPort),
    ARTHUR_MAX_MESSAGE_CHARS: envInt("ARTHUR_MAX_MESSAGE_CHARS", DEFAULTS_MAP.maxMessageChars),
    ARTHUR_MEMORY_PERSONAL_DB_PATH: envStr("ARTHUR_MEMORY_PERSONAL_DB_PATH", DEFAULTS_MAP.memoryPersonalDbPath),
    ARTHUR_MEMORY_BUSINESS_DB_PATH: envStr("ARTHUR_MEMORY_BUSINESS_DB_PATH", DEFAULTS_MAP.memoryBusinessDbPath),
    ARTHUR_EMBEDDING_PROVIDER: envStr("ARTHUR_EMBEDDING_PROVIDER", DEFAULTS_MAP.embeddingProvider),
    ARTHUR_EMBEDDING_MODEL: envStr("ARTHUR_EMBEDDING_MODEL", DEFAULTS_MAP.embeddingModel),
    ARTHUR_EMBEDDING_DIMENSIONS: envInt("ARTHUR_EMBEDDING_DIMENSIONS", DEFAULTS_MAP.embeddingDimensions),
    ARTHUR_MEMORY_MAX_RETRIEVAL_CANDIDATES: envInt("ARTHUR_MEMORY_MAX_RETRIEVAL_CANDIDATES", DEFAULTS_MAP.memoryMaxRetrievalCandidates),
    ARTHUR_MEMORY_MAX_RERANKED_RESULTS: envInt("ARTHUR_MEMORY_MAX_RERANKED_RESULTS", DEFAULTS_MAP.memoryMaxRerankedResults),
    ARTHUR_MEMORY_MAX_CONTEXT_TOKENS: envInt("ARTHUR_MEMORY_MAX_CONTEXT_TOKENS", DEFAULTS_MAP.memoryMaxContextTokens),
    ARTHUR_MEMORY_MAX_SINGLE_CHUNK_TOKENS: envInt("ARTHUR_MEMORY_MAX_SINGLE_CHUNK_TOKENS", DEFAULTS_MAP.memoryMaxSingleChunkTokens),
    ARTHUR_MEMORY_VECTOR_MIN_SIMILARITY: envFloat("ARTHUR_MEMORY_VECTOR_MIN_SIMILARITY", DEFAULTS_MAP.memoryVectorMinSimilarity),
    ARTHUR_MEMORY_EXTRACTION_ENABLED: envBool("ARTHUR_MEMORY_EXTRACTION_ENABLED", DEFAULTS_MAP.memoryExtractionEnabled) ? "true" : "false",
    ARTHUR_MEMORY_EXTRACTION_CONFIDENCE_THRESHOLD: envFloat("ARTHUR_MEMORY_EXTRACTION_CONFIDENCE_THRESHOLD", DEFAULTS_MAP.memoryExtractionConfidenceThreshold),
    ARTHUR_MEMORY_EXTRACTION_IMPORTANCE_THRESHOLD: envFloat("ARTHUR_MEMORY_EXTRACTION_IMPORTANCE_THRESHOLD", DEFAULTS_MAP.memoryExtractionImportanceThreshold),
    ARTHUR_MEMORY_TEMPORARY_TTL_SECONDS: envInt("ARTHUR_MEMORY_TEMPORARY_TTL_SECONDS", DEFAULTS_MAP.memoryTemporaryTtlSeconds),
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const upper = key
      .replace(/[A-Z]/g, (m) => `_${m}`)
      .toUpperCase()
      .replace(/^_/, "");
    const envKey = `ARTHUR_${upper}` === "ARTHUR_DEEPSEEK" ? "DEEPSEEK_API_KEY" : `ARTHUR_${upper}`;
    if (envKey === "ARTHUR_DEEPSEEK_API_KEY") {
      raw["DEEPSEEK_API_KEY"] = String(value);
      continue;
    }
    if (envKey === "ARTHUR_DEEPSEEK_BASE_URL") {
      raw["DEEPSEEK_BASE_URL"] = String(value);
      continue;
    }
    if (raw[envKey] !== undefined) raw[envKey] = typeof value === "number" ? value : String(value);
  }

  return {
    env: String(raw["ARTHUR_ENV"]),
    dbPath: String(raw["ARTHUR_DB_PATH"]),
    modelProvider: String(raw["ARTHUR_MODEL_PROVIDER"]) as ModelProviderId,
    modelName: String(raw["ARTHUR_MODEL_NAME"]),
    deepseekApiKey: String(raw["DEEPSEEK_API_KEY"]),
    deepseekBaseUrl: String(raw["DEEPSEEK_BASE_URL"]),
    modelTimeoutSeconds: Number(raw["ARTHUR_MODEL_TIMEOUT_SECONDS"]),
    historyMaxTurns: Number(raw["ARTHUR_HISTORY_MAX_TURNS"]),
    reasoningProfile: String(raw["ARTHUR_REASONING_PROFILE"]) as ReasoningProfile,
    contextTokenBudget: Number(raw["ARTHUR_CONTEXT_TOKEN_BUDGET"]),
    retryMaxAttempts: Number(raw["ARTHUR_MODEL_RETRY_MAX_ATTEMPTS"]),
    retryBaseDelayMs: Number(raw["ARTHUR_MODEL_RETRY_BASE_DELAY_MS"]),
    approvalTtlSeconds: Number(raw["ARTHUR_APPROVAL_TTL_SECONDS"]),
    logLevel: String(raw["ARTHUR_LOG_LEVEL"]),
    bindHost: String(raw["ARTHUR_BIND_HOST"]),
    bindPort: Number(raw["ARTHUR_BIND_PORT"]),
    maxMessageChars: Number(raw["ARTHUR_MAX_MESSAGE_CHARS"]),
    version: DEFAULTS_MAP.version,
    memoryPersonalDbPath: String(raw["ARTHUR_MEMORY_PERSONAL_DB_PATH"]),
    memoryBusinessDbPath: String(raw["ARTHUR_MEMORY_BUSINESS_DB_PATH"]),
    embeddingProvider: String(raw["ARTHUR_EMBEDDING_PROVIDER"]) as EmbeddingProviderId,
    embeddingModel: String(raw["ARTHUR_EMBEDDING_MODEL"]),
    embeddingDimensions: Number(raw["ARTHUR_EMBEDDING_DIMENSIONS"]),
    memoryMaxRetrievalCandidates: Number(raw["ARTHUR_MEMORY_MAX_RETRIEVAL_CANDIDATES"]),
    memoryMaxRerankedResults: Number(raw["ARTHUR_MEMORY_MAX_RERANKED_RESULTS"]),
    memoryMaxContextTokens: Number(raw["ARTHUR_MEMORY_MAX_CONTEXT_TOKENS"]),
    memoryMaxSingleChunkTokens: Number(raw["ARTHUR_MEMORY_MAX_SINGLE_CHUNK_TOKENS"]),
    memoryVectorMinSimilarity: Number(raw["ARTHUR_MEMORY_VECTOR_MIN_SIMILARITY"]),
    memoryExtractionEnabled: String(raw["ARTHUR_MEMORY_EXTRACTION_ENABLED"]) === "true",
    memoryExtractionConfidenceThreshold: Number(raw["ARTHUR_MEMORY_EXTRACTION_CONFIDENCE_THRESHOLD"]),
    memoryExtractionImportanceThreshold: Number(raw["ARTHUR_MEMORY_EXTRACTION_IMPORTANCE_THRESHOLD"]),
    memoryTemporaryTtlSeconds: Number(raw["ARTHUR_MEMORY_TEMPORARY_TTL_SECONDS"]),
    voice: loadVoiceSettings(overrides as VoiceSettingsOverrides),
  };
}

/** List of known secrets from settings, for redaction. */
export function collectSecrets(settings: Settings): string[] {
  const secrets: string[] = [];
  if (settings.deepseekApiKey && settings.deepseekApiKey.length >= 4) {
    secrets.push(settings.deepseekApiKey);
  }
  return secrets;
}