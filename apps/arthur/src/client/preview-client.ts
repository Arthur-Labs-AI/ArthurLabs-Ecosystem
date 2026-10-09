import {
  INBOX_PROJECT_ID,
  MAX_INFERENCE_CANDIDATES,
  MAX_KNOWLEDGE_BODY_CHARS,
  MAX_KNOWLEDGE_TITLE_CHARS,
  MAX_MERGE_PARENTS,
  MAX_RELATIONS_PER_INFERENCE,
  MAX_REVISIONS_PER_OBJECT,
  canonicalRelationEnds,
  codePointLength,
  describeCognitiveQueryProblem,
  describeCreateCaptureInputProblem,
  describeCreateRelationInputProblem,
  describeProjectNameProblem,
  describeRevisionChangesProblem,
  describeSpanProblem,
  diffRevisionContent,
  isKnowledgeObjectKind,
  isRelationKind,
  isSymmetricRelationKind,
  sliceCodePoints,
  type Capture,
  type CognitiveAnswer,
  type CognitiveQuery,
  type CognitiveRelation,
  type CognitiveRelationOrigin,
  type CreateCaptureInput,
  type CreateRelationInput,
  type CreateRevisionInput,
  type KnowledgeObject,
  type KnowledgeObjectKind,
  type KnowledgeSummary,
  type MicrophonePermissionState,
  type OrganizationState,
  type Project,
  type ProjectGraph,
  type ProjectScope,
  type MergeRevisionsInput,
  type ObjectLineage,
  type RelationErrorCode,
  type RelationFilter,
  type RevisionChanges,
  type RevisionOrigin,
  type RuntimeInfo,
  type SemanticRecallStatus,
  type AiCapability,
  type AiConfig,
  type AiProviderId,
  type SpeechFailure,
  type SpeechStatus,
  type ProviderTestOutcome,
  AI_CAPABILITIES,
  type ThoughtRevision,
} from "@arthur/contracts";
import { AiSetupError, SpeechError, DistillationError, LineageError, ProjectError, RecallError, RelationError, VoiceCaptureError, type ArthurClient } from "./arthur-client";

const DEFAULT_PREVIEW_INFO: RuntimeInfo = { appVersion: "0.0.0-preview", platform: "unknown" };

export interface PreviewVoiceOptions {
  /** Transcript the fake speech service "hears". Default: a fixed sentence. */
  transcript?: () => string;
  /** Make `startVoiceCapture` fail, e.g. to simulate a denied microphone permission. */
  startError?: VoiceCaptureError;
  /**
   * Make `finishVoiceCapture` fail, e.g. to simulate a network failure. A `stt_retryable` error behaves like the
   * native layer: the recording is kept for `retryVoiceTranscription` / `discardVoiceRecording`. Any other error is
   * final and keeps nothing.
   */
  finishError?: VoiceCaptureError;
  /**
   * What a retry does, in order, one entry per call; once the list is empty the retry succeeds. An entry is an error
   * to reject with (`stt_retryable` keeps the recording, anything else deletes it).
   */
  retryErrors?: VoiceCaptureError[];
  /**
   * The microphone permission the device reports. Shared, so a test can change it (for example after the user
   * "allowed" it in settings). Default `unknown`. A successful start makes it `granted`; a refused start makes it
   * `denied` unless the error says otherwise.
   */
  permission?: { current: MicrophonePermissionState };
  /** Called each time `openAppSettings` is used. */
  onOpenSettings?: () => void;
}

/** What the fake language model proposes. `evidence` must be a verbatim quote of the capture. */
export interface PreviewCandidate {
  kind: KnowledgeObjectKind;
  title: string;
  body: string;
  evidence: string;
}

export interface PreviewDistillationOptions {
  /** Default: one `note` covering the whole capture. */
  candidates?: (capture: Capture) => PreviewCandidate[];
  /** Make `distillCapture` fail, e.g. to simulate a provider error. Cleared after one use when `once` is true. */
  error?: DistillationError;
  once?: boolean;
}

/** What the fake language model proposes. Untrusted, like the native model output: `kind` is a plain string. */
export interface PreviewRelationProposal {
  sourceObjectId: string;
  targetObjectId: string;
  kind: string;
}

export interface PreviewInferenceOptions {
  /** Default: no relations, which is a valid answer. `objects` is the bounded candidate set. */
  proposals?: (objects: KnowledgeObject[], existing: CognitiveRelation[]) => PreviewRelationProposal[];
  /** Make `inferRelations` fail, e.g. to simulate a provider error. Cleared after one use when `once` is true. */
  error?: RelationError;
  once?: boolean;
}

export interface PreviewRecallOptions {
  /**
   * Supplies the answer to a question. The preview has no knowledge index and no answer model, so by default every question
   * resolves `insufficient_evidence` honestly. A test (or a clearly labelled demo) can supply a scripted result.
   */
  answer?: (query: CognitiveQuery, scope: CognitiveAnswer["scope"]) => CognitiveAnswer | Promise<CognitiveAnswer>;
  /** The starting semantic-Recall state. Default: OFF with nothing stored. */
  semantic?: Partial<SemanticRecallStatus>;
}

