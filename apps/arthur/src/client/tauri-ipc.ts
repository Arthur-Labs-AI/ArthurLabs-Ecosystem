import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  MAX_CAPTURE_LOOKUP,
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
  isMicrophonePermissionState,
  isOrganizationStatus,
  isProject,
  isProjectErrorPayload,
  isProjectGraph,
  isCognitiveAnswer,
  isRecallErrorPayload,
  isGraphIntegrationStatus,
  isSemanticRecallStatus,
  isAiConfig,
  isAiErrorPayload,
  isSpeechErrorPayload,
  isSpeechStart,
  isSpeechStatus,
  isProviderTestResult,
  describeCognitiveQueryProblem,
  describeProjectNameProblem,
  isRelationErrorPayload,
  isRuntimeInfo,
  isVoiceCaptureErrorPayload,
  describeReviewInputProblem,
  isApprovalInfo,
  isClaimOutcome,
  isEvolutionErrorPayload,
  isEvolutionStatus,
  isReviewOutcome,
  isRevisionProposal,
  isUnresolvedClaim,
  type ApprovalInfo,
  type ClaimOutcome,
  type EvolutionConsentKind,
  type EvolutionStatus,
  type ProposalState,
  type ResolveClaimInput,
  type ReviewOutcome,
  type ReviewProposalInput,
  type RevisionProposal,
  type UnresolvedClaim,
  type Capture,
  type CognitiveAnswer,
  type GraphIntegrationStatus,
  type SemanticRecallStatus,
  type AiCapability,
  type AiConfig,
  type AiProviderId,
  type SpeakInput,
  type SpeechStart,
  type SpeechStatus,
  type ProviderTestResult,
  type CognitiveQuery,
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
  type KnowledgeSummary,
  type MicrophonePermissionState,
  type OrganizationState,
  type Project,
  type ProjectGraph,
  type ProjectScope,
  type RelationFilter,
  type RuntimeInfo,
} from "@arthur/contracts";
import { AiSetupError, SpeechError, DistillationError, EvolutionError, LineageError, ProjectError, RecallError, RelationError, VoiceCaptureError } from "./arthur-client";

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
  const payload = await call("create_capture", {
    input: { source: input.source, content: input.content, ...(input.projectId !== undefined ? { projectId: input.projectId } : {}) },
  });
  if (!isCapture(payload)) {
    throw new Error("Native layer returned an invalid capture");
  }
  return payload;
}

/** `projectId` is sent only when set, so the native default (every project) applies otherwise. */
const scopeArgs = (scope: ProjectScope | undefined): Record<string, unknown> => (scope?.projectId !== undefined ? { projectId: requireId(scope.projectId, "project id") } : {});
/** The arguments of a command that takes only the scope: none at all when unscoped, exactly as before projects existed. */
const scopeOnly = (scope: ProjectScope | undefined): Record<string, unknown> | undefined => (scope?.projectId !== undefined ? scopeArgs(scope) : undefined);
/** Calls with no second argument at all when there are no arguments, exactly as before projects existed. */
const invokeWith = (call: Invoke, command: string, args: Record<string, unknown> | undefined): Promise<unknown> => (args === undefined ? call(command) : call(command, args));

export async function listCapturesOverIpc(scope: ProjectScope | undefined, call: Invoke = invoke): Promise<Capture[]> {
  const payload = await invokeWith(call, "list_captures", scopeOnly(scope));
  if (!Array.isArray(payload) || !payload.every(isCapture)) {
    throw new Error("Native layer returned an invalid capture list");
  }
  return payload;
}

