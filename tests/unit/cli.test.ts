/**
 * DEV-CLI-1: deterministic CLI-focused tests.
 *
 * The CLI runners are exercised in-process through an injected CliIO sink and
 * scripted line sources, so no child process, TTY, or network is involved.
 * Letters reference the DEV-CLI-1 task section 14 test matrix.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  renderCliError,
  renderToolCatalogTable,
  runApprove,
  runAsk,
  runChat,
  runDocumentCommands,
  runMemoryCommands,
  runReject,
  runSession,
  runStatus,
  runTools,
  runToolsInspect,
  type CliIO,
} from "../../apps/cli/index";
import { ArthurError, sessionNotFound } from "../../src/core/errors/errors";
import type { ArthurMode } from "../../src/core/modes/mode";
import type { ModelResult } from "../../src/models/contracts";
import { FakeProvider } from "../../src/models/providers/fake";
import type { LocalSystemAdapter } from "../../src/tools/adapters/local_system";
import { buildTestApp, validTurn } from "../helpers";
import type { App } from "../../src/app";

// ---- fixtures --------------------------------------------------------------

function captureIo(): { io: CliIO; out: () => string; err: () => string } {
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  return {
    io: {
      out: (text) => outBuf.push(text),
      err: (text) => errBuf.push(text),
    },
    out: () => outBuf.join(""),
    err: () => errBuf.join(""),
  };
}

/** Deterministic machine-local adapter: matches the DEV-CLI-1 target example. */
const FAKE_LOCAL_SYSTEM: LocalSystemAdapter = {
  async getStatus() {
    return {
      platform: "win32",
      arch: "x64",
      node_version: "v22.18.0",
      uptime_seconds: 1234,
      cpu_count: 12,
      total_memory_bytes: 32 * 2 ** 30,
      free_memory_bytes: 16 * 2 ** 30,
    };
  },
};

/** Scripted FakeProvider: responses replay in order, the last one repeats. */
function scriptedProvider(responses: ModelResult[]): FakeProvider {
  let call = 0;
  return new FakeProvider({
    id: "fake-scripted",
    modelName: "scripted-model",
    responder: async () => {
      const result = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (result === undefined) {
        throw new Error("scripted provider has no responses");
      }
      return result;
    },
  });
}

const TOOL_PROPOSAL: ModelResult = {
  assistant_text: "Let me check the local system.",
  tool_calls: [{ id: "call-status-1", name: "system.status", arguments: {} }],
  finish_reason: "tool_calls",
};

const FINAL_ANSWER: ModelResult = {
  assistant_text: "Running on Windows x64 with 12 CPUs and 32 GB RAM.",
  tool_calls: [],
  finish_reason: "stop",
};

const JOB_PROPOSAL: ModelResult = {
  assistant_text: "Creating the job.",
  tool_calls: [{ id: "call-job-1", name: "harness.create_job", arguments: { kind: "report" } }],
  finish_reason: "tool_calls",
};

const REJECTED_PROPOSAL: ModelResult = {
  assistant_text: "Let me echo that.",
  tool_calls: [{ id: "call-echo-bad", name: "system.echo", arguments: { wrong: 1 } }],
  finish_reason: "tool_calls",
};

async function chat(
  app: App,
  lines: string[],
  opts: { mode?: ArthurMode; verbose?: boolean; sessionId?: string } = {},
): Promise<{ code: number; out: string; err: string }> {
  const cap = captureIo();
  const code = await runChat(app, {
    mode: opts.mode ?? "personal",
    sessionId: opts.sessionId,
    verbose: opts.verbose,
    io: cap.io,
    lines,
  });
  return { code, out: cap.out(), err: cap.err() };
}

// ---- existing behavior (A-E) ----------------------------------------------

test("A: existing chat flow still works with the default fake provider", async () => {
  const app = buildTestApp();
  try {
    const { code, out, err } = await chat(app, ["hello", "/exit"]);
    assert.equal(code, 0);
    assert.equal(err, "");
    assert.ok(out.includes("ARTHUR Developer Console"));
    assert.ok(out.includes("Mode: PERSONAL"));
    assert.match(out, /\[session id: [^\]]+\]/);
    assert.ok(out.includes("arthur> fake:hello"));
  } finally {
    app.close();
  }
});

