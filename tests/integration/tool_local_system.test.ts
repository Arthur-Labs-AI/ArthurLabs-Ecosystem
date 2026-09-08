/**
 * TASK-0011 focused integration tests: system.status executes as a REAL
 * machine-local tool through the existing secured boundary (H-K), returns to
 * the model through the conversation loop (L, M), keeps the security posture
 * (N-P), and preserves the Phase 1 builtin behavior (Q, R).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ArthurError } from "../../src/core/errors/errors";
import { ArthurMode } from "../../src/core/modes/mode";
import { FakeProvider } from "../../src/models/providers/fake";
import type { ModelRequest, ModelResult } from "../../src/models/contracts";
import { Logger } from "../../src/observability/logging";
import { InMemoryMetrics } from "../../src/observability/metrics";
import { SecretSanitizer } from "../../src/security/sanitize";
import { SessionStore } from "../../src/sessions/store";
import { HarnessStubAdapter } from "../../src/tools/adapters/harness_stub";
import {
  LocalSystemAdapter,
  LocalSystemStatus,
  NodeLocalSystemAdapter,
} from "../../src/tools/adapters/local_system";
import { registerBuiltinTools } from "../../src/tools/builtin";
import { ToolOrchestrator } from "../../src/tools/orchestrator";
import { PermissionService } from "../../src/tools/permissions";
import { ToolRegistry } from "../../src/tools/registry";
import { buildTestApp, validTurn } from "../helpers";

const SRC = resolve(__dirname, "..", "..", "..", "src");

/** Deterministic machine-independent status used by every fake adapter. */
const FAKE_STATUS: LocalSystemStatus = {
  platform: "win32",
  arch: "x64",
  node_version: "v22.0.0-fake",
  uptime_seconds: 1234,
  cpu_count: 12,
  total_memory_bytes: 32 * 2 ** 30,
  free_memory_bytes: 16 * 2 ** 30,
};

const EXPECTED_SUMMARY = "Local system: win32 x64, Node v22.0.0-fake, 12 CPUs, 32 GB RAM";

class FakeLocalSystemAdapter implements LocalSystemAdapter {
  constructor(private readonly status: LocalSystemStatus) {}
  async getStatus(): Promise<LocalSystemStatus> {
    return { ...this.status };
  }
}

const SIGNING_SECRET = "tool-local-system-integration-secret";

interface World {
  registry: ToolRegistry;
  execution: ReturnType<ToolRegistry["createExecutionService"]>;
  orchestrator: ToolOrchestrator;
  store: SessionStore;
  ctx: Parameters<ToolOrchestrator["handleProposed"]>[1];
  close: () => void;
}

function buildWorld(
  adapter: LocalSystemAdapter = new FakeLocalSystemAdapter(FAKE_STATUS),
  mode: ArthurMode = ArthurMode.PERSONAL,
): World {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, new HarnessStubAdapter({ verificationSecret: SIGNING_SECRET }), adapter);
  const permissions = new PermissionService();
  const store = new SessionStore(":memory:", new SecretSanitizer([]));
  const execution = registry.createExecutionService(permissions);
  const orchestrator = new ToolOrchestrator({
    registry,
    execution,
    store,
    permissions,
    sanitizer: new SecretSanitizer([]),
    approvalTtlSeconds: 300,
    approvalSigningSecret: SIGNING_SECRET,
    logger: new Logger("error"),
    metrics: new InMemoryMetrics(),
  });
  store.createSession("s1", mode);
  store.createTurn({ id: "t1", sessionId: "s1", role: "user", text: "go", traceId: "tr1", status: "completed", mode });
  return {
    registry,
    execution,
    orchestrator,
    store,
    ctx: { session_id: "s1", turn_id: "t1", trace_id: "tr1", mode, approved: false },
    close: () => store.close(),
  };
}

// ---- H: executes automatically without approval ------------------------------

