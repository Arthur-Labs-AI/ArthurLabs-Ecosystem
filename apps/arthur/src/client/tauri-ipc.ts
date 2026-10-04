import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  describeCreateCaptureInputProblem,
  describeCreateRelationInputProblem,
  isLineageErrorPayload,
  isObjectLineage,
  isRevisionDiff,
  isThoughtRevision,
  isCapture,
  isCognitiveRelation,
  isDistillationErrorPayload,
  isKnowledgeObject,
  isRelationErrorPayload,
  isRuntimeInfo,
  isVoiceCaptureErrorPayload,
  type Capture,
  type CognitiveRelation,
  type CreateCaptureInput,
  type CreateRelationInput,
  type CreateRevisionInput,
  type MergeRevisionsInput,
  type ObjectLineage,
  type RevisionChanges,
  type RevisionDiff,
  type ThoughtRevision,
  type KnowledgeObject,
  type RelationFilter,
  type RuntimeInfo,
} from "@arthur/contracts";
import { DistillationError, LineageError, RelationError, VoiceCaptureError } from "./arthur-client";

/**
 * The single module allowed to import `@tauri-apps/*`.
 * Everything else reaches the native layer through an `ArthurClient`.
 */

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function isTauriRuntime(): boolean {
  return isTauri();
}

export async function fetchRuntimeInfo(call: Invoke = invoke): Promise<RuntimeInfo> {
  const payload = await call("get_runtime_info");
  if (!isRuntimeInfo(payload)) {
    throw new Error("Native layer returned an invalid runtime info payload");
  }
  return payload;
}

export async function createCaptureOverIpc(input: CreateCaptureInput, call: Invoke = invoke): Promise<Capture> {
  const problem = describeCreateCaptureInputProblem(input);
  if (problem) throw new Error(`Invalid capture: ${problem}`);
  // Only the contract fields are sent, so a caller cannot smuggle in an id or timestamp.
  const payload = await call("create_capture", { input: { source: input.source, content: input.content } });
  if (!isCapture(payload)) {
    throw new Error("Native layer returned an invalid capture");
  }
  return payload;
}

export async function listCapturesOverIpc(call: Invoke = invoke): Promise<Capture[]> {
  const payload = await call("list_captures");
  if (!Array.isArray(payload) || !payload.every(isCapture)) {
    throw new Error("Native layer returned an invalid capture list");
  }
  return payload;
}

/** The native layer rejects voice failures with `{ code, message }`; anything else is passed through. */
function toVoiceCaptureError(failure: unknown): unknown {
  if (isVoiceCaptureErrorPayload(failure)) return new VoiceCaptureError(failure.code, failure.message);
  return failure;
}

export async function startVoiceCaptureOverIpc(call: Invoke = invoke): Promise<void> {
  try {
    await call("start_voice_capture");
  } catch (failure) {
    throw toVoiceCaptureError(failure);
  }
}

export async function finishVoiceCaptureOverIpc(call: Invoke = invoke): Promise<Capture> {
  let payload: unknown;
  try {
    payload = await call("finish_voice_capture");
  } catch (failure) {
    throw toVoiceCaptureError(failure);
  }
  if (!isCapture(payload) || payload.source !== "voice") {
    throw new Error("Native layer returned an invalid voice capture");
  }
  return payload;
}

export async function cancelVoiceCaptureOverIpc(call: Invoke = invoke): Promise<void> {
  try {
    await call("cancel_voice_capture");
  } catch (failure) {
    throw toVoiceCaptureError(failure);
  }
}

/** The native layer rejects distillation failures with `{ code, message }`; anything else is passed through. */
function toDistillationError(failure: unknown): unknown {
  if (isDistillationErrorPayload(failure)) return new DistillationError(failure.code, failure.message);
  return failure;
}

export async function distillCaptureOverIpc(captureId: string, call: Invoke = invoke): Promise<KnowledgeObject[]> {
  if (typeof captureId !== "string" || captureId.length === 0) throw new Error("Invalid capture id");
  let payload: unknown;
  try {
    payload = await call("distill_capture", { captureId });
  } catch (failure) {
    throw toDistillationError(failure);
  }
  if (!Array.isArray(payload) || !payload.every(isKnowledgeObject)) {
    throw new Error("Native layer returned invalid knowledge objects");
  }
  return payload;
}

