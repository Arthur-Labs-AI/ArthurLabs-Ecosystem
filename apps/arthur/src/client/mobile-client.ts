import type { ArthurClient } from "./arthur-client";
import { fetchRuntimeInfo, type Invoke } from "./tauri-ipc";

/**
 * Tauri-backed client for Android (later iOS).
 * Capture, BLE and the sync outbox will diverge from the desktop client here.
 */
export function createMobileClient(call?: Invoke): ArthurClient {
  return {
    kind: "mobile",
    getRuntimeInfo: () => fetchRuntimeInfo(call),
  };
}
