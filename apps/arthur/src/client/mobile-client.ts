import type { ArthurClient } from "./arthur-client";
import {
  cancelVoiceCaptureOverIpc,
  createCaptureOverIpc,
  fetchRuntimeInfo,
  finishVoiceCaptureOverIpc,
  listCapturesOverIpc,
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
  };
}
