import { test } from "node:test";
import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";

import { FakeProvider } from "../../src/models/providers/fake";
import type { ModelRequest, ModelResult, ModelStreamEvent } from "../../src/models/contracts";
import { buildTestApp, validTurn } from "../helpers";

/**
 * Regression for the proven real-device failure: failed/interrupted/empty
 * persisted assistant turns leaked into model history as
 * { role: "assistant", content: null } with no tool_calls, which DeepSeek
 * rejects with HTTP 400 "Invalid assistant message: content or tool_calls
 * must be set" (surfacing as MODEL_UNAVAILABLE on voice turns).
 *
 * The provider double asserts that no invalid assistant message ever reaches
 * the provider boundary on a NEW streaming turn after such history exists.
 */
test("streaming turn with failed/interrupted empty assistant history sends only valid messages", async () => {
  const seenHistories: ModelRequest["history"][] = [];
  const invalidSeen: string[] = [];

  const provider = new FakeProvider({
    responder: (request: ModelRequest): ModelResult => {
      seenHistories.push(request.history);
      for (const message of request.history) {
        if (message.role !== "assistant") continue;
        const hasText = typeof message.content === "string" && message.content.trim() !== "";
        const hasCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
        if (!hasText && !hasCalls) {
          invalidSeen.push(JSON.stringify({ role: message.role, content: message.content }));
        }
      }
      return { assistant_text: "ok", tool_calls: [], finish_reason: "stop", usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });

  const app = buildTestApp({}, { provider });
  try {
    // Establish the session with one clean completed exchange.
    const first = await app.conversation.handleTurn(validTurn({ message: "hello" }));
    assert.equal(first.status, "completed");

    // Seed the persisted poison exactly as the real device session had it:
    // failed and interrupted assistant turns with empty text. These records
    // stay in the database (audit/debug) - they must only be excluded from
    // model context.
    app.store.createTurn({
      id: `bad-failed-${randomUUID()}`,
      sessionId: first.session_id,
      role: "assistant",
      text: "",
      traceId: "t-bad",
      status: "failed",
      mode: "personal",
    });
    app.store.createTurn({
      id: `bad-interrupted-${randomUUID()}`,
      sessionId: first.session_id,
      role: "assistant",
      text: "",
      traceId: "t-bad",
      status: "interrupted",
      mode: "personal",
    });

    // A NEW streaming turn through the exact voice path.
    const events: string[] = [];
    for await (const event of app.conversation.streamTurn({
      mode: "personal",
      message: "continue",
      session_id: first.session_id,
      client_request_id: `req-${randomUUID()}`,
    })) {
      events.push((event as { type: string }).type);
    }

    assert.equal(invalidSeen.length, 0, `no invalid assistant message may reach the provider; saw: ${invalidSeen.join("; ")}`);
    assert.ok(events.includes("turn_started"), `turn_started expected; events=${events.join(",")}`);
    assert.ok(events.includes("turn_completed"), `turn_completed expected; events=${events.join(",")}`);
    assert.ok(!events.includes("turn_failed"), `turn_failed must not occur; events=${events.join(",")}`);

    // The streamed request's history kept the completed exchange and
    // excluded both poisoned records, in chronological order.
    const lastHistory = seenHistories[seenHistories.length - 1];
    assert.ok(lastHistory, "the provider double must have observed a request");
    assert.deepEqual(
      lastHistory.map((m) => [m.role, m.content]),
      [
        ["user", "hello"],
        ["assistant", "ok"],
      ],
    );
  } finally {
    app.close();
  }
});
