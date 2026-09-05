/**
 * TASK-0011B integration tests: the model-facing completed tool message is a
 * bounded structured payload { summary, data } built from the VALIDATED
 * ToolResult - never the raw executor output. Covers: summary+data handoff,
 * model consumption of uptime_seconds, JSON validity, secret redaction,
 * oversized-data omission (no partial truncation), malformed executor output
 * dying before handoff, the detached-snapshot invariant, the concise
 * ToolCallSummary.result_summary contract, and the CLI never auto-dumping
 * structured data.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

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
} from "../../src/tools/adapters/local_system";
import { registerBuiltinTools } from "../../src/tools/builtin";
import type { ToolDefinition, ToolExecutor, ToolResult } from "../../src/tools/contracts";
import {
  MODEL_TOOL_RESULT_MAX_BYTES,
  TOOL_RESULT_PAYLOAD_TOO_LARGE,
} from "../../src/tools/model_payload";
import { ToolOrchestrator } from "../../src/tools/orchestrator";
import { PermissionService } from "../../src/tools/permissions";
import { ToolRegistry } from "../../src/tools/registry";
import { renderCompactToolCalls, renderVerboseToolCalls } from "../../apps/cli/index";
import type { ToolCallSummary } from "../../src/core/conversation/models";
import { buildTestApp, validTurn } from "../helpers";

const FAKE_STATUS: LocalSystemStatus = {
  platform: "win32",
  arch: "x64",
  node_version: "v22.18.0",
  uptime_seconds: 12345,
  cpu_count: 12,
  total_memory_bytes: 32 * 2 ** 30,
  free_memory_bytes: 16 * 2 ** 30,
};

const EXPECTED_SUMMARY = "Local system: win32 x64, Node v22.18.0, 12 CPUs, 32 GB RAM";

class FakeLocalSystemAdapter implements LocalSystemAdapter {
  constructor(private readonly status: LocalSystemStatus) {}
  async getStatus(): Promise<LocalSystemStatus> {
    return { ...this.status };
  }
}

const SIGNING_SECRET = "tool-model-payload-integration-secret";

interface ExtraTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
}

interface PayloadWorldOptions {
  tools?: ExtraTool[];
  sanitizer?: SecretSanitizer;
  modelToolResultMaxBytes?: number;
  /** Local system capability; defaults to the deterministic fake status. */
  localSystem?: LocalSystemAdapter;
}

function buildPayloadWorld(opts: PayloadWorldOptions = {}): {
  orchestrator: ToolOrchestrator;
  execution: ReturnType<ToolRegistry["createExecutionService"]>;
  store: SessionStore;
  ctx: Parameters<ToolOrchestrator["handleProposed"]>[1];
  close: () => void;
} {
  const registry = new ToolRegistry();
  registerBuiltinTools(
    registry,
    new HarnessStubAdapter({ verificationSecret: SIGNING_SECRET }),
    opts.localSystem ?? new FakeLocalSystemAdapter(FAKE_STATUS),
  );
  for (const tool of opts.tools ?? []) {
    registry.register(tool.definition, tool.executor);
  }
  const permissions = new PermissionService();
  const store = new SessionStore(":memory:", new SecretSanitizer([]));
  const execution = registry.createExecutionService(permissions);
  const orchestrator = new ToolOrchestrator({
    registry,
    execution,
    store,
    permissions,
    sanitizer: opts.sanitizer ?? new SecretSanitizer([]),
    approvalTtlSeconds: 300,
    approvalSigningSecret: SIGNING_SECRET,
    modelToolResultMaxBytes: opts.modelToolResultMaxBytes,
    logger: new Logger("error"),
    metrics: new InMemoryMetrics(),
  });
  store.createSession("s1", ArthurMode.PERSONAL);
  store.createTurn({ id: "t1", sessionId: "s1", role: "user", text: "go", traceId: "tr1", status: "completed", mode: ArthurMode.PERSONAL });
  return {
    orchestrator,
    execution,
    store,
    ctx: { session_id: "s1", turn_id: "t1", trace_id: "tr1", mode: ArthurMode.PERSONAL, approved: false },
    close: () => store.close(),
  };
}

function parsePayload(content: string | undefined): Record<string, unknown> {
  return JSON.parse(content ?? "") as Record<string, unknown>;
}

