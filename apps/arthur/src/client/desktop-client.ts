import { VoiceCaptureError, type ArthurClient } from "./arthur-client";
import {
  createCaptureOverIpc,
  distillCaptureOverIpc,
  fetchRuntimeInfo,
  listCapturesOverIpc,
  listKnowledgeObjectsOverIpc,
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
    distillCapture: (captureId) => distillCaptureOverIpc(captureId, call),
    listKnowledgeObjects: () => listKnowledgeObjectsOverIpc(call),
  };
}
