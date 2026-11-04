/**
 * Post-turn memory extraction hook (spec sections 20, 36).
 *
 * Runs after a completed conversation turn when extraction is enabled. It is
 * a bounded, schema-validated structured task over same-mode sanitized
 * transcript text; failures never affect the conversation response.
 */

import { Logger } from "../../observability/logging";
import { Metrics } from "../../observability/metrics";
import type { TurnRecord } from "../../sessions/models";
import type { SessionRecord } from "../../sessions/models";
import type { MemoryGateway } from "../gateway";
import { MemoryExtractor } from "./memory_extractor";

export interface TurnMemoryExtractorDeps {
  extractor: MemoryExtractor;
  gateway: MemoryGateway;
  enabled: boolean;
  logger: Logger;
  metrics: Metrics;
}

export interface TurnExtractionInput {
  session: SessionRecord;
  turnId: string;
  traceId: string;
  userMessage: string;
  assistantText: string;
  history: TurnRecord[];
}

export class TurnMemoryExtractor {
  private readonly extractor: MemoryExtractor;
  private readonly gateway: MemoryGateway;
  private readonly enabled: boolean;
  private readonly logger: Logger;
  private readonly metrics: Metrics;

  constructor(deps: TurnMemoryExtractorDeps) {
    this.extractor = deps.extractor;
    this.gateway = deps.gateway;
    this.enabled = deps.enabled;
    this.logger = deps.logger;
    this.metrics = deps.metrics;
  }

  async run(input: TurnExtractionInput): Promise<void> {
    if (!this.enabled) return;
    try {
      const result = await this.extractor.extract({
        mode: input.session.mode,
        history: input.history,
        userMessage: input.userMessage,
        assistantText: input.assistantText,
        traceId: input.traceId,
        sessionId: input.session.id,
      });
      if (result.malformed) {
        this.metrics.counter("arthur.memory.extraction", 1, { outcome: "malformed" });
        this.logger.warn("memory extraction output was malformed and discarded", {
          session_id: input.session.id,
          trace_id: input.traceId,
        });
        return;
      }
      this.metrics.counter("arthur.memory.extraction", result.candidates.length, { outcome: "stored" });
      for (const candidate of result.candidates) {
        await this.gateway.storeCandidate(
          { session: input.session, trace_id: input.traceId },
          { ...candidate, source_id: input.turnId },
        );
      }
    } catch (error) {
      // Extraction must never break the conversation turn (spec section 36).
      this.metrics.counter("arthur.memory.extraction", 1, { outcome: "failed" });
      this.logger.warn("memory extraction failed; conversation continues without memory", {
        session_id: input.session.id,
        trace_id: input.traceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}