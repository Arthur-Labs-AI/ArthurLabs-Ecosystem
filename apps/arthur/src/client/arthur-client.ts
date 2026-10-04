import type {
  Capture,
  CognitiveRelation,
  CreateCaptureInput,
  CreateRelationInput,
  CreateRevisionInput,
  DistillationErrorCode,
  KnowledgeObject,
  LineageErrorCode,
  MergeRevisionsInput,
  ObjectLineage,
  RelationErrorCode,
  RelationFilter,
  RevisionChanges,
  RevisionDiff,
  RuntimeInfo,
  ThoughtRevision,
  VoiceCaptureErrorCode,
} from "@arthur/contracts";

/**
 * Which implementation backs the UI.
 * - `desktop`: Tauri shell on Linux/Windows (later macOS).
 * - `mobile`: Tauri shell on Android (later iOS).
 * - `preview`: plain browser or tests, no native layer.
 */
export type ArthurClientKind = "desktop" | "mobile" | "preview";

/** What this client can do, so the UI can adapt without knowing which platform it is on. */
export interface ArthurClientCapabilities {
  readonly voiceCapture: boolean;
}

/** A voice capture attempt failed. `code` says why; `message` is safe to show to the user. */
export class VoiceCaptureError extends Error {
  readonly code: VoiceCaptureErrorCode;

  constructor(code: VoiceCaptureErrorCode, message: string) {
    super(message);
    this.name = "VoiceCaptureError";
    this.code = code;
  }
}

/** A distillation attempt failed. `code` says why; `message` is safe to show to the user. */
export class DistillationError extends Error {
  readonly code: DistillationErrorCode;

  constructor(code: DistillationErrorCode, message: string) {
    super(message);
    this.name = "DistillationError";
    this.code = code;
  }
}

/** A relation attempt (manual creation, query or inference) failed. `code` says why; `message` is safe to show. */
export class RelationError extends Error {
  readonly code: RelationErrorCode;

  constructor(code: RelationErrorCode, message: string) {
    super(message);
    this.name = "RelationError";
    this.code = code;
  }
}

/** A lineage operation failed. `code` says why; `message` is safe to show. */
export class LineageError extends Error {
  readonly code: LineageErrorCode;

  constructor(code: LineageErrorCode, message: string) {
    super(message);
    this.name = "LineageError";
    this.code = code;
  }
}

/**
 * The only way the product UI talks to Arthur.
 *
 * Components must not reach for localhost HTTP, Tailscale addresses, SQLite,
 * Android native APIs, microphones, speech providers or Node processes
 * (Repo Structure, Rule 5). Anything the UI needs is added here and
 * implemented per platform behind this interface.
 */
export interface ArthurClient {
  readonly kind: ArthurClientKind;
  readonly capabilities: ArthurClientCapabilities;
  getRuntimeInfo(): Promise<RuntimeInfo>;
  /** Persists a capture before resolving; the store assigns its id and timestamp. */
  createCapture(input: CreateCaptureInput): Promise<Capture>;
  /** All persisted captures, newest first. */
  listCaptures(): Promise<Capture[]>;

  /** Starts recording the microphone. Rejects with a `VoiceCaptureError`. */
  startVoiceCapture(): Promise<void>;
  /**
   * Stops recording, transcribes the speech, and resolves with the persisted
   * `source: "voice"` capture. The audio itself is never kept.
   */
  finishVoiceCapture(): Promise<Capture>;
  /** Discards an in-progress recording without transcribing it. */
  cancelVoiceCapture(): Promise<void>;

  /**
   * Turns one persisted capture into structured knowledge objects, each pointing at the exact
   * text it came from. Distilling a capture twice returns the same objects; it never
   * duplicates them. Rejects with a `DistillationError`.
   */
  distillCapture(captureId: string): Promise<KnowledgeObject[]>;
  /** Every knowledge object: newest distillation first, in reading order within one. */
  listKnowledgeObjects(): Promise<KnowledgeObject[]>;

  /**
   * Creates a user-authored relation between two existing knowledge objects. Id, timestamp and
   * `origin: "user"` are assigned by the native layer. A symmetric kind (related_to, contradicts,
   * duplicates) is stored once in canonical order, so the returned edge may have its ends swapped
   * relative to the input. Creating an edge that already exists returns it unchanged.
   * Rejects with a `RelationError`.
   */
  createRelation(input: CreateRelationInput): Promise<CognitiveRelation>;
  /** Every relation in the graph, oldest first. Never contains an edge whose object is missing. */
  listRelations(): Promise<CognitiveRelation[]>;
  /**
   * One-hop relations of an object, oldest first. A symmetric relation counts as both incoming and
   * outgoing for each of its objects. Rejects with a `RelationError` for an unknown object.
   */
  getObjectRelations(objectId: string, filter?: RelationFilter): Promise<CognitiveRelation[]>;
  /** The distinct objects one hop away through the matching relations. */
  getObjectNeighbors(objectId: string, filter?: RelationFilter): Promise<KnowledgeObject[]>;
  /**
   * Asks the cloud model to propose relations among a bounded set of recent knowledge objects (plus
   * `objectIds`, if given). Only proposals that pass deterministic validation are stored, all or
   * nothing, with `origin: "model"`. Resolves with the relations this call ADDED: an empty list is a
   * valid result, and calling again never duplicates edges. Rejects with a `RelationError`.
   */
  inferRelations(objectIds?: string[]): Promise<CognitiveRelation[]>;

  // --- Thought Lineage -------------------------------------------------------------------------------------
  // How ONE knowledge object evolved: a DAG of immutable revisions. Separate from Capture provenance (where the
  // object came from) and from the Cognitive Graph (how objects relate). All rejections are `LineageError`s.

  /** The whole history of an object (oldest first) and which revision is current. */
  getObjectLineage(objectId: string): Promise<ObjectLineage>;
  /** The revisions of an object, oldest first. */
  listRevisions(objectId: string): Promise<ThoughtRevision[]>;
  getRevision(revisionId: string): Promise<ThoughtRevision>;
  /** The direct parents of a revision (none for the initial one, two or more for a merge). */
  getRevisionParents(revisionId: string): Promise<ThoughtRevision[]>;
  /** The revisions continuing from this one. More than one means the history branches here. */
  getRevisionChildren(revisionId: string): Promise<ThoughtRevision[]>;
  /**
   * Edits an object: creates a new immutable revision whose parent is the current one, and makes it current. The
   * old revision is untouched. An edit that changes nothing is rejected. Edited text carries no Capture provenance.
   */
  updateKnowledgeObject(objectId: string, changes: RevisionChanges): Promise<ThoughtRevision>;
  /**
   * Creates a revision continuing from ANY revision of the object, including an old one, which makes a branch. It does
   * not become current unless `makeCurrent` is true.
   */
  createRevisionFrom(input: CreateRevisionInput): Promise<ThoughtRevision>;
  /**
   * Merges two or more revisions of one object into a new revision with all of them as parents. The caller supplies
   * the merged content; nothing is merged automatically. Not current unless `makeCurrent` is true.
   */
  mergeRevisions(input: MergeRevisionsInput): Promise<ThoughtRevision>;
  /** A deterministic word-level diff between two revisions of the same object. */
  diffRevisions(oldRevisionId: string, newRevisionId: string): Promise<RevisionDiff>;
}
