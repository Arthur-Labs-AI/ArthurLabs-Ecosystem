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

/**
 * Whether a capture has been organized into knowledge objects. Durable, and never inferred from how many objects
 * exist: a capture organized into nothing is `succeeded` with `objectCount` 0.
 *
 * - `pending`: never organized (or the app died before an attempt finished).
 * - `running`: this process is organizing it right now.
 * - `succeeded`: organized. `objectCount` 0 means nothing worth structuring was found.
 * - `failed`: the latest attempt failed; `failure` says why. It survives a restart and can be retried.
 */
export const ORGANIZATION_STATUSES = ["pending", "running", "succeeded", "failed"] as const;

export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export interface OrganizationFailure {
  code: Exclude<DistillationErrorCode, "capture_not_found">;
  /** Safe to show to the user. */
  message: string;
  /** ISO-8601 time of the latest failed attempt. */
  failedAt: string;
}

export interface OrganizationState {
  captureId: string;
  status: OrganizationStatus;
  /** Knowledge objects that came from this capture. */
  objectCount: number;
  /** Present only when `status` is `failed`. */
  failure?: OrganizationFailure | null;
}

export function isOrganizationStatus(value: unknown): value is OrganizationStatus {
  return typeof value === "string" && (ORGANIZATION_STATUSES as readonly string[]).includes(value);
}

/**
 * What a list row needs about one object, read in one request instead of one per object.
 * Not an analytics layer: counts and the time of the last change, nothing cached.
 */
export interface KnowledgeSummary {
  objectId: string;
  /** Relations the object is an end of. A symmetric relation counts once for each of its objects. */
  relationCount: number;
  revisionCount: number;
  /** When the current revision was created: the last time the object changed. */
  updatedAt: string;
  currentRevisionId: string;
}

/** Mirrored by the native store. Asking for no ids means every object. */
export const MAX_SUMMARY_IDS = 1_000;

// ---------------------------------------------------------------------------------------------
// Cognitive Graph (M02): typed relations between KnowledgeObjects.
//
// This is a SEPARATE system from capture provenance:
//   provenance  = KnowledgeObject -> the exact span of the raw Capture it was interpreted from
//   relation    = KnowledgeObject -> KnowledgeObject
// Provenance is never encoded as a relation (in particular, not as `derived_from`).
// ---------------------------------------------------------------------------------------------

/**
 * Semantics. "source" and "target" are the two ends of the stored edge.
 *
 * - `related_to`   General semantic relationship. Symmetric.
 * - `extends`      source develops or adds detail to target. Directional.
 * - `depends_on`   source requires target for execution, validity or context. Directional.
 * - `contradicts`  source materially conflicts with target. Symmetric.
 * - `derived_from` source was derived from the knowledge in target. Directional. This relates
 *                  two objects; it is NOT Capture provenance.
 * - `duplicates`   source and target are effectively the same thought. Symmetric.
 * - `supersedes`   source replaces target as the current knowledge or state. Directional. This is
 *                  only the graph edge: no revision or lineage mechanics exist yet.
 */
export const RELATION_KINDS = [
  "related_to",
  "extends",
  "depends_on",
  "contradicts",
  "derived_from",
  "duplicates",
  "supersedes",
] as const;

export type CognitiveRelationKind = (typeof RELATION_KINDS)[number];

/**
 * Kinds with no direction. A symmetric relation is stored once, with the lexicographically
 * smaller object id as `sourceObjectId`, so "A related_to B" and "B related_to A" are the same edge.
 */
export const SYMMETRIC_RELATION_KINDS = ["related_to", "contradicts", "duplicates"] as const;

export const RELATION_ORIGINS = ["model", "user", "system"] as const;

export type CognitiveRelationOrigin = (typeof RELATION_ORIGINS)[number];

/** Mirrored by the native store; keep both in sync. */
export const MAX_INFERENCE_CANDIDATES = 40;
export const MAX_RELATIONS_PER_INFERENCE = 30;
/**
 * Cost bounds of one inference run (M02.1). Stage A proposes at most `MAX_RELATION_PROPOSALS` relations; Stage B
 * verifies each of them twice in two batched requests; so a run makes at most `MAX_INFERENCE_REQUESTS`
 * provider requests (one proposal, two verification votes), however many objects or relations are involved.
 */
export const MAX_RELATION_PROPOSALS = 20;
export const MAX_INFERENCE_REQUESTS = 3;

