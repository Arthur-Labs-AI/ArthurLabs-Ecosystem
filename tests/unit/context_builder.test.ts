import { test } from "node:test";
import assert from "node:assert/strict";

import { ContextBuilder, MODE_CONTRACTS, SYSTEM_CONTRACT } from "../../src/core/conversation/context_builder";
import { estimateTokens } from "../../src/observability/usage";
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

// ---- history eligibility: failed/interrupted/empty turns are poison -----

function turnWithStatus(id: string, role: "user" | "assistant", text: string, status: string): TurnRecord {
  return {
    id,
    session_id: "s1",
    role,
    text,
    created_at: new Date().toISOString(),
    trace_id: "t",
    status,
    mode: "personal",
  };
}

test("history eligibility: only completed non-empty user/assistant turns reach the model", async () => {
  const builder = new ContextBuilder({ historyMaxTurns: 20, tokenBudget: 10000 });
  const history: TurnRecord[] = [
    turn("1", "user", "hello"),
    turn("2", "assistant", "hi"),
    turn("3", "user", "bad turn"),
    turnWithStatus("4", "assistant", "", "failed"),
    turn("5", "user", "continue"),
    turnWithStatus("6", "assistant", "", "interrupted"),
    turn("7", "user", "current context"),
  ];
  const req = await builder.build({
    mode: "personal",
    history,
    toolSchemas: schemas,
    userMessage: "go on",
    model: "m",
    reasoningProfile: "normal",
  });
  // Chronological order preserved; failed/interrupted/empty turns excluded.
  assert.deepEqual(
    req.history.map((m) => [m.role, m.content]),
    [
      ["user", "hello"],
      ["assistant", "hi"],
      ["user", "bad turn"],
      ["user", "continue"],
      ["user", "current context"],
    ],
  );
  assert.ok(
    !req.history.some((m) => m.role === "assistant" && m.content.trim() === ""),
    "no empty assistant content may reach the model (DeepSeek 400: content or tool_calls must be set)",
  );
});

test("history eligibility: bad turns do not consume historyMaxTurns slots", async () => {
  const builder = new ContextBuilder({ historyMaxTurns: 3, tokenBudget: 10000 });
  const history: TurnRecord[] = [
    turnWithStatus("f1", "assistant", "", "failed"),
    turn("1", "user", "a"),
    turnWithStatus("f2", "assistant", "", "interrupted"),
    turn("2", "assistant", "b"),
    turn("3", "user", "c"),
    turnWithStatus("f3", "assistant", "", "failed"),
    turn("4", "assistant", "d"),
    turn("5", "user", "e"),
  ];
  const req = await builder.build({
    mode: "personal",
    history,
    toolSchemas: schemas,
    userMessage: "now",
    model: "m",
    reasoningProfile: "normal",
  });
  // The 3 most recent ELIGIBLE turns survive - not the last 3 raw records.
  assert.deepEqual(req.history.map((m) => m.content), ["c", "d", "e"]);
});

test("history eligibility: bad turns do not consume the token budget", async () => {
  // Budget covers the contracts, the user message, and a 30-token margin -
  // enough for the two short good turns, far too little for the bad turn.
  const reserved =
    estimateTokens(SYSTEM_CONTRACT) + estimateTokens(MODE_CONTRACTS.personal) + estimateTokens("now");
  const builder = new ContextBuilder({ historyMaxTurns: 100, tokenBudget: reserved + 30 });
  // The failed turn is the MOST RECENT record: the budget walk considers it
  // first, so a pre-fix implementation spends the whole margin on it.
  const history: TurnRecord[] = [
    turn("1", "user", "keep me"),
    turn("2", "assistant", "and me"),
    turnWithStatus("bad", "assistant", "x".repeat(2000), "failed"),
  ];
  const req = await builder.build({
    mode: "personal",
    history,
    toolSchemas: schemas,
    userMessage: "now",
    model: "m",
    reasoningProfile: "normal",
  });
  // The huge FAILED turn must not eat the budget and starve good turns.
  assert.deepEqual(req.history.map((m) => m.content), ["keep me", "and me"]);
});

test("history eligibility: needs_approval and in-progress-style statuses are excluded", async () => {
  const builder = new ContextBuilder({ historyMaxTurns: 20, tokenBudget: 10000 });
  const history: TurnRecord[] = [
    turn("1", "user", "hello"),
    turnWithStatus("2", "assistant", "pending text", "needs_approval"),
    turn("3", "user", "next"),
  ];
  const req = await builder.build({
    mode: "personal",
    history,
    toolSchemas: schemas,
    userMessage: "go",
    model: "m",
    reasoningProfile: "normal",
  });
  assert.deepEqual(
    req.history.map((m) => [m.role, m.content]),
    [["user", "hello"], ["user", "next"]],
  );
});
