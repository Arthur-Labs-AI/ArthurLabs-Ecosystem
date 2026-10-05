import { VoiceCaptureError, type ArthurClient } from "./arthur-client";
import {
  createCaptureOverIpc,
  distillCaptureOverIpc,
  createRelationOverIpc,
  createRevisionFromOverIpc,
  diffRevisionsOverIpc,
  getObjectLineageOverIpc,
  getRevisionChildrenOverIpc,
  getRevisionOverIpc,
  getRevisionParentsOverIpc,
  listRevisionsOverIpc,
  mergeRevisionsOverIpc,
  updateKnowledgeObjectOverIpc,
  fetchRuntimeInfo,
  getObjectNeighborsOverIpc,
  getObjectRelationsOverIpc,
  inferRelationsOverIpc,
  listCapturesOverIpc,
  getKnowledgeSummariesOverIpc,
  listKnowledgeObjectsOverIpc,
  listOrganizationStatesOverIpc,
  listRelationsOverIpc,
  type Invoke,
} from "./tauri-ipc";

const voiceUnavailable = () => Promise.reject(new VoiceCaptureError("voice_unavailable", "Voice capture is not available on this device."));

/**
 * Tauri-backed client for Linux and Windows.
 * Captures use the app-local store; the canonical Home Node Cognitive Store is a later milestone.
 * Voice capture is Android-only for now.
 */
export function createDesktopClient(call?: Invoke): ArthurClient {
  return {
    kind: "desktop",
    capabilities: { voiceCapture: false },
    getRuntimeInfo: () => fetchRuntimeInfo(call),
    createCapture: (input) => createCaptureOverIpc(input, call),
    listCaptures: () => listCapturesOverIpc(call),
    startVoiceCapture: voiceUnavailable,
    finishVoiceCapture: voiceUnavailable,
    cancelVoiceCapture: () => Promise.resolve(),
    retryVoiceTranscription: voiceUnavailable,
    discardVoiceRecording: () => Promise.resolve(),
    getMicrophonePermission: () => Promise.resolve("unknown"),
    openAppSettings: voiceUnavailable,
    distillCapture: (captureId) => distillCaptureOverIpc(captureId, call),
    listKnowledgeObjects: () => listKnowledgeObjectsOverIpc(call),
    listOrganizationStates: () => listOrganizationStatesOverIpc(call),
    getKnowledgeSummaries: (objectIds) => getKnowledgeSummariesOverIpc(objectIds, call),
    createRelation: (input) => createRelationOverIpc(input, call),
    listRelations: () => listRelationsOverIpc(call),
    getObjectRelations: (objectId, filter) => getObjectRelationsOverIpc(objectId, filter, call),
    getObjectNeighbors: (objectId, filter) => getObjectNeighborsOverIpc(objectId, filter, call),
    inferRelations: (objectIds) => inferRelationsOverIpc(objectIds, call),
    getObjectLineage: (objectId) => getObjectLineageOverIpc(objectId, call),
    listRevisions: (objectId) => listRevisionsOverIpc(objectId, call),
    getRevision: (revisionId) => getRevisionOverIpc(revisionId, call),
    getRevisionParents: (revisionId) => getRevisionParentsOverIpc(revisionId, call),
    getRevisionChildren: (revisionId) => getRevisionChildrenOverIpc(revisionId, call),
    updateKnowledgeObject: (objectId, changes) => updateKnowledgeObjectOverIpc(objectId, changes, call),
    createRevisionFrom: (input) => createRevisionFromOverIpc(input, call),
    mergeRevisions: (input) => mergeRevisionsOverIpc(input, call),
    diffRevisions: (oldRevisionId, newRevisionId) => diffRevisionsOverIpc(oldRevisionId, newRevisionId, call),
  };
}