export async function getCapturesOverIpc(captureIds: string[], call: Invoke = invoke): Promise<Capture[]> {
  if (!Array.isArray(captureIds) || captureIds.length > MAX_CAPTURE_LOOKUP || captureIds.some((id) => typeof id !== "string" || id.length === 0)) throw new Error("Invalid capture ids");
  if (captureIds.length === 0) return [];
  const payload = await call("get_captures", { captureIds });
  if (!Array.isArray(payload) || !payload.every(isCapture)) throw new Error("Native layer returned an invalid capture list");
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

export async function finishVoiceCaptureOverIpc(projectId: string | undefined, call: Invoke = invoke): Promise<Capture> {
  let payload: unknown;
  try {
    payload = await invokeWith(call, "finish_voice_capture", scopeOnly({ projectId }));
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

export async function retryVoiceTranscriptionOverIpc(projectId: string | undefined, call: Invoke = invoke): Promise<Capture> {
  let payload: unknown;
  try {
    payload = await invokeWith(call, "retry_voice_transcription", scopeOnly({ projectId }));
  } catch (failure) {
    throw toVoiceCaptureError(failure);
  }
  if (!isCapture(payload) || payload.source !== "voice") {
    throw new Error("Native layer returned an invalid voice capture");
  }
  return payload;
}

export async function discardVoiceRecordingOverIpc(call: Invoke = invoke): Promise<void> {
  try {
    await call("discard_voice_recording");
  } catch (failure) {
    throw toVoiceCaptureError(failure);
  }
}

export async function getMicrophonePermissionOverIpc(call: Invoke = invoke): Promise<MicrophonePermissionState> {
  let payload: unknown;
  try {
    payload = await call("get_microphone_permission");
  } catch (failure) {
    throw toVoiceCaptureError(failure);
  }
  if (!isMicrophonePermissionState(payload)) throw new Error("Native layer returned an invalid microphone permission");
  return payload;
}

export async function openAppSettingsOverIpc(call: Invoke = invoke): Promise<void> {
  try {
    await call("open_app_settings");
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

export async function listKnowledgeObjectsOverIpc(scope: ProjectScope | undefined, call: Invoke = invoke): Promise<KnowledgeObject[]> {
  const payload = await invokeWith(call, "list_knowledge_objects", scopeOnly(scope));
  if (!Array.isArray(payload) || !payload.every(isKnowledgeObject)) {
    throw new Error("Native layer returned invalid knowledge objects");
  }
  return payload;
}

function isOrganizationState(value: unknown): value is OrganizationState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.captureId !== "string" || candidate.captureId.length === 0) return false;
  if (!isOrganizationStatus(candidate.status)) return false;
  if (typeof candidate.objectCount !== "number" || !Number.isInteger(candidate.objectCount) || candidate.objectCount < 0) return false;
  if (candidate.status === "failed") {
    const failure = candidate.failure as Record<string, unknown> | null | undefined;
    return typeof failure === "object" && failure !== null && typeof failure.code === "string" && typeof failure.message === "string" && typeof failure.failedAt === "string";
  }
  return candidate.failure === undefined || candidate.failure === null;
}

export async function listOrganizationStatesOverIpc(scope: ProjectScope | undefined, call: Invoke = invoke): Promise<OrganizationState[]> {
  const payload = await invokeWith(call, "list_organization_states", scopeOnly(scope));
  if (!Array.isArray(payload) || !payload.every(isOrganizationState)) throw new Error("Native layer returned invalid organization states");
  return payload;
}

function isKnowledgeSummary(value: unknown): value is KnowledgeSummary {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  const count = (n: unknown): boolean => typeof n === "number" && Number.isInteger(n) && n >= 0;
  return typeof c.objectId === "string" && c.objectId.length > 0 && count(c.relationCount) && count(c.revisionCount) && typeof c.updatedAt === "string" && c.updatedAt.length > 0 && typeof c.currentRevisionId === "string" && c.currentRevisionId.length > 0;
}

export async function getKnowledgeSummariesOverIpc(objectIds: string[] | undefined, scope: ProjectScope | undefined, call: Invoke = invoke): Promise<KnowledgeSummary[]> {
  const payload = await call("get_knowledge_summaries", { ...(objectIds === undefined ? {} : { objectIds }), ...scopeArgs(scope) });
  if (!Array.isArray(payload) || !payload.every(isKnowledgeSummary)) throw new Error("Native layer returned invalid knowledge summaries");
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

export async function inferRelationsOverIpc(objectIds: string[] | undefined, scope: ProjectScope | undefined, call: Invoke = invoke): Promise<CognitiveRelation[]> {
  if (objectIds !== undefined && (!Array.isArray(objectIds) || objectIds.some((id) => typeof id !== "string" || id.length === 0))) {
    throw new Error("Invalid object ids");
  }
  const args = { ...(objectIds === undefined ? {} : { objectIds }), ...scopeArgs(scope) };
  return readRelations(await relationCall("infer_relations", Object.keys(args).length === 0 ? undefined : args, call));
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


// --- Projects ----------------------------------------------------------------------------------------------------

/** The native layer rejects project failures with `{ code, message }`; anything else is passed through. */
async function projectCall(command: string, args: Record<string, unknown> | undefined, call: Invoke): Promise<unknown> {
  try {
    return await call(command, args);
  } catch (failure) {
    if (isProjectErrorPayload(failure)) throw new ProjectError(failure.code, failure.message);
    throw failure;
  }
}

function readProject(payload: unknown): Project {
  if (!isProject(payload)) throw new Error("Native layer returned an invalid project");
  return payload;
}

function validName(name: string): string {
  const problem = describeProjectNameProblem(name);
  if (problem) throw new ProjectError("invalid_project", `That project name is not valid: ${problem}.`);
  return name;
}

export async function listProjectsOverIpc(options: { includeArchived?: boolean } | undefined, call: Invoke = invoke): Promise<Project[]> {
  const payload = await projectCall("list_projects", options?.includeArchived === undefined ? undefined : { includeArchived: options.includeArchived === true }, call);
  if (!Array.isArray(payload) || !payload.every(isProject)) throw new Error("Native layer returned invalid projects");
  return payload;
}

export async function getProjectOverIpc(projectId: string, call: Invoke = invoke): Promise<Project> {
  return readProject(await projectCall("get_project", { projectId: requireId(projectId, "project id") }, call));
}

export async function createProjectOverIpc(name: string, call: Invoke = invoke): Promise<Project> {
  return readProject(await projectCall("create_project", { name: validName(name) }, call));
}

export async function renameProjectOverIpc(projectId: string, name: string, call: Invoke = invoke): Promise<Project> {
  return readProject(await projectCall("rename_project", { projectId: requireId(projectId, "project id"), name: validName(name) }, call));
}

export async function archiveProjectOverIpc(projectId: string, call: Invoke = invoke): Promise<Project> {
  return readProject(await projectCall("archive_project", { projectId: requireId(projectId, "project id") }, call));
}

export async function restoreProjectOverIpc(projectId: string, call: Invoke = invoke): Promise<Project> {
  return readProject(await projectCall("restore_project", { projectId: requireId(projectId, "project id") }, call));
}

export async function moveCaptureOverIpc(captureId: string, projectId: string, call: Invoke = invoke): Promise<Capture> {
  const payload = await projectCall("move_capture", { captureId: requireId(captureId, "capture id"), projectId: requireId(projectId, "project id") }, call);
  if (!isCapture(payload)) throw new Error("Native layer returned an invalid capture");
  return payload;
}

export async function moveKnowledgeObjectOverIpc(objectId: string, projectId: string, call: Invoke = invoke): Promise<KnowledgeObject> {
  const payload = await projectCall("move_knowledge_object", { objectId: requireId(objectId, "object id"), projectId: requireId(projectId, "project id") }, call);
  if (!isKnowledgeObject(payload)) throw new Error("Native layer returned an invalid knowledge object");
  return payload;
}

export async function getActiveProjectOverIpc(call: Invoke = invoke): Promise<Project> {
  return readProject(await projectCall("get_active_project", undefined, call));
}

export async function setActiveProjectOverIpc(projectId: string, call: Invoke = invoke): Promise<Project> {
  return readProject(await projectCall("set_active_project", { projectId: requireId(projectId, "project id") }, call));
}

export async function getProjectGraphOverIpc(projectId: string, call: Invoke = invoke): Promise<ProjectGraph> {
  const payload = await projectCall("get_project_graph", { projectId: requireId(projectId, "project id") }, call);
  if (!isProjectGraph(payload)) throw new Error("Native layer returned an invalid project graph");
  return payload;
}

/** Ask Arthur. The scope is explicit and passed through untouched: this layer never substitutes the active project. */
export async function askOverIpc(query: CognitiveQuery, call: Invoke = invoke): Promise<CognitiveAnswer> {
  const problem = describeCognitiveQueryProblem(query);
  if (problem) throw new RecallError("invalid_query", `That question cannot be asked: ${problem}.`);
  let payload: unknown;
  try {
    payload = await call("ask", { query: { query: query.query, scope: { projectId: query.scope.projectId } } });
  } catch (failure) {
    if (isRecallErrorPayload(failure)) throw new RecallError(failure.code, failure.message);
    throw failure;
  }
  if (!isCognitiveAnswer(payload)) throw new Error("Native layer returned an invalid answer");
  return payload;
}

async function semanticOverIpc(command: string, args: Record<string, unknown>, call: Invoke): Promise<SemanticRecallStatus> {
  let payload: unknown;
  try {
    payload = await call(command, args);
  } catch (failure) {
    if (isRecallErrorPayload(failure)) throw new RecallError(failure.code, failure.message);
    throw failure;
  }
  if (!isSemanticRecallStatus(payload)) throw new Error("Native layer returned an invalid semantic Recall status");
  return payload;
}

export const getSemanticRecallStatusOverIpc = (call: Invoke = invoke) => semanticOverIpc("get_semantic_recall_status", {}, call);
export const setSemanticRecallEnabledOverIpc = (enabled: boolean, call: Invoke = invoke) => semanticOverIpc("set_semantic_recall_enabled", { enabled }, call);
async function integrationOverIpc(command: string, args: Record<string, unknown>, call: Invoke): Promise<GraphIntegrationStatus> {
  let payload: unknown;
  try {
    payload = await call(command, args);
  } catch (failure) {
    if (isRecallErrorPayload(failure)) throw new RecallError(failure.code, failure.message);
    throw failure;
  }
  if (!isGraphIntegrationStatus(payload)) throw new Error("Native layer returned an invalid Automatic Connections status");
  return payload;
}

export const getGraphIntegrationOverIpc = (call: Invoke = invoke) => integrationOverIpc("get_graph_integration", {}, call);
export const setGraphIntegrationEnabledOverIpc = (enabled: boolean, call: Invoke = invoke) => integrationOverIpc("set_graph_integration_enabled", { enabled }, call);
export const purgeSemanticIndexOverIpc = (call: Invoke = invoke) => semanticOverIpc("purge_semantic_index", {}, call);

const AI_MESSAGES: Record<string, string> = {
  invalidCredentialFormat: "That doesn’t look like a valid key. Paste it exactly as the provider gave it.",
  unknownProvider: "That provider isn’t supported.",
  unknownCapability: "That capability isn’t supported.",
  unsupportedVoiceOrModel: "That voice or model isn’t available.",
  storage: "The key could not be saved securely on this device.",
};

async function aiCall(command: string, args: Record<string, unknown>, call: Invoke): Promise<unknown> {
  try {
    return await call(command, args);
  } catch (failure) {
    // The message is chosen here from the code alone, so nothing the native layer or a provider said is ever displayed.
    if (isAiErrorPayload(failure)) throw new AiSetupError(failure.code, AI_MESSAGES[failure.code] ?? "Provider setup failed.");
    throw failure;
  }
}

async function aiConfigCall(command: string, args: Record<string, unknown>, call: Invoke): Promise<AiConfig> {
  const payload = await aiCall(command, args, call);
  if (!isAiConfig(payload)) throw new Error("Native layer returned an invalid AI configuration");
  return payload;
}

export const getAiConfigOverIpc = (call: Invoke = invoke) => aiConfigCall("get_ai_config", {}, call);
export const setCredentialOverIpc = (provider: AiProviderId, secret: string, call: Invoke = invoke) => aiConfigCall("set_provider_credential", { provider, secret }, call);
export const deleteCredentialOverIpc = (provider: AiProviderId, call: Invoke = invoke) => aiConfigCall("delete_provider_credential", { provider }, call);
export const completeSetupOverIpc = (call: Invoke = invoke) => aiConfigCall("complete_setup", {}, call);

export async function hasCredentialOverIpc(provider: AiProviderId, call: Invoke = invoke): Promise<boolean> {
  const payload = await aiCall("has_provider_credential", { provider }, call);
  if (typeof payload !== "boolean") throw new Error("Native layer returned an invalid credential status");
  return payload;
}

export async function testProviderOverIpc(capability: AiCapability, call: Invoke = invoke): Promise<ProviderTestResult> {
  const payload = await aiCall("test_provider", { capability }, call);
  if (!isProviderTestResult(payload)) throw new Error("Native layer returned an invalid provider test result");
  return payload;
}

const SPEECH_MESSAGES = { emptyText: "There is nothing to read aloud.", unsupportedVoiceOrModel: "That voice or model isn’t available." } as const;

async function speechCall(command: string, args: Record<string, unknown>, call: Invoke): Promise<unknown> {
  try {
    return await call(command, args);
  } catch (failure) {
    // Chosen from the code alone, so nothing a provider or the native layer said is ever displayed.
    if (isSpeechErrorPayload(failure)) throw new SpeechError(failure.code, SPEECH_MESSAGES[failure.code]);
    throw failure;
  }
}

async function speechStart(command: string, args: Record<string, unknown>, call: Invoke): Promise<SpeechStart> {
  const payload = await speechCall(command, args, call);
  if (!isSpeechStart(payload)) throw new Error("Native layer returned an invalid speech session");
  return payload;
}

export const speakTextOverIpc = (input: SpeakInput, call: Invoke = invoke) => {
  if (typeof input.text !== "string" || input.text.trim().length === 0) return Promise.reject(new SpeechError("emptyText", SPEECH_MESSAGES.emptyText));
  return speechStart("speak_text", { text: input.text, voice: input.voice ?? null, model: input.model ?? null }, call);
};
export const testVoiceOverIpc = (call: Invoke = invoke) => speechStart("test_voice", {}, call);
export async function stopSpeechOverIpc(call: Invoke = invoke): Promise<void> {
  await speechCall("stop_speech", {}, call);
}
export async function getSpeechStatusOverIpc(call: Invoke = invoke): Promise<SpeechStatus> {
  const payload = await speechCall("get_speech_status", {}, call);
  if (!isSpeechStatus(payload)) throw new Error("Native layer returned an invalid speech status");
  return payload;
}

/** The native event Automatic Graph Integration emits after it changed the graph. Mirrors `GRAPH_CHANGED_EVENT` in `commands/integration.rs`. */
export const GRAPH_INTEGRATED_EVENT = "graph-integrated";

type Subscribe = (event: string, handler: () => void) => Promise<() => void>;

/** Subscribes to graph changes made by background integration. Never throws: outside the native shell it simply never fires. */
export function onGraphIntegratedOverIpc(listener: () => void, subscribe: Subscribe = listen): () => void {
  let stopped = false;
  let unlisten: (() => void) | undefined;
  try {
    subscribe(GRAPH_INTEGRATED_EVENT, listener).then(
      (stop) => {
        if (stopped) stop();
        else unlisten = stop;
      },
      () => {},
    );
  } catch {
    // no native event bus (a plain browser): nothing to subscribe to
  }
  return () => {
    stopped = true;
    unlisten?.();
  };
}

// --- Automatic Thought Evolution (review-first) --------------------------------------------------------------------

/** The native layer rejects with `{ code, message, currentRevisionId? }`; anything else is passed through. */
async function evolutionCall(command: string, args: Record<string, unknown> | undefined, call: Invoke): Promise<unknown> {
  try {
    return await call(command, args);
  } catch (failure) {
    if (isEvolutionErrorPayload(failure)) throw new EvolutionError(failure.code, failure.message, failure.currentRevisionId ?? null);
    throw failure;
  }
}

async function evolutionStatusCall(command: string, args: Record<string, unknown> | undefined, call: Invoke): Promise<EvolutionStatus> {
  const payload = await evolutionCall(command, args, call);
  if (!isEvolutionStatus(payload)) throw new Error("Native layer returned an invalid Automatic Thought Evolution status");
  return payload;
}

export const getEvolutionStatusOverIpc = (call: Invoke = invoke) => evolutionStatusCall("get_evolution_status", undefined, call);
export const setEvolutionEnabledOverIpc = (enabled: boolean, call: Invoke = invoke) => evolutionStatusCall("set_evolution_enabled", { enabled: enabled === true }, call);

export function setEvolutionConsentOverIpc(kind: EvolutionConsentKind, granted: boolean, disclosureVersion: string | undefined, call: Invoke = invoke): Promise<EvolutionStatus> {
  if (!["typesafe", "synthesis", "verification"].includes(kind)) return Promise.reject(new Error("Invalid consent kind"));
  return evolutionStatusCall("set_evolution_consent", { kind, granted: granted === true, ...(disclosureVersion === undefined ? {} : { disclosureVersion }) }, call);
}

export function setTypesafeCredentialOverIpc(secret: string, call: Invoke = invoke): Promise<EvolutionStatus> {
  if (typeof secret !== "string" || secret.trim().length === 0) return Promise.reject(new EvolutionError("invalid_credential", "That does not look like an API key."));
  // Write-only: the secret goes to the native layer and the answer is a status that contains no key.
  return evolutionStatusCall("set_typesafe_credential", { secret }, call);
}

export const deleteTypesafeCredentialOverIpc = (call: Invoke = invoke) => evolutionStatusCall("delete_typesafe_credential", undefined, call);

function readProposal(payload: unknown): RevisionProposal {
  if (!isRevisionProposal(payload)) throw new Error("Native layer returned an invalid suggestion");
  return payload;
}

export async function listRevisionProposalsOverIpc(options: { projectId?: string; states?: ProposalState[] } | undefined, call: Invoke = invoke): Promise<RevisionProposal[]> {
  const args = { ...(options?.projectId === undefined ? {} : { projectId: options.projectId }), ...(options?.states === undefined ? {} : { states: options.states }) };
  const payload = await evolutionCall("list_revision_proposals", Object.keys(args).length === 0 ? undefined : args, call);
  if (!Array.isArray(payload) || !payload.every(isRevisionProposal)) throw new Error("Native layer returned invalid suggestions");
  return payload;
}

export async function getRevisionProposalOverIpc(proposalId: string, call: Invoke = invoke): Promise<RevisionProposal> {
  return readProposal(await evolutionCall("get_revision_proposal", { proposalId: requireId(proposalId, "suggestion id") }, call));
}

export async function reviewRevisionProposalOverIpc(input: ReviewProposalInput, call: Invoke = invoke): Promise<ReviewOutcome> {
  const problem = describeReviewInputProblem(input);
  if (problem) throw new EvolutionError("invalid", problem);
  // Only the contract fields are sent: no revision id to write, no project, no model text.
  const payload = await evolutionCall(
    "review_revision_proposal",
    {
      input: {
        proposalId: input.proposalId,
        action: input.action,
        ...(input.editedBody === undefined ? {} : { editedBody: input.editedBody }),
        ...(input.reviewedRevisionId === undefined ? {} : { reviewedRevisionId: input.reviewedRevisionId }),
        ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
      },
    },
    call,
  );
  if (!isReviewOutcome(payload)) throw new Error("Native layer returned an invalid review result");
  return payload;
}

export async function listUnresolvedClaimsOverIpc(scope: ProjectScope | undefined, call: Invoke = invoke): Promise<UnresolvedClaim[]> {
  const payload = await evolutionCall("list_unresolved_claims", scope?.projectId === undefined ? undefined : { projectId: scope.projectId }, call);
  if (!Array.isArray(payload) || !payload.every(isUnresolvedClaim)) throw new Error("Native layer returned invalid waiting notes");
  return payload;
}

export async function resolveUnresolvedClaimOverIpc(input: ResolveClaimInput, call: Invoke = invoke): Promise<ClaimOutcome> {
  const payload = await evolutionCall("resolve_unresolved_claim", { input: { pendingId: requireId(input.pendingId, "note id"), action: input.action, ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }) } }, call);
  if (!isClaimOutcome(payload)) throw new Error("Native layer returned an invalid result");
  return payload;
}

export async function listObjectApprovalsOverIpc(objectId: string, call: Invoke = invoke): Promise<ApprovalInfo[]> {
  const payload = await evolutionCall("list_object_approvals", { objectId: requireId(objectId, "idea id") }, call);
  if (!Array.isArray(payload) || !payload.every(isApprovalInfo)) throw new Error("Native layer returned invalid approvals");
  return payload;
}

export async function restoreRevisionOverIpc(objectId: string, targetRevisionId: string, expectedCurrentRevisionId: string, call: Invoke = invoke): Promise<ThoughtRevision> {
  const payload = await evolutionCall(
    "restore_revision",
    { objectId: requireId(objectId, "idea id"), targetRevisionId: requireId(targetRevisionId, "revision id"), expectedCurrentRevisionId: requireId(expectedCurrentRevisionId, "revision id") },
    call,
  );
  if (!isThoughtRevision(payload)) throw new Error("Native layer returned an invalid revision");
  return payload;
}