test("H: system.status executes automatically (read risk, no approval, approved=false)", async () => {
  const w = buildWorld();
  try {
    assert.equal(w.ctx.approved, false);
    const handling = await w.orchestrator.handleProposed(
      [{ id: "call-ss", name: "system.status", arguments: {} }],
      w.ctx,
    );
    assert.equal(handling.needsApproval, false, "read tool must not need approval");
    assert.equal(handling.summaries.length, 1);
    assert.equal(handling.summaries[0]?.status, "completed");
    assert.equal(handling.summaries[0]?.risk, "read");
    assert.equal(handling.toolResultMessages.length, 1);
    const message = handling.toolResultMessages[0];
    assert.equal(message?.role, "tool");
    assert.equal(message?.name, "system.status");
    assert.equal(message?.tool_call_id, "call-ss");
    // TASK-0011B: the model-facing content is the bounded structured payload
    // { summary, data } - summary stays concise, data is the validated
    // canonical snapshot of the adapter status.
    const payload = JSON.parse(message?.content ?? "") as { summary: string; data: LocalSystemStatus };
    assert.equal(payload.summary, EXPECTED_SUMMARY);
    assert.deepEqual(payload.data, FAKE_STATUS);
    const records = w.store.getToolCallsForTurn("t1");
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "completed");
    assert.equal(records[0]?.tool_name, "system.status");
  } finally {
    w.close();
  }
});

// ---- I: runs through the ToolExecutionService --------------------------------

test("I: system.status runs through the secured ToolExecutionService boundary", async () => {
  const w = buildWorld();
  try {
    const result = await w.execution.execute("system.status", {}, w.ctx);
    assert.equal(result.ok, true);
    assert.equal(result.summary, EXPECTED_SUMMARY);
    // The facade returns the validated canonical snapshot of adapter data.
    assert.deepEqual(result.data, FAKE_STATUS);
    // Argument validation happens before any adapter call.
    await assert.rejects(
      () => w.execution.execute("system.status", { extra: 1 }, w.ctx),
      (err: unknown) => err instanceof ArthurError && err.code === "TOOL_ARGUMENT_INVALID",
    );
  } finally {
    w.close();
  }
});

// ---- J: malformed adapter output fails TOOL_OUTPUT_INVALID --------------------

test("J: malformed fake adapter output fails with TOOL_OUTPUT_INVALID", async () => {
  const broken = {
    async getStatus(): Promise<LocalSystemStatus> {
      // Lies about the contract: wrong type, missing field, extra field.
      return {
        platform: 123,
        arch: "x64",
        node_version: "v1",
        uptime_seconds: 1,
        cpu_count: 1,
        total_memory_bytes: 1,
      } as unknown as LocalSystemStatus;
    },
  } as LocalSystemAdapter;
  const w = buildWorld(broken);
  try {
    await assert.rejects(
      () => w.execution.execute("system.status", {}, w.ctx),
      (err: unknown) => err instanceof ArthurError && err.code === "TOOL_OUTPUT_INVALID",
    );
    // Via the orchestrator the same failure is audited as failed and produces
    // no model follow-up message.
    const handling = await w.orchestrator.handleProposed(
      [{ id: "call-broken", name: "system.status", arguments: {} }],
      w.ctx,
    );
    assert.equal(handling.toolResultMessages.length, 0);
    // SC-03: execution failure surfaces the durable status (failed), not the
    // old conflated "rejected" proposal status.
    assert.equal(handling.summaries[0]?.status, "failed");
    const records = w.store.getToolCallsForTurn("t1");
    assert.equal(records[0]?.status, "failed");
  } finally {
    w.close();
  }
});

// ---- K: adapter exception becomes TOOL_EXECUTION_FAILED -----------------------

test("K: adapter exception becomes TOOL_EXECUTION_FAILED", async () => {
  const failing = {
    async getStatus(): Promise<LocalSystemStatus> {
      throw new Error("host inventory exploded");
    },
  } as LocalSystemAdapter;
  const w = buildWorld(failing);
  try {
    await assert.rejects(
      () => w.execution.execute("system.status", {}, w.ctx),
      (err: unknown) => err instanceof ArthurError && err.code === "TOOL_EXECUTION_FAILED",
    );
    const handling = await w.orchestrator.handleProposed(
      [{ id: "call-fail", name: "system.status", arguments: {} }],
      w.ctx,
    );
    assert.equal(handling.toolResultMessages.length, 0);
    // SC-03: execution failure surfaces the durable status (failed).
    assert.equal(handling.summaries[0]?.status, "failed");
    const records = w.store.getToolCallsForTurn("t1");
    assert.equal(records[0]?.status, "failed");
    assert.ok(records[0]?.result_summary?.includes("execution failed"));
  } finally {
    w.close();
  }
});

// ---- L/M: conversation integration through the real service -------------------

