/**
 * HR-03A: RuntimeProviderDescriptor built on RuntimeProviderIdentity.
 *
 * Locality is trusted construction metadata (never inferred from names,
 * URLs, hostnames, or model ids):
 *
 *   cloud: runtime_mode cloud, node_id MUST be absent
 *   local: runtime_mode local, node_id REQUIRED (node must be local)
 *   lan:   runtime_mode lan,   node_id REQUIRED (node must be lan)
 *
 * Minimum coherent capability contracts:
 *
 *   kind model: requires model.generate; supports_tools=true requires
 *     model.tools; optional model metadata ONLY for kind model.
 *   kind stt:   requires speech.transcribe; model metadata MUST be absent.
 *   kind tts:   requires speech.synthesize; model metadata MUST be absent.
 *
 * Invalid registrations are rejected, never auto-repaired.
 */

import { HybridRegistryError } from "./errors";
import { isRuntimeCapability, type RuntimeCapability, type RuntimeProviderKind } from "../provider";
import { isRuntimeMode } from "../runtime_mode";
import type { RuntimeMode } from "../runtime_mode";
import type { RuntimeProviderIdentity } from "../provider";

export const MAX_PROVIDER_ID_CHARS = 128;
export const MAX_PROVIDER_CAPABILITIES = 32;
export const MAX_CONTEXT_TOKENS = 16_000_000;

const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

function failProvider(message: string): never {
  throw new HybridRegistryError("INVALID_PROVIDER_DESCRIPTOR", message);
}

function assertProviderId(id: unknown): string {
  if (typeof id !== "string") failProvider("provider id must be a string");
  const trimmed = (id as string).trim();
  if (trimmed === "") failProvider("provider id must be non-empty");
  if (trimmed.length > MAX_PROVIDER_ID_CHARS) {
    failProvider("provider id exceeds " + String(MAX_PROVIDER_ID_CHARS) + " characters");
  }
  if (CONTROL_CHAR_RE.test(trimmed)) failProvider("provider id contains control characters");
  return trimmed;
}

function assertKind(kind: unknown): RuntimeProviderKind {
  if (kind !== "stt" && kind !== "model" && kind !== "tts") {
    failProvider("unknown provider kind");
  }
  return kind as RuntimeProviderKind;
}

function assertCapabilities(caps: unknown): RuntimeCapability[] {
  if (!Array.isArray(caps)) failProvider("provider capabilities must be an array");
  const list = caps as unknown[];
  if (list.length > MAX_PROVIDER_CAPABILITIES) {
    failProvider("provider capabilities exceed " + String(MAX_PROVIDER_CAPABILITIES) + " entries");
  }
  const seen = new Set<string>();
  for (const cap of list) {
    if (!isRuntimeCapability(cap)) failProvider("unknown runtime capability");
    seen.add(cap as string);
  }
  return [...seen].sort() as RuntimeCapability[];
}

function assertNodeId(nodeId: unknown): string {
  if (typeof nodeId !== "string") failProvider("provider node_id must be a string");
  const trimmed = (nodeId as string).trim();
  if (trimmed === "") failProvider("provider node_id must be non-empty");
  if (trimmed.length > MAX_PROVIDER_ID_CHARS) failProvider("provider node_id is too long");
  if (CONTROL_CHAR_RE.test(trimmed)) failProvider("provider node_id contains control characters");
  return trimmed;
}

export interface ProviderModelMetadata {
  supports_tools: boolean;
  supports_reasoning: boolean;
  max_context_tokens: number;
}

function assertModelMetadata(meta: unknown, kind: RuntimeProviderKind): ProviderModelMetadata | undefined {
  if (meta === undefined) return undefined;
  if (kind !== "model") {
    failProvider("model metadata is only valid for kind model");
  }
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    failProvider("provider model metadata must be an object");
  }
  const raw = meta as Record<string, unknown>;
  if (typeof raw["supports_tools"] !== "boolean") failProvider("model metadata supports_tools must be boolean");
  if (typeof raw["supports_reasoning"] !== "boolean") failProvider("model metadata supports_reasoning must be boolean");
  const ctx = raw["max_context_tokens"];
  if (typeof ctx !== "number" || !Number.isInteger(ctx) || ctx <= 0 || ctx > MAX_CONTEXT_TOKENS) {
    failProvider("model metadata max_context_tokens must be a positive integer");
  }
  return { supports_tools: raw["supports_tools"] as boolean, supports_reasoning: raw["supports_reasoning"] as boolean, max_context_tokens: ctx };
}

