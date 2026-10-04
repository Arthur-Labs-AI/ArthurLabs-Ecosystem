/**
 * Cognitive contracts.
 *
 * Seed shape of the knowledge model. The Cognitive Store (`src/cognitive/store`)
 * is the authoritative owner of these objects; Memory/RAG only holds a
 * retrieval projection of them.
 */

export const KNOWLEDGE_OBJECT_KINDS = ["idea", "task", "decision", "question", "note"] as const;

export type KnowledgeObjectKind = (typeof KNOWLEDGE_OBJECT_KINDS)[number];

export interface KnowledgeObject {
  id: string;
  kind: KnowledgeObjectKind;
  title: string;
  body: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
}