test("L: FakeProvider proposal of system.status returns a role=tool follow-up", async () => {
  const requests: ModelRequest[] = [];
  let round = 0;
  const provider = new FakeProvider({
    responder: (request: ModelRequest): ModelResult => {
      requests.push(request);
      round += 1;
      if (round === 1) {
        return {
          assistant_text: "",
          tool_calls: [{ id: "call-ss", name: "system.status", arguments: {} }],
          finish_reason: "tool_calls",
        };
      }
      return { assistant_text: "Host is up: win32 x64, 12 CPUs.", tool_calls: [], finish_reason: "stop" };
    },
  });
  const app = buildTestApp({}, { provider, localSystem: new FakeLocalSystemAdapter(FAKE_STATUS) });
  try {
    const response = await app.conversation.handleTurn(validTurn({ message: "how is the host?" }));
    assert.equal(response.display_text, "Host is up: win32 x64, 12 CPUs.");

    // Model-facing availability: generic ToolDefinition -> registry ->
    // toToolSchema() -> ModelRequest.toolSchemas (section 9) - exactly the
    // four generic tools, no provider-specific handling.
    // Personal-mode session: the BUSINESS-only harness.create_job is correctly
    // absent; the three read tools are exposed to the model generically.
    const toolNames = requests[0]?.toolSchemas.map((s) => s.name).sort();
    assert.deepEqual(toolNames, ["harness.status", "system.echo", "system.status"]);
    const statusSchema = requests[0]?.toolSchemas.find((s) => s.name === "system.status");
    assert.ok(statusSchema);
    assert.deepEqual(statusSchema.parameters, {
      type: "object",
      properties: {},
      additionalProperties: false,
    });

    // TASK-0011B: the model receives exactly one role=tool follow-up carrying
    // the capped summary AND the validated structured data.
    const followupToolMessages = requests[1]?.history.filter((m) => m.role === "tool") ?? [];
    assert.equal(followupToolMessages.length, 1);
    const toolMessage = followupToolMessages[0];
    assert.equal(toolMessage?.name, "system.status");
    assert.equal(toolMessage?.tool_call_id, "call-ss");
    const followupPayload = JSON.parse(toolMessage?.content ?? "") as { summary: string; data: LocalSystemStatus };
    assert.equal(followupPayload.summary, EXPECTED_SUMMARY);
    assert.deepEqual(followupPayload.data, FAKE_STATUS);

    const records = app.store.getToolCallsForTurn(response.turn_id);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "completed");
    assert.equal(records[0]?.tool_name, "system.status");
  } finally {
    app.close();
  }
});

test("M: the conversation turn completes normally after the tool round", async () => {
  let round = 0;
  const provider = new FakeProvider({
    responder: (): ModelResult => {
      round += 1;
      if (round === 1) {
        return {
          assistant_text: "",
          tool_calls: [{ id: "call-ss", name: "system.status", arguments: {} }],
          finish_reason: "tool_calls",
        };
      }
      return { assistant_text: "All good.", tool_calls: [], finish_reason: "stop" };
    },
  });
  const app = buildTestApp({}, { provider, localSystem: new FakeLocalSystemAdapter(FAKE_STATUS) });
  try {
    const response = await app.conversation.handleTurn(validTurn({ message: "status?" }));
    assert.equal(response.display_text, "All good.");
    assert.equal(response.status, "completed");
    const turns = app.store.getTurns(response.session_id);
    const assistant = turns.find((t) => t.role === "assistant" && t.text === "All good.");
    assert.ok(assistant, "final assistant turn persisted");
    assert.equal(assistant?.status, "completed");
  } finally {
    app.close();
  }
});

// ---- N/O: security posture ----------------------------------------------------

