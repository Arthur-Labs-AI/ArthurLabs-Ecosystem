import type { ArthurClient } from "./arthur-client";
import { fetchRuntimeInfo, type Invoke } from "./tauri-ipc";

/** Tauri-backed client for Linux and Windows. */
export function createDesktopClient(call?: Invoke): ArthurClient {
  return {
    kind: "desktop",
    getRuntimeInfo: () => fetchRuntimeInfo(call),
  };
}
