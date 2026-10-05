import type {
  Capture,
  CognitiveRelation,
  CreateCaptureInput,
  CreateRelationInput,
  CreateRevisionInput,
  DistillationErrorCode,
  KnowledgeObject,
  KnowledgeSummary,
  LineageErrorCode,
  MicrophonePermissionState,
  MergeRevisionsInput,
  ObjectLineage,
  OrganizationState,
  Project,
  ProjectErrorCode,
  ProjectGraph,
  ProjectScope,
  RecallErrorCode,
  CognitiveAnswer,
  CognitiveQuery,
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

/** A project operation failed. `code` says why; `message` is safe to show. */
export class ProjectError extends Error {
  readonly code: ProjectErrorCode;

  constructor(code: ProjectErrorCode, message: string) {
    super(message);
    this.name = "ProjectError";
    this.code = code;
  }
}

/** Ask Arthur could not be served at all (a bad question, an unknown project, an unreadable store). `message` is safe to show. */
export class RecallError extends Error {
  readonly code: RecallErrorCode;

  constructor(code: RecallErrorCode, message: string) {
    super(message);
    this.name = "RecallError";
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
  /**
   * The captures with these ids, newest first, from ONE request and from any project. Unknown ids are absent. This is how
   * provenance opens the original Capture even after the idea derived from it moved to another project.
   */
  getCaptures(captureIds: string[]): Promise<Capture[]>;
  /** Persisted captures, newest first. With `scope.projectId`, only that project's; omitted, every project's. */
  listCaptures(scope?: ProjectScope): Promise<Capture[]>;

  /** Starts recording the microphone. Rejects with a `VoiceCaptureError`. */
  startVoiceCapture(): Promise<void>;
  /**
   * Stops recording, transcribes the speech, and resolves with the persisted
   * `source: "voice"` capture, in `projectId` (the Inbox when omitted). The audio itself is never kept.
   */
  finishVoiceCapture(projectId?: string): Promise<Capture>;
  /** Discards an in-progress recording without transcribing it. */
  cancelVoiceCapture(): Promise<void>;
  /**
   * Transcribes again the recording the native layer kept after `finishVoiceCapture` failed with `stt_retryable`,
   * without recording again. Resolves with the persisted `source: "voice"` capture, and the audio is deleted.
   * Rejects with `stt_retryable` again (the recording is still kept, until its original deadline), with another
   * `VoiceCaptureError` (final: the audio is deleted), or `no_retained_recording` if there is nothing to retry.
   */
  retryVoiceTranscription(projectId?: string): Promise<Capture>;
  /** Deletes the recording kept for a retry. Never fails; there may be nothing to delete. */
  discardVoiceRecording(): Promise<void>;
  /** The microphone permission, read without asking. Never shows a system dialog. */
  getMicrophonePermission(): Promise<MicrophonePermissionState>;
  /** Opens this app's page in the system settings, where a permanently refused microphone can be allowed again. */
  openAppSettings(): Promise<void>;

  /**
   * Turns one persisted capture into structured knowledge objects, each pointing at the exact
   * text it came from. Distilling a capture twice returns the same objects; it never
   * duplicates them. Rejects with a `DistillationError`.
   */
  distillCapture(captureId: string): Promise<KnowledgeObject[]>;
  /**
   * Knowledge objects: newest distillation first, in reading order within one. With `scope.projectId`, only that
   * project's; omitted, every project's.
   */
  listKnowledgeObjects(scope?: ProjectScope): Promise<KnowledgeObject[]>;
  /**
   * Whether each capture is pending, running, succeeded (maybe with zero objects) or failed. Durable: a failed
   * attempt is still `failed` after the app restarts, and `distillCapture` is the retry. One read for all captures.
   */
  listOrganizationStates(scope?: ProjectScope): Promise<OrganizationState[]>;
  /**
   * Connection and revision counts (and last-changed time) for many objects in ONE request. `objectIds` omitted:
   * every object. At most `MAX_SUMMARY_IDS` ids.
   */
  getKnowledgeSummaries(objectIds?: string[], scope?: ProjectScope): Promise<KnowledgeSummary[]>;

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
   *
   * PROJECT-LOCAL: the candidates are objects of ONE project only (`scope.projectId`, else the project the requested
   * objects share, else the Inbox). Relations across projects are never proposed by the model; manual and existing
   * cross-project relations are unaffected.
   */
  inferRelations(objectIds?: string[], scope?: ProjectScope): Promise<CognitiveRelation[]>;

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

  // --- Projects (Knowledge Spaces) --------------------------------------------------------------------------
  // A project is a domain boundary that owns Captures and KnowledgeObjects. There is always exactly one Inbox, which
  // cannot be archived or renamed. Projects are archived, never deleted. All rejections are `ProjectError`s.

  /** Open projects, the Inbox first. `includeArchived` adds archived ones. Counts come from one query. */
  listProjects(options?: { includeArchived?: boolean }): Promise<Project[]>;
  getProject(projectId: string): Promise<Project>;
  createProject(name: string): Promise<Project>;
  renameProject(projectId: string, name: string): Promise<Project>;
  /** Archives a project (idempotent). Its data stays; it accepts nothing new. If it was active, the Inbox becomes active. */
  archiveProject(projectId: string): Promise<Project>;
  restoreProject(projectId: string): Promise<Project>;
  /**
   * Moves a Capture. Its content is untouched, and so are the objects already distilled from it: they stay where
   * they are. Objects distilled later inherit the new project.
   */
  moveCapture(captureId: string, projectId: string): Promise<Capture>;
  /** Moves one KnowledgeObject. Same identity; no revision, provenance or lineage change. */
  moveKnowledgeObject(objectId: string, projectId: string): Promise<KnowledgeObject>;
  /**
   * The active project, the default boundary of Home, Ideas, Connections and (later) recall. Persisted locally between
   * launches; the Inbox when none is stored or the stored one was archived or removed.
   */
  getActiveProject(): Promise<Project>;
  /** Rejects with `project_not_found` / `project_archived`. Resolves with the new active project. */
  setActiveProject(projectId: string): Promise<Project>;
  /** One project's graph: its objects, every relation touching them, and the far ends of cross-project relations. */
  getProjectGraph(projectId: string): Promise<ProjectGraph>;

  // --- Cognitive Recall (Ask Arthur) -----------------------------------------------------------------------------------
  // A focused query -> result. Nothing is kept between questions.

  /**
   * Answers a question from the user's OWN knowledge, inside the ONE project named by `query.scope.projectId` (it is never
   * widened and never defaulted: the UI passes its active project). Retrieval, graph, lineage and provenance enrichment happen
   * natively and deterministically before an answer model writes anything; the model sees only that bounded evidence and has
   * no tools.
   *
   * Degradation RESOLVES with an `outcome`: `insufficient_evidence` (nothing relevant enough; no model call was made),
   * `retrieval_only` (evidence found, but no grounded answer could be produced), or `answered`. Only a request that cannot be
   * served at all rejects, with a `RecallError`. Evidence entries carry handles that the answer's paragraphs cite, whether they
   * are current or historical, the Project they belong to (and `externalProject`), the relation path that admitted them, and
   * provenance (the exact Capture span, and whether the text was edited since).
   */
  ask(query: CognitiveQuery): Promise<CognitiveAnswer>;
}