test("B: status command output is unchanged safe JSON", () => {
  const app = buildTestApp();
  try {
    const cap = captureIo();
    assert.equal(runStatus(app, { io: cap.io }), 0);
    const parsed = JSON.parse(cap.out());
    assert.equal(parsed.provider, "fake");
    assert.equal(parsed.version, "0.1.0");
    assert.equal(typeof parsed.model, "string");
    assert.equal(typeof parsed.capabilities, "object");
  } finally {
    app.close();
  }
});

test("C: session command prints the same session summary", async () => {
  const app = buildTestApp();
  try {
    const turn = await app.conversation.handleTurn(validTurn({ message: "remember me" }));
    const cap = captureIo();
    assert.equal(await runSession(app, { id: turn.session_id, io: cap.io }), 0);
    const parsed = JSON.parse(cap.out());
    assert.equal(parsed.id, turn.session_id);
    assert.equal(parsed.mode, "personal");
    assert.ok(Array.isArray(parsed.turns));
    assert.ok(parsed.turns.length >= 2);
  } finally {
    app.close();
  }
});

test("D: approve/reject command output is unchanged", async () => {
  const app = buildTestApp({}, { provider: scriptedProvider([JOB_PROPOSAL]) });
  try {
    const ask = captureIo();
    assert.equal(await runAsk(app, { mode: "business", message: "create the job", json: true, io: ask.io }), 0);
    const response = JSON.parse(ask.out());
    assert.equal(response.status, "needs_approval");
    const approvalId: string = response.tool_calls[0].approval_id;
    assert.equal(typeof approvalId, "string");

    const rejectCap = captureIo();
    assert.equal(await runReject(app, { id: approvalId, io: rejectCap.io }), 0);
    const rejected = JSON.parse(rejectCap.out());
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.tool_name, "harness.create_job");
    assert.equal(rejected.approval_id, approvalId);
    assert.equal(typeof rejected.tool_call_id, "string");

    // Approve path on a fresh pending approval executes through the stub.
    const ask2 = captureIo();
    await runAsk(app, { mode: "business", message: "create another job", json: true, io: ask2.io });
    const approvalId2: string = JSON.parse(ask2.out()).tool_calls[0].approval_id;
    const approveCap = captureIo();
    assert.equal(await runApprove(app, { id: approvalId2, io: approveCap.io }), 0);
    const approved = JSON.parse(approveCap.out());
    assert.equal(approved.status, "approved");
    assert.match(approved.result_summary, /job created: job-/);
  } finally {
    app.close();
  }
});

test("E: memory and document commands are unchanged", async () => {
  const app = buildTestApp();
  try {
    const turn = await app.conversation.handleTurn(validTurn({}));
    const flags = new Map([["session", turn.session_id]]);
    const statusCap = captureIo();
    await runMemoryCommands(app, "status", flags, ["memory", "status"], statusCap.io);
    const status = JSON.parse(statusCap.out());
    assert.equal(status.personal.state, "healthy");
    assert.equal(status.business.state, "healthy");
    assert.equal(typeof status.embedding.provider, "string");

    const docsCap = captureIo();
    await runDocumentCommands(app, "list", flags, ["documents", "list"], docsCap.io);
    assert.deepEqual(JSON.parse(docsCap.out()), { documents: [] });
  } finally {
    app.close();
  }
});

// ---- tool catalog (F-K) ----------------------------------------------------

test("F: tools lists all four current tools", () => {
  const app = buildTestApp();
  try {
    const cap = captureIo();
    assert.equal(runTools(app, { io: cap.io }), 0);
    const out = cap.out();
    for (const name of ["system.echo", "system.status", "harness.status", "harness.create_job"]) {
      assert.ok(out.includes(name), `catalog must include ${name}`);
    }
    assert.match(out, /NAME\s+VERSION\s+RISK\s+MODES/);
    assert.match(out, /harness\.create_job\s+1\.0\.0\s+approval_required\s+business/);
  } finally {
    app.close();
  }
});

test("G: personal mode filter excludes harness.create_job", () => {
  const app = buildTestApp();
  try {
    const cap = captureIo();
    assert.equal(runTools(app, { mode: "personal", io: cap.io }), 0);
    const out = cap.out();
    assert.ok(!out.includes("harness.create_job"));
    assert.match(out, /system\.status\s+1\.0\.0\s+read\s+personal,business/);
  } finally {
    app.close();
  }
});

