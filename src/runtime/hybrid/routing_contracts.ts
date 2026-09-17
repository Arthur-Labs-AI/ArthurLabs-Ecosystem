/**
 * HR-03A: routing operation / locality / request / decision contracts.
 *
 * The future flow is: operation requirement -> trusted registries ->
 * hard filtering -> deterministic ranking -> selected target. The LLM
 * NEVER decides where something executes; it may only request an
 * operation. HR-03A defines the data structures; NO route() engine,
 * NO scoring, NO fallback selection is implemented here.
 *
 * RoutingOperation is deliberately separate from RuntimeCapability:
 * one operation may require MULTIPLE capabilities (e.g. model.generate
 * with tools requires model.generate + model.tools).
 *
 * DataLocalityPolicy is a HARD constraint (never a score):
 *
 *   cloud_allowed: local + lan + cloud
 *   lan_or_local:  local + lan   (NOT lan_only: local stays allowed)
 *   local_only:    local
 *
 * allowedRuntimeModesFor() returns an allowed SET represented as an
 * array. Its array order MUST NOT be interpreted as routing preference:
 * membership is the constraint; ranking belongs to the future engine.
 */

import { HybridRegistryError } from "./errors";
import { isRuntimeCapability, type RuntimeCapability } from "../provider";
import { isRuntimeMode, type RuntimeMode } from "../runtime_mode";
import { isRoutingReason, ROUTING_REASONS, type RoutingReason } from "../routing";

export const ROUTING_OPERATIONS = ["model.generate", "tool.execute", "speech.transcribe", "speech.synthesize"] as const;

export type RoutingOperation = (typeof ROUTING_OPERATIONS)[number];

export function isRoutingOperation(value: unknown): value is RoutingOperation {
  return typeof value === "string" && (ROUTING_OPERATIONS as readonly string[]).includes(value);
}

export const DATA_LOCALITY_POLICIES = ["cloud_allowed", "lan_or_local", "local_only"] as const;

export type DataLocalityPolicy = (typeof DATA_LOCALITY_POLICIES)[number];

export function isDataLocalityPolicy(value: unknown): value is DataLocalityPolicy {
  return typeof value === "string" && (DATA_LOCALITY_POLICIES as readonly string[]).includes(value);
}

const CLOUD_ALLOWED_MODES: readonly RuntimeMode[] = ["cloud", "lan", "local"];
const LAN_OR_LOCAL_MODES: readonly RuntimeMode[] = ["lan", "local"];
const LOCAL_ONLY_MODES: readonly RuntimeMode[] = ["local"];

export function allowedRuntimeModesFor(policy: DataLocalityPolicy): readonly RuntimeMode[] {
  if (!isDataLocalityPolicy(policy)) {
    throw new HybridRegistryError("INVALID_ROUTING_REQUEST", "unknown data locality policy");
  }
  if (policy === "cloud_allowed") return [...CLOUD_ALLOWED_MODES];
  if (policy === "lan_or_local") return [...LAN_OR_LOCAL_MODES];
  return [...LOCAL_ONLY_MODES];
}

export function runtimeModeAllowed(policy: DataLocalityPolicy, mode: RuntimeMode): boolean {
  if (!isRuntimeMode(mode)) return false;
  return (allowedRuntimeModesFor(policy) as readonly string[]).includes(mode);
}

export const REASONING_PROFILES = ["fast", "normal", "deep"] as const;

export type ReasoningProfile = (typeof REASONING_PROFILES)[number];

export function isReasoningProfile(value: unknown): value is ReasoningProfile {
  return typeof value === "string" && (REASONING_PROFILES as readonly string[]).includes(value);
}

export const MAX_ROUTING_ID_CHARS = 128;
export const MAX_ROUTING_CAPABILITIES = 32;
export const MAX_ROUTING_ALTERNATIVES = 64;

const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

function failRequest(message: string): never {
  throw new HybridRegistryError("INVALID_ROUTING_REQUEST", message);
}

function assertRoutingId(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") failRequest(what + " must be a string");
  const trimmed = (value as string).trim();
  if (trimmed === "") failRequest(what + " must be non-empty");
  if (trimmed.length > MAX_ROUTING_ID_CHARS) failRequest(what + " is too long");
  if (CONTROL_CHAR_RE.test(trimmed)) failRequest(what + " contains control characters");
  return trimmed;
}

function assertCapabilities(caps: unknown): RuntimeCapability[] {
  if (!Array.isArray(caps)) failRequest("required_capabilities must be an array");
  const list = caps as unknown[];
  if (list.length > MAX_ROUTING_CAPABILITIES) failRequest("required_capabilities exceed the bound");
  const seen = new Set<string>();
  for (const cap of list) {
    if (!isRuntimeCapability(cap)) failRequest("unknown required capability");
    seen.add(cap as string);
  }
  return [...seen].sort() as RuntimeCapability[];
}

export interface RoutingConstraints {
  min_context_tokens?: number;
  needs_tools?: boolean;
}

function assertConstraints(raw: unknown): RoutingConstraints | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    failRequest("constraints must be an object");
  }
  const input = raw as Record<string, unknown>;
  const out: RoutingConstraints = {};
  if (input["min_context_tokens"] !== undefined) {
    const v = input["min_context_tokens"];
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      failRequest("min_context_tokens must be a positive integer");
    }
    out.min_context_tokens = v;
  }
  if (input["needs_tools"] !== undefined) {
    if (typeof input["needs_tools"] !== "boolean") failRequest("needs_tools must be boolean");
    out.needs_tools = input["needs_tools"] as boolean;
  }
  return out;
}

