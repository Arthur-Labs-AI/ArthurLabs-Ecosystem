/**
 * HR-03E: in-memory remote-node tool execution bindings (caller side).
 *
 * Maps a LAN node id -> the LAN tool execution client bound to that node.
 * This is NOT a ToolRegistry: it holds no definitions, schemas, risk
 * policy, permissions, or approval state - only the transport client that
 * dispatches an already-authorized attempt to one explicitly bound node.
 *
 * Rules: deterministic, explicit construction only, same node + same
 * instance idempotent, same node + conflicting instance fails closed,
 * no discovery, no config, no persistence, no heartbeat, no auto-creation.
 */

export interface RemoteToolExecutorClient {
  execute(
    toolId: string,
    toolVersion: string,
    toolDefinitionHash: string,
    args: Record<string, unknown>,
    ctx: RemoteToolWireContext,
    attempt: RemoteToolWireAttempt,
  ): Promise<RemoteToolResult>;
}

/** Bounded caller-side wire context (no authorization material). */
export interface RemoteToolWireContext {
  session_id: string;
  turn_id: string;
  trace_id: string;
  mode: string;
}

/** Caller-owned SC-03 attempt identity carried verbatim over LAN. */
export interface RemoteToolWireAttempt {
  execution_id: string;
  attempt_id: string;
  attempt_no: number;
  deadline_at: string;
  signal?: AbortSignal;
}

/** Structurally validated remote result (caller re-validates the contract). */
export interface RemoteToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

export class NodeToolExecutionBindings {
  private readonly clients = new Map<string, RemoteToolExecutorClient>();

  register(nodeId: string, client: RemoteToolExecutorClient): void {
    const key = this.keyOf(nodeId);
    this.assertClient(client);
    const existing = this.clients.get(key);
    if (existing !== undefined) {
      if (existing === client) return;
      throw new Error("remote tool binding conflict for node " + JSON.stringify(key));
    }
    this.clients.set(key, client);
  }

  get(nodeId: string): RemoteToolExecutorClient | undefined {
    if (typeof nodeId !== "string") return undefined;
    return this.clients.get(nodeId.trim());
  }

  has(nodeId: string): boolean {
    if (typeof nodeId !== "string") return false;
    return this.clients.has(nodeId.trim());
  }

  listIds(): string[] {
    return [...this.clients.keys()].sort();
  }

  remove(nodeId: string): boolean {
    if (typeof nodeId !== "string") return false;
    return this.clients.delete(nodeId.trim());
  }

  get size(): number {
    return this.clients.size;
  }

  private keyOf(nodeId: string): string {
    if (typeof nodeId !== "string" || nodeId.trim() === "") {
      throw new Error("remote tool binding node id must be non-empty");
    }
    if (nodeId.trim().length > 128) {
      throw new Error("remote tool binding node id exceeds the bound");
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F]/.test(nodeId)) {
      throw new Error("remote tool binding node id contains control characters");
    }
    return nodeId.trim();
  }

  private assertClient(client: RemoteToolExecutorClient): void {
    if (client === null || typeof client !== "object") {
      throw new Error("remote tool executor client must be an object");
    }
    if (typeof (client as { execute?: unknown }).execute !== "function") {
      throw new Error("remote tool executor client must implement execute()");
    }
  }
}

/** Recommended alias (spec §7): both names denote the same binding map. */
export { NodeToolExecutionBindings as RemoteNodeExecutorBindings };
