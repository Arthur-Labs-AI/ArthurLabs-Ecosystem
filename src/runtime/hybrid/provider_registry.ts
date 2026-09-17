/**
 * HR-03A: deterministic in-memory ProviderRegistry (metadata only).
 *
 * The registry NEVER calls providers, probes the network, loads models,
 * checks credentials, instantiates gateways, or executes tools.
 * Defensive copies on every boundary; sorted output; idempotent
 * same-descriptor registration; conflicting same-id registration fails
 * closed (PROVIDER_ID_CONFLICT). No persistence, no files, no DB.
 */

import { HybridRegistryError } from "./errors";
import { isRuntimeCapability, type RuntimeCapability } from "../provider";
import { isRuntimeMode, type RuntimeMode } from "../runtime_mode";
import type { RuntimeProviderKind } from "../provider";
import {
  normalizeProviderDescriptor,
  providerDescriptorsEqual,
  type RuntimeProviderDescriptor,
} from "./provider_descriptor";

function cloneDescriptor(descriptor: RuntimeProviderDescriptor): RuntimeProviderDescriptor {
  const normalized = normalizeProviderDescriptor(descriptor);
  const out: RuntimeProviderDescriptor = {
    identity: { ...normalized.identity },
    capabilities: [...normalized.capabilities],
  };
  if (normalized.node_id !== undefined) out.node_id = normalized.node_id;
  if (normalized.model !== undefined) out.model = { ...normalized.model };
  return out;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, RuntimeProviderDescriptor>();

  register(descriptor: RuntimeProviderDescriptor): RuntimeProviderDescriptor {
    const normalized = normalizeProviderDescriptor(descriptor);
    const existing = this.providers.get(normalized.identity.id);
    if (existing !== undefined) {
      if (!providerDescriptorsEqual(existing, normalized)) {
        throw new HybridRegistryError("PROVIDER_ID_CONFLICT", "provider id already registered with a different descriptor");
      }
      return cloneDescriptor(existing);
    }
    this.providers.set(normalized.identity.id, normalized);
    const stored = this.providers.get(normalized.identity.id) as RuntimeProviderDescriptor;
    return cloneDescriptor(stored);
  }

  get(providerId: string): RuntimeProviderDescriptor | undefined {
    const stored = this.providers.get(this.keyOf(providerId));
    return stored === undefined ? undefined : cloneDescriptor(stored);
  }

  list(): RuntimeProviderDescriptor[] {
    return [...this.providers.keys()].sort().map((id) => cloneDescriptor(this.providers.get(id) as RuntimeProviderDescriptor));
  }

  listByKind(kind: RuntimeProviderKind): RuntimeProviderDescriptor[] {
    if (kind !== "stt" && kind !== "model" && kind !== "tts") {
      throw new HybridRegistryError("INVALID_PROVIDER_DESCRIPTOR", "unknown provider kind");
    }
    return this.list().filter((d) => d.identity.kind === kind);
  }

  listByRuntimeMode(mode: RuntimeMode): RuntimeProviderDescriptor[] {
    if (!isRuntimeMode(mode)) {
      throw new HybridRegistryError("INVALID_PROVIDER_DESCRIPTOR", "unknown runtime mode");
    }
    return this.list().filter((d) => d.identity.runtime_mode === mode);
  }

  listByCapability(capability: RuntimeCapability): RuntimeProviderDescriptor[] {
    if (!isRuntimeCapability(capability)) {
      throw new HybridRegistryError("INVALID_PROVIDER_DESCRIPTOR", "unknown runtime capability");
    }
    return this.list().filter((d) => d.capabilities.includes(capability));
  }

  remove(providerId: string): boolean {
    return this.providers.delete(this.keyOf(providerId));
  }

  has(providerId: string): boolean {
    if (typeof providerId !== "string") return false;
    return this.providers.has(providerId.trim());
  }

  get size(): number {
    return this.providers.size;
  }

  private keyOf(providerId: string): string {
    if (typeof providerId !== "string" || providerId.trim() === "") {
      throw new HybridRegistryError("INVALID_PROVIDER_DESCRIPTOR", "provider id must be non-empty");
    }
    return providerId.trim();
  }
}
