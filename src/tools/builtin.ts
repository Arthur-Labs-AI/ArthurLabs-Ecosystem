/**
 * Built-in Phase 1 tools (spec section 10; TASK-0010 hardened manifests).
 *
 * - system.echo        (READ)               deterministic contract/integration tool
 * - harness.status     (READ)               deterministic fake harness status
 * - harness.create_job (APPROVAL_REQUIRED)  stub; never executes without approval
 *
 * Each builtin declares an output_schema so the executor-output validation
 * boundary (TASK-0010 section 4) is exercised by every regression path.
 */

import { ArthurMode } from "../core/modes/mode";
import { ApprovalToken, HarnessAdapter, HarnessJobSpec, ToolExecutionContext } from "./contracts";
import { ToolRegistry } from "./registry";

export function registerBuiltinTools(registry: ToolRegistry, harness: HarnessAdapter): void {
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
    async (args, ctx: ToolExecutionContext) => {
      if (!ctx.approved || !ctx.approvalToken) {
        throw new Error("harness.create_job requires explicit approval");
      }
      const token: ApprovalToken = ctx.approvalToken;
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
}
