/**
 * HR-01 ModelRouter seam.
 *
 * Target flow: ConversationLoopRunner -> ModelRouter -> ModelProvider.
 *
 * The router implements the same `ModelGateway` interface the loop already
 * consumes, so the loop keeps ONE authoritative model execution path
 * (SC-06 semantics unchanged: rounds, budgets, approval barrier, synthesis).
 *
 * HR-01 behavior: always resolves the currently configured provider with
 * reason `configured_default`. No fallback, no multi-model turns, no
 * mid-turn provider switch: the selected provider owns the entire turn
 * boundary (see routing.ts ownership invariant).
 */

import type {
  ModelCapabilities,
  ModelGateway,
  ModelRequest,
  ModelResult,
  ModelStreamEvent,
} from "../models/contracts";
import type { RuntimeMode } from "./runtime_mode";
import type { RuntimeCapabilitySet, RuntimeProviderIdentity } from "./provider";
import { providerStatus, type ProviderStatus } from "./provider_status";
import { configuredDefaultDecision, type RoutingDecision } from "./routing";

export interface ModelRouterDeps {
  /** The currently configured model gateway (DeepSeek or fake today). */
  gateway: ModelGateway;
  /**
   * Actual execution locality of the wrapped provider (trusted construction
   * metadata from the composition root — never inferred from ids, names,
   * hosts, or the network). DeepSeek -> "cloud"; in-process fake -> "local".
   */
  locality: RuntimeMode;
}

export class ModelRouter implements ModelGateway {
  private readonly gateway: ModelGateway;
  private readonly locality: RuntimeMode;
  private readonly decision: RoutingDecision;

  constructor(deps: ModelRouterDeps) {
    this.gateway = deps.gateway;
    this.locality = deps.locality;
    this.decision = configuredDefaultDecision(deps.gateway.id, deps.locality);
  }

  /** Explicit, testable routing decision (HR-01: always configured_default). */
  routingDecision(): RoutingDecision {
    return { ...this.decision };
  }

  identity(): RuntimeProviderIdentity {
    return { id: this.gateway.id, kind: "model", runtime_mode: this.locality };
  }

  /** ModelGateway surface: authoritative provider capabilities (unchanged). */
  capabilities(): ModelCapabilities {
    return this.gateway.capabilities();
  }

  /** Runtime capability metadata (routing vocabulary, not authorization). */
  runtimeCapabilities(): RuntimeCapabilitySet {
    const base = this.gateway.capabilities();
    return base.supportsTools ? ["model.generate", "model.tools"] : ["model.generate"];
  }

  status(): ProviderStatus {
    return providerStatus(this.gateway.id, "model", this.locality, "ready", "configured_default");
  }

  get id(): string {
    return this.gateway.id;
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    // Single provider per turn: no fan-out, no fallback, no retry-hopping.
    return this.gateway.generate(request);
  }

  generateStream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    return this.gateway.generateStream(request, signal);
  }
}
