import { test } from "node:test";
import assert from "node:assert/strict";

import { ContextBuilder, MODE_CONTRACTS, SYSTEM_CONTRACT } from "../../src/core/conversation/context_builder";
import type { TurnRecord } from "../../src/sessions/models";
import type { ToolSchema } from "../../src/models/contracts";

function turn(id: string, role: "user" | "assistant", text: string): TurnRecord {
  return {
    id,
    session_id: "s1",
    role,
    text,
    created_at: new Date().toISOString(),
    trace_id: "t",
    status: "completed",
    mode: "personal",
  };
}

const schemas: ToolSchema[] = [];

test("build assembles system + mode contracts and history", async () => {
  const builder = new ContextBuilder({ historyMaxTurns: 10, tokenBudget: 10000 });
  const req = await builder.build({
    mode: "personal",
    history: [turn("1", "user", "hello"), turn("2", "assistant", "hi there")],
    toolSchemas: schemas,
    userMessage: "new message",
    model: "fake-model",
    reasoningProfile: "normal",
  });
  assert.equal(req.systemContract, SYSTEM_CONTRACT);
  assert.equal(req.modeContract, MODE_CONTRACTS.personal);
  assert.equal(req.userMessage, "new message");
  assert.deepEqual(
    req.history.map((m) => [m.role, m.content]),
    [
      ["user", "hello"],
      ["assistant", "hi there"],
    ],
  );
});

test("respects the turn count limit (keeps most recent)", async () => {
  const builder = new ContextBuilder({ historyMaxTurns: 2, tokenBudget: 10000 });
  const history = [turn("1", "user", "a"), turn("2", "assistant", "b"), turn("3", "user", "c"), turn("4", "assistant", "d")];
  const req = await builder.build({
    mode: "personal",
    history,
    toolSchemas: schemas,
    userMessage: "now",
    model: "m",
    reasoningProfile: "normal",
  });
  assert.deepEqual(
    req.history.map((m) => m.content),
    ["c", "d"],
  );
});

test("respects the token budget (keeps most recent)", async () => {
  // Each message is ~200 chars => ~50 tokens; budget reserves ~ (system+mode+user)
  const builder = new ContextBuilder({ historyMaxTurns: 100, tokenBudget: 60 });
  const long = "x".repeat(200);
  const history = [turn("1", "user", long), turn("2", "assistant", long), turn("3", "user", long)];
  const req = await builder.build({
    mode: "personal",
    history,
    toolSchemas: schemas,
    userMessage: "now",
    model: "m",
    reasoningProfile: "normal",
  });
  // With a tiny budget, history should be trimmed to nothing (or nearly nothing).
  assert.ok(req.history.length < history.length);
});

test("excludes non user/assistant turns from history", async () => {
  const builder = new ContextBuilder({ historyMaxTurns: 10, tokenBudget: 10000 });
  const req = await builder.build({
    mode: "personal",
    history: [turn("1", "system" as "user", "marker")],
    toolSchemas: schemas,
    userMessage: "now",
    model: "m",
    reasoningProfile: "normal",
  });
  assert.equal(req.history.length, 0);
});