/** Shared oversized tool: a payload larger than the default 16 KiB cap. */
const BIG_BLOB_TOOL: ExtraTool = {
  definition: {
    name: "big.blob",
    version: "1.0.0",
    description: "returns a payload larger than the model-facing cap",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    output_schema: {
      type: "object",
      properties: { blob: { type: "string" } },
      required: ["blob"],
      additionalProperties: false,
    },
    risk: "read",
    allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
  },
  executor: () => ({ ok: true, summary: "big result", data: { blob: "X".repeat(20000) } }),
};

// ---- summary + data reach the model follow-up --------------------------------

test("0011B-1: system.status model follow-up receives summary AND validated data", async () => {
  const w = buildPayloadWorld();
  try {
    const handling = await w.orchestrator.handleProposed(
      [{ id: "call-ss", name: "system.status", arguments: {} }],
      w.ctx,
    );
    assert.equal(handling.toolResultMessages.length, 1);
    const message = handling.toolResultMessages[0];
    assert.equal(message?.role, "tool");
    assert.equal(message?.name, "system.status");
    assert.equal(message?.tool_call_id, "call-ss");

    const payload = parsePayload(message?.content);
    assert.equal(payload.summary, EXPECTED_SUMMARY);
    assert.deepEqual(payload.data, FAKE_STATUS);
  } finally {
    w.close();
  }
});

test("0011B-2: the payload is valid JSON that round-trips (never partial or decorated)", async () => {
  const w = buildPayloadWorld();
  try {
    const handling = await w.orchestrator.handleProposed(
      [{ id: "call-json", name: "system.status", arguments: {} }],
      w.ctx,
    );
    const content = handling.toolResultMessages[0]?.content ?? "";
    const parsed = JSON.parse(content) as unknown; // throws if not valid JSON
    // Round-trip: stringifying the parsed value reproduces the exact payload,
    // so the content is one canonical JSON document with no extra text.
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);
    assert.ok(typeof parsed === "object" && parsed !== null);
    assert.ok(content.startsWith("{") && content.endsWith("}"));
  } finally {
    w.close();
  }
});

test("0011B-3: FakeProvider can answer an uptime question from the payload data", async () => {
  const requests: ModelRequest[] = [];
  let round = 0;
  const provider = new FakeProvider({
    responder: (request: ModelRequest): ModelResult => {
      requests.push(request);
      round += 1;
      if (round === 1) {
        return {
          assistant_text: "",
          tool_calls: [{ id: "call-up", name: "system.status", arguments: {} }],
          finish_reason: "tool_calls",
        };
      }
      // Stand-in for the model: read the structured tool result and answer
      // from uptime_seconds specifically.
      const toolMessage = request.history.find((m) => m.role === "tool");
      assert.ok(toolMessage, "follow-up round must carry a role=tool message");
      const payload = JSON.parse(toolMessage.content ?? "{}") as { data?: { uptime_seconds?: number } };
      return {
        assistant_text: `This computer has been running for ${payload.data?.uptime_seconds} seconds.`,
        tool_calls: [],
        finish_reason: "stop",
      };
    },
  });
  const app = buildTestApp({}, { provider, localSystem: new FakeLocalSystemAdapter(FAKE_STATUS) });
  try {
    const response = await app.conversation.handleTurn(
      validTurn({ message: "How long has this computer been running? Use system.status." }),
    );
    assert.equal(response.display_text, "This computer has been running for 12345 seconds.");
    assert.equal(round, 2);
    assert.equal(requests[1]?.userMessage, "");
  } finally {
    app.close();
  }
});

// ---- sanitization ------------------------------------------------------------

