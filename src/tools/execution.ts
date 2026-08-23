/**
 * Secured tool execution facade (spec section 12; audit MEDIUM 7).
 *
 * This is the ONLY path that runs a tool executor. It re-validates arguments
 * and re-checks permissions on every call, so a caller that reaches a raw
 * executor or a hand-crafted approved:true context still cannot bypass the
 * guardrails. The orchestrator uses this for both auto-executed and explicitly
 * approved tools.
 *
 * The raw executor map lives privately inside ToolRegistry; this facade
 * receives it only as an invoker closure, so there is no public method that
 * can invoke an executor without validation.
 */

import { ArthurError, modeViolation } from "../core/errors/errors";
import type { PermissionService } from "./permissions";
import type { ToolRegistry } from "./registry";
import { ToolExecutionContext, ToolResult } from "./contracts";

export type ExecutorInvoker = (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
) => Promise<ToolResult>;

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
      throw modeViolation("Tool " + name + " is not permitted in " + ctx.mode + " mode", {
        tool: name,
        mode: ctx.mode,
        risk: definition.risk,
      });
    }
    if (decision === "approval" && (!ctx.approved || !ctx.approvalToken)) {
      throw new ArthurError("APPROVAL_REQUIRED", "Tool " + name + " requires explicit approval evidence");
    }
    if (decision === "approval" && ctx.approvalToken?.tool_name !== name) {
      throw new ArthurError("APPROVAL_INVALID", "Approval evidence does not authorize tool " + name);
    }

    return await this.invoker(name, args, ctx);
  }
}
