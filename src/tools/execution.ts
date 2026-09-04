/**
 * Secured tool execution facade (spec section 12; audit MEDIUM 7; TASK-0010).
 *
 * This is the ONLY path that runs a tool executor. It re-validates arguments,
 * re-checks permissions on every call, wraps raw executor failures into a
 * stable sanitized error, and validates the ToolResult contract (shape,
 * JSON-safety, and output_schema) before the result may return to the
 * conversation/model pipeline. A caller that reaches a raw executor or a
 * hand-crafted approved:true context still cannot bypass the guardrails.
 *
 * The raw executor map lives privately inside ToolRegistry; this facade
 * receives it only as an invoker closure, so there is no public method that
 * can invoke an executor without validation.
 */

import { ArthurError, modeViolation } from "../core/errors/errors";
import { assertJsonSafe, JsonSafeError } from "./json_safe";
import type { PermissionService } from "./permissions";
import type { ToolRegistry } from "./registry";
import { ToolExecutionContext, ToolDefinition, ToolResult } from "./contracts";

export type ExecutorInvoker = (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
) => Promise<ToolResult>;

/**
 * Hard bound for the raw executor summary at the boundary. The model-facing
 * and persisted cap stays tighter (SecretSanitizer.capSummary); this bound
 * only fails closed on absurd executor output.
 */
export const TOOL_RESULT_SUMMARY_MAX_CHARS = 2000;

const TOOL_RESULT_FIELDS = new Set(["ok", "summary", "data"]);

function outputInvalid(tool: string, reasons: string[]): ArthurError {
  return new ArthurError(
    "TOOL_OUTPUT_INVALID",
    "Tool " + tool + " returned invalid output: " + reasons.join("; "),
  );
}

export class ToolExecutionService {
  private readonly registry: ToolRegistry;
  private readonly permissions: PermissionService;
  private readonly invoker: ExecutorInvoker;

  constructor(registry: ToolRegistry, permissions: PermissionService, invoker: ExecutorInvoker) {
    this.registry = registry;
    this.permissions = permissions;
    this.invoker = invoker;
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const definition = this.registry.getDefinition(name);
    if (!definition) {
      throw new ArthurError("TOOL_NOT_FOUND", "Unknown tool: " + name);
    }

    const validation = this.registry.validateArgs(name, args);
    if (!validation.valid) {
      throw new ArthurError(
        "TOOL_ARGUMENT_INVALID",
        "Tool arguments invalid: " + (validation.errors ?? []).join("; "),
      );
    }

    const decision = this.permissions.evaluate(definition, ctx.mode);
    if (decision === "reject") {
      if (!definition.allowed_modes.includes(ctx.mode)) {
        throw modeViolation("Tool " + name + " is not permitted in " + ctx.mode + " mode", {
          tool: name,
          mode: ctx.mode,
          risk: definition.risk,
        });
      }
      // Policy rejection that is NOT a mode gate (e.g. high_risk): stable
      // tool-level permission code (TASK-0010 section 6).
      throw new ArthurError("TOOL_PERMISSION_DENIED", "Tool " + name + " is rejected by permission policy", {
        details: { tool: name, mode: ctx.mode, risk: definition.risk },
        exposeDetails: true,
      });
    }
    if (decision === "approval" && (!ctx.approved || !ctx.approvalToken)) {
      throw new ArthurError("APPROVAL_REQUIRED", "Tool " + name + " requires explicit approval evidence");
    }
    if (decision === "approval" && ctx.approvalToken?.tool_name !== name) {
      throw new ArthurError("APPROVAL_INVALID", "Approval evidence does not authorize tool " + name);
    }

    let result: ToolResult;
    try {
      result = await this.invoker(name, args, ctx);
    } catch (err) {
      if (err instanceof ArthurError) {
        throw err;
      }
      // Raw executor exceptions never cross the boundary directly (TASK-0010
      // section 6): they become a stable sanitized tool execution failure.
      // The cause stays attached for LOCAL logging only; ArthurError.toJSON()
      // never serializes it, so no stack/paths/secrets reach clients or model.
      throw new ArthurError("TOOL_EXECUTION_FAILED", "Tool " + name + " execution failed", {
        cause: err,
      });
    }
    return this.assertResultContract(name, definition, result);
  }

  /**
   * Fail-closed validation of the ToolResult contract (TASK-0010 sections
   * 4/5): shape invariants, JSON-safety of structured data, and the declared
   * output_schema. Invalid executor output fails as TOOL_OUTPUT_INVALID and
   * is never treated as successful output.
   */
  private assertResultContract(tool: string, definition: ToolDefinition, result: unknown): ToolResult {
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw outputInvalid(tool, ["executor must return a ToolResult object"]);
    }
    const r = result as Record<string, unknown>;
    const unknownFields = Object.keys(r).filter((key) => !TOOL_RESULT_FIELDS.has(key));
    if (unknownFields.length > 0) {
      throw outputInvalid(tool, ["unexpected ToolResult fields: " + unknownFields.join(", ")]);
    }
    if (typeof r.ok !== "boolean") {
      throw outputInvalid(tool, ["ToolResult.ok must be a boolean"]);
    }
    if (typeof r.summary !== "string") {
      throw outputInvalid(tool, ["ToolResult.summary must be a string"]);
    }
    if (r.summary.length > TOOL_RESULT_SUMMARY_MAX_CHARS) {
      throw outputInvalid(tool, ["ToolResult.summary exceeds " + TOOL_RESULT_SUMMARY_MAX_CHARS + " characters"]);
    }

    const data = r.data;
    if (data !== undefined) {
      try {
        assertJsonSafe(data, "ToolResult.data");
      } catch (err) {
        if (err instanceof JsonSafeError) {
          throw outputInvalid(tool, [err.message]);
        }
        throw err;
      }
    }

    if (definition.output_schema !== undefined) {
      if (data === undefined) {
        throw outputInvalid(tool, ["tool declared an output_schema but returned no data"]);
      }
      const output = this.registry.validateOutput(tool, data);
      if (!output.valid) {
        throw outputInvalid(tool, output.errors ?? ["data does not match output_schema"]);
      }
    }
    return result as ToolResult;
  }
}