test("0011B-4: secret-like keys and known secrets are redacted in the payload data", async () => {
  const KNOWN_SECRET = "super-secret-token-4242";
  const w = buildPayloadWorld({
    sanitizer: new SecretSanitizer([KNOWN_SECRET]),
    tools: [
      {
        definition: {
          name: "vault.peek",
          version: "1.0.0",
          description: "returns secret-shaped data for redaction testing",
          input_schema: { type: "object", properties: {}, additionalProperties: false },
          output_schema: {
            type: "object",
            properties: { password: { type: "string" }, note: { type: "string" }, count: { type: "integer" } },
            required: ["password", "note", "count"],
            additionalProperties: false,
          },
          risk: "read",
          allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
        },
        executor: () =>
          ({
            ok: true,
            summary: "vault peeked",
            data: { password: "hunter2", note: `token is ${KNOWN_SECRET}`, count: 3 },
          }) satisfies ToolResult,
      },
    ],
  });
  try {
    const handling = await w.orchestrator.handleProposed(
      [{ id: "call-vault", name: "vault.peek", arguments: {} }],
      w.ctx,
    );
    assert.equal(handling.toolResultMessages.length, 1);
    const payload = parsePayload(handling.toolResultMessages[0]?.content) as {
      summary: string;
      data: { password: string; note: string; count: number };
    };
    assert.equal(payload.summary, "vault peeked");
    assert.equal(payload.data.password, "[REDACTED]", "secret-like key must be redacted");
    assert.equal(payload.data.note.includes(KNOWN_SECRET), false, "known secret must be redacted");
    assert.ok(payload.data.note.includes("[REDACTED]"));
    assert.equal(payload.data.count, 3, "non-secret data survives");
    const content = handling.toolResultMessages[0]?.content ?? "";
    assert.equal(content.includes("hunter2"), false);
    assert.equal(content.includes(KNOWN_SECRET), false);
  } finally {
    w.close();
  }
});

// ---- payload bound -------------------------------------------------------------

test("0011B-5: oversized data is omitted whole, never partially truncated", async () => {
  const w = buildPayloadWorld({ tools: [BIG_BLOB_TOOL] });
  try {
    const handling = await w.orchestrator.handleProposed(
      [{ id: "call-big", name: "big.blob", arguments: {} }],
      w.ctx,
    );
    assert.equal(handling.toolResultMessages.length, 1);
    const content = handling.toolResultMessages[0]?.content ?? "";
    const payload = parsePayload(content) as { summary: string; data?: unknown; data_omitted?: boolean; reason?: string };
    assert.equal(payload.summary, "big result", "summary always survives");
    assert.equal(payload.data, undefined, "no partial data may leak");
    assert.equal(payload.data_omitted, true);
    assert.equal(payload.reason, TOOL_RESULT_PAYLOAD_TOO_LARGE);
    // No fragment of the oversized value may survive anywhere in the message.
    assert.equal(content.includes("XXXXX"), false);
    assert.ok(Buffer.byteLength(content, "utf8") <= MODEL_TOOL_RESULT_MAX_BYTES);
  } finally {
    w.close();
  }
});

test("0011B-6: the cap is injectable and the omission marker itself stays bounded", async () => {
  const w = buildPayloadWorld({ modelToolResultMaxBytes: 200 });
  try {
    const handling = await w.orchestrator.handleProposed(
      [{ id: "call-cap", name: "system.status", arguments: {} }],
      w.ctx,
    );
    const content = handling.toolResultMessages[0]?.content ?? "";
    const payload = parsePayload(content) as { summary: string; data?: unknown; data_omitted?: boolean; reason?: string };
    // The full system.status payload (~300 bytes) exceeds 200 bytes.
    assert.equal(payload.data, undefined);
    assert.equal(payload.data_omitted, true);
    assert.equal(payload.reason, TOOL_RESULT_PAYLOAD_TOO_LARGE);
    assert.equal(payload.summary, EXPECTED_SUMMARY);
    assert.ok(Buffer.byteLength(content, "utf8") <= 200, "marker payload stays within the cap");
  } finally {
    w.close();
  }
});

test("0011B-7: payloads within the cap keep their data (cap is not lossy for small results)", async () => {
  const w = buildPayloadWorld({ modelToolResultMaxBytes: 4096 });
  try {
    const handling = await w.orchestrator.handleProposed(
      [{ id: "call-ok", name: "system.status", arguments: {} }],
      w.ctx,
    );
    const payload = parsePayload(handling.toolResultMessages[0]?.content) as { data?: unknown };
    assert.deepEqual(payload.data, FAKE_STATUS);
  } finally {
    w.close();
  }
});

// ---- malformed executor output still dies before handoff ---------------------

