import {
  describeCreateCaptureInputProblem,
  type Capture,
  type RuntimeInfo,
} from "@arthur/contracts";
import type { ArthurClient } from "./arthur-client";

const DEFAULT_PREVIEW_INFO: RuntimeInfo = { appVersion: "0.0.0-preview", platform: "unknown" };

export interface PreviewClientOptions {
  info?: RuntimeInfo;
  /** Injectable for deterministic tests. */
  newId?: () => string;
  now?: () => Date;
}

/** Native-free client for `vite dev` in a plain browser and for tests. Captures live in memory only. */
export function createPreviewClient(options: PreviewClientOptions = {}): ArthurClient {
  const info = options.info ?? DEFAULT_PREVIEW_INFO;
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const captures: Capture[] = [];

  return {
    kind: "preview",
    getRuntimeInfo: () => Promise.resolve(info),
    createCapture: (input) => {
      const problem = describeCreateCaptureInputProblem(input);
      if (problem) return Promise.reject(new Error(`Invalid capture: ${problem}`));
      const capture: Capture = { id: newId(), source: input.source, content: input.content, createdAt: now().toISOString() };
      captures.unshift(capture);
      return Promise.resolve(capture);
    },
    listCaptures: () => Promise.resolve([...captures]),
  };
}
