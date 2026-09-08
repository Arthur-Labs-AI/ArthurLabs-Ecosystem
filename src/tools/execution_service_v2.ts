/**
 * Single-attempt secured execution primitive (SC-03 sections 6, 31-43).
 *
 * This is the ONLY path to a raw executor. It keeps every pre-existing
 * security gate (tool exists, args valid, authorization valid, current
 * permissions valid, approval evidence valid, result shape valid,
 * output_schema valid, JSON-safe snapshot valid) and adds the attempt scope:
 * bounded attempt timeout, a composed AbortSignal (caller cancellation +
 * attempt timeout + overall deadline), bounded abort grace, and typed failure
 * classification that distinguishes "executor threw" from "operation outcome".
 */
import { ArthurError, modeViolation } from "../core/errors/errors";
import { sha256Canonical } from "./canonical_json";
import { JsonSafeError, snapshotJsonSafe } from "./json_safe";
import type { PermissionService } from "./permissions";
import type { ToolRegistry } from "./registry";
import type { ToolAttemptContext, ToolDefinition, ToolExecutionContext, ToolResult } from "./contracts";
import type { ToolExecutionPolicy } from "./execution_policy";
import { classifyExecutorError, type EffectOutcome, type ExecutionFailure, type ExecutionFailureKind } from "./execution_types";

export interface AttemptExecutionInput {
  name: string;
  args: Record<string, unknown>;
  ctx: ToolExecutionContext;
  attempt: ToolAttemptContext;
  policy: ToolExecutionPolicy;
  signal: AbortSignal;
  abortGraceMs: number;
}

export interface AttemptSuccess {
  ok: true;
  result: ToolResult;
}

export interface AttemptFailure {
  ok: false;
  failure: ExecutionFailure;
  effectOutcome: EffectOutcome;
  kind: ExecutionFailureKind;
}

export type AttemptOutcome = AttemptSuccess | AttemptFailure;

function outputInvalid(tool: string, reasons: string[]): ArthurError {
  return new ArthurError(
    "TOOL_OUTPUT_INVALID",
    "Tool " + tool + " returned invalid output: " + reasons.join("; "),
  );
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    const e = err as Error & { name?: string; code?: unknown };
    if (e.name === "AbortError" || e.name === "TimeoutError") return true;
    if (typeof e.code === "string" && /abort|timeout|cancel/i.test(e.code)) return true;
  }
  return false;
}

export type AttemptInvoker = (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
  attempt: ToolAttemptContext,
) => Promise<ToolResult>;

