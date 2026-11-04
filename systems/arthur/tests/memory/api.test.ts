/**
 * Phase 2 HTTP API tests (spec sections 30, 32).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "../../apps/api/server";
import { buildTestApp, validTurn } from "../helpers";

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("memory HTTP endpoints: remember, search, list, forget, status", async () => {
  const app = buildTestApp();
  const { server, port } = await startServer(app, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    const turn = (await (await postJson(`${base}/v1/turns`, validTurn({ message: "start", client_request_id: "mapi-0" }))).json()) as { session_id: string };
    const sessionId = turn.session_id;

    const remember = await postJson(`${base}/v1/memory/remember`, {
      session_id: sessionId,
      client_request_id: "mapi-1",
      text: "The HTTP API memory test fact about the loft bed.",
      type: "semantic",
    });
    assert.equal(remember.status, 200);
    const item = (await remember.json()) as { id: string; type: string };
    assert.equal(item.type, "SEMANTIC");

    const search = await postJson(`${base}/v1/memory/search`, {
      session_id: sessionId,
      query: "loft bed",
    });
    assert.equal(search.status, 200);
    const searchBody = (await search.json()) as { memories: Array<{ memory_id: string }> };
    assert.equal(searchBody.memories.length, 1);
    assert.equal(searchBody.memories[0]?.memory_id, item.id);

    const list = await fetch(`${base}/v1/memory?session_id=${sessionId}`);
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as { memories: Array<{ id: string }> };
    assert.equal(listBody.memories.length, 1);

    const status = await fetch(`${base}/v1/memory/status?session_id=${sessionId}`);
    assert.equal(status.status, 200);
    const statusBody = (await status.json()) as { personal: { state: string }; embedding: { provider: string } };
    assert.equal(statusBody.personal.state, "healthy");
    assert.equal(statusBody.embedding.provider, "fake");

    const del = await fetch(`${base}/v1/memory/${item.id}?session_id=${sessionId}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const after = await postJson(`${base}/v1/memory/search`, { session_id: sessionId, query: "loft bed" });
    const afterBody = (await after.json()) as { memories: unknown[] };
    assert.equal(afterBody.memories.length, 0);
  } finally {
    server.close();
    app.close();
  }
});

test("memory HTTP endpoints reject client-supplied domain/namespace fields", async () => {
  const app = buildTestApp();
  const { server, port } = await startServer(app, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    const turn = (await (await postJson(`${base}/v1/turns`, validTurn({ client_request_id: "mapi-2" }))).json()) as { session_id: string };
    const sessionId = turn.session_id;

    for (const body of [
      { session_id: sessionId, client_request_id: "x1", text: "hi", type: "semantic", domain: "business" },
      { session_id: sessionId, client_request_id: "x2", text: "hi", type: "semantic", database: "business.db" },
      { session_id: sessionId, client_request_id: "x3", text: "hi", type: "semantic", context_key: "other:business" },
    ]) {
      const response = await postJson(`${base}/v1/memory/remember`, body);
      assert.equal(response.status, 400, `expected rejection for ${JSON.stringify(body)}`);
      const parsed = (await response.json()) as { error: { code: string } };
      assert.equal(parsed.error.code, "INVALID_REQUEST");
    }

    const list = await fetch(`${base}/v1/memory?session_id=${sessionId}`);
    const listBody = (await list.json()) as { memories: unknown[] };
    assert.equal(listBody.memories.length, 0, "nothing may be stored through rejected requests");
  } finally {
    server.close();
    app.close();
  }
});

test("documents HTTP endpoints: add, get, list, delete", async () => {
  const app = buildTestApp();
  const { server, port } = await startServer(app, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    const turn = (await (await postJson(`${base}/v1/turns`, validTurn({ mode: "business", message: "start", client_request_id: "mapi-3" }))).json()) as { session_id: string };
    const sessionId = turn.session_id;

    const add = await postJson(`${base}/v1/documents`, {
      session_id: sessionId,
      client_request_id: "mapi-doc-1",
      title: "API Doc",
      source_type: "text",
      content: "API document content about the greenhouse automation.",
    });
    assert.equal(add.status, 200);
    const doc = (await add.json()) as { document_id: string; chunk_count: number };
    assert.ok(doc.document_id.startsWith("doc-"));

    const get = await fetch(`${base}/v1/documents/${doc.document_id}?session_id=${sessionId}`);
    assert.equal(get.status, 200);
    const got = (await get.json()) as { title: string };
    assert.equal(got.title, "API Doc");

    const search = await postJson(`${base}/v1/memory/search`, { session_id: sessionId, query: "greenhouse automation" });
    const searchBody = (await search.json()) as { memories: Array<{ type: string }> };
    assert.equal(searchBody.memories[0]?.type, "DOCUMENT");

    const del = await fetch(`${base}/v1/documents/${doc.document_id}?session_id=${sessionId}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const getAfter = await fetch(`${base}/v1/documents/${doc.document_id}?session_id=${sessionId}`);
    assert.equal(getAfter.status, 400);
  } finally {
    server.close();
    app.close();
  }
});

test("memory endpoints require an existing session (server-owned mode)", async () => {
  const app = buildTestApp();
  const { server, port } = await startServer(app, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    const response = await postJson(`${base}/v1/memory/remember`, {
      session_id: "no-such-session",
      client_request_id: "x",
      text: "hi",
      type: "semantic",
    });
    assert.equal(response.status, 404);
    const parsed = (await response.json()) as { error: { code: string } };
    assert.equal(parsed.error.code, "SESSION_NOT_FOUND");
  } finally {
    server.close();
    app.close();
  }
});
