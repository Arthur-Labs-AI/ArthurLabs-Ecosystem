import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  describeCreateCaptureInputProblem,
  describeCreateRelationInputProblem,
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
  type KnowledgeObject,
  type RelationFilter,
  type RuntimeInfo,
} from "@arthur/contracts";
import { DistillationError, RelationError, VoiceCaptureError } from "./arthur-client";

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