export class SingleAttemptExecutionService {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissions: PermissionService,
    private readonly invoker: AttemptInvoker,
  ) {}

  /**
   * Execute exactly one attempt. Never retries, never spawns background work,
   * never touches lifecycle tables: the coordinator owns all of that.
   */
  async executeAttempt(input: AttemptExecutionInput): Promise<AttemptOutcome> {
    const { name, args, ctx, attempt, policy, signal, abortGraceMs } = input;
    const definition = this.registry.getDefinition(name);
    if (!definition) {
      throw new ArthurError("TOOL_NOT_FOUND", "Unknown tool: " + name);
    }
    const validation = this.registry.validateArgs(name, args);
    if (!validation.valid) {
      throw new ArthurError("TOOL_ARGUMENT_INVALID", "Tool arguments invalid: " + (validation.errors ?? []).join("; "));
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
      throw new ArthurError("TOOL_PERMISSION_DENIED", "Tool " + name + " is rejected by permission policy", {
        details: { tool: name, mode: ctx.mode, risk: definition.risk },
        exposeDetails: true,
      });
    }
    if (decision === "approval") {
      // SC-02 section 32 final execution verification (NOT weakened by SC-03):
      // immediately before invoker(), the FULL gate runs INCLUDING capability
      // freshness (expires_at/issued_at vs now). The race fix lives in the DB
      // CAS layer (consume + claimAttempt require expires_at > now on the same
      // persisted timestamps), never by skipping this check: an expired
      // authorization fails closed here even if the pre-dispatch CAS passed
      // long ago (long retry_wait backoff crossing expiry, suspended runtime).
      this.assertApprovalEvidence(name, args, ctx);
    }
    if (signal.aborted) {
      return {
        ok: false,
        failure: { kind: "cancelled", effect_outcome: "not_applied", retry_hint: false, code: "TOOL_CANCELLED", summary: "attempt aborted before dispatch" },
        effectOutcome: "not_applied",
        kind: "cancelled",
      };
    }

    let raw: ToolResult | undefined;
    try {
      const invocation = Promise.resolve().then(() => {
        const executor = this.executorFor(name);
        return executor(args, ctx, attempt);
      });
      raw = await this.raceWithSignal(invocation, signal, abortGraceMs, policy.effects);
    } catch (err) {
      if (err instanceof ArthurError && (err.code === "TOOL_TIMEOUT" || err.code === "TOOL_CANCELLED" || err.code === "TOOL_OUTCOME_UNKNOWN")) {
        const kind: ExecutionFailureKind = err.code === "TOOL_TIMEOUT" ? "timeout" : err.code === "TOOL_CANCELLED" ? "cancelled" : "timeout";
        const effect: EffectOutcome = policy.effects === "mutation" ? "unknown" : "not_applied";
        return { ok: false, failure: { kind, effect_outcome: effect, retry_hint: false, code: err.code, summary: err.message }, effectOutcome: effect, kind };
      }
      const failure = classifyExecutorError(err, policy.effects);
      if (err instanceof ArthurError) {
        failure.code = err.code;
        failure.summary = err.message.length > 500 ? err.message.slice(0, 500) + "\u2026(truncated)" : err.message;
      }
      return { ok: false, failure, effectOutcome: failure.effect_outcome, kind: failure.kind };
    }

    // Output validation AFTER the (possible) side effect: for mutations a
    // malformed result is uncertainty, never a plain FAILED (SC-03 31).
    try {
      const validated = this.assertResultContract(name, definition, raw);
      return { ok: true, result: validated };
    } catch (err) {
      if (policy.effects === "mutation") {
        const summary = err instanceof Error ? err.message : "tool returned invalid output";
        const failure: ExecutionFailure = {
          kind: "output_invalid",
          effect_outcome: "unknown",
          retry_hint: false,
          code: "TOOL_OUTPUT_INVALID",
          summary: summary.length > 500 ? summary.slice(0, 500) + "\u2026(truncated)" : summary,
        };
        return { ok: false, failure, effectOutcome: "unknown", kind: "output_invalid" };
      }
      const summary = err instanceof Error ? err.message : "tool returned invalid output";
      const failure: ExecutionFailure = {
        kind: "output_invalid",
        effect_outcome: "not_applied",
        retry_hint: false,
        code: "TOOL_OUTPUT_INVALID",
        summary: summary.length > 500 ? summary.slice(0, 500) + "\u2026(truncated)" : summary,
      };
      return { ok: false, failure, effectOutcome: "not_applied", kind: "output_invalid" };
    }
  }

  private executorFor(_name: string): (args: Record<string, unknown>, ctx: ToolExecutionContext, attempt?: ToolAttemptContext) => Promise<ToolResult> | ToolResult {
    return (args, ctx, attempt) => this.invoker(_name, args, ctx, attempt as ToolAttemptContext);
  }

  private assertApprovalEvidence(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): void {
    const auth = ctx.authorization;
    if (!auth) throw new ArthurError("APPROVAL_REQUIRED", "Tool " + name + " requires explicit approval evidence");
    if (auth.v !== 2 || auth.tool_name !== name) {
      throw new ArthurError("APPROVAL_INVALID", "Approval evidence does not authorize tool " + name);
    }
    if (auth.session_id !== ctx.session_id || auth.turn_id !== ctx.turn_id || auth.mode !== ctx.mode) {
      throw new ArthurError("APPROVAL_INVALID", "Approval evidence does not match this execution context");
    }
    // SC-02 sections 32/40 freshness: capability expiry + issued-at validity
    // enforced at the final gate, immediately before invoker(). Malformed
    // timestamps fail closed (NaN comparisons never pass).
    const nowMs = Date.now();
    if (!(new Date(auth.expires_at).getTime() > nowMs)) {
      throw new ArthurError("APPROVAL_INVALID", "Approval evidence is expired");
    }
    if (!(new Date(auth.issued_at).getTime() <= nowMs + 60000)) {
      throw new ArthurError("APPROVAL_INVALID", "Approval evidence is not yet valid");
    }
    if (ctx.approvalToken !== undefined && ctx.approvalToken.tool_name !== name) {
      throw new ArthurError("APPROVAL_INVALID", "Approval evidence does not authorize tool " + name);
    }
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

  private async raceWithSignal(
    work: Promise<ToolResult>,
    signal: AbortSignal,
    graceMs: number,
    effects: ToolExecutionPolicy["effects"],
  ): Promise<ToolResult> {
    if (signal.aborted) {
      throw new ArthurError("TOOL_CANCELLED", "Tool execution was cancelled before dispatch");
    }
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = (): void => {
        // Bounded grace: give a cooperative executor graceMs to settle, then
        // fail closed. Mutations become uncertainty, never silent success.
        // Not unref'd (same reason as the attempt timeout): the grace must
        // elapse even on an otherwise-idle loop; the bound keeps it finite.
        // SC-03 section 42: attempt-timeout abort is TIMEOUT (retryable for
        // side-effect-free), user cancellation is CANCELLED. The coordinator
        // aborts with distinct reasons; inspect signal.reason to tell them apart.
        setTimeout(() => {
          const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "");
          const userCancel = /user cancellation|user_cancel|cancel_requested/i.test(reason);
          if (userCancel) {
            if (effects === "mutation") {
              reject(new ArthurError("TOOL_OUTCOME_UNKNOWN", "Tool execution cancelled with uncertain side effects"));
            } else {
              reject(new ArthurError("TOOL_CANCELLED", "Tool execution was cancelled"));
            }
          } else if (effects === "mutation") {
            reject(new ArthurError("TOOL_OUTCOME_UNKNOWN", "Tool execution aborted with uncertain side effects"));
          } else {
            reject(new ArthurError("TOOL_TIMEOUT", "Tool execution timed out"));
          }
        }, Math.max(0, graceMs));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([work, abortPromise]);
    } catch (err) {
      if (isAbortError(err) && !signal.aborted) throw err;
      if (signal.aborted && isAbortError(err)) {
        if (effects === "mutation") throw new ArthurError("TOOL_OUTCOME_UNKNOWN", "Tool execution aborted with uncertain side effects");
        throw new ArthurError("TOOL_CANCELLED", "Tool execution was cancelled");
      }
      throw err;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      // Prevent an unsettled executor promise from becoming an unhandled
      // rejection after we already resolved via abort/timeout.
      work.then(undefined, () => undefined);
    }
  }

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
    const FIELDS = new Set(["ok", "summary", "data"]);
    const descriptors = Object.getOwnPropertyDescriptors(result) as Record<string, PropertyDescriptor>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!FIELDS.has(key)) throw outputInvalid(tool, ["unexpected ToolResult field: " + key]);
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw outputInvalid(tool, ["ToolResult." + key + " must be an ordinary data property (accessor rejected)"]);
      }
      if (!descriptor.enumerable) {
        throw outputInvalid(tool, ["ToolResult." + key + " must be an enumerable own data property (non-enumerable fields are rejected)"]);
      }
    }
    const okDescriptor = descriptors.ok;
    if (!okDescriptor) throw outputInvalid(tool, ["ToolResult.ok must be an own data property"]);
    const summaryDescriptor = descriptors.summary;
    if (!summaryDescriptor) throw outputInvalid(tool, ["ToolResult.summary must be an own data property"]);
    const ok = okDescriptor.value;
    if (typeof ok !== "boolean") throw outputInvalid(tool, ["ToolResult.ok must be a boolean"]);
    const summary = summaryDescriptor.value;
    if (typeof summary !== "string") throw outputInvalid(tool, ["ToolResult.summary must be a string"]);
    if (summary.length > 2000) throw outputInvalid(tool, ["ToolResult.summary exceeds 2000 characters"]);
    let data: unknown;
    let dataPresent = false;
    const dataDescriptor = descriptors.data;
    if (dataDescriptor) {
      try {
        data = snapshotJsonSafe(dataDescriptor.value, "ToolResult.data");
        dataPresent = true;
      } catch (err) {
        if (err instanceof JsonSafeError) throw outputInvalid(tool, [err.message]);
        throw err;
      }
    }
    if (definition.output_schema !== undefined) {
      if (!dataPresent) throw outputInvalid(tool, ["tool declared an output_schema but returned no data"]);
      const output = this.registry.validateOutput(tool, data);
      if (!output.valid) throw outputInvalid(tool, output.errors ?? ["data does not match output_schema"]);
    }
    const validated: ToolResult = { ok, summary };
    if (dataPresent) validated.data = data;
    return validated;
  }
}
