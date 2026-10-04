import {
  MAX_INFERENCE_CANDIDATES,
  MAX_RELATIONS_PER_INFERENCE,
  canonicalRelationEnds,
  describeCreateCaptureInputProblem,
  describeCreateRelationInputProblem,
  describeSpanProblem,
  isRelationKind,
  isSymmetricRelationKind,
  sliceCodePoints,
  type Capture,
  type CognitiveRelation,
  type CognitiveRelationOrigin,
  type CreateCaptureInput,
  type CreateRelationInput,
  type KnowledgeObject,
  type KnowledgeObjectKind,
  type RelationErrorCode,
  type RelationFilter,
  type RuntimeInfo,
} from "@arthur/contracts";
import { DistillationError, RelationError, VoiceCaptureError, type ArthurClient } from "./arthur-client";

const DEFAULT_PREVIEW_INFO: RuntimeInfo = { appVersion: "0.0.0-preview", platform: "unknown" };

export interface PreviewVoiceOptions {
  /** Transcript the fake speech service "hears". Default: a fixed sentence. */
  transcript?: () => string;
  /** Make `startVoiceCapture` fail, e.g. to simulate a denied microphone permission. */
  startError?: VoiceCaptureError;
  /** Make `finishVoiceCapture` fail, e.g. to simulate a network failure. */
  finishError?: VoiceCaptureError;
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

export interface PreviewClientOptions {
  info?: RuntimeInfo;
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
  const distillation = { ...options.distillation };
  const inference = { ...options.inference };
  const captures: Capture[] = [];
  /** Newest distillation first, like the native store. Zero-object runs are remembered too. */
  const runs: { captureId: string; objects: KnowledgeObject[] }[] = [];
  /** Oldest first, like the native store. */
  const relations: CognitiveRelation[] = [];
  let recording = false;

  const append = (input: CreateCaptureInput): Capture => {
    const capture: Capture = { id: newId(), source: input.source, content: input.content, createdAt: now().toISOString() };
    captures.unshift(capture);
    return capture;
  };

  const allObjects = (): KnowledgeObject[] => runs.flatMap((run) => run.objects);

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

  return {
    kind: "preview",
    capabilities: { voiceCapture: true },
    getRuntimeInfo: () => Promise.resolve(info),
    createCapture: (input) => {
      const problem = describeCreateCaptureInputProblem(input);
      if (problem) return Promise.reject(new Error(`Invalid capture: ${problem}`));
      return Promise.resolve(append(input));
    },
    listCaptures: () => Promise.resolve([...captures]),

    startVoiceCapture: () => {
      if (recording) return Promise.reject(new VoiceCaptureError("already_recording", "A recording is already in progress."));
      if (voice.startError) return Promise.reject(voice.startError);
      recording = true;
      return Promise.resolve();
    },
    finishVoiceCapture: () => {
      if (!recording) return Promise.reject(new VoiceCaptureError("not_recording", "There is no recording in progress."));
      recording = false;
      if (voice.finishError) return Promise.reject(voice.finishError);
      const transcript = (voice.transcript?.() ?? "Preview voice capture.").trim();
      if (transcript.length === 0) {
        return Promise.reject(new VoiceCaptureError("empty_transcript", "No speech was recognised. Nothing was saved."));
      }
      return Promise.resolve(append({ source: "voice", content: transcript }));
    },
    cancelVoiceCapture: () => {
      recording = false;
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
          return Promise.reject(new DistillationError("llm_invalid_output", "The language model returned something that could not be trusted. Nothing was saved."));
        }
        objects.push({
          id: newId(),
          kind: candidate.kind,
          title: candidate.title.trim(),
          body: candidate.body.trim(),
          createdAt: now().toISOString(),
          provenance: { captureId, sourceStart: start, sourceEnd: end },
        });
      }
      objects.sort((a, b) => a.provenance.sourceStart - b.provenance.sourceStart);
      runs.unshift({ captureId, objects });
      return Promise.resolve([...objects]);
    },
    listKnowledgeObjects: () => Promise.resolve(allObjects()),

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
    inferRelations: (objectIds) => {
      try {
        if (inference.error) {
          const failure = inference.error;
          if (inference.once) delete inference.error;
          throw failure;
        }
        // Candidate set: requested objects first, then the most recent others, up to the hard limit.
        const everything = allObjects();
        const requested = new Set(objectIds ?? []);
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
  };
}

