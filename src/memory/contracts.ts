/**
 * ARTHUR Phase 2 memory contracts (spec sections 8, 9, 10, 15, 26, 29).
 *
 * Personal and Business memory live in separate physical stores. Every
 * contract below is domain-tagged only for validation/audit; the store handle
 * itself decides which physical database a write or read targets.
 */

import type { SessionRecord } from "../sessions/models";
import type { ArthurMode } from "../core/modes/mode";

// ---- Domains -------------------------------------------------------------

export const MemoryDomain = {
  PERSONAL: "personal",
  BUSINESS: "business",
} as const;

export type MemoryDomain = (typeof MemoryDomain)[keyof typeof MemoryDomain];

export function isMemoryDomain(value: unknown): value is MemoryDomain {
  return value === MemoryDomain.PERSONAL || value === MemoryDomain.BUSINESS;
}

/** A session mode is exactly a memory domain (1:1, enforced by the gateway). */
export function domainFromMode(mode: ArthurMode): MemoryDomain {
  if (mode === "personal") return MemoryDomain.PERSONAL;
  if (mode === "business") return MemoryDomain.BUSINESS;
  throw new Error(`Unknown mode: ${String(mode)}`);
}

// ---- Memory taxonomy (spec section 9) -------------------------------------

export const MemoryType = {
  EPISODIC: "EPISODIC",
  SEMANTIC: "SEMANTIC",
  PROJECT: "PROJECT",
  DOCUMENT: "DOCUMENT",
  PROCEDURAL: "PROCEDURAL",
  TEMPORARY: "TEMPORARY",
} as const;

export type MemoryType = (typeof MemoryType)[keyof typeof MemoryType];

export const MEMORY_TYPES: readonly MemoryType[] = [
  MemoryType.EPISODIC,
  MemoryType.SEMANTIC,
  MemoryType.PROJECT,
  MemoryType.DOCUMENT,
  MemoryType.PROCEDURAL,
  MemoryType.TEMPORARY,
];

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

/** API-facing lowercase type names ("semantic" -> "SEMANTIC"). */
export const MEMORY_TYPE_BY_LABEL: Record<string, MemoryType> = {
  episodic: MemoryType.EPISODIC,
  semantic: MemoryType.SEMANTIC,
  project: MemoryType.PROJECT,
  document: MemoryType.DOCUMENT,
  procedural: MemoryType.PROCEDURAL,
  temporary: MemoryType.TEMPORARY,
};

export function parseMemoryTypeLabel(label: unknown): MemoryType | undefined {
  if (typeof label !== "string") return undefined;
  return MEMORY_TYPE_BY_LABEL[label.toLowerCase()];
}

export const MemorySourceType = {
  USER_EXPLICIT: "USER_EXPLICIT",
  CONVERSATION: "CONVERSATION",
  DOCUMENT: "DOCUMENT",
  TOOL: "TOOL",
  SYSTEM: "SYSTEM",
} as const;

export type MemorySourceType = (typeof MemorySourceType)[keyof typeof MemorySourceType];

export const MEMORY_SOURCE_TYPES: readonly MemorySourceType[] = [
  MemorySourceType.USER_EXPLICIT,
  MemorySourceType.CONVERSATION,
  MemorySourceType.DOCUMENT,
  MemorySourceType.TOOL,
  MemorySourceType.SYSTEM,
];

export const MemorySensitivity = {
  NORMAL: "NORMAL",
  PRIVATE: "PRIVATE",
  RESTRICTED: "RESTRICTED",
} as const;

export type MemorySensitivity = (typeof MemorySensitivity)[keyof typeof MemorySensitivity];

export const MEMORY_SENSITIVITIES: readonly MemorySensitivity[] = [
  MemorySensitivity.NORMAL,
  MemorySensitivity.PRIVATE,
  MemorySensitivity.RESTRICTED,
];

export const MemoryStatus = {
  ACTIVE: "ACTIVE",
  SUPERSEDED: "SUPERSEDED",
  DELETED: "DELETED",
  EXPIRED: "EXPIRED",
} as const;

export type MemoryStatus = (typeof MemoryStatus)[keyof typeof MemoryStatus];

