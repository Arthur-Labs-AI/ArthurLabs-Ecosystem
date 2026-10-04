import type { ArthurClient } from "./arthur-client";
import { createCaptureOverIpc, fetchRuntimeInfo, listCapturesOverIpc, type Invoke } from "./tauri-ipc";

/**
 * Tauri-backed client for Linux and Windows.
 * Captures use the app-local store; the canonical Home Node Cognitive Store is a later milestone.
 */
export function createDesktopClient(call?: Invoke): ArthurClient {
  return {
    kind: "desktop",
    getRuntimeInfo: () => fetchRuntimeInfo(call),
    createCapture: (input) => createCaptureOverIpc(input, call),
    listCaptures: () => listCapturesOverIpc(call),
  };
}
