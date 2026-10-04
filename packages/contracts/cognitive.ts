/**
 * Cognitive contracts.
 *
 * The Cognitive Store is the authoritative owner of these objects; Memory/RAG only
 * holds a retrieval projection of them. A `KnowledgeObject` is an INTERPRETATION of a
 * raw `Capture`: the capture stays immutable and every object points back at the exact
 * text it came from.
 */

export const KNOWLEDGE_OBJECT_KINDS = ["idea", "task", "decision", "question", "note"] as const;

export type KnowledgeObjectKind = (typeof KNOWLEDGE_OBJECT_KINDS)[number];

/**
 * Where in the raw capture an object came from.
 *
 * Offsets count Unicode code points (not UTF-16 units, not bytes) from the start of
 * `Capture.content`, as a half-open range: `[sourceStart, sourceEnd)`.
 */
export interface KnowledgeProvenance {
  captureId: string;
  sourceStart: number;
  sourceEnd: number;
}

export interface KnowledgeObject {
  /** Assigned by the store; unique and stable. */
  id: string;
  kind: KnowledgeObjectKind;
  title: string;
  body: string;
  /** ISO-8601 (RFC 3339) timestamp assigned by the store. */
  createdAt: string;
  provenance: KnowledgeProvenance;
}

/** Mirrored by the native store; keep both in sync. */
export const MAX_KNOWLEDGE_TITLE_CHARS = 200;
export const MAX_KNOWLEDGE_BODY_CHARS = 2_000;
export const MAX_OBJECTS_PER_DISTILLATION = 12;

export function isKnowledgeObjectKind(value: unknown): value is KnowledgeObjectKind {
  return typeof value === "string" && (KNOWLEDGE_OBJECT_KINDS as readonly string[]).includes(value);
}

export function codePointLength(text: string): number {
  return [...text].length;
}

/** Slices by code points, the unit used by `KnowledgeProvenance`. */
export function sliceCodePoints(text: string, start: number, end: number): string {
  return [...text].slice(start, end).join("");
}

/** Returns why `[start, end)` is not a valid span inside `content`, or `null` when it is valid. */
export function describeSpanProblem(content: string, start: unknown, end: unknown): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return "source span must be integers";
  const from = start as number;
  const to = end as number;
  if (from < 0) return "source span starts before the capture";
  if (to <= from) return "source span is empty or reversed";
  if (to > codePointLength(content)) return "source span ends after the capture";
  if (sliceCodePoints(content, from, to).trim().length === 0) return "source span contains no text";
  return null;
}

export function isKnowledgeProvenance(value: unknown): value is KnowledgeProvenance {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.captureId === "string" &&
    candidate.captureId.length > 0 &&
    Number.isInteger(candidate.sourceStart) &&
    Number.isInteger(candidate.sourceEnd) &&
    (candidate.sourceStart as number) >= 0 &&
    (candidate.sourceEnd as number) > (candidate.sourceStart as number)
  );
}

export function isKnowledgeObject(value: unknown): value is KnowledgeObject {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    isKnowledgeObjectKind(candidate.kind) &&
    typeof candidate.title === "string" &&
    candidate.title.trim().length > 0 &&
    typeof candidate.body === "string" &&
    candidate.body.trim().length > 0 &&
    typeof candidate.createdAt === "string" &&
    candidate.createdAt.length > 0 &&
    isKnowledgeProvenance(candidate.provenance)
  );
}

/**
 * Why a distillation attempt failed. The native layer reports exactly one of these codes
 * so the UI can react without knowing about providers, models or storage.
 */
export const DISTILLATION_ERROR_CODES = [
  "capture_not_found",
  "llm_not_configured",
  "llm_failed",
  "llm_refused",
  "llm_invalid_output",
  "storage_failed",
] as const;

export type DistillationErrorCode = (typeof DISTILLATION_ERROR_CODES)[number];

export interface DistillationErrorPayload {
  code: DistillationErrorCode;
  /** Safe to show to the user. Never contains credentials, prompts or provider bodies. */
  message: string;
}

export function isDistillationErrorCode(value: unknown): value is DistillationErrorCode {
  return typeof value === "string" && (DISTILLATION_ERROR_CODES as readonly string[]).includes(value);
}

export function isDistillationErrorPayload(value: unknown): value is DistillationErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isDistillationErrorCode(candidate.code) && typeof candidate.message === "string";
}