export const MEMORY_STATUSES: readonly MemoryStatus[] = [
  MemoryStatus.ACTIVE,
  MemoryStatus.SUPERSEDED,
  MemoryStatus.DELETED,
  MemoryStatus.EXPIRED,
];

export function isMemoryStatus(value: unknown): value is MemoryStatus {
  return typeof value === "string" && (MEMORY_STATUSES as readonly string[]).includes(value);
}

// ---- Trusted context (spec section 8) -------------------------------------

export interface MemoryContext {
  domain: MemoryDomain;
  /** Server-generated key; callers can never supply it. */
  context_key: string;
  session_id: string;
  user_id: string;
  business_workspace_id?: string;
  trace_id: string;
}

/**
 * The only context shape accepted by MemoryGateway. It wraps a trusted
 * server-side session record; the gateway derives domain/context_key itself
 * so no caller can choose a store.
 */
export interface TrustedSessionContext {
  session: SessionRecord;
  trace_id: string;
}

export function memoryContextFromSession(session: SessionRecord, traceId: string): MemoryContext {
  return {
    domain: domainFromMode(session.mode),
    context_key: `${session.id}:${session.mode}`,
    session_id: session.id,
    // Phase 2 has a single local user; the contract allows real user scoping later.
    user_id: "local-user",
    business_workspace_id: undefined,
    trace_id: traceId,
  };
}

// ---- Data model (spec section 10) ------------------------------------------

export interface MemoryItem {
  id: string;
  domain: MemoryDomain;
  type: MemoryType;
  subject_key?: string;
  project_key?: string;
  source_type: MemorySourceType;
  source_id?: string;
  canonical_text: string;
  display_text: string;
  content_hash: string;
  confidence: number;
  importance: number;
  sensitivity: MemorySensitivity;
  status: MemoryStatus;
  supersedes_id?: string;
  created_at: string;
  updated_at: string;
  last_verified_at?: string;
  expires_at?: string;
  embedding_model: string;
  embedding_version: string;
}

export interface MemoryChunk {
  id: string;
  memory_id: string;
  ordinal: number;
  text: string;
  token_count: number;
  content_hash: string;
  embedding?: number[];
}

/** Input for persistence; the store stamps id/domain/status/timestamps. */
export interface MemoryWrite {
  /** Optional deterministic id (document ingestion); default: generated UUID. */
  id?: string;
  content_hash: string;
  type: MemoryType;
  subject_key?: string;
  project_key?: string;
  source_type: MemorySourceType;
  source_id?: string;
  canonical_text: string;
  display_text: string;
  confidence: number;
  importance: number;
  sensitivity?: MemorySensitivity;
  expires_at?: string;
  supersedes_id?: string;
  embedding_model: string;
  embedding_version: string;
}

export interface MemoryChunkWrite {
  ordinal: number;
  text: string;
  token_count: number;
  content_hash: string;
  embedding?: number[];
}

export interface MemoryItemSummary {
  id: string;
  type: MemoryType;
  text: string;
  status: MemoryStatus;
  confidence: number;
  importance: number;
  source_type: MemorySourceType;
  source_id?: string;
  subject_key?: string;
  project_key?: string;
  created_at: string;
  updated_at: string;
}

// ---- Retrieval (spec sections 14, 15, 29) ----------------------------------

export interface RetrievalFilter {
  domain: MemoryDomain;
  project_key?: string;
  subject_keys?: string[];
  allowed_types?: MemoryType[];
}

export interface MemoryQuery {
  context: MemoryContext;
  query_text: string;
  project_key?: string;
  subject_keys?: string[];
  allowed_types?: MemoryType[];
  top_k: number;
  max_context_tokens: number;
}

export interface RetrievedMemory {
  memory_id: string;
  type: MemoryType;
  text: string;
  score: number;
  confidence: number;
  source_type: string;
  source_id?: string;
  project_key?: string;
  created_at: string;
}

export interface KeywordQuery {
  text: string;
  filters: RetrievalFilter;
  limit: number;
}

export interface KeywordHit {
  chunk_id: string;
  memory_id: string;
  text: string;
  score: number;
}

export interface VectorQuery {
  vector: number[];
  filters: RetrievalFilter;
  limit: number;
  /** Minimum cosine similarity for a chunk to be a candidate (default 0). */
  min_similarity?: number;
}

export interface VectorHit {
  chunk_id: string;
  memory_id: string;
  text: string;
  score: number;
}