export async function listKnowledgeObjectsOverIpc(call: Invoke = invoke): Promise<KnowledgeObject[]> {
  const payload = await call("list_knowledge_objects");
  if (!Array.isArray(payload) || !payload.every(isKnowledgeObject)) {
    throw new Error("Native layer returned invalid knowledge objects");
  }
  return payload;
}

/** The native layer rejects relation failures with `{ code, message }`; anything else is passed through. */
function toRelationError(failure: unknown): unknown {
  if (isRelationErrorPayload(failure)) return new RelationError(failure.code, failure.message);
  return failure;
}

async function relationCall(command: string, args: Record<string, unknown> | undefined, call: Invoke): Promise<unknown> {
  try {
    return await call(command, args);
  } catch (failure) {
    throw toRelationError(failure);
  }
}

function readRelations(payload: unknown): CognitiveRelation[] {
  if (!Array.isArray(payload) || !payload.every(isCognitiveRelation)) {
    throw new Error("Native layer returned invalid relations");
  }
  return payload;
}

/** Only fields that are set are sent, so the native defaults (any direction, any kind) apply otherwise. */
function filterArgs(objectId: string, filter: RelationFilter | undefined): Record<string, unknown> {
  if (typeof objectId !== "string" || objectId.length === 0) throw new Error("Invalid object id");
  return {
    objectId,
    ...(filter?.direction !== undefined ? { direction: filter.direction } : {}),
    ...(filter?.kind !== undefined ? { kind: filter.kind } : {}),
  };
}

export async function createRelationOverIpc(input: CreateRelationInput, call: Invoke = invoke): Promise<CognitiveRelation> {
  const problem = describeCreateRelationInputProblem(input);
  if (problem) throw new RelationError("invalid_relation", `That relation is not valid: ${problem}.`);
  // Only the contract fields are sent, so a caller cannot smuggle in an id, timestamp or origin.
  const payload = await relationCall(
    "create_relation",
    { input: { kind: input.kind, sourceObjectId: input.sourceObjectId, targetObjectId: input.targetObjectId } },
    call,
  );
  if (!isCognitiveRelation(payload)) throw new Error("Native layer returned an invalid relation");
  return payload;
}

export async function listRelationsOverIpc(call: Invoke = invoke): Promise<CognitiveRelation[]> {
  return readRelations(await relationCall("list_relations", undefined, call));
}

export async function getObjectRelationsOverIpc(objectId: string, filter: RelationFilter | undefined, call: Invoke = invoke): Promise<CognitiveRelation[]> {
  return readRelations(await relationCall("get_object_relations", filterArgs(objectId, filter), call));
}

export async function getObjectNeighborsOverIpc(objectId: string, filter: RelationFilter | undefined, call: Invoke = invoke): Promise<KnowledgeObject[]> {
  const payload = await relationCall("get_object_neighbors", filterArgs(objectId, filter), call);
  if (!Array.isArray(payload) || !payload.every(isKnowledgeObject)) throw new Error("Native layer returned invalid knowledge objects");
  return payload;
}

export async function inferRelationsOverIpc(objectIds: string[] | undefined, call: Invoke = invoke): Promise<CognitiveRelation[]> {
  if (objectIds !== undefined && (!Array.isArray(objectIds) || objectIds.some((id) => typeof id !== "string" || id.length === 0))) {
    throw new Error("Invalid object ids");
  }
  return readRelations(await relationCall("infer_relations", objectIds === undefined ? undefined : { objectIds }, call));
}

// --- Thought Lineage ---------------------------------------------------------------------------------------------

/** The native layer rejects lineage failures with `{ code, message }`; anything else is passed through. */
async function lineageCall(command: string, args: Record<string, unknown> | undefined, call: Invoke): Promise<unknown> {
  try {
    return await call(command, args);
  } catch (failure) {
    if (isLineageErrorPayload(failure)) throw new LineageError(failure.code, failure.message);
    throw failure;
  }
}

