/**
 * HR-03A: deterministic in-memory NodeRegistry.
 *
 * Stores STATIC ArthurNodeDescriptors plus SEPARATE dynamic
 * NodeRuntimeStates. Defensive copies on every boundary; list() sorted
 * by node id. Duplicate registration of the same normalized descriptor
 * is idempotent; same id with a conflicting descriptor fails closed
 * (NODE_ID_CONFLICT) - capabilities are never silently replaced.
 * Static updates require explicit remove + re-register.
 *
 * No persistence, no files, no DB, no network.
 */

import { HybridRegistryError } from "./errors";
import {
  defaultNodeState,
  nodeDescriptorsEqual,
  normalizeNodeDescriptor,
  normalizeNodeState,
  type ArthurNodeDescriptor,
  type NodeRuntimeState,
} from "./node";

export interface NodeRecord {
  descriptor: ArthurNodeDescriptor;
  state: NodeRuntimeState;
}

export class NodeRegistry {
  private readonly nodes = new Map<string, { descriptor: ArthurNodeDescriptor; state: NodeRuntimeState }>();

  register(descriptor: ArthurNodeDescriptor, initialState?: NodeRuntimeState): NodeRecord {
    const normalized = normalizeNodeDescriptor(descriptor);
    const existing = this.nodes.get(normalized.id);
    if (existing !== undefined) {
      if (!nodeDescriptorsEqual(existing.descriptor, normalized)) {
        throw new HybridRegistryError("NODE_ID_CONFLICT", "node id already registered with a different descriptor");
      }
      return this.snapshot(existing);
    }
    const state = initialState === undefined ? defaultNodeState() : normalizeNodeState(initialState);
    this.nodes.set(normalized.id, { descriptor: normalized, state });
    const stored = this.nodes.get(normalized.id) as { descriptor: ArthurNodeDescriptor; state: NodeRuntimeState };
    return this.snapshot(stored);
  }

  updateState(nodeId: string, state: NodeRuntimeState): NodeRecord {
    const key = this.keyOf(nodeId);
    const existing = this.nodes.get(key);
    if (existing === undefined) {
      throw new HybridRegistryError("UNKNOWN_NODE", "unknown node " + JSON.stringify(key));
    }
    const normalized = normalizeNodeState(state);
    this.nodes.set(key, { descriptor: existing.descriptor, state: normalized });
    const stored = this.nodes.get(key) as { descriptor: ArthurNodeDescriptor; state: NodeRuntimeState };
    return this.snapshot(stored);
  }

  get(nodeId: string): NodeRecord | undefined {
    const stored = this.nodes.get(this.keyOf(nodeId));
    return stored === undefined ? undefined : this.snapshot(stored);
  }

  getState(nodeId: string): NodeRuntimeState | undefined {
    const stored = this.nodes.get(this.keyOf(nodeId));
    return stored === undefined ? undefined : { ...stored.state };
  }

  list(): NodeRecord[] {
    const ids = [...this.nodes.keys()].sort();
    return ids.map((id) => this.snapshot(this.nodes.get(id) as { descriptor: ArthurNodeDescriptor; state: NodeRuntimeState }));
  }

  remove(nodeId: string): boolean {
    return this.nodes.delete(this.keyOf(nodeId));
  }

  has(nodeId: string): boolean {
    if (typeof nodeId !== "string") return false;
    return this.nodes.has(nodeId.trim());
  }

  get size(): number {
    return this.nodes.size;
  }

  private keyOf(nodeId: string): string {
    if (typeof nodeId !== "string" || nodeId.trim() === "") {
      throw new HybridRegistryError("INVALID_NODE_DESCRIPTOR", "node id must be non-empty");
    }
    return nodeId.trim();
  }

  private snapshot(stored: { descriptor: ArthurNodeDescriptor; state: NodeRuntimeState }): NodeRecord {
    return {
      descriptor: {
        ...stored.descriptor,
        runtime_capabilities: [...stored.descriptor.runtime_capabilities],
        tool_ids: [...stored.descriptor.tool_ids],
      },
      state: { ...stored.state },
    };
  }
}