test("H: business mode filter includes harness.create_job", () => {
  const app = buildTestApp();
  try {
    const cap = captureIo();
    assert.equal(runTools(app, { mode: "business", io: cap.io }), 0);
    assert.ok(cap.out().includes("harness.create_job"));
  } finally {
    app.close();
  }
});

test("I: tools inspect system.status shows the safe manifest", () => {
  const app = buildTestApp();
  try {
    const cap = captureIo();
    assert.equal(runToolsInspect(app, { name: "system.status", io: cap.io }), 0);
    const manifest = JSON.parse(cap.out());
    assert.equal(manifest.name, "system.status");
    assert.equal(manifest.version, "1.0.0");
    assert.equal(manifest.risk, "read");
    assert.deepEqual(manifest.allowed_modes, ["personal", "business"]);
    assert.equal(typeof manifest.description, "string");
    assert.equal(manifest.input_schema.type, "object");
    assert.equal(manifest.output_schema.type, "object");
  } finally {
    app.close();
  }
});

test("J: inspection never exposes executor/adapter/internal fields", () => {
  const app = buildTestApp();
  try {
    const cap = captureIo();
    runToolsInspect(app, { name: "system.status", io: cap.io });
    const manifest = JSON.parse(cap.out());
    assert.deepEqual(Object.keys(manifest).sort(), [
      "allowed_modes",
      "description",
      "input_schema",
      "name",
      "output_schema",
      "risk",
      "version",
    ]);
    const text = cap.out().toLowerCase();
    for (const banned of ["executor", "adapter", "invoker", "signature", "approvaltoken", "node_modules", "d:\\"]) {
      assert.ok(!text.includes(banned), `manifest must not contain ${banned}`);
    }
    // (Frozen-ness cannot survive JSON serialization; it is asserted below on
    // the objects the service actually returns.)

    // Catalog snapshots are cloned+frozen: mutating one never changes runtime.
    const snapshot = app.conversation.getToolDefinition("system.echo");
    assert.ok(snapshot);
    try {
      (snapshot as { risk: string }).risk = "high_risk";
    } catch {
      // frozen in strict mode: assignment throws
    }
    const fresh = app.conversation.getToolDefinition("system.echo");
    assert.ok(fresh);
    assert.equal(fresh.risk, "read");
    assert.notEqual(snapshot, fresh);

    const listed = app.conversation.listTools();
    assert.equal(listed.length, 4);
    assert.ok(listed.every((d) => Object.isFrozen(d)));
  } finally {
    app.close();
  }
});

test("K: unknown tool inspection fails cleanly", () => {
  const app = buildTestApp();
  try {
    const cap = captureIo();
    const code = runToolsInspect(app, { name: "ghost.tool", io: cap.io });
    assert.equal(code, 1);
    assert.ok(cap.err().includes("error [TOOL_NOT_FOUND]"));
    assert.ok(cap.err().includes("ghost.tool"));
    assert.equal(cap.out(), "");
  } finally {
    app.close();
  }
});

// ---- verbose rendering (L-O) ----------------------------------------------

test("L: verbose chat renders a completed system.status lifecycle", async () => {
  const app = buildTestApp(
    {},
    { provider: scriptedProvider([TOOL_PROPOSAL, FINAL_ANSWER]), localSystem: FAKE_LOCAL_SYSTEM },
  );
  try {
    const { out, err } = await chat(app, ["What machine are you running on?", "/exit"], { verbose: true });
    assert.equal(err, "");
    assert.match(out, /\[session\] \S+/);
    assert.ok(out.includes("[tool] system.status"));
    assert.ok(out.includes("       status: completed"));
    assert.ok(out.includes("       risk: read"));
    assert.ok(out.includes("       summary: Local system: win32 x64, Node v22.18.0, 12 CPUs, 32 GB RAM"));
    assert.ok(out.includes("arthur> Running on Windows x64 with 12 CPUs and 32 GB RAM."));
  } finally {
    app.close();
  }
});

test("M: verbose chat renders a rejected tool call", async () => {
  const app = buildTestApp({}, { provider: scriptedProvider([REJECTED_PROPOSAL]) });
  try {
    const { out, err } = await chat(app, ["echo something", "/exit"], { verbose: true });
    assert.equal(err, "");
    assert.ok(out.includes("[tool] system.echo"));
    assert.ok(out.includes("       status: rejected"));
    assert.ok(out.includes("       summary: invalid arguments"));
    assert.ok(!out.includes("stack"));
  } finally {
    app.close();
  }
});