export interface RuntimeProviderDescriptor {
  identity: RuntimeProviderIdentity;
  capabilities: RuntimeCapability[];
  node_id?: string;
  model?: ProviderModelMetadata;
}

export function normalizeProviderDescriptor(descriptor: RuntimeProviderDescriptor): RuntimeProviderDescriptor {
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    failProvider("provider descriptor must be an object");
  }
  const raw = descriptor as unknown as Record<string, unknown>;
  const identityRaw = raw["identity"];
  if (identityRaw === null || typeof identityRaw !== "object" || Array.isArray(identityRaw)) {
    failProvider("provider identity must be an object");
  }
  const identityIn = identityRaw as Record<string, unknown>;
  const identity: RuntimeProviderIdentity = {
    id: assertProviderId(identityIn["id"]),
    kind: assertKind(identityIn["kind"]),
    runtime_mode: assertMode(identityIn["runtime_mode"]),
  };
  const capabilities = assertCapabilities(raw["capabilities"]);
  let nodeId: string | undefined;
  if (raw["node_id"] !== undefined) nodeId = assertNodeId(raw["node_id"]);
  const model = assertModelMetadata(raw["model"], identity.kind);
  if (identity.runtime_mode === "cloud" && nodeId !== undefined) {
    failProvider("cloud provider must not bind a node");
  }
  if (identity.runtime_mode === "local" && nodeId === undefined) {
    failProvider("local provider requires a node_id");
  }
  if (identity.runtime_mode === "lan" && nodeId === undefined) {
    failProvider("lan provider requires a node_id");
  }
  assertCapabilityCoherence(identity.kind, capabilities, model);
  const out: RuntimeProviderDescriptor = { identity, capabilities };
  if (nodeId !== undefined) out.node_id = nodeId;
  if (model !== undefined) out.model = { ...model };
  return out;
}

function assertMode(mode: unknown): RuntimeMode {
  if (!isRuntimeMode(mode)) failProvider("unknown runtime mode");
  return mode as RuntimeMode;
}

function assertCapabilityCoherence(kind: RuntimeProviderKind, caps: RuntimeCapability[], model: ProviderModelMetadata | undefined): void {
  const has = (cap: RuntimeCapability): boolean => caps.includes(cap);
  if (kind === "model" && !has("model.generate")) {
    failProvider("kind model requires the model.generate capability");
  }
  if (kind === "stt" && !has("speech.transcribe")) {
    failProvider("kind stt requires the speech.transcribe capability");
  }
  if (kind === "tts" && !has("speech.synthesize")) {
    failProvider("kind tts requires the speech.synthesize capability");
  }
  if (model !== undefined && model.supports_tools && !has("model.tools")) {
    failProvider("supports_tools=true requires the model.tools capability");
  }
}

export function providerDescriptorsEqual(a: RuntimeProviderDescriptor, b: RuntimeProviderDescriptor): boolean {
  const left = normalizeProviderDescriptor(a);
  const right = normalizeProviderDescriptor(b);
  if (left.identity.id !== right.identity.id) return false;
  if (left.identity.kind !== right.identity.kind) return false;
  if (left.identity.runtime_mode !== right.identity.runtime_mode) return false;
  if ((left.node_id ?? null) !== (right.node_id ?? null)) return false;
  if (left.capabilities.length !== right.capabilities.length) return false;
  if (!left.capabilities.every((cap, i) => cap === right.capabilities[i])) return false;
  const lm = left.model;
  const rm = right.model;
  if ((lm === undefined) !== (rm === undefined)) return false;
  if (lm !== undefined && rm !== undefined) {
    if (lm.supports_tools !== rm.supports_tools) return false;
    if (lm.supports_reasoning !== rm.supports_reasoning) return false;
    if (lm.max_context_tokens !== rm.max_context_tokens) return false;
  }
  return true;
}
