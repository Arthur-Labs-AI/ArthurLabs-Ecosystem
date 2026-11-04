/**
 * Phase 2 secret-safety tests (spec sections 18, 32, 39).
 *
 * Credentials must never be persisted, embedded, or sent to the model;
 * document content is sanitized with the Phase 1 redaction boundary before
 * storage; FTS queries cannot be exploited as injection vectors.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurError } from "../../src/core/errors/errors";
import { hasSecretLikeContent, isCredentialBlob, decideCandidate } from "../../src/memory/policy";
import { buildFtsQuery } from "../../src/memory/retrieval/keyword_search";
import { parseExtractionOutput } from "../../src/memory/extraction/schemas";
import { FakeProvider } from "../../src/models/providers/fake";
import type { ModelRequest, ModelResult } from "../../src/models/contracts";
import { buildTestApp, validTurn } from "../helpers";

const JSON_SECRETS = [
  '{"api_key": "REALLOOKINGKEY123456"}',
  '{"api_key" : "REALLOOKINGKEY123456"}',
  '{"password": "s3cr3t-value"}',
  '{"client_secret": "xyz"}',
  '{"credentials": {"api_key": "NESTEDKEY123456789", "password": "nested-pw"}}',
];
const JSON_SECRET_NEEDLES = ["REALLOOKINGKEY123456", "s3cr3t-value", "NESTEDKEY123456789", "nested-pw"];

async function newSession(app: ReturnType<typeof buildTestApp>, mode: "personal" | "business"): Promise<string> {
  const response = await app.conversation.handleTurn(validTurn({ mode, message: "start" }));
  return response.session_id;
}

test("explicit remember rejects credential-like content before persistence", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    for (const payload of [
      "DEEPSEEK_API_KEY=sk-abcdefghijklmnop",
      "password=hunter2",
      "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\n-----END PRIVATE KEY-----",
    ]) {
      await assert.rejects(
        () => app.memory.remember(session, { text: payload, type: "SEMANTIC" }),
        (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
        `expected rejection for: ${payload.slice(0, 30)}`,
      );
    }
    assert.equal((await app.memory.list(session, { domain: "personal" })).length, 0, "nothing secret may be stored");
  } finally {
    app.close();
  }
});

test("document content is sanitized before persistence", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const content = "Server config: DEEPSEEK_API_KEY=sk-supersecretvalue1234567890 for staging.";
    const doc = await app.memory.ingestDocument(session, { title: "Config", source_type: "text", content }, "sec-doc-1");
    const fetched = await app.memory.getDocument(session, doc.document_id);
    assert.ok(fetched, "document is stored");

    // The raw secret must never appear in any retrieval output.
    const hits = await app.memory.search(session, { query_text: "sk-supersecretvalue1234567890", top_k: 10 });
    for (const hit of hits) assert.ok(!hit.text.includes("sk-supersecretvalue1234567890"), "raw secret must not be retrievable");
    const byConfig = await app.memory.search(session, { query_text: "Server config staging", top_k: 10 });
    assert.ok(byConfig.length >= 1);
    for (const hit of byConfig) assert.ok(!hit.text.includes("sk-supersecretvalue1234567890"), "retrieved text must be sanitized");
    // The persisted memory text itself is redacted, never the raw secret.
    const listed = await app.memory.list(session, { domain: "personal" });
    for (const item of listed) assert.ok(!item.text.includes("sk-supersecretvalue1234567890"), "persisted text must be sanitized");
  } finally {
    app.close();
  }
});

test("JSON-shaped secrets are rejected before persistence, FTS, retrieval, or the model payload (audit F1)", async () => {
  let captured: ModelRequest | undefined;
  const provider = new FakeProvider({
    responder: (req) => {
      captured = req;
      return { assistant_text: "ok", tool_calls: [], finish_reason: "stop", usage: { input_tokens: 1, output_tokens: 1 } } satisfies ModelResult;
    },
  });
  const app = buildTestApp({}, { provider });
  try {
    const session = await newSession(app, "personal");
    for (const payload of JSON_SECRETS) {
      await assert.rejects(
        () => app.memory.remember(session, { text: payload, type: "SEMANTIC", client_request_id: "f1-json" }),
        (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
        `expected rejection for: ${payload.slice(0, 40)}`,
      );
    }
    // Nothing secret may be persisted or listed.
    assert.equal((await app.memory.list(session, { domain: "personal" })).length, 0);
    for (const needle of JSON_SECRET_NEEDLES) {
      const hits = await app.memory.search(session, { query_text: needle, top_k: 20 });
      for (const hit of hits) assert.ok(!hit.text.includes(needle), `${needle} must not be retrievable`);
    }
    // A turn after the rejected writes must not carry the secrets to the model.
    await app.conversation.handleTurn(validTurn({ session_id: session, message: "any deployment credentials?", client_request_id: "f1-payload" }));
    const payload = (captured?.history ?? []).map((m) => m.content).join("\n");
    for (const needle of JSON_SECRET_NEEDLES) assert.ok(!payload.includes(needle), `${needle} must not reach the outbound payload`);
    // Harmless JSON usage fields are still stored normally.
    const ok = await app.memory.remember(session, { text: '{"input_tokens": 123, "token_budget": 200}', type: "SEMANTIC", client_request_id: "f1-json-ok" });
    assert.equal(ok.status, "ACTIVE");
    assert.equal((await app.memory.list(session, { domain: "personal" })).length, 1);
  } finally {
    app.close();
  }
});

test("JSON-shaped secrets in documents are sanitized before persistence (audit F1)", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const content = 'Deployment notes: {"api_key": "REALLOOKINGKEY123456", "password": "s3cr3t-value"} for staging.';
    const doc = await app.memory.ingestDocument(session, { title: "Config", source_type: "text", content }, "f1-doc-json");
    const fetched = await app.memory.getDocument(session, doc.document_id);
    assert.ok(fetched, "the sanitized document is stored");

    for (const needle of ["REALLOOKINGKEY123456", "s3cr3t-value"]) {
      const hits = await app.memory.search(session, { query_text: needle, top_k: 10 });
      for (const hit of hits) assert.ok(!hit.text.includes(needle), `raw secret ${needle} must not be retrievable`);
    }
    // The stored/retrieved content is the redacted form, never the raw value.
    const hits = await app.memory.search(session, { query_text: "Deployment notes staging", top_k: 10 });
    assert.ok(hits.length >= 1);
    for (const hit of hits) {
      assert.ok(!hit.text.includes("REALLOOKINGKEY123456"), "retrieved text must be sanitized");
      assert.ok(hit.text.includes("[REDACTED]"), "retrieved text must carry the redaction marker");
    }
  } finally {
    app.close();
  }
});

test("policy detects credential shapes and extraction candidates with secrets are rejected", () => {
  assert.ok(hasSecretLikeContent("password=hunter2"));
  assert.ok(hasSecretLikeContent("api key: sk-abcdefgh12345678"));
  // JSON-shaped assignments (audit F1) — quoted keys, spaced colons, nesting.
  for (const payload of JSON_SECRETS) {
    assert.ok(hasSecretLikeContent(payload), `JSON secret must be detected: ${payload}`);
  }
  assert.ok(hasSecretLikeContent('{"password" : "s3cr3t-value"}'));
  // Usage fields and prose must not trip the detector.
  assert.ok(!hasSecretLikeContent('{"input_tokens": 123, "token_budget": 200}'));
  assert.ok(!hasSecretLikeContent("the token expired yesterday"));
  assert.ok(!hasSecretLikeContent("the user likes hiking on weekends"));
  assert.ok(isCredentialBlob("sk-abcdefghijklmnopqrstuvwx"));
  assert.ok(!isCredentialBlob("the user likes hiking"));

  const verdict = decideCandidate({ text: "client secret=abc123 is set", confidence: 0.95, importance: 0.9, should_store: true });
  assert.equal(verdict.action, "reject");
});

test("malformed or non-JSON extraction output is discarded", () => {
  assert.deepEqual(parseExtractionOutput("not json at all"), { ok: false, candidates: [] });
  assert.deepEqual(parseExtractionOutput('{"memories": 42}'), { ok: false, candidates: [] });
  // Schema violations are discarded: missing text, out-of-range confidence, unknown type, extra key.
  assert.deepEqual(parseExtractionOutput('{"memories":[{"type":"EPISODIC","confidence":1,"importance":1,"reason":"r","should_store":true}]}'), { ok: false, candidates: [] });
  assert.deepEqual(parseExtractionOutput('{"memories":[{"text":"x","type":"EPISODIC","confidence":1.5,"importance":1,"reason":"r","should_store":true}]}'), { ok: false, candidates: [] });
  assert.deepEqual(parseExtractionOutput('{"memories":[{"text":"x","type":"WIZARD","confidence":1,"importance":1,"reason":"r","should_store":true}]}'), { ok: false, candidates: [] });
  assert.deepEqual(parseExtractionOutput('{"memories":[{"text":"x","type":"EPISODIC","confidence":1,"importance":1,"reason":"r","should_store":true,"extra":"no"}],"bonus":1}'), { ok: false, candidates: [] });
  const valid = parseExtractionOutput(
    '{"memories":[{"text":"The user prefers tea over coffee.","type":"SEMANTIC","confidence":0.9,"importance":0.8,"reason":"explicit statement","should_store":true}]}',
  );
  assert.equal(valid.ok, true);
  assert.equal(valid.candidates.length, 1);
  assert.equal(valid.candidates[0]?.text, "The user prefers tea over coffee.");
});

test("unknown types/statuses are rejected at the API boundary", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const { parseRememberBody, parseListParams } = await import("../../src/memory/api");
    assert.throws(
      () => parseRememberBody({ session_id: session, client_request_id: "x", text: "hi", type: "wizard_magic" }),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
    assert.throws(
      () => parseListParams({ session_id: session, status: "EXPLODED" }),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
  } finally {
    app.close();
  }
});

test("FTS queries are sanitized: FTS syntax cannot be injected through search text", () => {
  // Quotes, operators and wildcards are neutralized by the query builder.
  const safe = buildFtsQuery('a "b" OR c* NEAR(d) -e');
  assert.ok(!safe.includes('NEAR('));
  assert.ok(!safe.includes('-e'));
  assert.ok(!safe.includes('c*'));
  assert.ok(safe.includes('"'), "terms remain quoted literals");
  // Punctuation-only queries produce no FTS query at all.
  assert.equal(buildFtsQuery("*** ??? !!!"), "");
});