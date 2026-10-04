import type { RuntimeInfo } from "@arthur/contracts";
import type { ArthurClient } from "./arthur-client";

const DEFAULT_PREVIEW_INFO: RuntimeInfo = { appVersion: "0.0.0-preview", platform: "unknown" };

/** Native-free client for `vite dev` in a plain browser and for tests. */
export function createPreviewClient(info: RuntimeInfo = DEFAULT_PREVIEW_INFO): ArthurClient {
  return {
    kind: "preview",
    getRuntimeInfo: () => Promise.resolve(info),
  };
}
