/**
 * TASK-0010 input/output boundary tests (task sections 3/4/5/6/15 I-O).
 * Everything goes through the single secured execution facade.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurError } from "../../src/core/errors/errors";
import { ArthurMode } from "../../src/core/modes/mode";
import { TOOL_RESULT_SUMMARY_MAX_CHARS } from "../../src/tools/execution";
import { PermissionService } from "../../src/tools/permissions";
import { ToolRegistry } from "../../src/tools/registry";
import type { ToolDefinition, ToolExecutionContext, ToolExecutor, ToolResult } from "../../src/tools/contracts";

function ctx(mode: ArthurMode = ArthurMode.PERSONAL, approved = false): ToolExecutionContext {
  return { session_id: "s", turn_id: "t", trace_id: "tr", mode, approved };
}

interface Harness {
  registry: ToolRegistry;
  calls: { name: string; args: Record<string, unknown> }[];
  execution: { execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> };
}

function makeHarness(executor: ToolExecutor, definition: Partial<ToolDefinition> = {}, presenter?: (args: Record<string, unknown>) => { action: string; details: Array<{ label: string; value: string }> }): Harness {
  const registry = new ToolRegistry();
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const full = def({
    name: "spy.read",
    description: "records invocations",
    input_schema: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
      additionalProperties: false,
    },
    ...definition,
  });
  if (full.risk === "approval_required") {
    registry.register(full, presenter ?? (() => ({ action: "Test action", details: [] })), (args, c) => {
      calls.push({ name: c.mode === undefined ? "spy.read" : "spy.read", args });
      return executor(args, c);
    });
  } else {
  registry.register(
    def({
      name: "spy.read",
      description: "records invocations",
      input_schema: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
        additionalProperties: false,
      },
      ...definition,
    }),
    (args, c) => {
      calls.push({ name: c.mode === undefined ? "spy.read" : "spy.read", args });
      return executor(args, c);
    },
  );
  }
  const execution = registry.createExecutionService(new PermissionService());
  return { registry, calls, execution };
}

function def(partial: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "placeholder.name",
    version: "1.0.0",
    description: "placeholder description",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
    allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    ...partial,
  };
}

function assertCode(err: unknown, code: string): ArthurError {
  assert.ok(err instanceof ArthurError, "expected an ArthurError");
  assert.equal((err as ArthurError).code, code);
  return err as ArthurError;
}

// ---- I/J/K: input boundary -------------------------------------------------

test("I: valid args execute through the secured facade", async () => {
  const h = makeHarness((args) => ({ ok: true, summary: String(args.q), data: { q: args.q } }));
  const result = await h.execution.execute("spy.read", { q: "hello" }, ctx());
  assert.equal(result.ok, true);
  assert.equal(result.summary, "hello");
  assert.deepEqual(result.data, { q: "hello" });
  assert.equal(h.calls.length, 1);
});

test("J: invalid args never reach the executor", async () => {
  const h = makeHarness(() => ({ ok: true, summary: "ran" }));
  for (const badArgs of [{ q: 42 }, { wrong: "shape" }, {}, { q: "ok", extra: 1 }]) {
    await assert.rejects(
      () => h.execution.execute("spy.read", badArgs, ctx()),
      (err: unknown) => assertCode(err, "TOOL_ARGUMENT_INVALID") !== undefined,
    );
  }
  assert.equal(h.calls.length, 0, "executor must never run on invalid arguments");
});

test("K: unknown tool never reaches any executor", async () => {
  const h = makeHarness(() => ({ ok: true, summary: "ran" }));
  await assert.rejects(
    () => h.execution.execute("ghost.tool", {}, ctx()),
    (err: unknown) => assertCode(err, "TOOL_NOT_FOUND") !== undefined,
  );
  assert.equal(h.calls.length, 0);
});

// ---- L/M: output schema boundary -------------------------------------------

const GIT_STATUS_LIKE_SCHEMA = {
  type: "object",
  properties: {
    branch: { type: "string" },
    clean: { type: "boolean" },
    staged: { type: "array", items: { type: "string" } },
    unstaged: { type: "array", items: { type: "string" } },
    untracked: { type: "array", items: { type: "string" } },
  },
  required: ["branch", "clean", "staged", "unstaged", "untracked"],
  additionalProperties: false,
};

function statusTool(returnValue: unknown): Harness {
  return makeHarness(
    () => returnValue as ToolResult,
    { name: "future.git.status", description: "shape of the future git.status contract", output_schema: GIT_STATUS_LIKE_SCHEMA },
  );
}

test("L: valid output matching output_schema passes the boundary", async () => {
  const h = statusTool({
    ok: true,
    summary: "on main",
    data: { branch: "main", clean: true, staged: [], unstaged: [], untracked: [] },
  });
  const result = await h.execution.execute("future.git.status", { q: "x" }, ctx());
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { branch: "main", clean: true, staged: [], unstaged: [], untracked: [] });
});

test("M: malformed executor output fails with TOOL_OUTPUT_INVALID", async () => {
  const badOutputs: { title: string; result: unknown }[] = [
    { title: "branch is a number", result: { ok: true, summary: "s", data: { branch: 123, clean: true, staged: [], unstaged: [], untracked: [] } } },
    { title: "missing required field", result: { ok: true, summary: "s", data: { branch: "main" } } },
    { title: "unknown data field", result: { ok: true, summary: "s", data: { branch: "main", clean: true, staged: [], unstaged: [], untracked: [], extra: 1 } } },
    { title: "data is a string", result: { ok: true, summary: "s", data: "main" } },
    { title: "no data at all", result: { ok: true, summary: "s" } },
    { title: "ok is not boolean", result: { ok: "yes", summary: "s", data: { branch: "main", clean: true, staged: [], unstaged: [], untracked: [] } } },
    { title: "summary missing", result: { ok: true, data: { branch: "main", clean: true, staged: [], unstaged: [], untracked: [] } } },
    { title: "summary oversized", result: { ok: true, summary: "x".repeat(TOOL_RESULT_SUMMARY_MAX_CHARS + 1), data: { branch: "main", clean: true, staged: [], unstaged: [], untracked: [] } } },
    { title: "extra ToolResult field", result: { ok: true, summary: "s", stack: "sensitive", data: { branch: "main", clean: true, staged: [], unstaged: [], untracked: [] } } },
    { title: "result is not an object", result: "fine" },
  ];
  for (const c of badOutputs) {
    const h = statusTool(c.result);
    await assert.rejects(
      () => h.execution.execute("future.git.status", { q: "x" }, ctx()),
      (err: unknown) => {
        assertCode(err, "TOOL_OUTPUT_INVALID");
        return true;
      },
      c.title + " must fail closed",
    );
  }
});

test("output_schema is optional: untyped tools keep working", async () => {
  const h = makeHarness(() => ({ ok: true, summary: "s", data: { anything: [1, 2, 3] } }));
  const result = await h.execution.execute("spy.read", { q: "x" }, ctx());
  assert.deepEqual(result.data, { anything: [1, 2, 3] });
});

// ---- O: JSON-safety fail-closed ---------------------------------------------

test("O: cyclic and non-JSON-safe data fail closed", async () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const cases: { title: string; data: unknown }[] = [
    { title: "cyclic object", data: cyclic },
    { title: "function value", data: { fn: () => "leak" } },
    { title: "Date instance", data: { at: new Date(0) } },
    { title: "Map instance", data: { m: new Map() } },
    { title: "Set instance", data: { s: new Set([1]) } },
    { title: "RegExp instance", data: { r: /x/ } },
    { title: "BigInt value", data: { b: BigInt(1) } },
    { title: "undefined property", data: { u: undefined } },
    { title: "undefined array element", data: { arr: [1, undefined, 2] } },
    { title: "NaN", data: { n: Number.NaN } },
    { title: "Infinity", data: { n: Number.POSITIVE_INFINITY } },
    { title: "symbol value", data: { s: Symbol("sym") } },
  ];
  for (const c of cases) {
    const h = makeHarness(() => ({ ok: true, summary: "s", data: c.data } as unknown as ToolResult));
    await assert.rejects(
      () => h.execution.execute("spy.read", { q: "x" }, ctx()),
      (err: unknown) => {
        assertCode(err, "TOOL_OUTPUT_INVALID");
        return true;
      },
      c.title + " must fail closed",
    );
  }
});

// ---- TOOL_EXECUTION_FAILED wrapping / taxonomy -------------------------------

test("raw executor exceptions are wrapped, not propagated", async () => {
  const h = makeHarness(() => {
    throw new Error("ENOENT: no such file or directory, open C:\\Users\\me\\secret.txt");
  });
  const err = (await h.execution.execute("spy.read", { q: "x" }, ctx()).then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  )) as ArthurError;
  assertCode(err, "TOOL_EXECUTION_FAILED");
  // The raw message (local path) must not cross the boundary.
  assert.ok(!err.message.includes("ENOENT"));
  assert.ok(!err.message.includes("secret.txt"));
  assert.ok(!JSON.stringify(err.toJSON()).includes("secret.txt"));
  // The cause stays available for local logging only.
  assert.ok(err.cause instanceof Error);
});

test("ArthurErrors raised by executors pass through unchanged", async () => {
  const h = makeHarness(() => {
    throw new ArthurError("INVALID_REQUEST", "executor says no");
  });
  await assert.rejects(
    () => h.execution.execute("spy.read", { q: "x" }, ctx()),
    (err: unknown) => {
      assertCode(err, "INVALID_REQUEST");
      assert.equal((err as ArthurError).message, "executor says no");
      return true;
    },
  );
});

test("permission policy rejections use the stable tool taxonomy", async () => {
  // high_risk is rejected by POLICY even in an allowed mode.
  const h = makeHarness(() => ({ ok: true, summary: "ran" }), {
    name: "danger.tool",
    risk: "high_risk",
    allowed_modes: [ArthurMode.BUSINESS],
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  });
  const policyErr = (await h.execution.execute("danger.tool", {}, ctx(ArthurMode.BUSINESS)).then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  )) as ArthurError;
  assertCode(policyErr, "TOOL_PERMISSION_DENIED");
  assert.equal(h.calls.length, 0);
  // A mode gate rejection stays MODE_VIOLATION (existing error type reused).
  await assert.rejects(
    () => h.execution.execute("danger.tool", {}, ctx(ArthurMode.PERSONAL)),
    (e: unknown) => assertCode(e, "MODE_VIOLATION") !== undefined,
  );
  assert.equal(policyErr.httpStatus, 403);
});

test("approval evidence is required and tool-bound at the facade", async () => {
  const h = makeHarness(() => ({ ok: true, summary: "ran" }), {
    name: "gated.tool",
    risk: "approval_required",
    allowed_modes: [ArthurMode.BUSINESS],
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  });
  // approved:true with NO token can never authorize the action.
  await assert.rejects(
    () => h.execution.execute("gated.tool", {}, { ...ctx(ArthurMode.BUSINESS), approved: true }),
    (e: unknown) => assertCode(e, "APPROVAL_REQUIRED") !== undefined,
  );
  // A verified capability bound to a DIFFERENT tool name is rejected (SC-02 central gate).
  await assert.rejects(
    () =>
      h.execution.execute("gated.tool", {}, {
        ...ctx(ArthurMode.BUSINESS),
        approved: true,
        authorization: {
          v: 2 as const, alg: "Ed25519" as const, kid: "k", approval_id: "a", tool_call_id: "tc",
          session_id: "s", turn_id: "t", mode: ArthurMode.BUSINESS, tool_name: "other.tool",
          tool_version: "1.0.0", tool_definition_hash: "d", risk_level: "approval_required" as const,
          arguments_hash: "0".repeat(64), presentation_hash: "p", authorization_digest: "x",
          issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(),
        },
      }),
    (e: unknown) => assertCode(e, "APPROVAL_INVALID") !== undefined,
  );
  // A legacy token shape with NO verified capability is rejected before tool matching (SC-02).
  await assert.rejects(
    () =>
      h.execution.execute("gated.tool", {}, {
        ...ctx(ArthurMode.BUSINESS),
        approved: true,
        approvalToken: {
          approval_id: "a",
          tool_name: "other.tool",
          session_id: "s",
          turn_id: "t",
          arguments_hash: "0".repeat(64),
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60000).toISOString(),
          signature: "0".repeat(64),
        },
      }),
    (e: unknown) => assertCode(e, "APPROVAL_REQUIRED") !== undefined,
  );
  assert.equal(h.calls.length, 0);
});

// ---- TASK-0010 follow-up: descriptor/TOCTOU boundary (tests A-L) -----------

test("A: top-level ToolResult accessor is rejected", async () => {
  const h = makeHarness(() => {
    const r: Record<string, unknown> = { ok: true, summary: "s" };
    Object.defineProperty(r, "summary", {
      get: () => "tampered-" + String(Math.random()),
      enumerable: true,
      configurable: true,
    });
    return r as unknown as ToolResult;
  });
  await assert.rejects(
    () => h.execution.execute("spy.read", { q: "x" }, ctx()),
    (e: unknown) => {
      assertCode(e, "TOOL_OUTPUT_INVALID");
      assert.ok((e as ArthurError).message.includes("accessor"));
      return true;
    },
  );
});

test("B: nested data getter is rejected", async () => {
  const h = makeHarness(() => ({ ok: true, summary: "s", data: { get sneaky() { return "payload"; } } }) as unknown as ToolResult);
  await assert.rejects(
    () => h.execution.execute("spy.read", { q: "x" }, ctx()),
    (e: unknown) => {
      assertCode(e, "TOOL_OUTPUT_INVALID");
      assert.ok((e as ArthurError).message.includes("accessor"));
      return true;
    },
  );
});

test("C: setter/accessor (get+set) is rejected", async () => {
  const h = makeHarness(() => {
    const r: Record<string, unknown> = { summary: "s" };
    Object.defineProperty(r, "ok", {
      get: () => true,
      set: () => {},
      enumerable: true,
      configurable: true,
    });
    return r as unknown as ToolResult;
  });
  await assert.rejects(
    () => h.execution.execute("spy.read", { q: "x" }, ctx()),
    (e: unknown) => assertCode(e, "TOOL_OUTPUT_INVALID") !== undefined,
  );
});

test("D: non-enumerable own properties are rejected", async () => {
  // Non-enumerable unexpected field.
  const h1 = makeHarness(() => {
    const r: Record<string, unknown> = { ok: true, summary: "s" };
    Object.defineProperty(r, "shadow", { value: 1, enumerable: false, configurable: true });
    return r as unknown as ToolResult;
  });
  await assert.rejects(
    () => h1.execution.execute("spy.read", { q: "x" }, ctx()),
    (e: unknown) => assertCode(e, "TOOL_OUTPUT_INVALID") !== undefined,
  );
  // Non-enumerable KNOWN field (hidden ok).
  const h2 = makeHarness(() => {
    const r: Record<string, unknown> = { summary: "s" };
    Object.defineProperty(r, "ok", { value: true, enumerable: false, configurable: true });
    return r as unknown as ToolResult;
  });
  await assert.rejects(
    () => h2.execution.execute("spy.read", { q: "x" }, ctx()),
    (e: unknown) => {
      assertCode(e, "TOOL_OUTPUT_INVALID");
      assert.ok((e as ArthurError).message.includes("non-enumerable"));
      return true;
    },
  );
});

test("E: symbol-keyed ToolResult property is rejected", async () => {
  const h = makeHarness(() => {
    const r = { ok: true, summary: "s" } as Record<string | symbol, unknown>;
    r[Symbol("tracker")] = "side-channel";
    return r as unknown as ToolResult;
  });
  await assert.rejects(
    () => h.execution.execute("spy.read", { q: "x" }, ctx()),
    (e: unknown) => {
      assertCode(e, "TOOL_OUTPUT_INVALID");
      assert.ok((e as ArthurError).message.includes("symbol"));
      return true;
    },
  );
});

test("F: symbol-keyed nested data property is rejected", async () => {
  const h = makeHarness(() => {
    const payload = {} as Record<string | symbol, unknown>;
    payload[Symbol("k")] = 1;
    return { ok: true, summary: "s", data: payload } as unknown as ToolResult;
  });
  await assert.rejects(
    () => h.execution.execute("spy.read", { q: "x" }, ctx()),
    (e: unknown) => {
      assertCode(e, "TOOL_OUTPUT_INVALID");
      assert.ok((e as ArthurError).message.includes("symbol"));
      return true;
    },
  );
});

test("G: custom/class ToolResult is rejected", async () => {
  class CustomResult {
    ok = true;
    summary = "s";
  }
  const h1 = makeHarness(() => new CustomResult() as unknown as ToolResult);
  await assert.rejects(
    () => h1.execution.execute("spy.read", { q: "x" }, ctx()),
    (e: unknown) => {
      assertCode(e, "TOOL_OUTPUT_INVALID");
      assert.ok((e as ArthurError).message.includes("plain object"));
      return true;
    },
  );
  const h2 = makeHarness(() => Object.create({ ok: true, summary: "s" }) as unknown as ToolResult);
  await assert.rejects(
    () => h2.execution.execute("spy.read", { q: "x" }, ctx()),
    (e: unknown) => assertCode(e, "TOOL_OUTPUT_INVALID") !== undefined,
  );
});

test("H: custom/class nested data is rejected", async () => {
  class Payload {
    branch = "main";
  }
  const h = makeHarness(() => ({ ok: true, summary: "s", data: new Payload() }) as unknown as ToolResult);
  await assert.rejects(
    () => h.execution.execute("spy.read", { q: "x" }, ctx()),
    (e: unknown) => {
      assertCode(e, "TOOL_OUTPUT_INVALID");
      assert.ok((e as ArthurError).message.includes("plain JSON object"));
      return true;
    },
  );
});

test("I: mutating the executor result after validation cannot affect the returned result", async () => {
  const owned: { result: ToolResult } = { result: { ok: true, summary: "original", data: { v: 1 } } };
  const h = makeHarness(() => owned.result);
  const returned = await h.execution.execute("spy.read", { q: "x" }, ctx());

  // Mutate everything the executor still owns.
  owned.result.ok = false;
  owned.result.summary = "tampered";
  (owned.result.data as { v: number }).v = 999;
  (owned.result as { extra?: unknown }).extra = "injected";
  (owned.result.data as Record<string, unknown>).nested = { injected: true };
  delete (owned.result.data as Record<string, unknown>).v;

  assert.equal(returned.ok, true);
  assert.equal(returned.summary, "original");
  assert.deepEqual(returned.data, { v: 1 });
  assert.equal("extra" in returned, false);
  assert.equal("nested" in (returned.data as object), false);
  assert.notEqual(returned.data, owned.result.data, "snapshot must not share the executor object");
});

test("J: mutating nested executor data after validation cannot affect the returned data", async () => {
  const owned = {
    result: {
      ok: true,
      summary: "original",
      data: { list: [1, 2], inner: { k: "a" } } as unknown,
    } as ToolResult,
  };
  const data = owned.result.data as { list: number[]; inner: { k: string } };
  const h = makeHarness(() => owned.result);
  const returned = await h.execution.execute("spy.read", { q: "x" }, ctx());

  // Structural mutation of the nested graph after the boundary crossed.
  data.list.push(3);
  data.list.length = 0;
  data.inner.k = "tampered";
  delete (data as Record<string, unknown>).inner;

  const returnedData = returned.data as { list: number[]; inner: { k: string } };
  assert.deepEqual(returnedData.list, [1, 2]);
  assert.deepEqual(returnedData.inner, { k: "a" });
});

test("K: normal plain object/array JSON data still passes and returns a detached snapshot", async () => {
  const nested = { tags: ["a", "b"], meta: { count: 2, flag: true, nothing: null } };
  const h = makeHarness(() => ({ ok: true, summary: "s", data: { items: [nested, [1, 2, 3]], frozen: Object.freeze({ f: 1 }) } }));
  const result = await h.execution.execute("spy.read", { q: "x" }, ctx());
  assert.deepEqual(result.data, {
    items: [{ tags: ["a", "b"], meta: { count: 2, flag: true, nothing: null } }, [1, 2, 3]],
    frozen: { f: 1 },
  });
  assert.notEqual(result.data, nested, "snapshot must be a fresh object");
});

test("arrays with exotic own properties or holes fail closed", async () => {
  const exotic = [1, 2, 3] as unknown as Record<string | symbol, unknown>;
  exotic.extra = 9;
  const h1 = makeHarness(() => ({ ok: true, summary: "s", data: { arr: exotic } } as unknown as ToolResult));
  await assert.rejects(
    () => h1.execution.execute("spy.read", { q: "x" }, ctx()),
    (e: unknown) => {
      assertCode(e, "TOOL_OUTPUT_INVALID");
      assert.ok((e as ArthurError).message.includes("exotic own property"));
      return true;
    },
  );

  const sparse = [1, 2, 3] as unknown as Record<number, unknown>;
  delete sparse[1];
  const h2 = makeHarness(() => ({ ok: true, summary: "s", data: { arr: sparse } }));
  await assert.rejects(
    () => h2.execution.execute("spy.read", { q: "x" }, ctx()),
    (e: unknown) => {
      assertCode(e, "TOOL_OUTPUT_INVALID");
      assert.ok((e as ArthurError).message.includes("sparse"));
      return true;
    },
  );
});

