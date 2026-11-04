/**
 * TASK-0010 manifest validation tests (task sections 2/7/8/15 A-H, Q, R, S).
 * A malformed tool must fail registration deterministically and never appear
 * in the registry (therefore never in the model tool schemas).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurError } from "../../src/core/errors/errors";
import { ArthurMode } from "../../src/core/modes/mode";
import {
  MAX_TOOL_DESCRIPTION_CHARS,
  MAX_TOOL_NAME_CHARS,
  TOOL_NAME_PATTERN,
  TOOL_VERSION_PATTERN,
} from "../../src/tools/manifest";
import { ToolRegistry, toToolSchema } from "../../src/tools/registry";
import type { ToolDefinition, ToolExecutor } from "../../src/tools/contracts";

function def(partial: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "test.contract",
    version: "1.0.0",
    description: "a deterministic contract tool",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
    allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    ...partial,
  };
}

const noopExecutor: ToolExecutor = async () => ({ ok: true, summary: "ok" });

function assertRejected(partial: Partial<ToolDefinition>, field: string): void {
  const registry = new ToolRegistry();
  try {
    assert.throws(
      () => registry.register(def(partial), noopExecutor),
      (err: unknown) => {
        if (!(err instanceof ArthurError)) return false;
        assert.equal(err.code, "INVALID_CONFIG");
        assert.ok(err.message.includes(field), `message "${err.message}" should mention field "${field}"`);
        return true;
      },
    );
  } finally {
    // A rejected tool must never have entered the registry.
    const name = (partial.name as string) ?? "test.contract";
    assert.equal(registry.has(name), false, "malformed tool must not be registered");
  }
}

// ---- A: valid definition registers --------------------------------------

test("A: a valid definition registers and is listed", () => {
  const registry = new ToolRegistry();
  registry.register(def(), noopExecutor);
  assert.equal(registry.has("test.contract"), true);
  assert.ok(registry.getDefinition("test.contract"));
  assert.deepEqual(registry.list().map((d) => d.name), ["test.contract"]);
  assert.deepEqual(
    registry.listAllowedForMode(ArthurMode.BUSINESS).map((d) => d.name),
    ["test.contract"],
  );
});

// ---- B: malformed tool name rejected -------------------------------------

test("B: malformed tool names are rejected at registration", () => {
  assert.equal(TOOL_NAME_PATTERN.test("system.echo"), true);
  const badNames = [
    "system", // not dotted
    "System.Echo", // uppercase
    "system.Echo", // uppercase segment
    "1system.echo", // leading digit
    "system..echo", // empty segment
    "system.echo.", // trailing dot
    ".system.echo", // leading dot
    "system echo", // space
    "system\techo", // tab
    "system;echo", // shell syntax
    "system|echo", // shell syntax
    "system$(echo)", // shell syntax
    "system.`echo`", // shell syntax
    "system.echo-x", // hyphen is not part of the canonical grammar
    "system.ech\u00f6", // non-ascii identifier
    "system.echo!",
    "",
    "a".repeat(MAX_TOOL_NAME_CHARS + 1),
  ];
  for (const name of badNames) {
    assertRejected({ name }, "name");
  }
});

// ---- C: invalid semantic version rejected --------------------------------

test("C: invalid versions are rejected, never normalized", () => {
  assert.equal(TOOL_VERSION_PATTERN.test("1.0.0"), true);
  const badVersions = [
    "1", // used to register before TASK-0010
    "1.0",
    "1.0.0.0",
    "v1.0.0",
    "01.0.0", // zero padding
    "1.0.0-beta", // prerelease tags are not part of the stable format
    "1.0.0+build",
    "latest",
    "",
    1 as unknown as string,
  ];
  for (const version of badVersions) {
    assertRejected({ version: version as string }, "version");
  }
});

// ---- D: empty/oversized description rejected ------------------------------

test("D: empty and oversized descriptions are rejected", () => {
  assertRejected({ description: "" }, "description");
  assertRejected({ description: "    " }, "description");
  assertRejected({ description: undefined as unknown as string }, "description");
  assertRejected(
    { description: "x".repeat(MAX_TOOL_DESCRIPTION_CHARS + 1) },
    "description",
  );
  // At the bound the description is still accepted.
  const registry = new ToolRegistry();
  registry.register(def({ description: "x".repeat(MAX_TOOL_DESCRIPTION_CHARS) }), noopExecutor);
  assert.equal(registry.has("test.contract"), true);
});

// ---- E: invalid input schema rejected -------------------------------------

test("E: invalid input schemas fail registration", () => {
  const badSchemas: unknown[] = [
    42,
    "object",
    null,
    [],
    { type: "strng" }, // unknown type name
    { type: "object", required: "text" }, // wrong keyword value type (strict AJV)
    { type: "object", additonalProperties: false }, // unknown keyword (strict AJV)
    { type: "object", properties: { a: () => null } }, // function is not JSON-safe
  ];
  for (const schema of badSchemas) {
    assertRejected({ input_schema: schema as ToolDefinition["input_schema"] }, "input_schema");
  }
  // Cyclic schema.
  const cyclic: Record<string, unknown> = { type: "object" };
  cyclic.self = cyclic;
  assertRejected({ input_schema: cyclic as unknown as ToolDefinition["input_schema"] }, "input_schema");
});

// ---- F: invalid output schema rejected ------------------------------------

test("F: invalid output schemas fail registration", () => {
  const badSchemas: unknown[] = [
    7,
    "nope",
    { type: "integar" },
    { type: "object", requird: ["a"] },
  ];
  for (const schema of badSchemas) {
    assertRejected({ output_schema: schema as ToolDefinition["output_schema"] }, "output_schema");
  }
  const cyclic: Record<string, unknown> = { type: "object" };
  cyclic.self = cyclic;
  assertRejected({ output_schema: cyclic as unknown as ToolDefinition["output_schema"] }, "output_schema");
});

// ---- G: empty/duplicate/invalid modes rejected ----------------------------

test("G: allowed_modes must be a non-empty duplicate-free set of valid modes", () => {
  assertRejected({ allowed_modes: [] }, "allowed_modes");
  assertRejected(
    { allowed_modes: [ArthurMode.PERSONAL, ArthurMode.PERSONAL] },
    "allowed_modes",
  );
  assertRejected(
    { allowed_modes: ["omnipotent" as ArthurMode] },
    "allowed_modes",
  );
  assertRejected({ allowed_modes: "personal" as unknown as ArthurMode[] }, "allowed_modes");
  assertRejected({ allowed_modes: [undefined as unknown as ArthurMode] }, "allowed_modes");
});

// ---- invalid risk / unknown fields / duplicate registration ---------------

test("invalid risk and unknown manifest fields are rejected", () => {
  assertRejected({ risk: "dangerous" as ToolDefinition["risk"] }, "risk");
  assertRejected({ risk: undefined as unknown as ToolDefinition["risk"] }, "risk");
  assertRejected({ extra_field: true } as Partial<ToolDefinition>, "extra_field");
  assertRejected({ name: undefined } as Partial<ToolDefinition>, "name");
});

test("H: duplicate tool registration fails deterministically", () => {
  const registry = new ToolRegistry();
  registry.register(def(), noopExecutor);
  assert.throws(
    () => registry.register(def(), noopExecutor),
    (err: unknown) => err instanceof ArthurError && err.code === "INVALID_CONFIG",
  );
  assert.equal(registry.list().length, 1);
});

test("registration rejects a non-object definition", () => {
  const registry = new ToolRegistry();
  assert.throws(
    () => registry.register(null as unknown as ToolDefinition, noopExecutor),
    (err: unknown) => err instanceof ArthurError && err.code === "INVALID_CONFIG",
  );
});

// ---- R/S: definition immutability -----------------------------------------

test("R: mutating the caller object after registration has no effect", () => {
  const registry = new ToolRegistry();
  const definition = def({
    name: "mutable.caller",
    input_schema: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
    output_schema: { type: "object", properties: { b: { type: "number" } }, additionalProperties: false },
  });
  registry.register(definition, noopExecutor);

  definition.description = "tampered";
  definition.version = "9.9.9";
  definition.risk = "high_risk";
  definition.allowed_modes.length = 0;
  (definition.input_schema as { properties: unknown }).properties = { hacked: { type: "string" } };
  (definition.output_schema as { properties: unknown }).properties = { hacked: { type: "number" } };

  const stored = registry.getDefinition("mutable.caller");
  assert.ok(stored);
  assert.equal(stored.description, "a deterministic contract tool");
  assert.equal(stored.version, "1.0.0");
  assert.equal(stored.risk, "read");
  assert.deepEqual(stored.allowed_modes, [ArthurMode.PERSONAL, ArthurMode.BUSINESS]);
  assert.deepEqual((stored.input_schema as { properties: unknown }).properties, { a: { type: "string" } });
  assert.deepEqual((stored.output_schema as { properties: unknown }).properties, { b: { type: "number" } });
  // Runtime validation still uses the registered schema, not the caller object.
  assert.equal(registry.validateArgs("mutable.caller", { a: "ok" }).valid, true);
  assert.equal(registry.validateArgs("mutable.caller", { hacked: "x" }).valid, false);
});

test("S: registry-returned definitions are frozen and cannot mutate runtime policy", () => {
  const registry = new ToolRegistry();
  registry.register(
    def({ name: "frozen.tool", output_schema: { type: "object", properties: {} } }),
    noopExecutor,
  );
  const stored = registry.getDefinition("frozen.tool");
  assert.ok(stored);
  assert.ok(Object.isFrozen(stored));
  assert.ok(Object.isFrozen(stored.input_schema));
  assert.ok(Object.isFrozen(stored.output_schema));
  assert.ok(Object.isFrozen(stored.allowed_modes));
  assert.ok(Object.isFrozen(toToolSchema(stored).parameters));
  assert.throws(() => {
    (stored as { risk: string }).risk = "high_risk";
  });
  assert.throws(() => {
    (stored.allowed_modes as ArthurMode[]).push(ArthurMode.BUSINESS);
  });
  assert.throws(() => {
    (stored.input_schema as { type: string }).type = "string";
  });
  // The registry still returns the original policy.
  assert.equal(registry.getDefinition("frozen.tool")?.risk, "read");
  for (const listed of registry.list()) {
    assert.ok(Object.isFrozen(listed));
  }
});

// ---- Q: raw executors stay private ----------------------------------------

test("Q: the public registry API never exposes a raw executor", () => {
  const registry = new ToolRegistry();
  registry.register(def({ name: "private.executor" }), noopExecutor);
  const methodNames = Object.getOwnPropertyNames(ToolRegistry.prototype);
  for (const forbidden of ["runExecutor", "execute", "invoke", "getExecutor", "callExecutor"]) {
    assert.equal(methodNames.includes(forbidden), false, `unexpected registry method ${forbidden}`);
  }
  const stored = registry.getDefinition("private.executor");
  assert.ok(stored);
  assert.equal("executor" in stored, false);
  for (const listed of registry.list()) {
    assert.equal("executor" in listed, false);
  }
  // JSON round-trip of model-facing schema carries no executable surface.
  const schema = toToolSchema(stored);
  assert.deepEqual(Object.keys(schema).sort(), ["description", "name", "parameters"]);
});
