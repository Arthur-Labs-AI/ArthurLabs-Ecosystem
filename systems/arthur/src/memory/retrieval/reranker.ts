/**
 * Lightweight local reranker (spec section 15.2).
 *
 * Deterministic heuristic adjustments on top of the fused score:
 *  - importance: bounded boost
 *  - recency: small boost for recent EPISODIC memories
 *  - confidence: low-confidence extracted memories are downweighted
 *  - project match: strong boost when the query carries a known project key
 */

import { MemoryItemSummary, MemoryType } from "../contracts";
import type { FusedChunk } from "./fusion";

export interface RerankOptions {
  projectKey?: string;
  now?: Date;
}

export interface RerankedMemory extends FusedChunk {
  summary: MemoryItemSummary;
  finalScore: number;
}

const IMPORTANCE_BOOST_MAX = 0.5;
const RECENCY_DAYS = 7;
const RECENCY_BOOST = 0.1;
const PROJECT_BOOST = 1.5;
const LOW_CONFIDENCE = 0.6;
const LOW_CONFIDENCE_FACTOR = 0.75;

export function rerankMemories(
  candidates: FusedChunk[],
  summaries: Map<string, MemoryItemSummary>,
  opts: RerankOptions = {},
): RerankedMemory[] {
  const now = opts.now ?? new Date();
  const ranked: RerankedMemory[] = [];
  for (const candidate of candidates) {
    const summary = summaries.get(candidate.memoryId);
    if (!summary) continue; // item disappeared between fusion and rerank
    let score = candidate.score;
    score += summary.importance * IMPORTANCE_BOOST_MAX;
    if (summary.type === MemoryType.EPISODIC) {
      const ageMs = now.getTime() - Date.parse(summary.created_at);
      if (ageMs >= 0 && ageMs < RECENCY_DAYS * 24 * 3600 * 1000) score += RECENCY_BOOST;
    }
    if (summary.confidence < LOW_CONFIDENCE) score *= LOW_CONFIDENCE_FACTOR;
    if (opts.projectKey && summary.project_key === opts.projectKey) score += PROJECT_BOOST;
    ranked.push({ ...candidate, summary, finalScore: score });
  }
  return ranked.sort(
    (a, b) =>
      b.finalScore - a.finalScore ||
      (a.summary.created_at < b.summary.created_at ? 1 : -1) ||
      (a.memoryId < b.memoryId ? -1 : 1),
  );
}
