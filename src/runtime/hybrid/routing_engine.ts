/**
 * HR-03B: deterministic hybrid routing engine (FIRST actual router).
 *
 * Pipeline per route(): snapshot registries -> build candidates -> HARD
 * filter -> lexicographic rank -> selected target + ranked alternatives.
 * No weighted magic scores: correctness/security filtering first,
 * preferences second. Preferred ids are SOFT boosts that never resurrect
 * filtered candidates. Busy nodes/providers stay eligible but rank below
 * ready peers, all else equal - so a LAN-ready peer beats a local-busy
 * one. active_jobs is recorded for future compatibility, not ranked on.
 *
 * The engine NEVER invokes providers, executes tools, touches the
 * network, mutates registries/config/files, sleeps, retries, or calls
 * readiness/doctor. Same inputs => same output. Tool routing answers
 * WHICH already-authorized target can execute a tool, never whether the
 * tool is allowed (SC-02/SC-03 + ToolRegistry stay authoritative).
 */

import { HybridRegistryError } from "./errors";
import { NodeRegistry } from "./node_registry";
import type { ProviderRegistry } from "./provider_registry";
import type { ArthurNodeDescriptor, NodeRuntimeState } from "./node";
import type { RuntimeProviderDescriptor } from "./provider_descriptor";
import type { RuntimeMode } from "../runtime_mode";
import {
  normalizeHybridRoutingDecision,
  normalizeRoutingRequest,
  runtimeModeAllowed,
  type ExtendedRoutingReason,
  type HybridRoutingDecision,
  type RoutingRequest,
} from "./routing_contracts";
import { DEFAULT_ROUTING_POLICY, normalizeRoutingPolicy, preferenceListFor, preferenceRankOf, type RoutingPolicy } from "./routing_policy";
import { validateProviderNodeBinding } from "./validation";

export const NO_ELIGIBLE_TARGET = "NO_ELIGIBLE_TARGET";

