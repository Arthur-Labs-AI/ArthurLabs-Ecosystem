/**
 * Cognitive Recall contracts (M04C): Ask Arthur as a focused query -> result.
 *
 * Recall answers from the user's OWN knowledge. It reconstructs evidence along the structure Arthur already built
 * (Project -> KnowledgeObjects -> Graph -> Lineage -> Provenance) and only then asks a model to write an answer from that
 * bounded evidence. The model has no tools and no database access. Nothing here is persisted: no query, no answer, no history.
 *
 * The scope is ALWAYS explicit. Native Recall never substitutes the active project; the UI supplies it.
 */

/** Mirrored by the native layer. */
export const MAX_QUERY_CHARS = 500;

export interface CognitiveQuery {
  query: string;
  scope: { projectId: string };
}

/**
 * - `answered`: a grounded answer; every paragraph cites evidence handles.
 * - `insufficient_evidence`: nothing relevant enough was found (no model call was made), or the model said the evidence does not answer it.
 * - `retrieval_only`: evidence was found but no grounded answer could be produced (model missing, offline, refused, or unusable output twice).
 */
export const ASK_OUTCOMES = ["answered", "insufficient_evidence", "retrieval_only"] as const;
export type AskOutcome = (typeof ASK_OUTCOMES)[number];

/** Computed by Arthur from what a paragraph cites, never taken from the model. */
export const RECALL_TEMPORALS = ["current", "historical", "mixed", "external"] as const;
export type RecallTemporal = (typeof RECALL_TEMPORALS)[number];

export interface AnswerParagraph {
  text: string;
  /** Evidence handles (`E1`, `E3.h1`) from `CognitiveAnswer.evidence`. */
  basedOn: string[];
  temporal: RecallTemporal;
}

export interface CognitiveAnswerBody {
  paragraphs: AnswerParagraph[];
  /** What the evidence did not contain (only when the model said so). */
  gaps: string[];
}

export interface EvidenceStrength {
  points: number;
  /** strong | sufficient | supporting | weak. A `weak` entry is a similar-looking candidate that nothing else supports. */
  level: "strong" | "sufficient" | "supporting" | "weak";
  sufficient: boolean;
  signals: { name: string; points: number }[];
}

export interface GraphPath {
  fromObjectId: string;
  fromHandle: string;
  toObjectId: string;
  relationId: string;
  relationKind: string;
  /** Relative to `fromObjectId`: `out` = it is the stored source of the relation. */
  direction: "out" | "in" | "sym";
  distance: number;
  externalProject: boolean;
}

export interface EvidenceGraph {
  role: "expanded" | "supported";
  score: number | null;
  intentRelevant: boolean;
  /** How this entry got in (a second hop has two edges). Lets the UI say "Included because Idea A depends on Decision B". */
  paths: GraphPath[];
  supersededBy: string[];
  supersedes: string[];
  conflictsWith: string[];
  contradictory: boolean;
  aliases: { objectId: string; title: string }[];
}

export interface EvidenceSource {
  captureId: string;
  captureProjectId: string;
  captureSource: string;
  captureCreatedAt: string;
  spanStart: number;
  spanEnd: number;
  excerpt: string | null;
  excerptTruncated: boolean;
}

export interface EvidenceHistoryEntry {
  handle: string;
  revisionId: string;
  /** Never `current`. */
  status: "historical" | "branch_not_current";
  origin: string;
  createdAt: string;
  title: string;
  body: string;
  truncated: boolean;
  marks: string[];
  leadsToCurrent: boolean;
  source: EvidenceSource | null;
}

export interface CognitiveEvidence {
  /** `E1`, `E2`... stable inside one result. */
  handle: string;
  /** `primary` (found by search) or `graph` (added because it is connected to a found entry). */
  role: "primary" | "graph";
  objectId: string;
  projectId: string;
  projectName: string;
  /** Belongs to ANOTHER Project than the one asked about. */
  externalProject: boolean;
  kind: string;
  title: string;
  /** The CURRENT revision's text. Old wording lives only in `lineage.entries`. */
  currentBody: string;
  currentRevisionId: string;
  /** `superseded`: another entry replaces it, so it is not the current position. */
  status: "current" | "superseded";
  strength: EvidenceStrength;
  retrieval: Record<string, unknown> | null;
  graph: EvidenceGraph | null;
  lineage: { revisionCount: number; entries: EvidenceHistoryEntry[] } | null;
  provenance: {
    origin: EvidenceSource | null;
    /** Present only when the CURRENT revision was itself interpreted from a Capture. */
    currentRevisionSource: EvidenceSource | null;
    /** The current text was edited after capture, so the Capture does not support it. */
    editedSinceCapture: boolean;
    currentRevisionOrigin: string;
  } | null;
  /** A validated paragraph of the answer rests on this entry. */
  cited: boolean;
  /** The model was shown it (it may have been dropped for the token budget). */
  inContext: boolean;
}

