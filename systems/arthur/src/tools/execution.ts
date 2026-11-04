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
import { sha256Canonical } from "./canonical_json";
import { JsonSafeError, snapshotJsonSafe } from "./json_safe";
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
    // SC-02 section 31/32: ToolExecutionService is the MANDATORY final approval
    // verification gate. Authority comes ONLY from a centrally verified
    // capability (`authorization`); the deprecated `approved` boolean and any
    // caller-supplied token shape carry zero authority on their own.
    if (decision === "approval") {
      const auth = ctx.authorization;
      if (!auth) {
        throw new ArthurError("APPROVAL_REQUIRED", "Tool " + name + " requires explicit approval evidence");
      }
      if (auth.v !== 2 || auth.tool_name !== name) {
        throw new ArthurError("APPROVAL_INVALID", "Approval evidence does not authorize tool " + name);
      }
      if (auth.session_id !== ctx.session_id || auth.turn_id !== ctx.turn_id || auth.mode !== ctx.mode) {
        throw new ArthurError("APPROVAL_INVALID", "Approval evidence does not match this execution context");
      }
      if (new Date(auth.expires_at).getTime() < Date.now() || new Date(auth.issued_at).getTime() > Date.now() + 60000) {
        throw new ArthurError("APPROVAL_INVALID", "Approval evidence is expired or not yet valid");
      }
      // Legacy HMAC token, when present, must still agree on the tool binding;
      // its absence does not weaken the Ed25519 capability, and its presence
      // grants zero authority on its own (SC-02 section 34: only VerifiedApproval
      // authorizes; the HMAC stub boundary verifies signatures itself).
      if (ctx.approvalToken !== undefined && ctx.approvalToken.tool_name !== name) {
        throw new ArthurError("APPROVAL_INVALID", "Approval evidence does not authorize tool " + name);
      }
      // SC-02 section 32 final gate, checked immediately before invoker(): the
      // capability's argument digest must match the EXACT args about to execute.
      // A caller that swaps args after approval (or reuses a capability for a
      // different payload) fails closed here even if every persisted check passed.
      let liveArgsHash: string;
      try {
        liveArgsHash = sha256Canonical(args);
      } catch {
        throw new ArthurError("APPROVAL_INVALID", "Approval evidence does not cover these arguments");
      }
      if (auth.arguments_hash !== liveArgsHash) {
        throw new ArthurError("APPROVAL_INVALID", "Approval evidence does not authorize these exact arguments");
      }
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
   * 4/5; descriptor/TOCTOU hardening per the TASK-0010 follow-up): the
   * wrapper itself must be a plain data object with ordinary own enumerable
   * DATA properties (accessors, non-enumerable fields, symbol keys, unknown
   * fields, and custom prototypes are rejected - a getter is never merely
   * read and trusted), and the result is returned as a fresh validated
   * plain-data snapshot built in ONE descriptor pass. Later mutation of the
   * executor-owned object can never change what crossed the boundary.
   */
  private assertResultContract(tool: string, definition: ToolDefinition, result: unknown): ToolResult {
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw outputInvalid(tool, ["executor must return a ToolResult object"]);
    }
    const proto = Object.getPrototypeOf(result);
    if (proto !== Object.prototype && proto !== null) {
      throw outputInvalid(tool, ["ToolResult must be a plain object (custom prototypes are rejected)"]);
    }
    if (Object.getOwnPropertySymbols(result).length > 0) {
      throw outputInvalid(tool, ["ToolResult contains symbol-keyed properties"]);
    }
    // getOwnPropertyDescriptors exposes EVERY own property (including
    // non-enumerable ones), so exotic fields cannot hide behind enumerability.
    // Each accepted field value is captured here exactly once; nothing below
    // re-reads from the executor-owned object.
    const descriptors = Object.getOwnPropertyDescriptors(result) as Record<string, PropertyDescriptor>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!TOOL_RESULT_FIELDS.has(key)) {
        throw outputInvalid(tool, ["unexpected ToolResult field: " + key]);
      }
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw outputInvalid(tool, ["ToolResult." + key + " must be an ordinary data property (accessor rejected)"]);
      }
      if (!descriptor.enumerable) {
        throw outputInvalid(tool, ["ToolResult." + key + " must be an enumerable own data property (non-enumerable fields are rejected)"]);
      }
    }
    const okDescriptor = descriptors.ok;
    if (!okDescriptor) {
      throw outputInvalid(tool, ["ToolResult.ok must be an own data property"]);
    }
    const summaryDescriptor = descriptors.summary;
    if (!summaryDescriptor) {
      throw outputInvalid(tool, ["ToolResult.summary must be an own data property"]);
    }
    const ok = okDescriptor.value;
    if (typeof ok !== "boolean") {
      throw outputInvalid(tool, ["ToolResult.ok must be a boolean"]);
    }
    const summary = summaryDescriptor.value;
    if (typeof summary !== "string") {
      throw outputInvalid(tool, ["ToolResult.summary must be a string"]);
    }
    if (summary.length > TOOL_RESULT_SUMMARY_MAX_CHARS) {
      throw outputInvalid(tool, ["ToolResult.summary exceeds " + TOOL_RESULT_SUMMARY_MAX_CHARS + " characters"]);
    }

    // Snapshot the structured data in the same single pass that validates it:
    // fresh plain data, independent of the executor-owned graph. An explicit
    // own data: undefined is invalid (JSON would silently drop it), while an
    // absent data property remains valid for tools without output_schema.
    let data: unknown;
    let dataPresent = false;
    const dataDescriptor = descriptors.data;
    if (dataDescriptor) {
      try {
        data = snapshotJsonSafe(dataDescriptor.value, "ToolResult.data");
        dataPresent = true;
      } catch (err) {
        if (err instanceof JsonSafeError) {
          throw outputInvalid(tool, [err.message]);
        }
        throw err;
      }
    }

    if (definition.output_schema !== undefined) {
      if (!dataPresent) {
        throw outputInvalid(tool, ["tool declared an output_schema but returned no data"]);
      }
      // The schema validates the SNAPSHOT - the exact value that will cross.
      const output = this.registry.validateOutput(tool, data);
      if (!output.valid) {
        throw outputInvalid(tool, output.errors ?? ["data does not match output_schema"]);
      }
    }

    // Fresh plain wrapper built exclusively from validated values.
    const validated: ToolResult = { ok, summary };
    if (dataPresent) {
      validated.data = data;
    }
    return validated;
  }
}
