/**
 * HR-03E: remote-host tool executor bindings (execution allowlist).
 *
 * The remote host needs ONLY execution bindings: exact capability
 * identity (tool_id + version + definition hash) -> the bound adapter.
 * This is NOT a ToolRegistry: no risk policy, no PermissionService, no
 * approvals, no SC-02/SC-03 state, no schemas, no routing policy.
 * Explicit trusted construction only; no discovery, no auto-registration.
 */

import type { ToolExecutor, ToolResult } from "../../../tools/contracts";

export interface BoundToolExecutor {
  tool_id: string;
  tool_version: string;
  tool_definition_hash: string;
  executor: ToolExecutor;
}

export class ToolExecutorBindings {
  private readonly entries = new Map<string, { version: string; hash: string; executor: ToolExecutor }>();

  register(entry: BoundToolExecutor): void {
    const id = this.keyOf(entry.tool_id);
    this.assertVersion(entry.tool_version);
    this.assertHash(entry.tool_definition_hash);
    if (typeof entry.executor !== "function") throw new Error("tool executor binding must be a function");
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      if (existing.executor === entry.executor && existing.version === entry.tool_version && existing.hash === entry.tool_definition_hash) {
        return;
      }
      throw new Error("tool executor binding conflict for tool " + JSON.stringify(id));
    }
    this.entries.set(id, { version: entry.tool_version, hash: entry.tool_definition_hash, executor: entry.executor });
  }

  get(toolId: string): { version: string; hash: string; executor: ToolExecutor } | undefined {
    if (typeof toolId !== "string") return undefined;
    const stored = this.entries.get(toolId.trim());
    return stored === undefined ? undefined : { version: stored.version, hash: stored.hash, executor: stored.executor };
  }

  has(toolId: string): boolean {
    if (typeof toolId !== "string") return false;
    return this.entries.has(toolId.trim());
  }

  listIds(): string[] {
    return [...this.entries.keys()].sort();
  }

  get size(): number {
    return this.entries.size;
  }

  private keyOf(toolId: string): string {
    if (typeof toolId !== "string" || toolId.trim() === "") {
      throw new Error("tool executor binding id must be non-empty");
    }
    if (toolId.trim().length > 256) throw new Error("tool executor binding id exceeds the bound");
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F]/.test(toolId)) throw new Error("tool executor binding id contains control characters");
    return toolId.trim();
  }

  private assertVersion(version: unknown): void {
    if (typeof version !== "string" || version === "" || version.length > 64) {
      throw new Error("tool executor binding version must be a bounded non-empty string");
    }
  }

  private assertHash(hash: unknown): void {
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error("tool executor binding definition hash must be a 64-char hex digest");
    }
  }
}

export type { ToolResult };
