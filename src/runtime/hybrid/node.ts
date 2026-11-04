/**
 * HR-03A: ArthurNode contracts - static descriptor + separate dynamic state.
 *
 * An ArthurNode is a trusted ARTHUR machine (this device or a trusted
 * LAN peer). STATIC describes what the machine can do; DYNAMIC describes
 * what state it is in right now. The two are never mixed into one
 * unvalidated mutable object.
 *
 * Node descriptor runtime_mode is locality RELATIVE TO THIS ARTHUR CORE:
 * the machine ARTHUR Core runs on is local; another trusted machine on
 * the LAN is lan. cloud is NOT an Arthur machine node - cloud providers
 * exist without a node binding. A laptop is local when Core runs on it
 * and lan from the server perspective.
 *
 * Nodes carry NO IP addresses, secrets, filesystem paths, commands,
 * credentials, or auth tokens. Those belong elsewhere (later phases).
 */

import { HybridRegistryError, type HybridErrorReason } from "./errors";
import { isRuntimeCapability, type RuntimeCapability } from "../provider";
import { isRuntimeMode, type RuntimeMode } from "../runtime_mode";

export const ARTHUR_NODE_ROLES = ["server", "desktop", "laptop", "phone", "box", "other"] as const;

export type ArthurNodeRole = (typeof ARTHUR_NODE_ROLES)[number];

export function isArthurNodeRole(value: unknown): value is ArthurNodeRole {
  return typeof value === "string" && (ARTHUR_NODE_ROLES as readonly string[]).includes(value);
}

export const ARTHUR_NODE_RUNTIME_MODES = ["local", "lan"] as const;

export type ArthurNodeRuntimeMode = (typeof ARTHUR_NODE_RUNTIME_MODES)[number];

export function isArthurNodeRuntimeMode(value: unknown): value is ArthurNodeRuntimeMode {
  return value === "local" || value === "lan";
}

export const MAX_NODE_ID_CHARS = 128;
export const MAX_NODE_PLATFORM_CHARS = 64;
export const MAX_NODE_CAPABILITIES = 64;
export const MAX_NODE_TOOL_IDS = 256;
export const MAX_NODE_TOOL_ID_CHARS = 256;
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

function failNode(reason: HybridErrorReason, message: string): never {
  throw new HybridRegistryError(reason, message);
}

function assertNodeId(id: unknown): string {
  if (typeof id !== "string") failNode("INVALID_NODE_DESCRIPTOR", "node id must be a string");
  const trimmed = (id as string).trim();
  if (trimmed === "") failNode("INVALID_NODE_DESCRIPTOR", "node id must be non-empty");
  if (trimmed.length > MAX_NODE_ID_CHARS) {
    failNode("INVALID_NODE_DESCRIPTOR", "node id exceeds " + String(MAX_NODE_ID_CHARS) + " characters");
  }
  if (CONTROL_CHAR_RE.test(trimmed)) failNode("INVALID_NODE_DESCRIPTOR", "node id contains control characters");
  return trimmed;
}

function assertPlatform(platform: unknown): string {
  if (typeof platform !== "string") failNode("INVALID_NODE_DESCRIPTOR", "node platform must be a string");
  const trimmed = (platform as string).trim();
  if (trimmed === "") failNode("INVALID_NODE_DESCRIPTOR", "node platform must be non-empty");
  if (trimmed.length > MAX_NODE_PLATFORM_CHARS) {
    failNode("INVALID_NODE_DESCRIPTOR", "node platform exceeds " + String(MAX_NODE_PLATFORM_CHARS) + " characters");
  }
  if (CONTROL_CHAR_RE.test(trimmed)) failNode("INVALID_NODE_DESCRIPTOR", "node platform contains control characters");
  return trimmed;
}

function assertCapabilities(caps: unknown): RuntimeCapability[] {
  if (!Array.isArray(caps)) failNode("INVALID_NODE_DESCRIPTOR", "node runtime_capabilities must be an array");
  const list = caps as unknown[];
  if (list.length > MAX_NODE_CAPABILITIES) {
    failNode("INVALID_NODE_DESCRIPTOR", "node runtime_capabilities exceed " + String(MAX_NODE_CAPABILITIES) + " entries");
  }
  const seen = new Set<string>();
  for (const cap of list) {
    if (!isRuntimeCapability(cap)) failNode("INVALID_NODE_DESCRIPTOR", "unknown runtime capability");
    seen.add(cap as string);
  }
  return [...seen].sort() as RuntimeCapability[];
}

function assertToolIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) failNode("INVALID_NODE_DESCRIPTOR", "node tool_ids must be an array");
  const list = ids as unknown[];
  if (list.length > MAX_NODE_TOOL_IDS) {
    failNode("INVALID_NODE_DESCRIPTOR", "node tool_ids exceed " + String(MAX_NODE_TOOL_IDS) + " entries");
  }
  const seen = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== "string") failNode("INVALID_NODE_DESCRIPTOR", "node tool id must be a string");
    const trimmed = (raw as string).trim();
    if (trimmed === "") failNode("INVALID_NODE_DESCRIPTOR", "node tool id must be non-empty");
    if (trimmed.length > MAX_NODE_TOOL_ID_CHARS) {
      failNode("INVALID_NODE_DESCRIPTOR", "node tool id exceeds " + String(MAX_NODE_TOOL_ID_CHARS) + " characters");
    }
    if (CONTROL_CHAR_RE.test(trimmed)) failNode("INVALID_NODE_DESCRIPTOR", "node tool id contains control characters");
    seen.add(trimmed);
  }
  return [...seen].sort();
}
export interface ArthurNodeDescriptor {
  id: string;
  role: ArthurNodeRole;
  runtime_mode: ArthurNodeRuntimeMode;
  platform: string;
  runtime_capabilities: RuntimeCapability[];
  tool_ids: string[];
}

export function normalizeNodeDescriptor(descriptor: ArthurNodeDescriptor): ArthurNodeDescriptor {
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    failNode("INVALID_NODE_DESCRIPTOR", "node descriptor must be an object");
  }
  const raw = descriptor as unknown as Record<string, unknown>;
  const id = assertNodeId(raw["id"]);
  if (!isArthurNodeRole(raw["role"])) failNode("INVALID_NODE_DESCRIPTOR", "unknown node role");
  const mode = raw["runtime_mode"];
  if (!isArthurNodeRuntimeMode(mode)) {
    failNode("INVALID_NODE_DESCRIPTOR", "node runtime_mode must be local or lan (cloud is not a machine node)");
  }
  if (isRuntimeMode(mode) && mode !== "local" && mode !== "lan") {
    failNode("INVALID_NODE_DESCRIPTOR", "node runtime_mode must be local or lan");
  }
  return {
    id,
    role: raw["role"] as ArthurNodeRole,
    runtime_mode: mode as ArthurNodeRuntimeMode,
    platform: assertPlatform(raw["platform"]),
    runtime_capabilities: assertCapabilities(raw["runtime_capabilities"]),
    tool_ids: assertToolIds(raw["tool_ids"]),
  };
}

export function nodeDescriptorsEqual(a: ArthurNodeDescriptor, b: ArthurNodeDescriptor): boolean {
  const left = normalizeNodeDescriptor(a);
  const right = normalizeNodeDescriptor(b);
  return (
    left.id === right.id &&
    left.role === right.role &&
    left.runtime_mode === right.runtime_mode &&
    left.platform === right.platform &&
    left.runtime_capabilities.length === right.runtime_capabilities.length &&
    left.runtime_capabilities.every((cap, i) => cap === right.runtime_capabilities[i]) &&
    left.tool_ids.length === right.tool_ids.length &&
    left.tool_ids.every((nodeId, i) => nodeId === right.tool_ids[i])
  );
}

export const NODE_STATUSES = ["ready", "busy", "unavailable"] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];

export function isNodeStatus(value: unknown): value is NodeStatus {
  return typeof value === "string" && (NODE_STATUSES as readonly string[]).includes(value);
}

export interface NodeRuntimeState {
  status: NodeStatus;
  active_jobs: number;
  last_seen_at_ms: number;
}

export function normalizeNodeState(state: NodeRuntimeState): NodeRuntimeState {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    failNode("INVALID_NODE_DESCRIPTOR", "node state must be an object");
  }
  const raw = state as unknown as Record<string, unknown>;
  if (!isNodeStatus(raw["status"])) failNode("INVALID_NODE_DESCRIPTOR", "unknown node status");
  const jobs = raw["active_jobs"];
  if (typeof jobs !== "number" || !Number.isInteger(jobs) || jobs < 0) {
    failNode("INVALID_NODE_DESCRIPTOR", "node active_jobs must be a non-negative integer");
  }
  const seen = raw["last_seen_at_ms"];
  if (typeof seen !== "number" || !Number.isFinite(seen) || seen < 0) {
    failNode("INVALID_NODE_DESCRIPTOR", "node last_seen_at_ms must be a finite non-negative timestamp");
  }
  return { status: raw["status"] as NodeStatus, active_jobs: jobs, last_seen_at_ms: seen };
}

export function defaultNodeState(nowMs?: number): NodeRuntimeState {
  const at = nowMs ?? Date.now();
  return normalizeNodeState({ status: "ready", active_jobs: 0, last_seen_at_ms: at });
}

export type { RuntimeMode };
