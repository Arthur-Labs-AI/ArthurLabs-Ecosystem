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
  private readonly ajv = new Ajv({ allErrors: true, strict: false });

  register(definition: ToolDefinition, executor: ToolExecutor): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    const immutable = deepFreeze(structuredClone(definition));
    const validator = this.ajv.compile(immutable.input_schema);
    this.tools.set(immutable.name, { definition: immutable, executor, validator });
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