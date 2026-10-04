import type { ArthurClient } from "./arthur-client";
import { createCaptureOverIpc, fetchRuntimeInfo, listCapturesOverIpc, type Invoke } from "./tauri-ipc";

/**
 * Tauri-backed client for Android (later iOS).
 * Captures are persisted by the native layer in the app's private SQLite database.
 * BLE and the sync outbox will diverge from the desktop client here.
 */
export function createMobileClient(call?: Invoke): ArthurClient {
  return {
    kind: "mobile",
    getRuntimeInfo: () => fetchRuntimeInfo(call),
    createCapture: (input) => createCaptureOverIpc(input, call),
    listCaptures: () => listCapturesOverIpc(call),
  };
}