export interface MemoryListFilter {
  domain: MemoryDomain;
  status?: MemoryStatus;
  type?: MemoryType;
  project_key?: string;
  subject_key?: string;
  limit?: number;
  offset?: number;
}

// ---- Sources / documents ---------------------------------------------------

export interface MemorySourceRecord {
  id: string;
  source_type: MemorySourceType;
  source_external_id?: string;
  title?: string;
  source_hash: string;
  metadata_json?: string;
  created_at: string;
  updated_at: string;
}

export type DocumentSourceType = "text" | "markdown";

export interface DocumentRequest {
  title: string;
  source_type: DocumentSourceType;
  content: string;
  project_key?: string;
}

export interface DocumentResult {
  document_id: string;
  title: string;
  source_type: string;
  project_key?: string;
  memory_ids: string[];
  chunk_count: number;
  created_at: string;
  updated_at: string;
  status: string;
}

// ---- Ingestion idempotency (spec section 33) --------------------------------

export type IngestionState = "pending" | "writing" | "completed" | "failed";

export interface IngestionRecord {
  request_id: string;
  request_hash: string;
  state: IngestionState;
  result_id?: string;
  created_at: string;
  updated_at: string;
}

export type IngestionReservation =
  | { kind: "proceed" }
  | { kind: "completed"; resultId: string }
  | { kind: "conflict" };

// ---- Store (Appendix A, extended) -------------------------------------------

export interface MemoryStore {
  domain(): MemoryDomain;
  put(item: MemoryWrite): Promise<MemoryItem>;
  get(id: string): Promise<MemoryItem | null>;
  list(filter: MemoryListFilter): Promise<MemoryItemSummary[]>;
  keywordSearch(query: KeywordQuery): Promise<KeywordHit[]>;
  vectorSearch(query: VectorQuery): Promise<VectorHit[]>;
  supersede(oldId: string, replacement: MemoryWrite): Promise<MemoryItem>;
  forget(id: string): Promise<void>;
  putChunks(memoryId: string, chunks: MemoryChunkWrite[]): Promise<void>;
  /** Atomic document write: source + item + chunks + FTS in one transaction. */
  writeDocumentAtomic(input: { source: MemorySourceRecord; item: MemoryWrite; chunks: MemoryChunkWrite[] }): Promise<void>;
  getChunks(memoryId: string): Promise<MemoryChunk[]>;
  deleteChunks(memoryId: string): Promise<void>;
  putSource(source: MemorySourceRecord): Promise<void>;
  getSource(id: string): Promise<MemorySourceRecord | null>;
  listSources(): Promise<MemorySourceRecord[]>;
  deleteSource(id: string): Promise<{ deletedMemories: number; deletedChunks: number }>;
  reserveIngestion(requestId: string, requestHash: string): IngestionReservation;
  beginIngestion(requestId: string, requestHash: string): boolean;
  completeIngestion(requestId: string, resultId: string): void;
  failIngestion(requestId: string): void;
  getIngestion(requestId: string): IngestionRecord | null;
  /** Crash reconciliation: recover interrupted ingestion rows. */
  reconcileIngestions(): string[];
  touchVerified(id: string): void;
  expireDue(): number;
  findActiveByHash(contentHash: string): Promise<MemoryItem | null>;
  findActiveBySubject(subjectKey: string, type: MemoryType): Promise<MemoryItem[]>;
  health(): boolean;
  close(): void;
}

// ---- Request shapes for the gateway (spec section 26) ------------------------

export interface RememberRequest {
  text: string;
  type: MemoryType;
  subject_key?: string;
  project_key?: string;
  /** Optional client idempotency key (same key + same content -> one memory). */
  client_request_id?: string;
}

export interface RetrievalRequest {
  query_text: string;
  project_key?: string;
  subject_keys?: string[];
  allowed_types?: MemoryType[];
  top_k?: number;
  max_context_tokens?: number;
}

export type MemoryWriteReason = "explicit" | "extracted" | "document" | "system";

export interface MemoryStatusReport {
  personal: { state: "healthy" | "degraded" | "unavailable" };
  business: { state: "healthy" | "degraded" | "unavailable" };
  embedding: { provider: string; model: string; version: string; dimensions: number };
}