export interface RoutingRequest {
  operation: RoutingOperation;
  required_capabilities: RuntimeCapability[];
  data_locality: DataLocalityPolicy;
  reasoning_profile?: ReasoningProfile;
  session_id?: string;
  preferred_node_id?: string;
  preferred_provider_id?: string;
  constraints?: RoutingConstraints;
}

export function normalizeRoutingRequest(request: RoutingRequest): RoutingRequest {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    failRequest("routing request must be an object");
  }
  const raw = request as unknown as Record<string, unknown>;
  if (!isRoutingOperation(raw["operation"])) failRequest("unknown routing operation");
  if (!isDataLocalityPolicy(raw["data_locality"])) failRequest("unknown data locality policy");
  let reasoning: ReasoningProfile | undefined;
  if (raw["reasoning_profile"] !== undefined) {
    if (!isReasoningProfile(raw["reasoning_profile"])) failRequest("unknown reasoning profile");
    reasoning = raw["reasoning_profile"] as ReasoningProfile;
  }
  const out: RoutingRequest = {
    operation: raw["operation"] as RoutingOperation,
    required_capabilities: assertCapabilities(raw["required_capabilities"]),
    data_locality: raw["data_locality"] as DataLocalityPolicy,
  };
  if (reasoning !== undefined) out.reasoning_profile = reasoning;
  const session = assertRoutingId(raw["session_id"], "session_id");
  if (session !== undefined) out.session_id = session;
  const node = assertRoutingId(raw["preferred_node_id"], "preferred_node_id");
  if (node !== undefined) out.preferred_node_id = node;
  const provider = assertRoutingId(raw["preferred_provider_id"], "preferred_provider_id");
  if (provider !== undefined) out.preferred_provider_id = provider;
  const constraints = assertConstraints(raw["constraints"]);
  if (constraints !== undefined) out.constraints = constraints;
  return out;
}

export const EXTENDED_ROUTING_REASONS = [
  "configured_default",
  "forced_local",
  "local_preferred",
  "lan_preferred",
  "cloud_preferred",
  "session_affinity",
  "preferred_provider",
  "preferred_node",
  "fallback",
] as const;

export type ExtendedRoutingReason = (typeof EXTENDED_ROUTING_REASONS)[number];

export function isExtendedRoutingReason(value: unknown): value is ExtendedRoutingReason {
  return typeof value === "string" && (EXTENDED_ROUTING_REASONS as readonly string[]).includes(value);
}

export function isBackwardCompatibleReason(reason: ExtendedRoutingReason): boolean {
  return isRoutingReason(reason);
}

export function assertExtendedRoutingReason(value: unknown): ExtendedRoutingReason {
  if (!isExtendedRoutingReason(value)) {
    throw new HybridRegistryError("INVALID_ROUTING_DECISION", "unknown routing reason");
  }
  return value as ExtendedRoutingReason;
}

export interface HybridRoutingDecision {
  operation: RoutingOperation;
  target_provider_id?: string;
  target_node_id?: string;
  runtime_mode: RuntimeMode;
  reason: ExtendedRoutingReason;
  /** Ranked alternatives in engine preference order (first = most preferred). Never re-sorted here. */
  alternatives: string[];
}

function assertAlternatives(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new HybridRegistryError("INVALID_ROUTING_DECISION", "alternatives must be an array");
  }
  const list = value as unknown[];
  if (list.length > MAX_ROUTING_ALTERNATIVES) {
    throw new HybridRegistryError("INVALID_ROUTING_DECISION", "alternatives exceed the bound");
  }
  // Ranked order is owned by the future routing engine: validate each id,
  // trim per id rules, deduplicate preserving FIRST occurrence, and keep
  // the supplied order verbatim (never lexically sort).
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") throw new HybridRegistryError("INVALID_ROUTING_DECISION", "alternative id must be a string");
    const trimmed = (raw as string).trim();
    if (trimmed === "" || trimmed.length > MAX_ROUTING_ID_CHARS || CONTROL_CHAR_RE.test(trimmed)) {
      throw new HybridRegistryError("INVALID_ROUTING_DECISION", "invalid alternative id");
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

export function normalizeHybridRoutingDecision(decision: HybridRoutingDecision): HybridRoutingDecision {
  if (decision === null || typeof decision !== "object" || Array.isArray(decision)) {
    throw new HybridRegistryError("INVALID_ROUTING_DECISION", "routing decision must be an object");
  }
  const raw = decision as unknown as Record<string, unknown>;
  if (!isRoutingOperation(raw["operation"])) {
    throw new HybridRegistryError("INVALID_ROUTING_DECISION", "unknown routing operation");
  }
  if (!isRuntimeMode(raw["runtime_mode"])) {
    throw new HybridRegistryError("INVALID_ROUTING_DECISION", "unknown runtime mode");
  }
  const out: HybridRoutingDecision = {
    operation: raw["operation"] as RoutingOperation,
    runtime_mode: raw["runtime_mode"] as RuntimeMode,
    reason: assertExtendedRoutingReason(raw["reason"]),
    alternatives: assertAlternatives(raw["alternatives"]),
  };
  const provider = assertRoutingId(raw["target_provider_id"], "target_provider_id");
  if (provider !== undefined) out.target_provider_id = provider;
  const node = assertRoutingId(raw["target_node_id"], "target_node_id");
  if (node !== undefined) out.target_node_id = node;
  return out;
}

export { ROUTING_REASONS };
export type { RoutingReason };