test("N: no shell or child-process execution primitive exists in the local tool host", () => {
  const adapterSource = readFileSync(resolve(SRC, "tools", "adapters", "local_system.ts"), "utf8");
  const builtinSource = readFileSync(resolve(SRC, "tools", "builtin.ts"), "utf8");
  // The adapter must run on Node standard APIs only: its ONLY module import is
  // node:os, so no process/shell module can even be reached.
  const adapterImports = [...adapterSource.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(adapterImports, ["node:os"]);
  // Scan EXECUTABLE source (comments stripped) for shell primitives; comments
  // may document that primitives are banned without tripping the scan.
  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const BANNED_SHELL_TOKENS = [
    "child_process",
    "spawn",
    "execSync",
    "execFile",
    "popen",
    "cmd.exe",
    "powershell",
    "wmic",
    "systeminfo",
  ];
  const scanTargets: [string, string][] = [
    ["adapter", stripComments(adapterSource)],
    ["builtin", stripComments(builtinSource)],
  ];
  for (const [label, source] of scanTargets) {
    for (const token of BANNED_SHELL_TOKENS) {
      assert.equal(
        source.includes(token),
        false,
        label + " source must not contain shell primitive: " + token,
      );
    }
  }
  // Runtime: the registry of a real app-facing composition exposes no
  // process/shell tools (checked via the model-facing schemas in test L).
});

test("O: executed result contains no environment variables or path-like data", async () => {
  const w = buildWorld(new NodeLocalSystemAdapter());
  try {
    const result = await w.execution.execute("system.status", {}, w.ctx);
    assert.deepEqual(Object.keys(result.data as object).sort(), [
      "arch",
      "cpu_count",
      "free_memory_bytes",
      "node_version",
      "platform",
      "total_memory_bytes",
      "uptime_seconds",
    ]);
    const json = JSON.stringify(result.data) ?? "";
    for (const name of ["USERNAME", "USERPROFILE", "HOME", "PATH", "APPDATA", "COMPUTERNAME", "TEMP", "TMP"]) {
      const value = process.env[name];
      if (!value) continue;
      assert.ok(!json.includes(value), "result must not contain value of " + name);
    }
    assert.equal(json.includes("\\"), false, "no backslashes (paths) in output");
    assert.equal(json.includes("/"), false, "no slashes (paths) in output");
  } finally {
    w.close();
  }
});

test("P: the raw local system adapter is not exposed through the public App", async () => {
  const adapter = new FakeLocalSystemAdapter(FAKE_STATUS);
  const app = buildTestApp({}, { localSystem: adapter });
  try {
    const surfaceKeys = Object.keys(app);
    for (const forbidden of ["registry", "execution", "orchestrator", "localSystem", "adapter", "executor", "harness"]) {
      assert.equal(surfaceKeys.includes(forbidden), false, "App must not expose key: " + forbidden);
    }
    for (const [key, value] of Object.entries(app)) {
      assert.notEqual(value, adapter, "App." + key + " must not be the raw adapter");
      if (value !== null && typeof value === "object") {
        for (const [nestedKey, nested] of Object.entries(value)) {
          assert.notEqual(nested, adapter, "App." + key + "." + nestedKey + " must not be the raw adapter");
        }
      }
    }
  } finally {
    app.close();
  }
});

// ---- Q/R: builtin + approval regressions ---------------------------------------

test("Q: existing builtins keep their exact manifests alongside system.status", async () => {
  const w = buildWorld();
  try {
    const byName = new Map(w.registry.list().map((d) => [d.name, d]));
    assert.deepEqual([...byName.keys()].sort(), [
      "harness.create_job",
      "harness.status",
      "system.echo",
      "system.status",
    ]);
    assert.deepEqual(byName.get("system.echo")?.allowed_modes, [ArthurMode.PERSONAL, ArthurMode.BUSINESS]);
    assert.equal(byName.get("system.echo")?.risk, "read");
    assert.deepEqual(byName.get("harness.status")?.allowed_modes, [ArthurMode.PERSONAL, ArthurMode.BUSINESS]);
    assert.equal(byName.get("harness.status")?.risk, "read");
    assert.deepEqual(byName.get("harness.create_job")?.allowed_modes, [ArthurMode.BUSINESS]);
    assert.equal(byName.get("harness.create_job")?.risk, "approval_required");

    const echo = await w.execution.execute("system.echo", { text: "ping" }, w.ctx);
    assert.deepEqual(echo.data, { echo: "ping" });
    const status = await w.execution.execute("harness.status", {}, w.ctx);
    assert.equal((status.data as { status: string }).status, "online");
  } finally {
    w.close();
  }
});

test("R: the approval flow remains unchanged with the new tool registered", async () => {
  const w = buildWorld(undefined, ArthurMode.BUSINESS);
  try {
    await assert.rejects(
      () => w.execution.execute("harness.create_job", { kind: "deploy" }, w.ctx),
      (err: unknown) => err instanceof ArthurError && err.code === "APPROVAL_REQUIRED",
    );
    const handling = await w.orchestrator.handleProposed(
      [
        { id: "call-approval", name: "harness.create_job", arguments: { kind: "deploy" } },
        { id: "call-read", name: "system.status", arguments: {} },
      ],
      w.ctx,
    );
    assert.equal(handling.needsApproval, true, "approval-required tool still goes to pending");
    assert.equal(handling.summaries[0]?.status, "pending_approval");
    assert.equal(handling.summaries[1]?.status, "completed", "read tool still auto-executes in the same turn");
    assert.equal(handling.toolResultMessages.length, 1, "only the completed tool returns to the model");
    assert.equal(handling.toolResultMessages[0]?.name, "system.status");
  } finally {
    w.close();
  }
});
