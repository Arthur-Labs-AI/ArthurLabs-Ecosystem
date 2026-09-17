/**
 * HR-03C: ModelRouter over the deterministic hybrid routing engine.
 *
 * Flow: ConversationLoopRunner -> ModelRouter (ModelGateway) ->
 * HybridRoutingEngine -> selected ModelGateway -> provider. The loop keeps
 * ONE authoritative model path and SC-06 semantics are untouched: routing
 * runs per MODEL ATTEMPT (one generate()/generateStream() call pins one
 * provider). A later SC-06 round after tool execution re-routes; no
 * cross-round pinning is invented here.
 *
 * Legacy form ModelRouter({ gateway, locality }) still works: it builds a
 * single-provider hybrid world (local node + metadata + gateway registry)
 * that routes to the same provider with reason configured_default.
 *
 * Fallback is bounded and pre-output only: at most 2 attempts (primary +
 * one ranked alternative), only for ProviderTimeoutError /
 * ProviderUnavailableError (incl. their ArthurError MODEL_TIMEOUT /
 * MODEL_UNAVAILABLE-with-unavailable-cause mappings), never after the
 * first externally visible stream event, never on auth/bad-response /
 * invalid-request / cancellation / programmer errors. No partial-output
 * concatenation: a fallback attempt starts fresh. No health marking, no
 * retry loops, no backoff, no circuit breaker.
 *
 * Concurrency: selection state lives in call scope; an optional observer
 * receives per-attempt metadata ({ provider_id, runtime_mode, reason,
 * fallback_used, attempt_count }). No shared mutable lastDecision.
 */

