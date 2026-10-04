import type { ArthurClient, ArthurClientKind } from "./arthur-client";
import { createDesktopClient } from "./desktop-client";
import { createMobileClient } from "./mobile-client";
import { createPreviewClient } from "./preview-client";
import { isTauriRuntime, type Invoke } from "./tauri-ipc";

export { DistillationError, LineageError, RelationError, VoiceCaptureError } from "./arthur-client";
export type { ArthurClient, ArthurClientCapabilities, ArthurClientKind } from "./arthur-client";

export interface ClientEnvironment {
  /** True when running inside a Tauri webview. */
  isTauri: boolean;
  /** Tauri target platform of this build (`TAURI_ENV_PLATFORM`), when known. */
  tauriPlatform?: string | undefined;
}

export function readClientEnvironment(): ClientEnvironment {
  return {
    isTauri: isTauriRuntime(),
    tauriPlatform: import.meta.env.TAURI_ENV_PLATFORM,
  };
}

export function selectClientKind(env: ClientEnvironment): ArthurClientKind {
  if (!env.isTauri) return "preview";
  return env.tauriPlatform === "android" || env.tauriPlatform === "ios" ? "mobile" : "desktop";
}

export function createArthurClient(env: ClientEnvironment = readClientEnvironment(), call?: Invoke): ArthurClient {
  switch (selectClientKind(env)) {
    case "desktop":
      return createDesktopClient(call);
    case "mobile":
      return createMobileClient(call);
    case "preview":
      return createPreviewClient();
  }
}
