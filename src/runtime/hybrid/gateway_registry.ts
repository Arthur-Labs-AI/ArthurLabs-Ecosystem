/**
 * HR-03C: executable ModelGateway registry (runtime binding layer).
 *
 * ProviderRegistry holds trusted ROUTING METADATA; this registry holds the
 * actual executable ModelGateway objects. A model provider is usable by
 * ModelRouter only when it exists in BOTH: metadata without a gateway is
 * not executable, a gateway without metadata is not routable. Same id +
 * same instance is idempotent; same id + different instance fails closed.
 * In-memory only: no config, no discovery, no persistence, no network.
 */

import { HybridRegistryError } from "./errors";
import type { ModelGateway } from "../../models/contracts";

export class ModelGatewayRegistry {
  private readonly gateways = new Map<string, ModelGateway>();

  register(providerId: string, gateway: ModelGateway): void {
    const key = this.keyOf(providerId);
    this.assertGateway(gateway);
    const existing = this.gateways.get(key);
    if (existing !== undefined) {
      if (existing !== gateway) {
        throw new HybridRegistryError("PROVIDER_ID_CONFLICT", "gateway already registered for provider " + JSON.stringify(key));
      }
      return;
    }
    this.gateways.set(key, gateway);
  }

  get(providerId: string): ModelGateway | undefined {
    return this.gateways.get(this.keyOf(providerId));
  }

  has(providerId: string): boolean {
    if (typeof providerId !== "string") return false;
    return this.gateways.has(providerId.trim());
  }

  listIds(): string[] {
    return [...this.gateways.keys()].sort();
  }

  remove(providerId: string): boolean {
    return this.gateways.delete(this.keyOf(providerId));
  }

  get size(): number {
    return this.gateways.size;
  }

  private keyOf(providerId: string): string {
    if (typeof providerId !== "string" || providerId.trim() === "") {
      throw new HybridRegistryError("INVALID_PROVIDER_DESCRIPTOR", "provider id must be non-empty");
    }
    return providerId.trim();
  }

  private assertGateway(gateway: ModelGateway): void {
    if (gateway === null || typeof gateway !== "object") {
      throw new HybridRegistryError("INVALID_PROVIDER_DESCRIPTOR", "gateway must be a ModelGateway object");
    }
    const candidate = gateway as unknown as Record<string, unknown>;
    if (typeof candidate["generate"] !== "function" || typeof candidate["generateStream"] !== "function" || typeof candidate["capabilities"] !== "function") {
      throw new HybridRegistryError("INVALID_PROVIDER_DESCRIPTOR", "gateway must implement the ModelGateway surface");
    }
  }
}