import type {
  ModelCapabilities,
  ModelGateway,
  ModelRequest,
  ModelResult,
  ModelStreamEvent,
} from "../models/contracts";
import {
  ProviderAuthError,
  ProviderBadResponseError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from "../models/contracts";
import { ArthurError } from "../core/errors/errors";
import type { RuntimeMode } from "./runtime_mode";
import type { RuntimeCapabilitySet, RuntimeProviderIdentity } from "./provider";
import { providerStatus, type ProviderStatus } from "./provider_status";
import { configuredDefaultDecision, type RoutingDecision } from "./routing";
import { HybridRegistryError } from "./hybrid/errors";
import { NodeRegistry } from "./hybrid/node_registry";
import { ProviderRegistry } from "./hybrid/provider_registry";
import { ModelGatewayRegistry } from "./hybrid/gateway_registry";
import { HybridRoutingEngine, isNoEligibleTargetError } from "./hybrid/routing_engine";
import { DEFAULT_ROUTING_POLICY, type RoutingPolicy } from "./hybrid/routing_policy";
import { allowedRuntimeModesFor, type DataLocalityPolicy, type HybridRoutingDecision, type RoutingRequest } from "./hybrid/routing_contracts";

export const HYBRID_MODEL_ROUTER_ID = "hybrid-model-router";

export const MAX_MODEL_ROUTING_ATTEMPTS = 2;

export interface ModelRoutingObserver {
  onAttempt?(info: { provider_id: string; runtime_mode: RuntimeMode; reason: string; attempt: number; fallback: boolean }): void;
}

export interface ModelRouterHybridDeps {
  nodes: NodeRegistry;
  providers: ProviderRegistry;
  gateways: ModelGatewayRegistry;
  engine?: HybridRoutingEngine;
  policy?: RoutingPolicy;
  dataLocalityPolicy?: DataLocalityPolicy;
  observer?: ModelRoutingObserver;
}

export interface ModelRouterLegacyDeps {
  gateway: ModelGateway;
  locality: RuntimeMode;
}

export type ModelRouterDeps = ModelRouterHybridDeps | ModelRouterLegacyDeps;

function isLegacyDeps(deps: ModelRouterDeps): deps is ModelRouterLegacyDeps {
  return (deps as ModelRouterLegacyDeps).gateway !== undefined;
}

function isAuthFailure(err: unknown): boolean {
  // Typed causes only: message text is NEVER inspected (spoofable).
  if (err instanceof ProviderAuthError) return true;
  if (err instanceof ArthurError && err.code === "MODEL_UNAVAILABLE" && err.cause instanceof ProviderAuthError) return true;
  return false;
}

function fallbackEligible(err: unknown): boolean {
  // Raw provider errors: only availability-class failures are retryable.
  if (err instanceof ProviderTimeoutError || err instanceof ProviderUnavailableError) return true;
  if (err instanceof ProviderAuthError || err instanceof ProviderBadResponseError) return false;
  // Mapped ArthurErrors: the code alone is NOT sufficient (MODEL_UNAVAILABLE
  // also carries auth and unexpected failures). Only a typed cause proving
  // availability semantics permits fallback; ambiguous mappings fail closed.
  if (err instanceof ArthurError) {
    if (err.code === "MODEL_TIMEOUT" && err.cause instanceof ProviderTimeoutError) return true;
    if (err.code === "MODEL_UNAVAILABLE" && err.cause instanceof ProviderUnavailableError) return true;
    return false;
  }
  return false;
}

function buildRoutingRequest(request: ModelRequest, dataLocality: DataLocalityPolicy): RoutingRequest {
  const needsTools = request.toolSchemas.length > 0;
  const required = needsTools ? ["model.generate", "model.tools"] : ["model.generate"];
  const out: RoutingRequest = {
    operation: "model.generate",
    required_capabilities: required as RoutingRequest["required_capabilities"],
    data_locality: dataLocality,
    reasoning_profile: request.reasoningProfile === "fast" || request.reasoningProfile === "normal" || request.reasoningProfile === "deep"
      ? request.reasoningProfile
      : "normal",
  };
  if (request.sessionId !== undefined && request.sessionId !== "") out.session_id = request.sessionId;
  if (needsTools) out.constraints = { needs_tools: true };
  return out;
}

export class ModelRouter implements ModelGateway {
  private readonly nodes: NodeRegistry;
  private readonly providers: ProviderRegistry;
  private readonly gateways: ModelGatewayRegistry;
  private readonly engine: HybridRoutingEngine;
  private readonly dataLocality: DataLocalityPolicy;
  private readonly observer?: ModelRoutingObserver;
  private readonly legacyDecision?: RoutingDecision;
  private readonly legacyGateway?: ModelGateway;
  private readonly legacyLocality?: RuntimeMode;

  constructor(deps: ModelRouterDeps) {
    if (isLegacyDeps(deps)) {
      const nodes = new NodeRegistry();
      nodes.register({
        id: "local-node",
        role: "box",
        runtime_mode: deps.locality === "cloud" ? "lan" : deps.locality,
        platform: "unknown",
        runtime_capabilities: ["model.generate", "model.tools"],
        tool_ids: [],
      }, { status: "ready", active_jobs: 0, last_seen_at_ms: 0 });
      const nodeId = "local-node";
      const providers = new ProviderRegistry();
      if (deps.locality === "cloud") {
        providers.register({
          identity: { id: deps.gateway.id, kind: "model", runtime_mode: "cloud" },
          capabilities: ["model.generate", "model.tools"],
          model: { supports_tools: true, supports_reasoning: true, max_context_tokens: 128000 },
        });
      } else {
        providers.register({
          identity: { id: deps.gateway.id, kind: "model", runtime_mode: deps.locality },
          capabilities: ["model.generate", "model.tools"],
          node_id: nodeId,
          model: { supports_tools: true, supports_reasoning: true, max_context_tokens: 128000 },
        });
      }
      const gateways = new ModelGatewayRegistry();
      gateways.register(deps.gateway.id, deps.gateway);
      this.nodes = nodes;
      this.providers = providers;
      this.gateways = gateways;
      this.engine = new HybridRoutingEngine({ nodes, providers, policy: DEFAULT_ROUTING_POLICY });
      this.dataLocality = "cloud_allowed";
      this.legacyDecision = configuredDefaultDecision(deps.gateway.id, deps.locality);
      this.legacyGateway = deps.gateway;
      this.legacyLocality = deps.locality;
      return;
    }
    if (deps.nodes === undefined || deps.providers === undefined || deps.gateways === undefined) {
      throw new HybridRegistryError("INVALID_ROUTING_REQUEST", "hybrid ModelRouter requires nodes, providers, and gateways");
    }
    this.nodes = deps.nodes;
    this.providers = deps.providers;
    this.gateways = deps.gateways;
    this.engine = deps.engine ?? new HybridRoutingEngine({ nodes: deps.nodes, providers: deps.providers, policy: deps.policy });
    this.dataLocality = deps.dataLocalityPolicy ?? "cloud_allowed";
    if (!allowedRuntimeModesFor(this.dataLocality).includes("cloud") && !allowedRuntimeModesFor(this.dataLocality).includes("local") && !allowedRuntimeModesFor(this.dataLocality).includes("lan")) {
      throw new HybridRegistryError("INVALID_ROUTING_REQUEST", "unknown data locality policy");
    }
    if (deps.observer !== undefined) this.observer = deps.observer;
  }

  routingDecision(): RoutingDecision {
    if (this.legacyDecision !== undefined) return { ...this.legacyDecision };
    throw new HybridRegistryError("INVALID_ROUTING_DECISION", "hybrid ModelRouter has no single constructor-time decision; observe per-attempt metadata instead");
  }

  identity(): RuntimeProviderIdentity {
    if (this.legacyGateway !== undefined) {
      return { id: this.legacyGateway.id, kind: "model", runtime_mode: this.legacyLocality as RuntimeMode };
    }
    return { id: HYBRID_MODEL_ROUTER_ID, kind: "model", runtime_mode: "cloud" };
  }

  capabilities(): ModelCapabilities {
    if (this.legacyGateway !== undefined) return this.legacyGateway.capabilities();
    let supportsTools = false;
    let supportsReasoning = false;
    let maxContextTokens = 0;
    let online = false;
    let seen = false;
    for (const descriptor of this.providers.list()) {
      if (descriptor.identity.kind !== "model") continue;
      const gateway = this.gateways.get(descriptor.identity.id);
      if (gateway === undefined) continue;
      seen = true;
      let caps: ModelCapabilities;
      try {
        caps = gateway.capabilities();
      } catch {
        continue;
      }
      if (caps.supportsTools) supportsTools = true;
      if (caps.supportsReasoning) supportsReasoning = true;
      if (caps.maxContextTokens > maxContextTokens) maxContextTokens = caps.maxContextTokens;
      if (caps.online) online = true;
    }
    if (!seen) {
      return { id: HYBRID_MODEL_ROUTER_ID, modelName: HYBRID_MODEL_ROUTER_ID, supportsTools: false, supportsReasoning: false, maxContextTokens: 0, online: false };
    }
    return { id: HYBRID_MODEL_ROUTER_ID, modelName: HYBRID_MODEL_ROUTER_ID, supportsTools, supportsReasoning, maxContextTokens, online };
  }

  runtimeCapabilities(): RuntimeCapabilitySet {
    return this.capabilities().supportsTools ? ["model.generate", "model.tools"] : ["model.generate"];
  }

  status(): ProviderStatus {
    if (this.legacyGateway !== undefined) {
      return providerStatus(this.legacyGateway.id, "model", this.legacyLocality as RuntimeMode, "ready", "configured_default");
    }
    return providerStatus(HYBRID_MODEL_ROUTER_ID, "model", "cloud", "ready", "configured_default");
  }

  get id(): string {
    if (this.legacyGateway !== undefined) return this.legacyGateway.id;
    return HYBRID_MODEL_ROUTER_ID;
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    const routingRequest = buildRoutingRequest(request, this.dataLocality);
    const decision = this.engine.route(routingRequest);
    const ordered: { providerId: string; nodeId?: string }[] = [{ providerId: decision.target_provider_id as string, ...(decision.target_node_id !== undefined ? { nodeId: decision.target_node_id } : {}) }];
    for (const alt of decision.alternatives) ordered.push({ providerId: alt });
    let attempt = 0;
    let lastError: unknown;
    for (const candidate of ordered.slice(0, MAX_MODEL_ROUTING_ATTEMPTS)) {
      attempt += 1;
      const gateway = this.gateways.get(candidate.providerId);
      if (gateway === undefined) {
        lastError = new HybridRegistryError("INVALID_PROVIDER_DESCRIPTOR", "no executable gateway for provider " + JSON.stringify(candidate.providerId));
        continue;
      }
      this.notify(decision, candidate.providerId, attempt, attempt > 1);
      try {
        return await gateway.generate(request);
      } catch (err) {
        lastError = err;
        if (isAuthFailure(err) || err instanceof ProviderBadResponseError) throw err;
        if (!fallbackEligible(err)) throw err;
        continue;
      }
    }
    if (isNoEligibleTargetError(lastError)) throw lastError;
    throw lastError;
  }

  generateStream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    return this.streamAttempt(request, signal);
  }

  private async *streamAttempt(request: ModelRequest, signal: AbortSignal | undefined): AsyncIterable<ModelStreamEvent> {
    const routingRequest = buildRoutingRequest(request, this.dataLocality);
    const decision = this.engine.route(routingRequest);
    const ordered: string[] = [decision.target_provider_id as string, ...decision.alternatives].slice(0, MAX_MODEL_ROUTING_ATTEMPTS);
    let attempt = 0;
    let lastError: unknown;
    for (const providerId of ordered) {
      attempt += 1;
      const gateway = this.gateways.get(providerId);
      if (gateway === undefined) {
        lastError = new HybridRegistryError("INVALID_PROVIDER_DESCRIPTOR", "no executable gateway for provider " + JSON.stringify(providerId));
        continue;
      }
      this.notify(decision, providerId, attempt, attempt > 1);
      let yielded = false;
      try {
        for await (const event of gateway.generateStream(request, signal)) {
          yielded = true;
          yield event;
        }
        return;
      } catch (err) {
        // First externally visible event commits ownership: post-yield
        // failure must fail the stream, never hop providers mid-stream.
        // Pre-yield availability failure may try ONE fresh alternative.
        lastError = err;
        if (yielded) throw err;
        if (signal?.aborted === true) throw err;
        if (isAuthFailure(err) || err instanceof ProviderBadResponseError) throw err;
        if (!fallbackEligible(err)) throw err;
        continue;
      }
    }
    void lastError;
    if (isNoEligibleTargetError(lastError)) throw lastError;
    throw lastError;
  }

  private notify(decision: HybridRoutingDecision, providerId: string, attempt: number, fallback: boolean): void {
    if (this.observer?.onAttempt === undefined) return;
    try {
      this.observer.onAttempt({ provider_id: providerId, runtime_mode: decision.runtime_mode, reason: decision.reason, attempt, fallback });
    } catch {
    }
  }
}
