/**
 * Deduplication + supersession trigger (spec sections 21, 22).
 *
 * Order: normalize -> exact content_hash -> same-subject/type semantic
 * similarity -> update provenance (equivalent) | supersede (explicit
 * correction) | create. Superseded memories remain in the store for audit but
 * are excluded from normal retrieval.
 */

import { cosineSimilarity, EmbeddingBatch, EmbeddingGateway } from "./embeddings/contracts";
import {
  MemoryItem,
  MemoryStore,
  MemoryType,
  MemoryWrite,
} from "./contracts";
import { normalizeForCompare } from "./ingestion/normalizer";

export type DedupeAction = "created" | "updated" | "superseded";

export interface DedupeOutcome {
  action: DedupeAction;
  item: MemoryItem;
  /** Canonical-text embedding batch (for chunk reuse by the caller). */
  batch: EmbeddingBatch;
}

/** Semantic similarity above this = same fact rephrased. */
export const SAME_FACT_SIMILARITY = 0.85;
/** Below this, same-subject texts are treated as unrelated (both kept). */
export const MIN_RELATED_SIMILARITY = 0.5;

const SUBJECT_SCOPED_TYPES: readonly MemoryType[] = [
  MemoryType.SEMANTIC,
  MemoryType.PROJECT,
  MemoryType.PROCEDURAL,
  MemoryType.EPISODIC,
];

/** Words that may differ between two phrasings of the same fact. */
const STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "were", "will", "would", "about",
  "their", "there", "which", "when", "than", "then", "them", "they", "your",
  "ours", "yours", "hers", "their", "being", "been", "into", "over", "only",
  "very", "just", "also", "more", "most", "some", "such", "each", "both",
  "these", "those", "while", "after", "before", "between", "during",
]);

/** Token-level content difference (words of >= 4 chars, excluding stopwords). */
function contentDifference(a: string, b: string): string[] {
  const tokensA = new Set(normalizeForCompare(a).split(/\s+/).filter(Boolean));
  const tokensB = new Set(normalizeForCompare(b).split(/\s+/).filter(Boolean));
  const diff = new Set<string>([...tokensA, ...tokensB].filter((t) => !(tokensA.has(t) && tokensB.has(t))));
  return [...diff].filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

export class DedupeService {
  private readonly embeddings: EmbeddingGateway;

  constructor(embeddings: EmbeddingGateway) {
    this.embeddings = embeddings;
  }

  /**
   * Resolve a new memory write against the domain store. When the write is
   * created or supersedes an old memory, the returned item is the persisted
   * ACTIVE item and the caller is responsible for writing its chunks.
   */
  async resolve(store: MemoryStore, write: MemoryWrite): Promise<DedupeOutcome> {
    // 1. Exact content hash — the dominant duplicate signal (no embedding needed).
    const exact = await store.findActiveByHash(write.content_hash);
    if (exact) {
      await store.touchVerified(exact.id);
      return {
        action: "updated",
        item: exact,
        batch: { provider: "", model: write.embedding_model, version: write.embedding_version, dimensions: 0, vectors: [] },
      };
    }

    // 2. Embed canonical text once; stamp model/version on the write.
    const batch = await this.embeddings.embed([write.canonical_text]);
    const queryVector = batch.vectors[0] ?? [];
    write.embedding_model = batch.model;
    write.embedding_version = batch.version;

    // 3. Same subject + type semantic comparison.
    if (write.subject_key && SUBJECT_SCOPED_TYPES.includes(write.type)) {
      const candidates = await store.findActiveBySubject(write.subject_key, write.type);
      if (candidates.length > 0) {
        const candidateBatch = await this.embeddings.embed(candidates.map((candidate) => candidate.canonical_text));
        let best: { item: MemoryItem; similarity: number } | undefined;
        for (let i = 0; i < candidates.length; i++) {
          const similarity = cosineSimilarity(queryVector, candidateBatch.vectors[i] ?? []);
          if (!best || similarity > best.similarity) {
            best = { item: candidates[i] as MemoryItem, similarity };
          }
        }
        if (best && best.similarity >= SAME_FACT_SIMILARITY) {
          // Highly similar: same fact unless a content word changed (correction).
          const contentDiff = contentDifference(write.canonical_text, best.item.canonical_text);
          if (contentDiff.length === 0 || write.source_type !== "USER_EXPLICIT") {
            await store.touchVerified(best.item.id);
            return { action: "updated", item: best.item, batch };
          }
          // Explicit user correction with a new content word: supersede.
          const replacement = await store.supersede(best.item.id, write);
          return { action: "superseded", item: replacement, batch };
        }
        if (best && best.similarity >= MIN_RELATED_SIMILARITY) {
          if (write.source_type === "USER_EXPLICIT") {
            // Explicit user statements are corrections with authority over
            // older memories.
            const replacement = await store.supersede(best.item.id, write);
            return { action: "superseded", item: replacement, batch };
          }
          // Re-verified inference: update provenance instead of duplicating.
          await store.touchVerified(best.item.id);
          return { action: "updated", item: best.item, batch };
        }
      }
    }

    // 4. New memory.
    const item = await store.put(write);
    return { action: "created", item, batch };
  }
}