export const REJECTION_REASONS = [
  "KIND_MISMATCH",
  "CAPABILITY_MISSING",
  "DATA_LOCALITY_BLOCKED",
  "NODE_UNAVAILABLE",
  "NODE_BINDING_INVALID",
  "PROVIDER_NODE_LOCALITY_MISMATCH",
  "CONTEXT_TOO_SMALL",
  "TOOLS_UNSUPPORTED",
  "TOOL_NOT_AVAILABLE",
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export function isRejectionReason(value: unknown): value is RejectionReason {
  return typeof value === "string" && (REJECTION_REASONS as readonly string[]).includes(value);
}

export class NoEligibleTargetError extends HybridRegistryError {
  readonly rejections: { candidate: string; reason: RejectionReason }[];

  constructor(rejections: { candidate: string; reason: RejectionReason }[]) {
    super("INVALID_ROUTING_DECISION", NO_ELIGIBLE_TARGET + ": no eligible routing target");
    this.name = "NoEligibleTargetError";
    this.rejections = rejections.map((r) => ({ candidate: r.candidate, reason: r.reason }));
  }
}

export function isNoEligibleTargetError(value: unknown): value is NoEligibleTargetError {
  return value instanceof NoEligibleTargetError;
}

export interface EngineProviderCandidate {
  providerId: string;
  kind: "stt" | "model" | "tts";
  mode: RuntimeMode;
  nodeId?: string;
  nodeReady: boolean;
  nodeBusy: boolean;
  descriptor: RuntimeProviderDescriptor;
}

export interface EngineNodeCandidate {
  nodeId: string;
  mode: RuntimeMode;
  nodeReady: boolean;
  nodeBusy: boolean;
  descriptor: ArthurNodeDescriptor;
  state: NodeRuntimeState;
}

function expectedKindFor(operation: RoutingRequest["operation"]): "stt" | "model" | "tts" | null {
  if (operation === "model.generate") return "model";
  if (operation === "speech.transcribe") return "stt";
  if (operation === "speech.synthesize") return "tts";
  return null;
}

interface ProviderRejection {
  candidate: string;
  reason: RejectionReason;
  descriptor: RuntimeProviderDescriptor;
}

function filterProvider(
  descriptor: RuntimeProviderDescriptor,
  request: RoutingRequest,
  nodes: NodeRegistry,
): { candidate: EngineProviderCandidate } | { rejection: ProviderRejection } {
  const expected = expectedKindFor(request.operation);
  if (expected === null || descriptor.identity.kind !== expected) {
    return { rejection: { candidate: descriptor.identity.id, reason: "KIND_MISMATCH", descriptor } };
  }
  for (const cap of request.required_capabilities) {
    if (!descriptor.capabilities.includes(cap)) {
      return { rejection: { candidate: descriptor.identity.id, reason: "CAPABILITY_MISSING", descriptor } };
    }
  }
  if (!runtimeModeAllowed(request.data_locality, descriptor.identity.runtime_mode)) {
    return { rejection: { candidate: descriptor.identity.id, reason: "DATA_LOCALITY_BLOCKED", descriptor } };
  }
  if (descriptor.identity.runtime_mode === "cloud") {
    if (descriptor.node_id !== undefined) {
      return { rejection: { candidate: descriptor.identity.id, reason: "NODE_BINDING_INVALID", descriptor } };
    }
  } else {
    try {
      validateProviderNodeBinding(descriptor, nodes);
    } catch (e) {
      if (e instanceof HybridRegistryError && e.reason === "PROVIDER_NODE_LOCALITY_MISMATCH") {
        return { rejection: { candidate: descriptor.identity.id, reason: "PROVIDER_NODE_LOCALITY_MISMATCH", descriptor } };
      }
      const record = descriptor.node_id === undefined ? undefined : nodes.get(descriptor.node_id);
      if (record === undefined) {
        return { rejection: { candidate: descriptor.identity.id, reason: "NODE_BINDING_INVALID", descriptor } };
      }
      if (record.state.status === "unavailable") {
        return { rejection: { candidate: descriptor.identity.id, reason: "NODE_UNAVAILABLE", descriptor } };
      }
      return { rejection: { candidate: descriptor.identity.id, reason: "NODE_BINDING_INVALID", descriptor } };
    }
    const record = nodes.get(descriptor.node_id as string) as { state: NodeRuntimeState };
    if (record.state.status === "unavailable") {
      return { rejection: { candidate: descriptor.identity.id, reason: "NODE_UNAVAILABLE", descriptor } };
    }
    if (request.operation === "model.generate") {
      const verdict = checkModelConstraints(descriptor, request);
      if (verdict !== null) return { rejection: { candidate: descriptor.identity.id, reason: verdict, descriptor } };
    }
    return {
      candidate: {
        providerId: descriptor.identity.id,
        kind: descriptor.identity.kind,
        mode: descriptor.identity.runtime_mode,
        nodeId: descriptor.node_id,
        nodeReady: record.state.status === "ready",
        nodeBusy: record.state.status === "busy",
        descriptor,
      },
    };
  }
  if (request.operation === "model.generate") {
    const verdict = checkModelConstraints(descriptor, request);
    if (verdict !== null) return { rejection: { candidate: descriptor.identity.id, reason: verdict, descriptor } };
  }
  return {
    candidate: {
      providerId: descriptor.identity.id,
      kind: descriptor.identity.kind,
      mode: descriptor.identity.runtime_mode,
      nodeReady: true,
      nodeBusy: false,
      descriptor,
    },
  };
}

function checkModelConstraints(descriptor: RuntimeProviderDescriptor, request: RoutingRequest): RejectionReason | null {
  const minCtx = request.constraints?.min_context_tokens;
  const needsTools = request.constraints?.needs_tools === true;
  if (minCtx === undefined && !needsTools) return null;
  const meta = descriptor.model;
  if (minCtx !== undefined) {
    if (meta === undefined || meta.max_context_tokens < minCtx) return "CONTEXT_TOO_SMALL";
  }
  if (needsTools) {
    if (meta === undefined || meta.supports_tools !== true) return "TOOLS_UNSUPPORTED";
    if (!descriptor.capabilities.includes("model.tools")) return "TOOLS_UNSUPPORTED";
  }
  return null;
}

interface NodeRejection {
  candidate: string;
  reason: RejectionReason;
  descriptor: ArthurNodeDescriptor;
}

function filterToolNode(
  descriptor: ArthurNodeDescriptor,
  state: NodeRuntimeState,
  request: RoutingRequest,
): { candidate: EngineNodeCandidate } | { rejection: NodeRejection } {
  const toolId = request.constraints?.tool_id as string;
  if (!descriptor.tool_ids.includes(toolId)) {
    return { rejection: { candidate: descriptor.id, reason: "TOOL_NOT_AVAILABLE", descriptor } };
  }
  if (!runtimeModeAllowed(request.data_locality, descriptor.runtime_mode)) {
    return { rejection: { candidate: descriptor.id, reason: "DATA_LOCALITY_BLOCKED", descriptor } };
  }
  if (state.status === "unavailable") {
    return { rejection: { candidate: descriptor.id, reason: "NODE_UNAVAILABLE", descriptor } };
  }
  for (const cap of request.required_capabilities) {
    if (!descriptor.runtime_capabilities.includes(cap)) {
      return { rejection: { candidate: descriptor.id, reason: "CAPABILITY_MISSING", descriptor } };
    }
  }
  return {
    candidate: {
      nodeId: descriptor.id,
      mode: descriptor.runtime_mode,
      nodeReady: state.status === "ready",
      nodeBusy: state.status === "busy",
      descriptor,
      state: { ...state },
    },
  };
}

function compareProviders(a: EngineProviderCandidate, b: EngineProviderCandidate, request: RoutingRequest, modes: readonly RuntimeMode[], preferReady: boolean): number {
  const prefProvider = request.preferred_provider_id;
  if (prefProvider !== undefined) {
    const am = a.providerId === prefProvider ? 0 : 1;
    const bm = b.providerId === prefProvider ? 0 : 1;
    if (am !== bm) return am - bm;
  }
  const prefNode = request.preferred_node_id;
  if (prefNode !== undefined) {
    const am = a.nodeId !== undefined && a.nodeId === prefNode ? 0 : 1;
    const bm = b.nodeId !== undefined && b.nodeId === prefNode ? 0 : 1;
    if (am !== bm) return am - bm;
  }
  if (preferReady) {
    const am = a.nodeReady ? 0 : 1;
    const bm = b.nodeReady ? 0 : 1;
    if (am !== bm) return am - bm;
  }
  const ar = preferenceRankOf(modes, a.mode);
  const br = preferenceRankOf(modes, b.mode);
  if (ar !== br) return ar - br;
  return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
}

function compareToolNodes(a: EngineNodeCandidate, b: EngineNodeCandidate, request: RoutingRequest, modes: readonly RuntimeMode[], preferReady: boolean): number {
  const prefNode = request.preferred_node_id;
  if (prefNode !== undefined) {
    const am = a.nodeId === prefNode ? 0 : 1;
    const bm = b.nodeId === prefNode ? 0 : 1;
    if (am !== bm) return am - bm;
  }
  if (preferReady) {
    const am = a.nodeReady ? 0 : 1;
    const bm = b.nodeReady ? 0 : 1;
    if (am !== bm) return am - bm;
  }
  const ar = preferenceRankOf(modes, a.mode);
  const br = preferenceRankOf(modes, b.mode);
  if (ar !== br) return ar - br;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

function reasonForProvider(winner: EngineProviderCandidate, request: RoutingRequest): ExtendedRoutingReason {
  if (request.preferred_provider_id !== undefined && winner.providerId === request.preferred_provider_id) return "preferred_provider";
  if (request.preferred_node_id !== undefined && winner.nodeId !== undefined && winner.nodeId === request.preferred_node_id) return "preferred_node";
  if (request.data_locality === "local_only" && winner.mode === "local") return "forced_local";
  if (winner.mode === "local") return "local_preferred";
  if (winner.mode === "lan") return "lan_preferred";
  return "cloud_preferred";
}

function reasonForToolNode(winner: EngineNodeCandidate, request: RoutingRequest): ExtendedRoutingReason {
  if (request.preferred_node_id !== undefined && winner.nodeId === request.preferred_node_id) return "preferred_node";
  if (request.data_locality === "local_only" && winner.mode === "local") return "forced_local";
  if (winner.mode === "local") return "local_preferred";
  if (winner.mode === "lan") return "lan_preferred";
  return "cloud_preferred";
}

function snapshotNodes(records: { descriptor: ArthurNodeDescriptor; state: NodeRuntimeState }[]): NodeRegistry {
  // NodeRegistry.list() already returns defensive copies, so wrapping the
  // snapshot records in a fresh registry gives filterProvider an immutable,
  // internally-consistent view without touching the live registries.
  const frozen = new NodeRegistry();
  for (const record of records) {
    frozen.register(record.descriptor, record.state);
  }
  return frozen;
}

export interface HybridRoutingEngineDeps {
  nodes: NodeRegistry;
  providers: ProviderRegistry;
  policy?: RoutingPolicy;
}

export class HybridRoutingEngine {
  private readonly nodes: NodeRegistry;
  private readonly providers: ProviderRegistry;
  private readonly policy: RoutingPolicy;

  constructor(deps: HybridRoutingEngineDeps) {
    if (deps === null || typeof deps !== "object") {
      throw new HybridRegistryError("INVALID_ROUTING_REQUEST", "routing engine requires nodes and providers");
    }
    if (deps.nodes === null || typeof deps.nodes !== "object" || typeof (deps.nodes as NodeRegistry).list !== "function") {
      throw new HybridRegistryError("INVALID_ROUTING_REQUEST", "routing engine requires a NodeRegistry");
    }
    if (deps.providers === null || typeof deps.providers !== "object" || typeof (deps.providers as ProviderRegistry).list !== "function") {
      throw new HybridRegistryError("INVALID_ROUTING_REQUEST", "routing engine requires a ProviderRegistry");
    }
    this.nodes = deps.nodes;
    this.providers = deps.providers;
    this.policy = normalizeRoutingPolicy(deps.policy ?? DEFAULT_ROUTING_POLICY);
  }

  route(request: RoutingRequest): HybridRoutingDecision {
    // Snapshot ONCE per decision: node descriptors + states + providers are
    // copied into immutable locals so a concurrent registry update cannot
    // produce a mixed decision. routeTool re-snapshots from the same
    // immutable copies via the snapshot registries below.
    const normalized = normalizeRoutingRequest(request);
    const nodeSnapshot = this.nodes.list();
    const providerSnapshot = this.providers.list();
    if (normalized.operation === "tool.execute") {
      return this.routeTool(normalized, nodeSnapshot);
    }
    return this.routeProvider(normalized, providerSnapshot, nodeSnapshot);
  }

  explain(request: RoutingRequest): { rejections: { candidate: string; reason: RejectionReason }[] } {
    const normalized = normalizeRoutingRequest(request);
    if (normalized.operation === "tool.execute") {
      const seen: { candidate: string; reason: RejectionReason }[] = [];
      for (const record of this.nodes.list()) {
        const verdict = filterToolNode(record.descriptor, record.state, normalized);
        if ("rejection" in verdict) seen.push({ candidate: verdict.rejection.candidate, reason: verdict.rejection.reason });
      }
      return { rejections: seen.sort((a, b) => (a.candidate < b.candidate ? -1 : a.candidate > b.candidate ? 1 : 0)) };
    }
    const seen: { candidate: string; reason: RejectionReason }[] = [];
    for (const descriptor of this.providers.list()) {
      const verdict = filterProvider(descriptor, normalized, this.nodes);
      if ("rejection" in verdict) seen.push({ candidate: verdict.rejection.candidate, reason: verdict.rejection.reason });
    }
    return { rejections: seen.sort((a, b) => (a.candidate < b.candidate ? -1 : a.candidate > b.candidate ? 1 : 0)) };
  }

  private routeProvider(normalized: RoutingRequest, providerSnapshot: RuntimeProviderDescriptor[], nodeSnapshot: { descriptor: ArthurNodeDescriptor; state: NodeRuntimeState }[]): HybridRoutingDecision {
    const eligible: EngineProviderCandidate[] = [];
    const rejections: { candidate: string; reason: RejectionReason }[] = [];
    const frozen = snapshotNodes(nodeSnapshot);
    for (const descriptor of providerSnapshot) {
      const verdict = filterProvider(descriptor, normalized, frozen);
      if ("rejection" in verdict) {
        rejections.push({ candidate: verdict.rejection.candidate, reason: verdict.rejection.reason });
        continue;
      }
      eligible.push(verdict.candidate);
    }
    if (eligible.length === 0) throw new NoEligibleTargetError(rejections);
    const modes = preferenceListFor(this.policy, normalized.reasoning_profile);
    const preferReady = this.policy.prefer_ready_over_busy;
    const ranked = [...eligible].sort((a, b) => compareProviders(a, b, normalized, modes, preferReady));
    const winner = ranked[0] as EngineProviderCandidate;
    const decision: HybridRoutingDecision = {
      operation: normalized.operation,
      runtime_mode: winner.mode,
      reason: reasonForProvider(winner, normalized),
      alternatives: ranked.slice(1).map((c) => c.providerId),
    };
    if (winner.nodeId !== undefined) decision.target_node_id = winner.nodeId;
    decision.target_provider_id = winner.providerId;
    return normalizeHybridRoutingDecision(decision);
  }

  private routeTool(normalized: RoutingRequest, nodeSnapshot: { descriptor: ArthurNodeDescriptor; state: NodeRuntimeState }[]): HybridRoutingDecision {
    const eligible: EngineNodeCandidate[] = [];
    const rejections: { candidate: string; reason: RejectionReason }[] = [];
    for (const record of nodeSnapshot) {
      const verdict = filterToolNode(record.descriptor, record.state, normalized);
      if ("rejection" in verdict) {
        rejections.push({ candidate: verdict.rejection.candidate, reason: verdict.rejection.reason });
        continue;
      }
      eligible.push(verdict.candidate);
    }
    if (eligible.length === 0) throw new NoEligibleTargetError(rejections);
    const modes = preferenceListFor(this.policy, normalized.reasoning_profile);
    const preferReady = this.policy.prefer_ready_over_busy;
    const ranked = [...eligible].sort((a, b) => compareToolNodes(a, b, normalized, modes, preferReady));
    const winner = ranked[0] as EngineNodeCandidate;
    return normalizeHybridRoutingDecision({
      operation: normalized.operation,
      target_node_id: winner.nodeId,
      runtime_mode: winner.mode,
      reason: reasonForToolNode(winner, normalized),
      alternatives: ranked.slice(1).map((c) => c.nodeId),
    });
  }
}