/** Scripts provider setup in memory. By default Setup is done and OpenAI is connected, so every other screen behaves as before. */
export interface PreviewAiOptions {
  setupCompleted?: boolean;
  /** Providers that have a stored credential. */
  credentials?: AiProviderId[];
  /** What `testProvider` answers per capability. Default `connected`. */
  testOutcomes?: Partial<Record<AiCapability, ProviderTestOutcome>>;
}

/** Scripts voice output in memory: what was spoken is recorded, and playback can be held open or made to fail. */
export interface PreviewSpeechOptions {
  /** Called with every text the client was asked to speak. */
  onSpeak?: (text: string) => void;
  /** Keep the session `playing` until `stopSpeech` is called. Otherwise it finishes straight away. */
  hold?: boolean;
  /** Make every session fail with this reason. */
  failure?: SpeechFailure;
}

export interface PreviewClientOptions {
  info?: RuntimeInfo;
  recall?: PreviewRecallOptions;
  ai?: PreviewAiOptions;
  speech?: PreviewSpeechOptions;
  voice?: PreviewVoiceOptions;
  distillation?: PreviewDistillationOptions;
  inference?: PreviewInferenceOptions;
  /** Injectable for deterministic tests. */
  newId?: () => string;
  now?: () => Date;
}

/** Native-free client for `vite dev` in a plain browser and for tests. Everything lives in memory only. */
export function createPreviewClient(options: PreviewClientOptions = {}): ArthurClient {
  const info = options.info ?? DEFAULT_PREVIEW_INFO;
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const voice = options.voice ?? {};
  let integrationEnabled = false;
  let semantic: SemanticRecallStatus = {
    enabled: false,
    savedEnabled: false,
    savedModelKey: null,
    settingsCorrupt: false,
    activeModelKey: "preview:none",
    storedVectors: 0,
    storedVectorsAllKeys: 0,
    pendingObjects: 0,
    ...options.recall?.semantic,
  };
  let setupCompleted = options.ai?.setupCompleted ?? true;
  const credentials = new Set<AiProviderId>(options.ai?.credentials ?? ["openai"]);
  const aiConfig = (): AiConfig => ({
    setupCompleted,
    providers: [{ id: "openai", name: "OpenAI", hasCredential: credentials.has("openai") }],
    capabilities: AI_CAPABILITIES.map((capability) => ({
      capability,
      provider: "openai" as const,
      providerName: "OpenAI",
      models: capability === "llm" ? ["gpt-4.1-mini", "gpt-6-luna"] : capability === "stt" ? ["gpt-4o-transcribe"] : capability === "tts" ? ["gpt-4o-mini-tts"] : ["text-embedding-3-small"],
      ...(capability === "tts" ? { voice: "alloy" } : {}),
      status: credentials.has("openai") ? ("ready" as const) : ("needsCredential" as const),
    })),
  });
  let speechStatus: SpeechStatus = { state: "idle", sessionId: 0, chunkIndex: 0, chunkCount: 0, truncated: false, outcome: null, failure: null, timings: { startupMs: 0, synthesisMs: 0, preparationMs: 0, timeToAudibleMs: 0, cleanupMs: 0 } };
  const speak = (text: string) => {
    if (text.trim().length === 0) return Promise.reject(new SpeechError("emptyText", "There is nothing to read aloud."));
    options.speech?.onSpeak?.(text);
    const sessionId = speechStatus.sessionId + 1;
    // Without a credential the real native layer fails the session the same way, before any provider call.
    const failure = !credentials.has("openai") ? ("notConfigured" as const) : (options.speech?.failure ?? null);
    const base = { ...speechStatus, sessionId, chunkIndex: 0, chunkCount: 1, truncated: false };
    speechStatus = failure ? { ...base, state: "idle", outcome: "failed", failure } : options.speech?.hold ? { ...base, state: "playing", outcome: null, failure: null } : { ...base, state: "idle", outcome: "finished", failure: null };
    return Promise.resolve({ sessionId, chunkCount: 1, truncated: false });
  };
  const distillation = { ...options.distillation };
  const inference = { ...options.inference };
  const captures: Capture[] = [];
  /** Projects in creation order. The Inbox is always first, never archived, never renamed. */
  const projects: { id: string; name: string; createdAt: string; updatedAt: string; archivedAt: string | null }[] = [
    { id: INBOX_PROJECT_ID, name: "Inbox", createdAt: "1970-01-01T00:00:00Z", updatedAt: "1970-01-01T00:00:00Z", archivedAt: null },
  ];
  let activeProjectId = INBOX_PROJECT_ID;
  /** Newest distillation first, like the native store. Zero-object runs are remembered too. */
  const runs: { captureId: string; objects: KnowledgeObject[] }[] = [];
  /** Oldest first, like the native store. */
  const relations: CognitiveRelation[] = [];
  /** Per object: its revisions (oldest first) and which one is current. The object in `runs` is a projection of it. */
  const lineages = new Map<string, { revisions: ThoughtRevision[]; current: string }>();
  let recording = false;
  /** A recording kept after a retryable transcription failure. Nothing about the audio itself is modelled. */
  let kept = false;
  const retryErrors = [...(voice.retryErrors ?? [])];
  const permission = voice.permission ?? { current: "unknown" as MicrophonePermissionState };
  /** The latest failure per capture, like the native `organization_failures`. A success clears it. */
  const failures = new Map<string, NonNullable<OrganizationState["failure"]>>();

  const remember = (captureId: string, failure: DistillationError): void => {
    if (failure.code === "capture_not_found") return;
    failures.set(captureId, { code: failure.code, message: failure.message, failedAt: now().toISOString() });
  };

  const append = (input: CreateCaptureInput): Capture => {
    const projectId = input.projectId ?? INBOX_PROJECT_ID;
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("Invalid capture: project does not exist");
    if (project.archivedAt !== null) throw new Error("Invalid capture: project is archived");
    const capture: Capture = { id: newId(), source: input.source, content: input.content, createdAt: now().toISOString(), projectId };
    captures.unshift(capture);
    return capture;
  };

  const allObjects = (): KnowledgeObject[] => runs.flatMap((run) => run.objects);
  const inProject = <T extends { projectId: string }>(items: T[], scope: ProjectScope | undefined): T[] =>
    scope?.projectId === undefined ? items : items.filter((item) => item.projectId === scope.projectId);

  // --- Projects: the same rules as the native store, in memory ------------------------------------------------
  const projectProblem = (code: ConstructorParameters<typeof ProjectError>[0], message: string): ProjectError => new ProjectError(code, message);
  const findProject = (projectId: string) => {
    const found = projects.find((project) => project.id === projectId);
    if (!found) throw projectProblem("project_not_found", "That project no longer exists.");
    return found;
  };
  const openProject = (projectId: string) => {
    const found = findProject(projectId);
    if (found.archivedAt !== null) throw projectProblem("project_archived", "That project is archived. Restore it first.");
    return found;
  };
  const toProject = (project: (typeof projects)[number]): Project => ({
    ...project,
    isInbox: project.id === INBOX_PROJECT_ID,
    captureCount: captures.filter((capture) => capture.projectId === project.id).length,
    objectCount: allObjects().filter((object) => object.projectId === project.id).length,
  });
  const cleanName = (name: string, exceptId?: string): string => {
    const problem = describeProjectNameProblem(name);
    if (problem) throw projectProblem("invalid_project", `That project name is not valid: ${problem}.`);
    const trimmed = name.trim();
    if (projects.some((project) => project.id !== exceptId && project.name.toLowerCase() === trimmed.toLowerCase())) {
      throw projectProblem("project_name_taken", "Another project already has that name.");
    }
    return trimmed;
  };
  const projectResult = <T,>(work: () => T): Promise<T> => {
    try {
      return Promise.resolve(work());
    } catch (failure) {
      return Promise.reject(failure);
    }
  };
  const activeProject = () => {
    const stored = projects.find((project) => project.id === activeProjectId);
    return stored && stored.archivedAt === null ? stored : findProject(INBOX_PROJECT_ID);
  };

  /**
   * Same rules as the native store: validate everything first, then write everything. Returns
   * every edge the inputs resolve to, and whether each was newly created.
   */
  const commitRelations = (
    inputs: CreateRelationInput[],
    origin: CognitiveRelationOrigin,
    invalid: RelationErrorCode,
  ): { relation: CognitiveRelation; created: boolean }[] => {
    const fail = (code: RelationErrorCode, reason: string): never => {
      throw new RelationError(code, `That relation is not valid: ${reason}.`);
    };
    const known = new Set(allObjects().map((object) => object.id));
    const seen = new Set<string>();
    const planned = inputs.map((input, index) => {
      const problem = describeCreateRelationInputProblem(input);
      if (problem) return fail(invalid, `relation ${index}: ${problem}`);
      if (!known.has(input.sourceObjectId) || !known.has(input.targetObjectId)) {
        throw new RelationError("object_not_found", "One of those knowledge objects no longer exists.");
      }
      const ends = canonicalRelationEnds(input.kind, input.sourceObjectId, input.targetObjectId);
      const key = `${input.kind}|${ends.sourceObjectId}|${ends.targetObjectId}`;
      if (seen.has(key)) return fail(invalid, `relation ${index} is a duplicate`);
      seen.add(key);
      return { kind: input.kind, ...ends };
    });

    return planned.map((ends) => {
      const existing = relations.find((r) => r.kind === ends.kind && r.sourceObjectId === ends.sourceObjectId && r.targetObjectId === ends.targetObjectId);
      if (existing) return { relation: existing, created: false };
      const relation: CognitiveRelation = { id: newId(), ...ends, createdAt: now().toISOString(), origin };
      relations.push(relation);
      return { relation, created: true };
    });
  };

  const touches = (relation: CognitiveRelation, objectId: string, direction: NonNullable<RelationFilter["direction"]>): boolean => {
    const symmetric = isSymmetricRelationKind(relation.kind);
    const outgoing = relation.sourceObjectId === objectId || (symmetric && relation.targetObjectId === objectId);
    const incoming = relation.targetObjectId === objectId || (symmetric && relation.sourceObjectId === objectId);
    return direction === "outgoing" ? outgoing : direction === "incoming" ? incoming : outgoing || incoming;
  };

  const relationsOf = (objectId: string, filter: RelationFilter | undefined): CognitiveRelation[] => {
    if (!allObjects().some((object) => object.id === objectId)) {
      throw new RelationError("object_not_found", "One of those knowledge objects no longer exists.");
    }
    if (filter?.kind !== undefined && !isRelationKind(filter.kind)) {
      throw new RelationError("invalid_relation", "That relation is not valid: unknown relation kind.");
    }
    return relations.filter((r) => touches(r, objectId, filter?.direction ?? "any") && (filter?.kind === undefined || r.kind === filter.kind));
  };

  // --- Thought Lineage: the same rules as the native store, in memory ---------------------------------------
  const lineageProblem = (reason: string): LineageError => new LineageError("invalid_revision", `That revision is not valid: ${reason}.`);
  const lineageOf = (objectId: string): { revisions: ThoughtRevision[]; current: string } => {
    const lineage = lineages.get(objectId);
    if (!lineage) throw new LineageError("object_not_found", "That knowledge object no longer exists.");
    return lineage;
  };
  const findRevision = (revisionId: string): ThoughtRevision => {
    for (const lineage of lineages.values()) {
      const found = lineage.revisions.find((revision) => revision.id === revisionId);
      if (found) return found;
    }
    throw new LineageError("revision_not_found", "That revision no longer exists.");
  };
  const ownRevision = (objectId: string, revisionId: string): ThoughtRevision => {
    const revision = findRevision(revisionId);
    if (revision.objectId !== objectId) throw lineageProblem("that revision belongs to a different object");
    return revision;
  };
  const validateContent = (content: { kind: unknown; title: unknown; body: unknown }): void => {
    if (!isKnowledgeObjectKind(content.kind)) throw lineageProblem("unknown kind");
    if (typeof content.title !== "string" || content.title.trim().length === 0) throw lineageProblem("title is empty");
    if (codePointLength(content.title) > MAX_KNOWLEDGE_TITLE_CHARS) throw lineageProblem("title is too long");
    if (typeof content.body !== "string" || content.body.trim().length === 0) throw lineageProblem("body is empty");
    if (codePointLength(content.body) > MAX_KNOWLEDGE_BODY_CHARS) throw lineageProblem("body is too long");
  };
  /** The one way a later revision comes into existence: validate everything, then write revision and pointer together. */
  const addRevision = (
    objectId: string,
    content: { kind: ThoughtRevision["kind"]; title: string; body: string },
    origin: RevisionOrigin,
    parents: ThoughtRevision[],
    makeCurrent: boolean,
  ): ThoughtRevision => {
    const lineage = lineageOf(objectId);
    if (lineage.revisions.length >= MAX_REVISIONS_PER_OBJECT) throw lineageProblem(`an object has at most ${MAX_REVISIONS_PER_OBJECT} revisions`);
    validateContent(content);
    if (origin === "merge" ? parents.length < 2 || parents.length > MAX_MERGE_PARENTS : parents.length !== 1) throw lineageProblem("wrong number of parent revisions");
    if (new Set(parents.map((parent) => parent.id)).size !== parents.length) throw lineageProblem("a parent revision is listed twice");
    const revision: ThoughtRevision = {
      id: `${objectId}:rev${lineage.revisions.length + 1}`,
      objectId,
      kind: content.kind,
      title: content.title,
      body: content.body,
      createdAt: now().toISOString(),
      origin,
      // Oldest parent first, whatever order the caller gave them.
      parentRevisionIds: [...parents].sort((a, b) => lineage.revisions.indexOf(a) - lineage.revisions.indexOf(b)).map((parent) => parent.id),
    };
    lineage.revisions.push(revision);
    if (makeCurrent) {
      lineage.current = revision.id;
      for (const run of runs) {
        const at = run.objects.findIndex((object) => object.id === objectId);
        if (at >= 0) run.objects[at] = { ...(run.objects[at] as KnowledgeObject), kind: revision.kind, title: revision.title, body: revision.body };
      }
    }
    return { ...revision };
  };
  const applyChanges = (base: ThoughtRevision, changes: RevisionChanges): { kind: ThoughtRevision["kind"]; title: string; body: string } => {
    const problem = describeRevisionChangesProblem(base, changes);
    if (problem) throw lineageProblem(problem);
    return { kind: changes.kind ?? base.kind, title: changes.title ?? base.title, body: changes.body ?? base.body };
  };
  const lineageResult = <T,>(work: () => T): Promise<T> => {
    try {
      return Promise.resolve(work());
    } catch (failure) {
      return Promise.reject(failure);
    }
  };

  return {
    kind: "preview",
    capabilities: { voiceCapture: true, speechOutput: true },
    getRuntimeInfo: () => Promise.resolve(info),
    createCapture: (input) => {
      const problem = describeCreateCaptureInputProblem(input);
      if (problem) return Promise.reject(new Error(`Invalid capture: ${problem}`));
      return projectResult(() => append(input));
    },
    getCaptures: (captureIds) => Promise.resolve(captures.filter((capture) => captureIds.includes(capture.id))),
    listCaptures: (scope) => Promise.resolve(inProject(captures, scope)),

    startVoiceCapture: () => {
      if (recording) return Promise.reject(new VoiceCaptureError("already_recording", "A recording is already in progress."));
      kept = false; // starting over leaves the retry flow
      if (voice.startError) {
        if (permission.current !== "denied_permanently") permission.current = "denied";
        return Promise.reject(voice.startError);
      }
      permission.current = "granted";
      recording = true;
      return Promise.resolve();
    },
    finishVoiceCapture: (projectId) => {
      if (!recording) return Promise.reject(new VoiceCaptureError("not_recording", "There is no recording in progress."));
      recording = false;
      if (voice.finishError) {
        kept = voice.finishError.code === "stt_retryable";
        return Promise.reject(voice.finishError);
      }
      const transcript = (voice.transcript?.() ?? "Preview voice capture.").trim();
      if (transcript.length === 0) {
        return Promise.reject(new VoiceCaptureError("empty_transcript", "No speech was recognised. Nothing was saved."));
      }
      return projectResult(() => append({ source: "voice", content: transcript, ...(projectId !== undefined ? { projectId } : {}) }));
    },
    cancelVoiceCapture: () => {
      recording = false;
      return Promise.resolve();
    },
    retryVoiceTranscription: (projectId) => {
      if (!kept) return Promise.reject(new VoiceCaptureError("no_retained_recording", "That recording is no longer kept. Record it again, or type it."));
      const failure = retryErrors.shift();
      if (failure) {
        kept = failure.code === "stt_retryable";
        return Promise.reject(failure);
      }
      kept = false;
      const transcript = (voice.transcript?.() ?? "Preview voice capture.").trim();
      if (transcript.length === 0) return Promise.reject(new VoiceCaptureError("empty_transcript", "No speech was recognised. Nothing was saved."));
      return projectResult(() => append({ source: "voice", content: transcript, ...(projectId !== undefined ? { projectId } : {}) }));
    },
    discardVoiceRecording: () => {
      kept = false;
      return Promise.resolve();
    },
    getMicrophonePermission: () => Promise.resolve(permission.current),
    openAppSettings: () => {
      voice.onOpenSettings?.();
      return Promise.resolve();
    },

    distillCapture: (captureId) => {
      const capture = captures.find((candidate) => candidate.id === captureId);
      if (!capture) return Promise.reject(new DistillationError("capture_not_found", "That capture no longer exists."));
      const existing = runs.find((run) => run.captureId === captureId);
      if (existing) return Promise.resolve([...existing.objects]);

      if (distillation.error) {
        const failure = distillation.error;
        if (distillation.once) delete distillation.error;
        remember(captureId, failure);
        return Promise.reject(failure);
      }

      const proposed = distillation.candidates?.(capture) ?? [
        { kind: "note" as const, title: sliceCodePoints(capture.content.trim(), 0, 60), body: capture.content.trim(), evidence: capture.content.trim() },
      ];
      const objects: KnowledgeObject[] = [];
      const characters = [...capture.content];
      for (const candidate of proposed) {
        // Same rule as the native resolver: the evidence must be found verbatim in the raw text.
        const needle = [...candidate.evidence.trim()];
        let start = -1;
        for (let from = 0; from + needle.length <= characters.length; from += 1) {
          if (needle.every((character, offset) => characters[from + offset] === character)) {
            start = from;
            break;
          }
        }
        const end = start + needle.length;
        if (needle.length === 0 || start < 0 || describeSpanProblem(capture.content, start, end) !== null) {
          const invalid = new DistillationError("llm_invalid_output", "The language model returned something that could not be trusted. Nothing was saved.");
          remember(captureId, invalid);
          return Promise.reject(invalid);
        }
        objects.push({
          id: newId(),
          kind: candidate.kind,
          title: candidate.title.trim(),
          body: candidate.body.trim(),
          createdAt: now().toISOString(),
          provenance: { captureId, sourceStart: start, sourceEnd: end },
          projectId: capture.projectId,
        });
      }
      objects.sort((a, b) => a.provenance.sourceStart - b.provenance.sourceStart);
      for (const object of objects) {
        const initial: ThoughtRevision = {
          id: `${object.id}:rev1`,
          objectId: object.id,
          kind: object.kind,
          title: object.title,
          body: object.body,
          createdAt: object.createdAt,
          origin: "initial",
          provenance: { ...object.provenance },
          parentRevisionIds: [],
        };
        lineages.set(object.id, { revisions: [initial], current: initial.id });
      }
      runs.unshift({ captureId, objects });
      failures.delete(captureId); // a success supersedes any failure
      return Promise.resolve([...objects]);
    },
    listKnowledgeObjects: (scope) => Promise.resolve(inProject(allObjects(), scope)),
    listOrganizationStates: (scope) =>
      Promise.resolve(
        inProject(captures, scope).map((capture): OrganizationState => {
          const run = runs.find((candidate) => candidate.captureId === capture.id);
          if (run) return { captureId: capture.id, status: "succeeded", objectCount: run.objects.length };
          const failure = failures.get(capture.id);
          return failure ? { captureId: capture.id, status: "failed", objectCount: 0, failure } : { captureId: capture.id, status: "pending", objectCount: 0 };
        }),
      ),
    getKnowledgeSummaries: (objectIds, scope) => {
      const wanted = objectIds === undefined ? null : new Set(objectIds);
      const summaries: KnowledgeSummary[] = [];
      for (const object of inProject(allObjects(), scope)) {
        if (wanted && !wanted.has(object.id)) continue;
        const lineage = lineages.get(object.id);
        const current = lineage?.revisions.find((revision) => revision.id === lineage.current);
        if (!lineage || !current) continue;
        const relationCount = relations.filter((relation) => relation.sourceObjectId === object.id || relation.targetObjectId === object.id).length;
        summaries.push({ objectId: object.id, relationCount, revisionCount: lineage.revisions.length, updatedAt: current.createdAt, currentRevisionId: current.id });
      }
      return Promise.resolve(summaries);
    },

    createRelation: (input) => {
      try {
        const [only] = commitRelations([input], "user", "invalid_relation");
        return Promise.resolve(only!.relation);
      } catch (failure) {
        return Promise.reject(failure);
      }
    },
    listRelations: () => Promise.resolve([...relations]),
    getObjectRelations: (objectId, filter) => {
      try {
        return Promise.resolve(relationsOf(objectId, filter));
      } catch (failure) {
        return Promise.reject(failure);
      }
    },
    getObjectNeighbors: (objectId, filter) => {
      try {
        const neighborIds = new Set(relationsOf(objectId, filter).map((r) => (r.sourceObjectId === objectId ? r.targetObjectId : r.sourceObjectId)));
        return Promise.resolve(allObjects().filter((object) => neighborIds.has(object.id)));
      } catch (failure) {
        return Promise.reject(failure);
      }
    },
    inferRelations: (objectIds, scope) => {
      try {
        if (inference.error) {
          const failure = inference.error;
          if (inference.once) delete inference.error;
          throw failure;
        }
        // Candidate set: requested objects first, then the most recent others, up to the hard limit.
        // Project-local, like the native layer: one project only (given, else the requested objects', else the Inbox).
        const requested = new Set(objectIds ?? []);
        const owners = new Set<string>();
        for (const id of requested) {
          const owner = allObjects().find((object) => object.id === id);
          if (!owner) throw new RelationError("object_not_found", "One of those knowledge objects no longer exists.");
          owners.add(owner.projectId);
        }
        if (scope?.projectId !== undefined) {
          if (!projects.some((project) => project.id === scope.projectId)) throw new RelationError("invalid_relation", "That relation is not valid: unknown project.");
          if ([...owners].some((owner) => owner !== scope.projectId)) throw new RelationError("invalid_relation", "That relation is not valid: the requested objects are not all in that project.");
        } else if (owners.size > 1) {
          throw new RelationError("invalid_relation", "That relation is not valid: the requested objects belong to different projects.");
        }
        const everything = inProject(allObjects(), { projectId: scope?.projectId ?? [...owners][0] ?? INBOX_PROJECT_ID });
        if (requested.size > MAX_INFERENCE_CANDIDATES) throw new RelationError("invalid_relation", "That relation is not valid: too many objects requested.");
        if ([...requested].some((id) => !everything.some((object) => object.id === id))) {
          throw new RelationError("object_not_found", "One of those knowledge objects no longer exists.");
        }
        let room = MAX_INFERENCE_CANDIDATES - requested.size;
        const candidates = everything.filter((object) => requested.has(object.id) || (room > 0 && (room -= 1, true)));
        if (candidates.length < 2) return Promise.resolve([]);

        const ids = new Set(candidates.map((object) => object.id));
        const existing = relations.filter((r) => ids.has(r.sourceObjectId) && ids.has(r.targetObjectId));
        const proposals = inference.proposals?.(candidates, existing) ?? [];

        // Never trust the model: any bad proposal rejects the whole set.
        const untrusted = (reason: string): never => {
          throw new RelationError("llm_invalid_output", `The language model returned something that could not be trusted (${reason}). Nothing was saved. Try again.`);
        };
        if (proposals.length > MAX_RELATIONS_PER_INFERENCE) untrusted("too many relations");
        const valid = proposals.map((proposal, index) => {
          if (!isRelationKind(proposal.kind)) return untrusted(`relation ${index}: unknown relation kind`);
          if (!ids.has(proposal.sourceObjectId) || !ids.has(proposal.targetObjectId)) return untrusted(`relation ${index}: refers to an object that was not supplied`);
          return { kind: proposal.kind, sourceObjectId: proposal.sourceObjectId, targetObjectId: proposal.targetObjectId };
        });
        const added = commitRelations(valid, "model", "llm_invalid_output").filter((item) => item.created);
        return Promise.resolve(added.map((item) => item.relation));
      } catch (failure) {
        return Promise.reject(failure);
      }
    },
    getObjectLineage: (objectId) =>
      lineageResult((): ObjectLineage => {
        const lineage = lineageOf(objectId);
        return { objectId, currentRevisionId: lineage.current, revisions: lineage.revisions.map((revision) => ({ ...revision })) };
      }),
    listRevisions: (objectId) => lineageResult(() => lineageOf(objectId).revisions.map((revision) => ({ ...revision }))),
    getRevision: (revisionId) => lineageResult(() => ({ ...findRevision(revisionId) })),
    getRevisionParents: (revisionId) => lineageResult(() => findRevision(revisionId).parentRevisionIds.map((id) => ({ ...findRevision(id) }))),
    getRevisionChildren: (revisionId) =>
      lineageResult(() => {
        const revision = findRevision(revisionId);
        return lineageOf(revision.objectId)
          .revisions.filter((candidate) => candidate.parentRevisionIds.includes(revisionId))
          .map((child) => ({ ...child }));
      }),
    updateKnowledgeObject: (objectId, changes) =>
      lineageResult(() => {
        const lineage = lineageOf(objectId);
        const current = ownRevision(objectId, lineage.current);
        return addRevision(objectId, applyChanges(current, changes), "user_edit", [current], true);
      }),
    createRevisionFrom: (input: CreateRevisionInput) =>
      lineageResult(() => {
        lineageOf(input.objectId);
        const parent = ownRevision(input.objectId, input.parentRevisionId);
        return addRevision(input.objectId, applyChanges(parent, input.changes), "user_edit", [parent], input.makeCurrent === true);
      }),
    mergeRevisions: (input: MergeRevisionsInput) =>
      lineageResult(() => {
        lineageOf(input.objectId);
        const parents = input.parentRevisionIds.map((id) => ownRevision(input.objectId, id));
        return addRevision(input.objectId, input.result, "merge", parents, input.makeCurrent === true);
      }),
    diffRevisions: (oldRevisionId, newRevisionId) =>
      lineageResult(() => {
        const older = findRevision(oldRevisionId);
        const newer = findRevision(newRevisionId);
        if (older.objectId !== newer.objectId) throw lineageProblem("revisions of different objects cannot be compared");
        return diffRevisionContent(older, newer);
      }),

    listProjects: (options) =>
      projectResult(() => {
        const open = projects.filter((project) => options?.includeArchived === true || project.archivedAt === null);
        const rest = open.filter((project) => project.id !== INBOX_PROJECT_ID).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
        return [...open.filter((project) => project.id === INBOX_PROJECT_ID), ...rest].map(toProject);
      }),
    getProject: (projectId) => projectResult(() => toProject(findProject(projectId))),
    createProject: (name) =>
      projectResult(() => {
        const trimmed = cleanName(name);
        const at = now().toISOString();
        const project = { id: newId(), name: trimmed, createdAt: at, updatedAt: at, archivedAt: null };
        projects.push(project);
        return toProject(project);
      }),
    renameProject: (projectId, name) =>
      projectResult(() => {
        const project = findProject(projectId);
        if (project.id === INBOX_PROJECT_ID) throw projectProblem("inbox_protected", "The Inbox cannot be renamed or archived.");
        const trimmed = cleanName(name, projectId);
        if (project.name !== trimmed) Object.assign(project, { name: trimmed, updatedAt: now().toISOString() });
        return toProject(project);
      }),
    archiveProject: (projectId) =>
      projectResult(() => {
        const project = findProject(projectId);
        if (project.id === INBOX_PROJECT_ID) throw projectProblem("inbox_protected", "The Inbox cannot be renamed or archived.");
        if (project.archivedAt === null) Object.assign(project, { archivedAt: now().toISOString(), updatedAt: now().toISOString() });
        if (activeProjectId === projectId) activeProjectId = INBOX_PROJECT_ID;
        return toProject(project);
      }),
    restoreProject: (projectId) =>
      projectResult(() => {
        const project = findProject(projectId);
        if (project.archivedAt !== null) Object.assign(project, { archivedAt: null, updatedAt: now().toISOString() });
        return toProject(project);
      }),
    moveCapture: (captureId, projectId) =>
      projectResult(() => {
        openProject(projectId);
        const at = captures.findIndex((capture) => capture.id === captureId);
        if (at < 0) throw projectProblem("capture_not_found", "That capture no longer exists.");
        // Only membership changes; the content, time and the objects distilled from it stay as they are.
        captures[at] = { ...(captures[at] as Capture), projectId };
        return captures[at] as Capture;
      }),
    moveKnowledgeObject: (objectId, projectId) =>
      projectResult(() => {
        openProject(projectId);
        for (const run of runs) {
          const at = run.objects.findIndex((object) => object.id === objectId);
          if (at >= 0) {
            run.objects[at] = { ...(run.objects[at] as KnowledgeObject), projectId };
            return run.objects[at] as KnowledgeObject;
          }
        }
        throw projectProblem("object_not_found", "That idea no longer exists.");
      }),
    getActiveProject: () => projectResult(() => toProject(activeProject())),
    setActiveProject: (projectId) =>
      projectResult(() => {
        const project = openProject(projectId);
        activeProjectId = project.id;
        return toProject(project);
      }),
    getProjectGraph: (projectId) =>
      projectResult((): ProjectGraph => {
        findProject(projectId);
        const objects = allObjects();
        const own = objects.filter((object) => object.projectId === projectId);
        const ownIds = new Set(own.map((object) => object.id));
        const touching = relations.filter((relation) => ownIds.has(relation.sourceObjectId) || ownIds.has(relation.targetObjectId));
        const farIds = new Set(touching.flatMap((relation) => [relation.sourceObjectId, relation.targetObjectId]).filter((id) => !ownIds.has(id)));
        const externalObjects = objects
          .filter((object) => farIds.has(object.id))
          .map((object) => ({ id: object.id, kind: object.kind, title: object.title, projectId: object.projectId, projectName: findProject(object.projectId).name }));
        return { projectId, objects: own, relations: touching, externalObjects };
      }),
    // The preview has no native layer, no knowledge index and no answer model, so it can never produce evidence or an answer. It
    // validates the question and the project exactly like the native layer and says "insufficient evidence" honestly. (It never
    // returns a made-up answer.)
    ask: (query: CognitiveQuery): Promise<CognitiveAnswer> => {
      const problem = describeCognitiveQueryProblem(query);
      if (problem) return Promise.reject(new RecallError("invalid_query", `That question cannot be asked: ${problem}.`));
      let project: Project;
      try {
        project = toProject(findProject(query.scope.projectId));
      } catch {
        return Promise.reject(new RecallError("project_not_found", "That project does not exist."));
      }
      const scope = { projectId: project.id, projectName: project.name, archived: project.archivedAt !== null };
      if (options.recall?.answer) return Promise.resolve(options.recall.answer({ query: query.query.trim(), scope: { projectId: query.scope.projectId } }, scope));
      return Promise.resolve({
        query: query.query.trim(),
        scope,
        outcome: "insufficient_evidence",
        answer: null,
        evidence: [],
        diagnostics: {
          retrieval: { intent: {}, lexical: "skippedNoTerms", semantic: "disabled", semanticReason: null, semanticCoverage: null, embeddingRequests: 0, uploadedTexts: 0, sqlReads: 0 },
          enrichment: {},
          context: null,
          synthesis: { state: "skipped", reason: "noEvidence", model: null, retried: false, requests: 0, strippedRefs: 0, droppedParagraphs: 0, temporalCorrected: 0 },
          timings: {},
          counts: {},
          sqlReads: 0,
        },
      });
    },
    getGraphIntegration: () => Promise.resolve({ enabled: integrationEnabled, pending: 0 }),
    setGraphIntegrationEnabled: (enabled) => {
      integrationEnabled = enabled;
      return Promise.resolve({ enabled, pending: 0 });
    },
    getSemanticRecallStatus: () => Promise.resolve({ ...semantic }),
    setSemanticRecallEnabled: (enabled) => {
      semantic = { ...semantic, enabled, savedEnabled: enabled, savedModelKey: semantic.activeModelKey };
      return Promise.resolve({ ...semantic });
    },
    purgeSemanticIndex: () => {
      semantic = { ...semantic, storedVectors: 0, storedVectorsAllKeys: 0, pendingObjects: 0 };
      return Promise.resolve({ ...semantic });
    },
    getAiConfig: () => Promise.resolve(aiConfig()),
    setCredential: (provider, secret) => {
      if (!/^[\x21-\x7e]+$/.test(secret.trim())) return Promise.reject(new AiSetupError("invalidCredentialFormat", "That doesn’t look like a valid key. Paste it exactly as the provider gave it."));
      credentials.add(provider);
      return Promise.resolve(aiConfig());
    },
    hasCredential: (provider) => Promise.resolve(credentials.has(provider)),
    deleteCredential: (provider) => {
      credentials.delete(provider);
      return Promise.resolve(aiConfig());
    },
    testProvider: (capability) => Promise.resolve({ capability, outcome: credentials.has("openai") ? (options.ai?.testOutcomes?.[capability] ?? "connected") : "notConfigured" }),
    completeSetup: () => {
      setupCompleted = true;
      return Promise.resolve(aiConfig());
    },
    speakText: (input) => speak(input.text),
    testVoice: () => speak("Hello, I'm Arthur. This is how I sound."),
    stopSpeech: () => {
      if (speechStatus.state !== "idle") speechStatus = { ...speechStatus, state: "idle", outcome: "stopped", failure: null };
      return Promise.resolve();
    },
    getSpeechStatus: () => Promise.resolve({ ...speechStatus }),
  };
}
