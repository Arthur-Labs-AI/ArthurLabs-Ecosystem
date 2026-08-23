/**
 * Built-in Phase 1 tools (spec section 10).
 *
 * - system.echo        (READ)               deterministic contract/integration tool
 * - harness.status     (READ)               deterministic fake harness status
 * - harness.create_job (APPROVAL_REQUIRED)  stub; never executes without approval
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
      risk: "approval_required",
      allowed_modes: [ArthurMode.BUSINESS],
    },
    async (args, ctx: ToolExecutionContext) => {
      if (!ctx.approved || !ctx.approvalToken) {
        throw new Error("harness.create_job requires explicit approval");
      }
      const token: ApprovalToken = ctx.approvalToken;
      const spec: HarnessJobSpec = {
        kind: String(args.kind ?? ""),
        payload: args.payload as Record<string, unknown> | undefined,
      };
      const job = await harness.createJob(spec, token);
      return { ok: true, summary: `job created: ${job.id} (${job.status})`, data: job };
    },
  );
}
