import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  describeCreateCaptureInputProblem,
  isCapture,
  isRuntimeInfo,
  type Capture,
  type CreateCaptureInput,
  type RuntimeInfo,
} from "@arthur/contracts";

/**
 * The single module allowed to import `@tauri-apps/*`.
 * Everything else reaches the native layer through an `ArthurClient`.
 */

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function isTauriRuntime(): boolean {
  return isTauri();
}

export async function fetchRuntimeInfo(call: Invoke = invoke): Promise<RuntimeInfo> {
  const payload = await call("get_runtime_info");
  if (!isRuntimeInfo(payload)) {
    throw new Error("Native layer returned an invalid runtime info payload");
  }
  return payload;
}

export async function createCaptureOverIpc(input: CreateCaptureInput, call: Invoke = invoke): Promise<Capture> {
  const problem = describeCreateCaptureInputProblem(input);
  if (problem) throw new Error(`Invalid capture: ${problem}`);
  // Only the contract fields are sent, so a caller cannot smuggle in an id or timestamp.
  const payload = await call("create_capture", { input: { source: input.source, content: input.content } });
  if (!isCapture(payload)) {
    throw new Error("Native layer returned an invalid capture");
  }
  return payload;
}

export async function listCapturesOverIpc(call: Invoke = invoke): Promise<Capture[]> {
  const payload = await call("list_captures");
  if (!Array.isArray(payload) || !payload.every(isCapture)) {
    throw new Error("Native layer returned an invalid capture list");
  }
  return payload;
}