test("0011B-8: malformed executor output dies before model handoff (no message)", async () => {
  const w = buildPayloadWorld({
    tools: [
      {
        definition: {
          name: "sneaky.output",
          version: "1.0.0",
          description: "executor tries accessor and undefined tricks",
          input_schema: { type: "object", properties: {}, additionalProperties: false },
          risk: "read",
          allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
        },
        executor: () =>
          ({
            ok: true,
            summary: "sneaky",
            get data() {
              return { trick: true };
            },
          }) as unknown as ToolResult,
      },
    ],
  });
  try {
    const handling = await w.orchestrator.handleProposed(
      [{ id: "call-sneaky", name: "sneaky.output", arguments: {} }],
      w.ctx,
    );
    assert.equal(handling.toolResultMessages.length, 0, "malformed output must not reach the model");
    assert.equal(handling.summaries[0]?.status, "rejected");
    const records = w.store.getToolCallsForTurn("t1");
    assert.equal(records[0]?.status, "failed");
    assert.ok(records[0]?.result_summary?.includes("invalid output"));
    // The failure is a boundary rejection, not an escape: TOOL_OUTPUT_INVALID.
    await assert.rejects(
      () => w.execution.execute("sneaky.output", {}, w.ctx),
      (err: unknown) => err instanceof ArthurError && err.code === "TOOL_OUTPUT_INVALID",
    );
  } finally {
    w.close();
  }
});

// ---- detached snapshot invariant ----------------------------------------------

test("0011B-9: detached snapshot invariant - mutating the executor-owned graph afterwards changes nothing", async () => {
  const executorOwned: { value: string } = { value: "original" };
  const w = buildPayloadWorld({
    tools: [
      {
        definition: {
          name: "snapshot.probe",
          version: "1.0.0",
          description: "returns a shared executor-owned nested object",
          input_schema: { type: "object", properties: {}, additionalProperties: false },
          output_schema: {
            type: "object",
            properties: { nested: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } },
            required: ["nested"],
            additionalProperties: false,
          },
          risk: "read",
          allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
        },
        // The executor hands back a wrapper that shares its own nested object.
        executor: () => ({ ok: true, summary: "snap", data: { nested: executorOwned } }),
      },
    ],
  });
  try {
    const handling = await w.orchestrator.handleProposed(
      [{ id: "call-snap", name: "snapshot.probe", arguments: {} }],
      w.ctx,
    );
    const content = handling.toolResultMessages[0]?.content ?? "";
    assert.ok(content.includes("original"), "payload carries the value observed at execution");
    // Mutate the executor-owned graph AFTER the handoff was built.
    executorOwned.value = "MUTATED-AFTER-HANDOFF";
    assert.equal(
      (parsePayload(content) as { data: { nested: { value: string } } }).data.nested.value,
      "original",
      "the model payload must be detached from the executor-owned graph",
    );
  } finally {
    w.close();
  }
});

// ---- ToolCallSummary stays concise ---------------------------------------------

test("0011B-10: ToolCallSummary.result_summary stays the concise summary, not the payload", async () => {
  const w = buildPayloadWorld();
  try {
    const handling = await w.orchestrator.handleProposed(
      [{ id: "call-sum", name: "system.status", arguments: {} }],
      w.ctx,
    );
    const completed = handling.summaries[0];
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.result_summary, EXPECTED_SUMMARY);
    // The summary is a plain human-readable line, not the JSON payload.
    assert.equal(completed?.result_summary?.includes("uptime_seconds"), false);
    assert.equal(completed?.result_summary?.includes("total_memory_bytes"), false);
    assert.throws(() => JSON.parse(completed?.result_summary ?? ""), "result_summary must not be the JSON payload");
  } finally {
    w.close();
  }
});

// ---- CLI verbose never dumps structured data -----------------------------------

test("0011B-11: CLI verbose and compact renderings never include structured data", async () => {
  const summary: ToolCallSummary = {
    tool_call_id: "call-cli",
    name: "system.status",
    risk: "read",
    status: "completed",
    result_summary: EXPECTED_SUMMARY,
  };
  const verbose = renderVerboseToolCalls([summary]);
  const compact = renderCompactToolCalls([summary]);
  assert.ok(verbose.includes(EXPECTED_SUMMARY), "verbose still shows the concise summary");
  for (const fragment of ["uptime_seconds", "total_memory_bytes", "free_memory_bytes", "cpu_count", "node_version"]) {
    assert.equal(verbose.includes(fragment), false, `verbose must not dump data key: ${fragment}`);
    assert.equal(compact.includes(fragment), false, `compact must not dump data key: ${fragment}`);
  }
});

