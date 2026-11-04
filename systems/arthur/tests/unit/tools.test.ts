import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurMode } from "../../src/core/modes/mode";
import { ToolRegistry, toToolSchema } from "../../src/tools/registry";
import { PermissionService, canonicalizeArgs } from "../../src/tools/permissions";
import type { ToolDefinition } from "../../src/tools/contracts";

function def(partial: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "test.tool",
    version: "1.0.0",
    description: "a test tool",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    risk: "read",
    allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    ...partial,
  };
}

test("registry lookup returns definition and validates args against JSON schema", () => {
  const registry = new ToolRegistry();
  registry.register(def(), async (args) => ({ ok: true, summary: String(args.text), data: args }));

  assert.ok(registry.getDefinition("test.tool"));
  assert.equal(registry.getDefinition("missing"), undefined);

  assert.equal(registry.validateArgs("test.tool", { text: "hi" }).valid, true);
  const invalid = registry.validateArgs("test.tool", { text: 123 });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors && invalid.errors.length > 0);

  assert.equal(registry.validateArgs("missing", {}).valid, false);
});

test("registry lists tools allowed for a mode", () => {
  const registry = new ToolRegistry();
  registry.register(def({ name: "both.modes" }), async () => ({ ok: true, summary: "" }));
  registry.register(
    def({ name: "business.only", allowed_modes: [ArthurMode.BUSINESS] }),
    async () => ({ ok: true, summary: "" }),
  );

  const personal = registry.listAllowedForMode(ArthurMode.PERSONAL).map((d) => d.name);
  assert.deepEqual(personal, ["both.modes"]);
  const business = registry.listAllowedForMode(ArthurMode.BUSINESS).map((d) => d.name);
  assert.deepEqual(business, ["both.modes", "business.only"]);
});

test("permission service maps risk to decisions", () => {
  const permissions = new PermissionService();
  assert.equal(permissions.evaluate(def({ risk: "read" }), ArthurMode.PERSONAL), "auto");
  assert.equal(permissions.evaluate(def({ risk: "low_write" }), ArthurMode.BUSINESS), "auto");
  assert.equal(permissions.evaluate(def({ risk: "approval_required" }), ArthurMode.BUSINESS), "approval");
  assert.equal(permissions.evaluate(def({ risk: "high_risk" }), ArthurMode.BUSINESS), "reject");
  // mode gating
  assert.equal(
    permissions.evaluate(def({ allowed_modes: [ArthurMode.BUSINESS] }), ArthurMode.PERSONAL),
    "reject",
  );
});

test("canonicalizeArgs is key-order independent", () => {
  const a = canonicalizeArgs({ b: 1, a: { y: 2, x: 3 } });
  const b = canonicalizeArgs({ a: { x: 3, y: 2 }, b: 1 });
  assert.equal(a, b);
  const c = canonicalizeArgs({ a: 1, b: 2 });
  assert.notEqual(a, c);
});

test("toToolSchema maps definition into model schema", () => {
  const schema = toToolSchema(def({ name: "system.echo" }));
  assert.equal(schema.name, "system.echo");
  assert.equal(typeof schema.description, "string");
  assert.deepEqual(schema.parameters, def().input_schema);
});
