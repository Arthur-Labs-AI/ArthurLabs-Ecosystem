/**
 * Tool registry (spec section 10; audit MEDIUM 7).
 *
 * Holds tool definitions plus their raw executors and performs JSON-schema
 * argument validation. The raw executor map is private and reachable only
 * through `createExecutionService`, which hands the single secured execution
 * facade an invoker closure. The registry is never exposed on the composition
 * root, so there is no public path that runs an executor without validation
 * and permission checks.
 */

import Ajv, { ErrorObject, ValidateFunction } from "ajv";

import { ArthurError } from "../core/errors/errors";
import type { ArthurMode } from "../core/modes/mode";
import type { ToolSchema } from "../models/contracts";
import { ToolDefinition, ToolExecutor } from "./contracts";
import { ToolExecutionService, type ExecutorInvoker } from "./execution";
import { toolManifestInvalid, validateToolDefinition } from "./manifest";
import type { PermissionService } from "./permissions";

/** Convert a tool definition into the schema shape handed to the model. */
export function toToolSchema(definition: ToolDefinition): ToolSchema {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.input_schema,
  };
}

interface RegisteredTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
  validator: ValidateFunction;
  outputValidator?: ValidateFunction;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  /**
   * Schema compiler (TASK-0010). Strict mode rejects malformed schemas
   * (unknown keywords, wrong keyword value types, invalid type names) at
   * registration time, so an invalid tool can never enter the registry and
   * therefore never reach the model tool schemas. The compiled validators are
   * reused for runtime argument/output validation; strict COMPILATION never
   * changes what an accepted schema matches at validation time.
   */
  private readonly ajv = new Ajv({ allErrors: true, strict: true });

  /**
   * Register a tool. The manifest is validated as a whole first (TASK-0010
   * sections 2/8): malformed name/version/description/modes/risk or
   * uncompilable schemas fail deterministically with INVALID_CONFIG and the
   * tool is never stored. The stored definition is a deep-frozen clone, so
   * later mutation of the caller's object or of the returned definition can
   * never alter runtime policy.
   */
  register(definition: ToolDefinition, executor: ToolExecutor): void {
    validateToolDefinition(definition);
    if (this.tools.has(definition.name)) {
      throw toolManifestInvalid("name", "tool already registered: " + definition.name);
    }
    const immutable = deepFreeze(structuredClone(definition));
    const validator = this.compileSchema("input_schema", immutable.input_schema);
    const outputValidator = immutable.output_schema
      ? this.compileSchema("output_schema", immutable.output_schema)
      : undefined;
    this.tools.set(immutable.name, { definition: immutable, executor, validator, outputValidator });
  }

  private compileSchema(field: "input_schema" | "output_schema", schema: Record<string, unknown>): ValidateFunction {
    try {
      return this.ajv.compile(schema);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "schema does not compile with AJV";
      throw toolManifestInvalid(field, reason);
    }
  }

  getDefinition(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  listAllowedForMode(mode: ArthurMode): ToolDefinition[] {
    return this.list().filter((d) => d.allowed_modes.includes(mode));
  }

  /** JSON-schema argument validation (spec section 10, 18). */
  validateArgs(name: string, args: unknown): { valid: boolean; errors?: string[] } {
    const tool = this.tools.get(name);
    if (!tool) {
      return { valid: false, errors: ["unknown tool"] };
    }
    const valid = tool.validator(args);
    if (valid) return { valid: true };
    const errors = (tool.validator.errors ?? []).map((e: ErrorObject) => e.message ?? "invalid argument");
    return { valid: false, errors };
  }

  /**
   * JSON-schema validation of executor output data against the tool's declared
   * output_schema (TASK-0010 section 4). Tools without an output_schema always
   * pass here; the ToolResult shape/JSON-safety contract is enforced by the
   * execution facade. This is a validator only - it never exposes executors.
   */
  validateOutput(name: string, data: unknown): { valid: boolean; errors?: string[] } {
    const tool = this.tools.get(name);
    if (!tool) {
      return { valid: false, errors: ["unknown tool"] };
    }
    if (!tool.outputValidator) {
      return { valid: true };
    }
    const valid = tool.outputValidator(data);
    if (valid) return { valid: true };
    const errors = (tool.outputValidator.errors ?? []).map(
      (e: ErrorObject) => ((e.instancePath || "(root)") + " " + (e.message ?? "invalid output")).trim(),
    );
    return { valid: false, errors };
  }

  /**
   * Build the single secured execution facade bound to this registry's private
   * executor map. The raw executors are reachable only through the returned
   * facade, which always re-validates arguments and re-checks permissions
   * (audit MEDIUM 7).
   */
  createExecutionService(permissions: PermissionService): ToolExecutionService {
    const invoker: ExecutorInvoker = async (name, args, ctx) => {
      const tool = this.tools.get(name);
      if (!tool) {
        throw new ArthurError("TOOL_NOT_FOUND", "Unknown tool: " + name);
      }
      return await tool.executor(args, ctx);
    };
    return new ToolExecutionService(this, permissions, invoker);
  }
}