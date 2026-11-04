/**
 * Session-aware memory facade (spec sections 30, 32).
 *
 * The HTTP API and CLI depend on this facade, never on MemoryGateway stores
 * directly. The domain is resolved server-side from the session record; no
 * method accepts a caller-supplied domain, database, namespace, or
 * context_key.
 */

import { sessionNotFound } from "../core/errors/errors";
import { newTraceId } from "../observability/tracing";
import type { SessionStore } from "../sessions/store";
import type { MemoryGateway } from "./gateway";
import {
  DocumentRequest,
  DocumentResult,
  MemoryItem,
  MemoryItemSummary,
  MemoryListFilter,
  MemoryStatusReport,
  RememberRequest,
  RetrievedMemory,
  RetrievalRequest,
  TrustedSessionContext,
} from "./contracts";

export class MemoryService {
  private readonly gateway: MemoryGateway;
  private readonly sessions: SessionStore;

  constructor(gateway: MemoryGateway, sessions: SessionStore) {
    this.gateway = gateway;
    this.sessions = sessions;
  }

  /** Build the trusted context; session must exist and mode is server-owned. */
  private trusted(sessionId: string, traceId: string): TrustedSessionContext {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw sessionNotFound(sessionId);
    return { session, trace_id: traceId };
  }

  remember(sessionId: string, request: RememberRequest, traceId = newTraceId()): Promise<MemoryItem> {
    return this.gateway.remember(this.trusted(sessionId, traceId), request);
  }

  search(sessionId: string, request: RetrievalRequest, traceId = newTraceId()): Promise<RetrievedMemory[]> {
    return this.gateway.retrieve(this.trusted(sessionId, traceId), request);
  }

  list(sessionId: string, filter: MemoryListFilter, traceId = newTraceId()): Promise<MemoryItemSummary[]> {
    return this.gateway.list(this.trusted(sessionId, traceId), filter);
  }

  forget(sessionId: string, memoryId: string, traceId = newTraceId()): Promise<void> {
    return this.gateway.forget(this.trusted(sessionId, traceId), memoryId);
  }

  ingestDocument(sessionId: string, request: DocumentRequest, clientRequestId: string, traceId = newTraceId()): Promise<DocumentResult> {
    return this.gateway.ingestDocument(this.trusted(sessionId, traceId), request, clientRequestId);
  }

  getDocument(sessionId: string, documentId: string, traceId = newTraceId()): Promise<DocumentResult | null> {
    return this.gateway.getDocument(this.trusted(sessionId, traceId), documentId);
  }

  listDocuments(sessionId: string, traceId = newTraceId()): Promise<DocumentResult[]> {
    return this.gateway.listDocuments(this.trusted(sessionId, traceId));
  }

  deleteDocument(sessionId: string, documentId: string, traceId = newTraceId()): Promise<{ deletedMemories: number; deletedChunks: number }> {
    return this.gateway.deleteDocument(this.trusted(sessionId, traceId), documentId);
  }

  status(sessionId?: string): MemoryStatusReport {
    if (sessionId !== undefined) {
      this.trusted(sessionId, "memory-status");
    }
    return this.gateway.status();
  }

  close(): void {
    this.gateway.close();
  }
}