test("N: verbose chat renders a pending approval without any approval token", async () => {
  const app = buildTestApp({}, { provider: scriptedProvider([JOB_PROPOSAL]) });
  try {
    const { out, err } = await chat(app, ["create the job"], { mode: "business", verbose: true });
    assert.equal(err, "");
    assert.ok(out.includes("[tool] harness.create_job"));
    assert.ok(out.includes("       status: pending_approval"));
    assert.ok(out.includes("       risk: approval_required"));
    assert.match(out, /       approval: \S+/);
    assert.ok(out.includes("[pending approval]"));
    assert.ok(out.includes("approve with:"));
    assert.ok(out.includes("npm run cli -- approve "));
    assert.ok(!/[0-9a-f]{64}/i.test(out), "no 64-hex signature material may be printed");
    assert.ok(!out.toLowerCase().includes("signature"));
    assert.ok(!out.toLowerCase().includes("token"));
  } finally {
    app.close();
  }
});

test("O: verbose output contains no configured secrets", async () => {
  const secret = "cli-configured-secret-987";
  const app = buildTestApp(
    { deepseekApiKey: secret },
    { provider: scriptedProvider([TOOL_PROPOSAL, FINAL_ANSWER]), localSystem: FAKE_LOCAL_SYSTEM },
  );
  try {
    const { out, err } = await chat(app, ["What machine are you running on?", "/exit"], { verbose: true });
    assert.ok(out.length > 0);
    assert.ok(!out.includes(secret));
    assert.ok(!err.includes(secret));
  } finally {
    app.close();
  }
});

// ---- interactive slash commands (P-U) --------------------------------------

test("P: /status shows safe runtime status without secrets", async () => {
  const app = buildTestApp({ deepseekApiKey: "cli-configured-secret-987" });
  try {
    const { out, err } = await chat(app, ["/status", "/exit"]);
    assert.equal(err, "");
    assert.ok(out.includes("Mode: PERSONAL"));
    assert.ok(out.includes("Session: new"));
    assert.ok(out.includes("Provider: fake"));
    assert.ok(out.includes("Model: fake-model"), "configured model is shown without secrets");
    assert.ok(out.includes("Memory: disabled"));
    assert.ok(!out.includes("cli-configured-secret-987"));
  } finally {
    app.close();
  }
});

test("Q: /session shows the current session id and mode", async () => {
  const app = buildTestApp();
  try {
    const fresh = await chat(app, ["/session", "/exit"]);
    assert.ok(fresh.out.includes("Session: new"));
    assert.ok(fresh.out.includes("Mode: PERSONAL"));

    const { out } = await chat(app, ["hello", "/session", "/exit"]);
    const shownId = out.match(/\[session id: ([^\]]+)\]/)?.[1] ?? "";
    assert.ok(shownId !== "", "first-turn session id line missing");
    assert.ok(out.includes(`Session: ${shownId}`));
    assert.ok(out.includes("Mode: PERSONAL"));
  } finally {
    app.close();
  }
});

test("R: /tools lists tools for the current mode", async () => {
  const app = buildTestApp();
  try {
    const { out, err } = await chat(app, ["/tools", "/exit"]);
    assert.equal(err, "");
    for (const name of ["system.echo", "system.status", "harness.status"]) {
      assert.ok(out.includes(name), `must include ${name}`);
    }
    assert.ok(!out.includes("harness.create_job"), "personal mode must not offer business-only tools");
  } finally {
    app.close();
  }
});

test("S: /tool shows the safe manifest; unknown names fail cleanly", async () => {
  const app = buildTestApp();
  try {
    const { out, err } = await chat(app, ["/tool system.status", "/exit"]);
    assert.equal(err, "");
    const start = out.indexOf("{");
    assert.ok(start >= 0);
    const manifest = JSON.parse(out.slice(start));
    assert.equal(manifest.name, "system.status");
    assert.equal(manifest.risk, "read");

    const unknown = await chat(app, ["/tool ghost.tool", "/exit"]);
    assert.ok(unknown.err.includes("error [TOOL_NOT_FOUND]"));
    assert.equal(unknown.out.indexOf("{"), -1);
  } finally {
    app.close();
  }
});

