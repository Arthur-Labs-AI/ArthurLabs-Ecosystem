/**
 * TASK-0010 regression: explicit ToolResult.data = undefined must fail closed.
 * JSON.stringify silently drops undefined object properties, so an executor
 * must omit `data` entirely when it has no structured payload.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurError } from "../../src/core/errors/errors";
import { ArthurMode } from "../../src/core/modes/mode";
import type { ToolExecutionContext, ToolResult } from "../../src/tools/contracts";
import { PermissionService } from "../../src/tools/permissions";
import { ToolRegistry } from "../../src/tools/registry";

function context(): ToolExecutionContext {
  return {
    session_id: "s",
    turn_id: "t",
    trace_id: "tr",
    mode: ArthurMode.PERSONAL,
    approved: false,
  };
}

function register(registry: ToolRegistry, executor: () => ToolResult): void {
  registry.register(
    {
      name: "boundary.undefined_data",
      version: "1.0.0",
      description: "Regression tool for explicit undefined ToolResult data.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL],
    },
    executor,
  );
}

test("explicit ToolResult.data undefined fails closed", async () => {
  const registry = new ToolRegistry();
  register(
    registry,
    () => ({ ok: true, summary: "done", data: undefined }) as unknown as ToolResult,
  );
  const execution = registry.createExecutionService(new PermissionService());

  await assert.rejects(
    () => execution.execute("boundary.undefined_data", {}, context()),
    (err: unknown) => {
      assert.ok(err instanceof ArthurError);
      assert.equal(err.code, "TOOL_OUTPUT_INVALID");
      assert.match(err.message, /undefined|JSON-safe/);
      return true;
    },
  );
});

test("omitting ToolResult.data remains valid when output_schema is absent", async () => {
  const registry = new ToolRegistry();
  register(registry, () => ({ ok: true, summary: "done" }));
  const execution = registry.createExecutionService(new PermissionService());

  const result = await execution.execute("boundary.undefined_data", {}, context());
  assert.deepEqual(result, { ok: true, summary: "done" });
  assert.equal(Object.prototype.hasOwnProperty.call(result, "data"), false);
});
