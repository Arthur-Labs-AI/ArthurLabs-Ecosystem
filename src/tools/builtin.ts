/**
 * Built-in tools (spec section 10; TASK-0010 hardened manifests; TASK-0011).
 *
 * - system.echo        (READ)               deterministic contract/integration tool
 * - harness.status     (READ)               deterministic fake harness status
 * - harness.create_job (APPROVAL_REQUIRED)  stub; never executes without approval
 * - system.status      (READ)               FIRST REAL machine-local tool (TASK-0011):
 *                                           reports non-sensitive host information through
 *                                           the injected LocalSystemAdapter capability.
 *
 * Each builtin declares an output_schema so the executor-output validation
 * boundary (TASK-0010 section 4) is exercised by every regression path.
 */

import { ArthurMode } from "../core/modes/mode";
import { ApprovalToken, HarnessAdapter, HarnessJobSpec, ToolExecutionContext } from "./contracts";
import { harnessCreateJobPresenter } from "./approval_presenters";
import { LocalSystemAdapter, NodeLocalSystemAdapter } from "./adapters/local_system";
import { ToolRegistry } from "./registry";

export function registerBuiltinTools(
  registry: ToolRegistry,
  harness: HarnessAdapter,
  /** Local system capability; production defaults to the real Node adapter. */
  localSystem: LocalSystemAdapter = new NodeLocalSystemAdapter(),
): void {
  registry.register(
    {
      name: "system.echo",
      version: "1.0.0",
      description: "Echo the supplied text back. Used for contract and integration testing.",
      input_schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: { echo: { type: "string" } },
        required: ["echo"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    },
    (args) => {
      const text = String(args.text ?? "");
      return { ok: true, summary: text, data: { echo: text } };
    },
  );

  registry.register(
    {
      name: "harness.status",
      version: "1.0.0",
      description: "Return the current AI Harness status (stub).",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      output_schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["online", "offline", "degraded"] },
          version: { type: "string" },
          jobs_active: { type: "integer", minimum: 0 },
        },
        required: ["status", "version", "jobs_active"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    },
    async () => {
      const status = await harness.getStatus();
      return {
        ok: true,
        summary: `harness ${status.status} (v${status.version}, ${status.jobs_active} active jobs)`,
        data: status,
      };
    },
  );

  registry.register(
    {
      name: "harness.create_job",
      version: "1.0.0",
      description: "Create a job on the AI Harness. Requires explicit approval.",
      input_schema: {
        type: "object",
        properties: {
          kind: { type: "string" },
          payload: { type: "object" },
        },
        required: ["kind"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["queued", "running", "succeeded", "failed", "cancelled"] },
          spec: {
            type: "object",
            properties: {
              kind: { type: "string" },
              payload: { type: "object" },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        },
        required: ["id", "status", "spec"],
        additionalProperties: false,
      },
      risk: "approval_required",
      allowed_modes: [ArthurMode.BUSINESS],
    },
    harnessCreateJobPresenter(),
    async (args, ctx: ToolExecutionContext) => {
      if (!ctx.authorization && (!ctx.approved || !ctx.approvalToken)) {
        throw new Error("harness.create_job requires explicit approval");
      }
      const token: ApprovalToken = ctx.approvalToken as ApprovalToken;
      // TASK-0010: structured results must be JSON-safe (no explicit undefined
      // fields - they would be silently dropped by JSON serialization).
      const spec: HarnessJobSpec = { kind: String(args.kind ?? "") };
      if (args.payload !== undefined) {
        spec.payload = args.payload as Record<string, unknown>;
      }
      const job = await harness.createJob(spec, token);
      return { ok: true, summary: `job created: ${job.id} (${job.status})`, data: job };
    },
  );

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
      // Machine-local capability call: the adapter is an implementation of the
      // capability, reached ONLY through this registered executor under the
      // secured registry -> execution-service -> permission boundary.
      const status = await localSystem.getStatus();
      const totalGb = Math.round(status.total_memory_bytes / 2 ** 30);
      return {
        ok: true,
        summary: `Local system: ${status.platform} ${status.arch}, Node ${status.node_version}, ${status.cpu_count} CPUs, ${totalGb} GB RAM`,
        data: status,
      };
    },
  );
}