test("T: /new starts a new session on the next message and keeps the old one", async () => {
  const app = buildTestApp();
  try {
    const { out } = await chat(app, ["hello one", "/new", "hello two"]);
    assert.ok(out.includes("Session cleared."));
    const ids = [...out.matchAll(/\[session id: ([^\]]+)\]/g)].map((m) => m[1] ?? "");
    assert.equal(ids.length, 2);
    const id0 = ids[0] ?? "";
    const id1 = ids[1] ?? "";
    assert.ok(id0 !== "" && id1 !== "");
    assert.notEqual(id0, id1);
    // The old session is NOT deleted.
    const kept = await app.conversation.getSession(id0);
    assert.equal(kept.id, id0);
  } finally {
    app.close();
  }
});

test("U: /exit leaves the console; plain exit still works", async () => {
  const app = buildTestApp();
  try {
    const first = await chat(app, ["/exit", "hello after exit"]);
    assert.equal(first.code, 0);
    assert.ok(!first.out.includes("fake:hello after exit"), "no turn may run after /exit");

    const second = await chat(app, ["exit", "hello after plain exit"]);
    assert.equal(second.code, 0);
    assert.ok(!second.out.includes("fake:hello after plain exit"));
  } finally {
    app.close();
  }
});

// ---- one-shot ask (V-X) ----------------------------------------------------

test("V: ask calls ConversationService and prints only the final answer", async () => {
  const app = buildTestApp();
  try {
    const cap = captureIo();
    const code = await runAsk(app, { mode: "personal", message: "Hello there", io: cap.io });
    assert.equal(code, 0);
    assert.equal(cap.out(), "fake:Hello there\n");
    assert.equal(cap.err(), "");
    // handleTurn really persisted a session (ConversationService path).
    const cap2 = captureIo();
    await runAsk(app, { mode: "personal", message: "Second turn", verbose: true, io: cap2.io });
    const sessionId = cap2.out().match(/\[session\] (\S+)/)?.[1];
    assert.ok(sessionId);
    const session = await app.conversation.getSession(sessionId);
    assert.equal(session.mode, "personal");
  } finally {
    app.close();
  }
});

test("W: scripted tool proposal produces a visible system.status lifecycle in verbose ask", async () => {
  const app = buildTestApp(
    {},
    { provider: scriptedProvider([TOOL_PROPOSAL, FINAL_ANSWER]), localSystem: FAKE_LOCAL_SYSTEM },
  );
  try {
    const cap = captureIo();
    const code = await runAsk(app, {
      mode: "personal",
      message: "Check the local system status.",
      verbose: true,
      io: cap.io,
    });
    assert.equal(code, 0);
    const out = cap.out();
    assert.match(out, /\[session\] \S+/);
    assert.ok(out.includes("[tool] system.status"));
    assert.ok(out.includes("       status: completed"));
    assert.ok(out.includes("       risk: read"));
    assert.ok(out.includes("       summary: Local system: win32 x64, Node v22.18.0, 12 CPUs, 32 GB RAM"));
    assert.ok(out.includes("Running on Windows x64 with 12 CPUs and 32 GB RAM."));
  } finally {
    app.close();
  }
});

test("X: the final assistant response is printed for one-shot ask", async () => {
  const app = buildTestApp(
    {},
    { provider: scriptedProvider([TOOL_PROPOSAL, FINAL_ANSWER]), localSystem: FAKE_LOCAL_SYSTEM },
  );
  try {
    const cap = captureIo();
    const code = await runAsk(app, { mode: "personal", message: "Check status", io: cap.io });
    assert.equal(code, 0);
    assert.equal(cap.out(), "Running on Windows x64 with 12 CPUs and 32 GB RAM.\n");
  } finally {
    app.close();
  }
});

// ---- machine-readable mode (Y-AA) ------------------------------------------

test("Y: tools --json is valid JSON and honors the mode filter", () => {
  const app = buildTestApp();
  try {
    const cap = captureIo();
    assert.equal(runTools(app, { json: true, io: cap.io }), 0);
    const parsed = JSON.parse(cap.out());
    assert.ok(Array.isArray(parsed.tools));
    assert.deepEqual(
      parsed.tools.map((t: { name: string }) => t.name),
      ["harness.create_job", "harness.status", "system.echo", "system.status"],
    );

    const cap2 = captureIo();
    assert.equal(runTools(app, { mode: "personal", json: true, io: cap2.io }), 0);
    const parsed2 = JSON.parse(cap2.out());
    assert.ok(!parsed2.tools.some((t: { name: string }) => t.name === "harness.create_job"));
  } finally {
    app.close();
  }
});

