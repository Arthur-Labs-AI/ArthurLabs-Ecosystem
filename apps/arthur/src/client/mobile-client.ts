import type { ArthurClient } from "./arthur-client";
import {
  cancelVoiceCaptureOverIpc,
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
  finishVoiceCaptureOverIpc,
  listCapturesOverIpc,
  getKnowledgeSummariesOverIpc,
  getMicrophonePermissionOverIpc,
  listKnowledgeObjectsOverIpc,
  listOrganizationStatesOverIpc,
  openAppSettingsOverIpc,
  retryVoiceTranscriptionOverIpc,
  discardVoiceRecordingOverIpc,
  listRelationsOverIpc,
  startVoiceCaptureOverIpc,
  type Invoke,
} from "./tauri-ipc";

/**
 * Tauri-backed client for Android (later iOS).
 * Captures are persisted by the native layer in the app's private SQLite database.
 * Voice capture records the microphone natively, transcribes in the cloud, and stores
 * only the transcript. BLE and the sync outbox will diverge from the desktop client here.
 */
export function createMobileClient(call?: Invoke): ArthurClient {
  return {
    kind: "mobile",
    capabilities: { voiceCapture: true },
    getRuntimeInfo: () => fetchRuntimeInfo(call),
    createCapture: (input) => createCaptureOverIpc(input, call),
    listCaptures: () => listCapturesOverIpc(call),
    startVoiceCapture: () => startVoiceCaptureOverIpc(call),
    finishVoiceCapture: () => finishVoiceCaptureOverIpc(call),
    cancelVoiceCapture: () => cancelVoiceCaptureOverIpc(call),
    retryVoiceTranscription: () => retryVoiceTranscriptionOverIpc(call),
    discardVoiceRecording: () => discardVoiceRecordingOverIpc(call),
    getMicrophonePermission: () => getMicrophonePermissionOverIpc(call),
    openAppSettings: () => openAppSettingsOverIpc(call),
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
