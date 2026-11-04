/**
 * Phase 2 isolation tests (spec sections 4, 5, 8, 27, 32, 37).
 *
 * The North Star: any attempt to cross Personal/Business memory boundaries —
 * by the client, the model, or a failing store — fails closed before retrieval
 * or persistence occurs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurError } from "../../src/core/errors/errors";
import { FakeProvider } from "../../src/models/providers/fake";
import type { ModelRequest, ModelResult } from "../../src/models/contracts";
import { buildTestApp, validTurn } from "../helpers";

const PERSONAL_SENTINEL = "PERSONAL_SENTINEL_ZULU";
const BUSINESS_SENTINEL = "BUSINESS_SENTINEL_OSCAR";

function result(text: string, tool_calls: ModelResult["tool_calls"] = []): ModelResult {
  return { assistant_text: text, tool_calls, finish_reason: "stop", usage: { input_tokens: 1, output_tokens: 1 } };
}

async function newSession(app: ReturnType<typeof buildTestApp>, mode: "personal" | "business"): Promise<string> {
  const response = await app.conversation.handleTurn(validTurn({ mode, message: "start" }));
  return response.session_id;
}

test("personal retrieval never returns business memories (sentinel isolation)", async () => {
  const app = buildTestApp();
  try {
    const personalSession = await newSession(app, "personal");
    const businessSession = await newSession(app, "business");

    await app.memory.remember(personalSession, {
      text: `The user's favorite plant is ${PERSONAL_SENTINEL} fern`,
      type: "SEMANTIC",
      client_request_id: "iso-1",
    });
    await app.memory.remember(businessSession, {
      text: `The Q3 budget target is ${BUSINESS_SENTINEL}`,
      type: "SEMANTIC",
      client_request_id: "iso-2",
    });

    // Content-level isolation: whatever a weak local embedding channel
    // retrieves, no personal result may ever contain business data.
    const personalHits = await app.memory.search(personalSession, { query_text: BUSINESS_SENTINEL, top_k: 20 });
    for (const hit of personalHits) {
      assert.ok(!hit.text.includes(BUSINESS_SENTINEL), "personal search must not return business memory");
      assert.ok(!hit.text.includes("Q3 budget"), "personal search must not return business memory");
    }
    assert.ok(personalHits.every((h) => h.memory_id !== undefined));

    const businessHits = await app.memory.search(businessSession, { query_text: PERSONAL_SENTINEL, top_k: 20 });
    for (const hit of businessHits) {
      assert.ok(!hit.text.includes(PERSONAL_SENTINEL), "business search must not return personal memory");
      assert.ok(!hit.text.includes("favorite plant"), "business search must not return personal memory");
    }
  } finally {
    app.close();
  }
});

test("personal session cannot read or delete a business memory id it knows", async () => {
  const app = buildTestApp();
  try {
    const personalSession = await newSession(app, "personal");
    const businessSession = await newSession(app, "business");

    const businessMemory = await app.memory.remember(businessSession, {
      text: "Confidential business plan details for Project Kappa",
      type: "SEMANTIC",
      client_request_id: "iso-3",
    });

    // Cross-domain delete must fail closed.
    await assert.rejects(
      () => app.memory.forget(personalSession, businessMemory.id),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );

    // The business memory is still there and still retrievable in business mode.
    const hits = await app.memory.search(businessSession, { query_text: "Confidential business plan details for Project Kappa" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.memory_id, businessMemory.id);
  } finally {
    app.close();
  }
});

test("client-supplied fake namespace/domain fields are rejected by validation", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    // The remember endpoint schema is strict: domain/namespace/context_key are
    // not accepted fields, so a client cannot steer the store.
    const response = await app.conversation.handleTurn(
      validTurn({ session_id: session, message: "second" }),
    );
    assert.equal(response.status, "completed");

    // Directly exercising the API validation boundary:
    const { parseRememberBody } = await import("../../src/memory/api");
    assert.throws(
      () => parseRememberBody({
        session_id: session,
        client_request_id: "x",
        text: "hello",
        type: "semantic",
        domain: "business", // attacker-supplied namespace
      }),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
    assert.throws(
      () => parseRememberBody({
        session_id: session,
        client_request_id: "x",
        text: "hello",
        type: "semantic",
        database: "business.db",
      }),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
  } finally {
    app.close();
  }
});

test("memory gateway derives the domain only from the trusted session record", async () => {
  const app = buildTestApp();
  try {
    const personalSession = await newSession(app, "personal");
    const item = await app.memory.remember(personalSession, { text: "Trusted session routing marker", type: "SEMANTIC" });
    assert.equal(item.domain, "personal");

    // A business session's session record always resolves to the business store.
    const businessSession = await newSession(app, "business");
    const businessItem = await app.memory.remember(businessSession, { text: "Trusted session routing marker", type: "SEMANTIC" });
    assert.equal(businessItem.domain, "business");
    assert.notEqual(businessItem.id, item.id);
  } finally {
    app.close();
  }
});

test("mode-safe context: DeepSeek payload carries only the active domain memory", async () => {
  let captured: ModelRequest | undefined;
  const provider = new FakeProvider({
    responder: (req) => {
      captured = req;
      return result("ok");
    },
  });
  const app = buildTestApp({}, { provider });
  try {
    const personalSession = await newSession(app, "personal");
    const businessSession = await newSession(app, "business");

    await app.memory.remember(personalSession, { text: `Personal fact ${PERSONAL_SENTINEL}`, type: "SEMANTIC" });
    await app.memory.remember(businessSession, { text: `Business fact ${BUSINESS_SENTINEL}`, type: "SEMANTIC" });

    // Personal turn: the query overlaps the personal memory so retrieval
    // returns it; the payload must then carry it — and never business data.
    await app.conversation.handleTurn(validTurn({ session_id: personalSession, message: "Personal fact please", client_request_id: "payload-1" }));
    const personalHistory = captured?.history.map((m) => m.content).join("\n") ?? "";
    assert.ok(personalHistory.includes(PERSONAL_SENTINEL), "personal payload should include personal memory");
    assert.ok(!personalHistory.includes(BUSINESS_SENTINEL), "personal payload must not include business memory");
    assert.ok(personalHistory.includes('<memory domain="personal">'), "memory block is labeled with the personal domain");

    // Business turn: same-domain memory is carried, personal memory is not.
    await app.conversation.handleTurn(validTurn({ session_id: businessSession, mode: "business", message: "Business fact please", client_request_id: "payload-2" }));
    const businessHistory = captured?.history.map((m) => m.content).join("\n") ?? "";
    assert.ok(businessHistory.includes(BUSINESS_SENTINEL), "business payload should include business memory");
    assert.ok(!businessHistory.includes(PERSONAL_SENTINEL), "business payload must not include personal memory");
    assert.ok(businessHistory.includes('<memory domain="business">'), "memory block is labeled with the business domain");
  } finally {
    app.close();
  }
});

test("failing personal store degrades personal memory only; business keeps working", async () => {
  const app = buildTestApp();
  try {
    const personalSession = await newSession(app, "personal");
    const businessSession = await newSession(app, "business");

    await app.memory.remember(personalSession, { text: "personal surviving fact", type: "SEMANTIC" });
    await app.memory.remember(businessSession, { text: "business surviving fact", type: "SEMANTIC" });

    // Close the personal store while the gateway is still used: personal
    // operations must fail (or degrade) — never fall back to business.
    const gateway = (app.memory as unknown as { gateway: { close: () => void } }).gateway;
    const personalStore = (gateway as unknown as { personal: { close: () => void } }).personal;
    personalStore.close();

    // Fail closed: a dead personal store yields NO personal memory (degraded
    // no-memory mode) — it never throws into the conversation and never serves
    // business data as a fallback.
    const personalHits = await app.memory.search(personalSession, { query_text: "personal surviving fact" });
    assert.equal(personalHits.length, 0, "personal retrieval must fail closed when the personal store is unavailable");

    // Business domain is unaffected and must not serve personal memory.
    const businessHits = await app.memory.search(businessSession, { query_text: "personal surviving fact", top_k: 20 });
    for (const hit of businessHits) {
      assert.ok(!hit.text.includes("personal surviving fact"), "business store must never serve personal memory as fallback");
    }
  } finally {
    app.close();
  }
});

test("model-proposed tool arguments cannot override the memory domain (no memory tools exist)", async () => {
  const provider = new FakeProvider({
    responder: () =>
      result("I will use the memory tool", [
        {
          id: "call-1",
          name: "memory_write",
          arguments: { text: "steal business data", domain: "business", session_id: "fake-session" },
        },
      ]),
  });
  const app = buildTestApp({}, { provider });
  try {
    const personalSession = await newSession(app, "personal");
    const response = await app.conversation.handleTurn(
      validTurn({ session_id: personalSession, message: "try to write memory", client_request_id: "tool-1" }),
    );
    // Unknown tool -> rejected; no memory was written.
    assert.ok(response.tool_calls.some((t) => t.status === "rejected"), "unregistered memory tool must be rejected");
    const memories = await app.memory.list(personalSession, { domain: "personal" });
    assert.equal(memories.length, 0, "no memory may be written through a tool call");
  } finally {
    app.close();
  }
});