import type {
  Capture,
  CognitiveRelation,
  CreateCaptureInput,
  CreateRelationInput,
  DistillationErrorCode,
  KnowledgeObject,
  RelationErrorCode,
  RelationFilter,
  RuntimeInfo,
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
}