const requireId = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${what}`);
  return value;
};

/** Only the contract fields are sent, so a caller cannot smuggle in an id, a timestamp, an origin or provenance. */
function changesArgs(changes: RevisionChanges): RevisionChanges {
  if (typeof changes !== "object" || changes === null) throw new LineageError("invalid_revision", "That revision is not valid: changes must be an object.");
  return {
    ...(changes.kind !== undefined ? { kind: changes.kind } : {}),
    ...(changes.title !== undefined ? { title: changes.title } : {}),
    ...(changes.body !== undefined ? { body: changes.body } : {}),
  };
}

function readRevision(payload: unknown): ThoughtRevision {
  if (!isThoughtRevision(payload)) throw new Error("Native layer returned an invalid revision");
  return payload;
}

function readRevisions(payload: unknown): ThoughtRevision[] {
  if (!Array.isArray(payload) || !payload.every(isThoughtRevision)) throw new Error("Native layer returned invalid revisions");
  return payload;
}

export async function getObjectLineageOverIpc(objectId: string, call: Invoke = invoke): Promise<ObjectLineage> {
  const payload = await lineageCall("get_object_lineage", { objectId: requireId(objectId, "object id") }, call);
  if (!isObjectLineage(payload)) throw new Error("Native layer returned an invalid lineage");
  return payload;
}

export async function listRevisionsOverIpc(objectId: string, call: Invoke = invoke): Promise<ThoughtRevision[]> {
  return readRevisions(await lineageCall("list_revisions", { objectId: requireId(objectId, "object id") }, call));
}

export async function getRevisionOverIpc(revisionId: string, call: Invoke = invoke): Promise<ThoughtRevision> {
  return readRevision(await lineageCall("get_revision", { revisionId: requireId(revisionId, "revision id") }, call));
}

export async function getRevisionParentsOverIpc(revisionId: string, call: Invoke = invoke): Promise<ThoughtRevision[]> {
  return readRevisions(await lineageCall("get_revision_parents", { revisionId: requireId(revisionId, "revision id") }, call));
}

export async function getRevisionChildrenOverIpc(revisionId: string, call: Invoke = invoke): Promise<ThoughtRevision[]> {
  return readRevisions(await lineageCall("get_revision_children", { revisionId: requireId(revisionId, "revision id") }, call));
}

export async function updateKnowledgeObjectOverIpc(objectId: string, changes: RevisionChanges, call: Invoke = invoke): Promise<ThoughtRevision> {
  return readRevision(await lineageCall("update_knowledge_object", { objectId: requireId(objectId, "object id"), changes: changesArgs(changes) }, call));
}

export async function createRevisionFromOverIpc(input: CreateRevisionInput, call: Invoke = invoke): Promise<ThoughtRevision> {
  return readRevision(
    await lineageCall(
      "create_revision_from",
      {
        input: {
          objectId: requireId(input?.objectId, "object id"),
          parentRevisionId: requireId(input?.parentRevisionId, "revision id"),
          changes: changesArgs(input.changes),
          ...(input.makeCurrent !== undefined ? { makeCurrent: input.makeCurrent === true } : {}),
        },
      },
      call,
    ),
  );
}

export async function mergeRevisionsOverIpc(input: MergeRevisionsInput, call: Invoke = invoke): Promise<ThoughtRevision> {
  const parents = input?.parentRevisionIds;
  if (!Array.isArray(parents) || parents.length < 2 || parents.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new LineageError("invalid_revision", "That revision is not valid: a merge needs two or more parent revisions.");
  }
  const { kind, title, body } = input.result ?? ({} as MergeRevisionsInput["result"]);
  return readRevision(
    await lineageCall(
      "merge_revisions",
      {
        input: {
          objectId: requireId(input.objectId, "object id"),
          parentRevisionIds: parents,
          result: { kind, title, body },
          ...(input.makeCurrent !== undefined ? { makeCurrent: input.makeCurrent === true } : {}),
        },
      },
      call,
    ),
  );
}

export async function diffRevisionsOverIpc(oldRevisionId: string, newRevisionId: string, call: Invoke = invoke): Promise<RevisionDiff> {
  const payload = await lineageCall("diff_revisions", { oldRevisionId: requireId(oldRevisionId, "revision id"), newRevisionId: requireId(newRevisionId, "revision id") }, call);
  if (!isRevisionDiff(payload)) throw new Error("Native layer returned an invalid diff");
  return payload;
}