test("0011B-12: CLI ask --verbose prints the answer and summaries, never the payload", async () => {
  const requests: ModelRequest[] = [];
  let round = 0;
  const provider = new FakeProvider({
    responder: (request: ModelRequest): ModelResult => {
      requests.push(request);
      round += 1;
      if (round === 1) {
        return {
          assistant_text: "",
          tool_calls: [{ id: "call-cli2", name: "system.status", arguments: {} }],
          finish_reason: "tool_calls",
        };
      }
      const toolMessage = request.history.find((m) => m.role === "tool");
      const payload = JSON.parse(toolMessage?.content ?? "{}") as { data?: { uptime_seconds?: number } };
      return {
        assistant_text: `Uptime: ${payload.data?.uptime_seconds} seconds.`,
        tool_calls: [],
        finish_reason: "stop",
      };
    },
  });
  const app = buildTestApp({}, { provider, localSystem: new FakeLocalSystemAdapter(FAKE_STATUS) });
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  try {
    const { runAsk } = await import("../../apps/cli/index");
    const code = await runAsk(app, {
      mode: ArthurMode.PERSONAL,
      message: "How long has this computer been running?",
      verbose: true,
      io: { out: (t) => outBuf.push(t), err: (t) => errBuf.push(t) },
    });
    assert.equal(code, 0);
    const out = outBuf.join("");
    assert.ok(out.includes("Uptime: 12345 seconds."), "the model answer uses the payload data");
    assert.ok(out.includes(EXPECTED_SUMMARY), "verbose tool line shows the concise summary");
    for (const fragment of ["uptime_seconds", "total_memory_bytes", "free_memory_bytes"]) {
      assert.equal(out.includes(fragment), false, `CLI verbose must not dump data key: ${fragment}`);
    }
    assert.equal(errBuf.join(""), "");
  } finally {
    app.close();
  }
});

// ---- injected cap hardening (TASK-0011B-F1) -----------------------------------

const INVALID_CAPS = [0, -1, -16384, Number.NaN, Number.POSITIVE_INFINITY];

test("0011B-13: invalid injected caps (0, negative, NaN, Infinity) never omit normal payloads", async () => {
  for (const invalidCap of INVALID_CAPS) {
    const w = buildPayloadWorld({ modelToolResultMaxBytes: invalidCap });
    try {
      const handling = await w.orchestrator.handleProposed(
        [{ id: `call-h-${String(invalidCap)}`, name: "system.status", arguments: {} }],
        w.ctx,
      );
      const payload = parsePayload(handling.toolResultMessages[0]?.content) as {
        data?: unknown;
        data_omitted?: boolean;
      };
      // A 0/negative cap would omit every payload and look "bounded" while
      // being useless; the fallback must keep normal data flowing.
      assert.deepEqual(payload.data, FAKE_STATUS, `cap ${String(invalidCap)} must not omit normal payloads`);
      assert.equal(payload.data_omitted, undefined);
    } finally {
      w.close();
    }
  }
});

test("0011B-14: invalid injected caps (NaN, Infinity, 0) still enforce the default 16 KiB bound", async () => {
  for (const invalidCap of INVALID_CAPS) {
    const w = buildPayloadWorld({ modelToolResultMaxBytes: invalidCap, tools: [BIG_BLOB_TOOL] });
    try {
      const handling = await w.orchestrator.handleProposed(
        [{ id: `call-nan-${String(invalidCap)}`, name: "big.blob", arguments: {} }],
        w.ctx,
      );
      const payload = parsePayload(handling.toolResultMessages[0]?.content) as {
        data?: unknown;
        data_omitted?: boolean;
        reason?: string;
      };
      // NaN would compare false against every size and silently disable the
      // cap; the fallback must keep the default 16 KiB bound active.
      assert.equal(payload.data, undefined, `cap ${String(invalidCap)} must not become unbounded`);
      assert.equal(payload.data_omitted, true);
      assert.equal(payload.reason, TOOL_RESULT_PAYLOAD_TOO_LARGE);
      assert.ok(
        Buffer.byteLength(handling.toolResultMessages[0]?.content ?? "", "utf8") <= MODEL_TOOL_RESULT_MAX_BYTES,
      );
    } finally {
      w.close();
    }
  }
});