test("Z: ask --json is valid JSON with final response and safe tool summaries", async () => {
  const app = buildTestApp(
    {},
    { provider: scriptedProvider([TOOL_PROPOSAL, FINAL_ANSWER]), localSystem: FAKE_LOCAL_SYSTEM },
  );
  try {
    const cap = captureIo();
    const code = await runAsk(app, { mode: "personal", message: "Check status", json: true, io: cap.io });
    assert.equal(code, 0);
    const parsed = JSON.parse(cap.out());
    assert.equal(parsed.status, "completed");
    assert.equal(parsed.display_text, "Running on Windows x64 with 12 CPUs and 32 GB RAM.");
    assert.equal(parsed.mode, "personal");
    assert.equal(typeof parsed.session_id, "string");
    assert.equal(parsed.tool_calls.length, 1);
    assert.equal(parsed.tool_calls[0].name, "system.status");
    assert.equal(parsed.tool_calls[0].status, "completed");
    assert.equal(parsed.tool_calls[0].risk, "read");
    assert.match(parsed.tool_calls[0].result_summary, /Local system: win32 x64/);
  } finally {
    app.close();
  }
});

test("AA: JSON output contains no banner, prompt text, or ANSI decoration", async () => {
  const app = buildTestApp(
    {},
    { provider: scriptedProvider([TOOL_PROPOSAL, FINAL_ANSWER]), localSystem: FAKE_LOCAL_SYSTEM },
  );
  try {
    const toolsCap = captureIo();
    runTools(app, { json: true, io: toolsCap.io });
    const askCap = captureIo();
    await runAsk(app, { mode: "personal", message: "Check status", json: true, io: askCap.io });
    const inspectCap = captureIo();
    runToolsInspect(app, { name: "system.status", json: true, io: inspectCap.io });

    for (const text of [toolsCap.out(), askCap.out(), inspectCap.out()]) {
      assert.ok(!text.includes("ARTHUR Developer Console"));
      assert.ok(!text.includes("you>"));
      assert.ok(!text.includes("arthur>"));
      assert.ok(!text.includes("Type /help"));
      assert.ok(!text.includes("\u001b"), "no ANSI escape sequences");
    }
  } finally {
    app.close();
  }
});

// ---- argument parsing and rendering helpers --------------------------------

test("boolean flags never swallow the following positional", () => {
  const parsed = parseArgs(["ask", "--verbose", "Check the system", "--json"]);
  assert.equal(parsed.command, "ask");
  assert.equal(parsed.flags.get("verbose"), "true");
  assert.equal(parsed.flags.get("json"), "true");
  assert.deepEqual(parsed.positionals, ["ask", "Check the system"]);

  const valued = parseArgs(["chat", "--mode", "business", "--session", "s1"]);
  assert.equal(valued.flags.get("mode"), "business");
  assert.equal(valued.flags.get("session"), "s1");

  const eq = parseArgs(["tools", "--mode=personal", "--json"]);
  assert.equal(eq.flags.get("mode"), "personal");
  assert.equal(eq.flags.get("json"), "true");
});

test("catalog table columns align deterministically", () => {
  const app = buildTestApp();
  try {
    const table = renderToolCatalogTable(app.conversation.listTools());
    const lines = table.split("\n");
    assert.equal(lines.length, 5);
    const header = lines[0] ?? "";
    assert.match(header, /^NAME\s+VERSION\s+RISK\s+MODES$/);
    assert.equal(header.indexOf("VERSION"), 20, "name column matches the longest tool name");
    assert.equal(header.indexOf("RISK"), 29);
  } finally {
    app.close();
  }
});

// ---- pre-existing CLI tests (unchanged) ------------------------------------

test("CLI error rendering uses the configured public sanitization boundary", () => {
  const secret = "cli-configured-secret-987";
  const app = buildTestApp({ deepseekApiKey: secret });
  try {
    const output = renderCliError(sessionNotFound(secret), app);
    assert.ok(output.includes("SESSION_NOT_FOUND"));
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes("stack"));
  } finally {
    app.close();
  }
});

test("CLI generic rendering redacts credential shapes and preserves codes", () => {
  const github = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const output = renderCliError(new ArthurError("INVALID_REQUEST", `bad request ${github}`));
  assert.ok(output.includes("INVALID_REQUEST"));
  assert.ok(!output.includes(github));
});