/** Structural facts only: counts, timings, codes. Never stored text. */
export interface RecallDiagnostics {
  retrieval: {
    intent: Record<string, number>;
    lexical: "ok" | "degradedScan" | "skippedNoTerms";
    semantic: "ok" | "partial" | "disabled" | "unavailable" | "noIndex";
    semanticReason: string | null;
    semanticCoverage: number | null;
    embeddingRequests: number;
    uploadedTexts: number;
    sqlReads: number;
  };
  enrichment: Record<string, number | boolean>;
  context: {
    budgetTokens: number;
    estimatedTokens: number;
    entriesIncluded: number;
    historyIncluded: number;
    dropped: { handle: string; reason: string }[];
    truncation: { step: string; items: number }[];
  } | null;
  synthesis: {
    state: "ok" | "skipped" | "unavailable" | "failed" | "invalidOutput";
    reason: string | null;
    model: string | null;
    retried: boolean;
    requests: number;
    strippedRefs: number;
    droppedParagraphs: number;
    temporalCorrected: number;
  };
  timings: Record<string, number>;
  counts: Record<string, number>;
  sqlReads: number;
}

export interface CognitiveAnswer {
  query: string;
  scope: { projectId: string; projectName: string; archived: boolean };
  outcome: AskOutcome;
  answer: CognitiveAnswerBody | null;
  evidence: CognitiveEvidence[];
  diagnostics: RecallDiagnostics;
}

/** Only requests that cannot be served at all reject; every degradation resolves with an `outcome` and diagnostics. */
export const RECALL_ERROR_CODES = ["invalid_query", "project_not_found", "storage_failed"] as const;
export type RecallErrorCode = (typeof RECALL_ERROR_CODES)[number];

export interface RecallErrorPayload {
  code: RecallErrorCode;
  /** Safe to show to the user. Never contains stored text. */
  message: string;
}

export function isRecallErrorPayload(value: unknown): value is RecallErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c.code === "string" && (RECALL_ERROR_CODES as readonly string[]).includes(c.code) && typeof c.message === "string";
}

/** Returns why `query` is not askable, or `null`. Mirrors the native validation. */
export function describeCognitiveQueryProblem(query: unknown): string | null {
  if (typeof query !== "object" || query === null) return "the question must be an object";
  const c = query as Record<string, unknown>;
  if (typeof c.query !== "string" || c.query.trim().length === 0) return "the question is empty";
  if ([...c.query.trim()].length > MAX_QUERY_CHARS) return `the question is longer than ${MAX_QUERY_CHARS} characters`;
  const scope = c.scope as Record<string, unknown> | undefined;
  if (typeof scope !== "object" || scope === null || typeof scope.projectId !== "string" || scope.projectId.length === 0) return "the question needs an explicit project";
  return null;
}

function isParagraph(value: unknown): value is AnswerParagraph {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c.text === "string" && Array.isArray(c.basedOn) && c.basedOn.every((h) => typeof h === "string") && typeof c.temporal === "string" && (RECALL_TEMPORALS as readonly string[]).includes(c.temporal);
}

function isEvidence(value: unknown): value is CognitiveEvidence {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  const strength = c.strength as Record<string, unknown> | undefined;
  return (
    typeof c.handle === "string" &&
    /^E\d+$/.test(c.handle) &&
    (c.role === "primary" || c.role === "graph") &&
    typeof c.objectId === "string" &&
    typeof c.projectId === "string" &&
    typeof c.projectName === "string" &&
    typeof c.externalProject === "boolean" &&
    typeof c.kind === "string" &&
    typeof c.title === "string" &&
    typeof c.currentBody === "string" &&
    typeof c.currentRevisionId === "string" &&
    (c.status === "current" || c.status === "superseded") &&
    typeof strength === "object" &&
    strength !== null &&
    typeof strength.points === "number" &&
    typeof strength.level === "string" &&
    typeof strength.sufficient === "boolean" &&
    typeof c.cited === "boolean" &&
    typeof c.inContext === "boolean"
  );
}

export function isCognitiveAnswer(value: unknown): value is CognitiveAnswer {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  const scope = c.scope as Record<string, unknown> | undefined;
  const diagnostics = c.diagnostics as Record<string, unknown> | undefined;
  const answer = c.answer as Record<string, unknown> | null | undefined;
  return (
    typeof c.query === "string" &&
    typeof scope === "object" &&
    scope !== null &&
    typeof scope.projectId === "string" &&
    typeof scope.projectName === "string" &&
    typeof scope.archived === "boolean" &&
    typeof c.outcome === "string" &&
    (ASK_OUTCOMES as readonly string[]).includes(c.outcome) &&
    (answer === null || (typeof answer === "object" && answer !== undefined && Array.isArray(answer.paragraphs) && answer.paragraphs.every(isParagraph) && Array.isArray(answer.gaps) && answer.gaps.every((g) => typeof g === "string"))) &&
    // An answer exists only for `answered` or a model-declared `insufficient_evidence`; `retrieval_only` never carries one.
    (c.outcome !== "retrieval_only" || answer === null) &&
    Array.isArray(c.evidence) &&
    c.evidence.every(isEvidence) &&
    typeof diagnostics === "object" &&
    diagnostics !== null &&
    typeof diagnostics.synthesis === "object" &&
    typeof diagnostics.retrieval === "object"
  );
}
