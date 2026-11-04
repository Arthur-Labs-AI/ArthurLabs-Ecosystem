/**
 * HR-01: provider identity + capability contracts.
 *
 * Identity is stable, machine-readable, and bounded: id, kind, runtime
 * mode. It must never expose credentials, filesystem paths, raw process
 * commands, or secret configuration (status/detail strings stay generic).
 *
 * Capabilities are provider/runtime metadata (what an operation needs),
 * not authorization. SC-02 remains authoritative for authorization; routing
 * must never bypass SC-02, SC-03, or ToolRegistry.
 */

import type { RuntimeMode } from "./runtime_mode";

export type RuntimeProviderKind = "stt" | "model" | "tts";

export interface RuntimeProviderIdentity {
  id: string;
  kind: RuntimeProviderKind;
  runtime_mode: RuntimeMode;
}

/** Generic capability vocabulary (metadata only, not authorization). */
export const RUNTIME_CAPABILITIES = [
  "speech.transcribe",
  "speech.synthesize",
  "model.generate",
  "model.tools",
  "network.internet",
  "network.lan",
  "tool.local",
  "tool.remote",
] as const;

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

export function isRuntimeCapability(value: unknown): value is RuntimeCapability {
  return typeof value === "string" && (RUNTIME_CAPABILITIES as readonly string[]).includes(value);
}

/** Bounded capability set advertised by a provider (metadata only). */
export type RuntimeCapabilitySet = readonly RuntimeCapability[];
