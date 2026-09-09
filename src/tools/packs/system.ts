/**
 * SC-04 system tool pack (spec sections 10-11, 60).
 *
 * system.status (existing) + system.storage (scoped: per-root
 * total/free bytes only, root_id keyed, no physical paths).
 * Both are read risk, effects=none, cooperative cancellation, safe
 * bounded retry inherited from the SC-03 risk default.
 */

import { ArthurMode } from "../../core/modes/mode";
import type { LocalCapabilityHost } from "../local_host";
import type { ToolRegistry } from "../registry";

export function registerSystemPack(registry: ToolRegistry, host: LocalCapabilityHost): void {
  registry.register(
    {
      name: "system.status",
      version: "1.0.0",
      description:
        "Report non-sensitive local host information: platform, architecture, Node version, uptime, CPU count, and memory. Read-only.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      output_schema: {
        type: "object",
        properties: {
          platform: { type: "string" },
          arch: { type: "string" },
          node_version: { type: "string" },
          uptime_seconds: { type: "number", minimum: 0 },
          cpu_count: { type: "integer", minimum: 1 },
          total_memory_bytes: { type: "integer", minimum: 0 },
          free_memory_bytes: { type: "integer", minimum: 0 },
        },
        required: [
          "platform",
          "arch",
          "node_version",
          "uptime_seconds",
          "cpu_count",
          "total_memory_bytes",
          "free_memory_bytes",
        ],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    },
    async () => {
      const status = await host.system.getStatus();
      const totalGb = Math.round(status.total_memory_bytes / 2 ** 30);
      return {
        ok: true,
        summary: "Local system: " + status.platform + " " + status.arch + ", Node " + status.node_version + ", " + status.cpu_count + " CPUs, " + totalGb + " GB RAM",
        data: status,
      };
    },
  );

  registry.register(
    {
      name: "system.storage",
      version: "1.0.0",
      description:
        "Report storage totals for the filesystem scopes ARTHUR may use (per root_id). Read-only; no physical paths.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      output_schema: {
        type: "object",
        properties: {
          roots: {
            type: "array",
            items: {
              type: "object",
              properties: {
                root_id: { type: "string" },
                total_bytes: { type: "integer", minimum: 0 },
                free_bytes: { type: "integer", minimum: 0 },
              },
              required: ["root_id", "total_bytes", "free_bytes"],
              additionalProperties: false,
            },
          },
        },
        required: ["roots"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    },
    async () => {
      const roots = await host.filesystem.storage();
      return {
        ok: true,
        summary: "Storage for " + roots.length + " scope(s)",
        data: { roots: roots },
      };
    },
  );
}