export interface CognitiveRelation {
  /** Assigned by the store; unique and stable. */
  id: string;
  kind: CognitiveRelationKind;
  /** For symmetric kinds this is the smaller of the two object ids. */
  sourceObjectId: string;
  targetObjectId: string;
  /** ISO-8601 (RFC 3339) timestamp assigned by the store. */
  createdAt: string;
  origin: CognitiveRelationOrigin;
}

/** What a caller supplies to create a relation. Identity, time and origin are not caller-controlled. */
export interface CreateRelationInput {
  kind: CognitiveRelationKind;
  sourceObjectId: string;
  targetObjectId: string;
}

/**
 * Edge direction as seen from one object. A symmetric relation counts as BOTH incoming and
 * outgoing for each of its two objects; a directional one is outgoing for its source and incoming
 * for its target.
 */
export const RELATION_DIRECTIONS = ["incoming", "outgoing", "any"] as const;

export type RelationDirection = (typeof RELATION_DIRECTIONS)[number];

export interface RelationFilter {
  /** Default: `any`. */
  direction?: RelationDirection;
  kind?: CognitiveRelationKind;
}

export function isRelationKind(value: unknown): value is CognitiveRelationKind {
  return typeof value === "string" && (RELATION_KINDS as readonly string[]).includes(value);
}

export function isSymmetricRelationKind(kind: CognitiveRelationKind): boolean {
  return (SYMMETRIC_RELATION_KINDS as readonly string[]).includes(kind);
}

export function isRelationOrigin(value: unknown): value is CognitiveRelationOrigin {
  return typeof value === "string" && (RELATION_ORIGINS as readonly string[]).includes(value);
}

export function isRelationDirection(value: unknown): value is RelationDirection {
  return typeof value === "string" && (RELATION_DIRECTIONS as readonly string[]).includes(value);
}

/** The stored (source, target) pair for an edge: symmetric kinds are ordered by object id. */
export function canonicalRelationEnds(
  kind: CognitiveRelationKind,
  sourceObjectId: string,
  targetObjectId: string,
): { sourceObjectId: string; targetObjectId: string } {
  const swap = isSymmetricRelationKind(kind) && targetObjectId < sourceObjectId;
  return swap ? { sourceObjectId: targetObjectId, targetObjectId: sourceObjectId } : { sourceObjectId, targetObjectId };
}

export function isCognitiveRelation(value: unknown): value is CognitiveRelation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    !isRelationKind(candidate.kind) ||
    typeof candidate.sourceObjectId !== "string" ||
    candidate.sourceObjectId.length === 0 ||
    typeof candidate.targetObjectId !== "string" ||
    candidate.targetObjectId.length === 0 ||
    candidate.sourceObjectId === candidate.targetObjectId ||
    typeof candidate.createdAt !== "string" ||
    candidate.createdAt.length === 0 ||
    !isRelationOrigin(candidate.origin)
  ) {
    return false;
  }
  return canonicalRelationEnds(candidate.kind, candidate.sourceObjectId, candidate.targetObjectId).sourceObjectId === candidate.sourceObjectId;
}

/** Why a relation attempt failed. The native layer reports exactly one of these codes. */
export const RELATION_ERROR_CODES = [
  "object_not_found",
  "invalid_relation",
  "llm_not_configured",
  "llm_failed",
  "llm_refused",
  "llm_invalid_output",
  "storage_failed",
] as const;

export type RelationErrorCode = (typeof RELATION_ERROR_CODES)[number];

export interface RelationErrorPayload {
  code: RelationErrorCode;
  /** Safe to show to the user. Never contains credentials, prompts or provider bodies. */
  message: string;
}

export function isRelationErrorCode(value: unknown): value is RelationErrorCode {
  return typeof value === "string" && (RELATION_ERROR_CODES as readonly string[]).includes(value);
}

export function isRelationErrorPayload(value: unknown): value is RelationErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isRelationErrorCode(candidate.code) && typeof candidate.message === "string";
}

/** Returns why `input` is not a creatable relation, or `null` when it is. Object existence is the store's check. */
export function describeCreateRelationInputProblem(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return "relation must be an object";
  const candidate = input as Record<string, unknown>;
  if (!isRelationKind(candidate.kind)) return "unknown relation kind";
  for (const end of [candidate.sourceObjectId, candidate.targetObjectId]) {
    if (typeof end !== "string" || end.length === 0) return "a relation needs a source and a target object";
  }
  if (candidate.sourceObjectId === candidate.targetObjectId) return "an object cannot be related to itself";
  return null;
}
