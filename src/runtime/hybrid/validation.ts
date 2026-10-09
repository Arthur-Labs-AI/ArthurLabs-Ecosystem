/**
 * HR-03A: cross-registry provider/node binding validation.
 *
 * Canonical relative-locality interpretation (documented invariant):
 * node runtime_mode describes locality RELATIVE TO THIS ARTHUR CORE.
 * The machine Core runs on is local; a trusted peer is lan. Therefore:
 *
 *   provider local -> node runtime_mode MUST equal local
 *   provider lan   -> node runtime_mode MUST equal lan
 *   provider cloud -> no node binding (node_id must be absent)
 *
 * Locality is trusted construction metadata, never inferred. This
 * validator is pure metadata: no network, no probing, no execution.
 * Capabilities advertise ability (NOT authorization): future tool flow
 * stays Model -> ToolRegistry -> validation -> SC-02 -> SC-03 ->
 * coordinator -> service -> CapabilityRouter -> executor. Routing metadata
 * MUST NEVER become authorization; no second ToolRegistry exists here.
 */

import { HybridRegistryError } from "./errors";
import type { NodeRegistry } from "./node_registry";
import type { RuntimeProviderDescriptor } from "./provider_descriptor";

export function validateProviderNodeBinding(
  provider: RuntimeProviderDescriptor,
  nodes: NodeRegistry,
): { ok: true } {
  const mode = provider.identity.runtime_mode;
  if (mode === "cloud") {
    if (provider.node_id !== undefined) {
      throw new HybridRegistryError("INVALID_PROVIDER_DESCRIPTOR", "cloud provider must not bind a node");
    }
    return { ok: true };
  }
  if (provider.node_id === undefined) {
    throw new HybridRegistryError("UNKNOWN_NODE", "provider requires a node binding");
  }
  const record = nodes.get(provider.node_id);
  if (record === undefined) {
    throw new HybridRegistryError("UNKNOWN_NODE", "unknown node " + JSON.stringify(provider.node_id));
  }
  const expected = mode === "local" ? "local" : "lan";
  if (record.descriptor.runtime_mode !== expected) {
    throw new HybridRegistryError(
      "PROVIDER_NODE_LOCALITY_MISMATCH",
      "provider " + JSON.stringify(provider.identity.id) + " requires a " + expected + " node",
    );
  }
  return { ok: true };
}
