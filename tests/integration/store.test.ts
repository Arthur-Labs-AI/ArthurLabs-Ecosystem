import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { SessionStore } from "../../src/sessions/store";
import { argumentsDigest } from "../../src/tools/permissions";

import { buildTestApp, validTurn } from "../helpers";
import { createLegacyPhase1Database } from "../fixtures/phase1-legacy-schema";

function workspaceTempDir(): string {
  // Prefer the workspace so sandbox write policy always applies; fall back to OS tmp.
  const base = process.cwd();
  try {
    return mkdtempSync(join(base, "data", "arthur-test-"));
  } catch {
    return mkdtempSync(join(tmpdir(), "arthur-test-"));
  }
}

test("session history persists across store reopen (restart)", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");

  const app1 = buildTestApp({ dbPath });
  const first = await app1.conversation.handleTurn(validTurn({ message: "persist me" }));
  const sessionId = first.session_id;
  app1.close();

  // "Restart": open a fresh app on the same database file.
  const app2 = buildTestApp({ dbPath });
  const summary = await app2.conversation.getSession(sessionId);
  assert.equal(summary.id, sessionId);
  assert.ok(summary.turns.some((t) => t.role === "user" && t.text === "persist me"));
  assert.ok(summary.turns.some((t) => t.role === "assistant"));
  app2.close();

  rmSync(dir, { recursive: true, force: true });
});



test("original Phase 1 database upgrades forward with data and restart safety", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "legacy.db");
  createLegacyPhase1Database(dbPath);

  const before = new DatabaseSync(dbPath);
  const initialCounts = Object.fromEntries(
    ["sessions", "turns", "model_calls", "tool_calls", "approvals"].map((table) => [
      table,
      Number((before.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count),
    ]),
  );
  before.close();

  const first = buildTestApp({ dbPath });
  const original = await first.conversation.getSession("legacy-session");
  assert.equal(original.turns[0]?.text, "legacy text");
  assert.equal(original.turns[0]?.mode, "personal");
  assert.ok(first.store.getModelCallsForTurn("legacy-turn").some((call) => call.id === "legacy-model"));
  assert.ok(first.store.getToolCall("legacy-tool"));
  assert.ok(first.store.getApproval("legacy-approval"));

  const upgraded = new DatabaseSync(dbPath);
  for (const [table, expected] of Object.entries(initialCounts)) {
    const actual = Number((upgraded.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    assert.equal(actual, expected, `${table} row count changed during migration`);
  }
  assert.equal((upgraded.prepare("SELECT mode FROM turns WHERE id = 'legacy-turn'").get() as { mode: string }).mode, "personal");
  assert.equal(Number((upgraded.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get() as { count: number }).count), 0);
  upgraded.close();

  const request = validTurn({
    session_id: "legacy-session",
    mode: "personal",
    message: "after upgrade",
    client_request_id: "legacy-upgrade-request",
  });
  const response = await first.conversation.handleTurn(request);
  const replay = await first.conversation.handleTurn(request);
  assert.deepEqual(replay, response);
  await first.conversation.changeMode("legacy-session", { mode: "business" });
  await first.conversation.changeMode("legacy-session", { mode: "personal" });
  first.close();

  const inspect = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
  for (const [table, expected] of Object.entries(initialCounts)) {
    const actual = Number((inspect.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    assert.ok(actual >= expected, `${table} rows were not preserved`);
  }
  const turnColumns = (inspect.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>).map((row) => row.name);
  assert.ok(turnColumns.includes("mode"));
  assert.equal(Number((inspect.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get() as { count: number }).count), 1);
  assert.deepEqual(
    (inspect.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.equal(inspect.prepare("PRAGMA foreign_key_check").all().length, 0);
  inspect.close();

  const second = buildTestApp({ dbPath });
  assert.equal(second.store.getSession("legacy-session")?.mode, "personal");
  assert.deepEqual(await second.conversation.handleTurn(request), response);
  second.close();

  const finalDb = new DatabaseSync(dbPath);
  assert.deepEqual(
    (finalDb.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7],
  );
  finalDb.close();
  rmSync(dir, { recursive: true, force: true });
});



test("legacy migration failure rolls back without a half-migrated schema", () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "legacy-invalid.db");
  createLegacyPhase1Database(dbPath);
  const seed = new DatabaseSync(dbPath);
  seed.exec(`INSERT INTO approvals
    SELECT 'duplicate-approval', turn_id, session_id, tool_call_id, tool_name, arguments_json,
      arguments_hash, status, expires_at, created_at, resolved_at FROM approvals WHERE id = 'legacy-approval'`);
  seed.close();

  assert.throws(() => new SessionStore(dbPath));

  const inspect = new DatabaseSync(dbPath);
  assert.deepEqual(
    (inspect.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map((row) => row.version),
    [1, 2],
  );
  assert.equal((inspect.prepare("SELECT COUNT(*) AS count FROM approvals").get() as { count: number }).count, 2);
  assert.equal((inspect.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE '__new_%'").get() as { count: number }).count, 0);
  assert.equal((inspect.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_keys'").get() as { count: number }).count, 0);
  assert.ok(!(inspect.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>).some((row) => row.name === "mode"));
  inspect.close();
  rmSync(dir, { recursive: true, force: true });
});

test("migrations are idempotent across reopen", () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");

  const app1 = buildTestApp({ dbPath });
  app1.close();
  const app2 = buildTestApp({ dbPath });
  app2.close();

  rmSync(dir, { recursive: true, force: true });
});

test("concurrent process-like workers serialize migration startup", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "concurrent.db");
  const modulePath = require.resolve("../../src/sessions/store");
  const workerCode = `
    const { parentPort, workerData } = require("node:worker_threads");
    const { SessionStore } = require(workerData.modulePath);
    try {
      const store = new SessionStore(workerData.dbPath);
      store.close();
      parentPort.postMessage({ ok: true });
    } catch (error) {
      parentPort.postMessage({ ok: false, error: String(error && error.stack || error) });
    }
  `;
  const run = () => new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
    const worker = new Worker(workerCode, { eval: true, workerData: { dbPath, modulePath } });
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  const results = await Promise.all([run(), run(), run(), run()]);
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const store = new SessionStore(dbPath);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("approval and persistence constraints fail closed", () => {
  const store = new SessionStore(":memory:");
  try {
    assert.throws(() => store.createModelCall({ id: "m", turnId: "missing", provider: "p", model: "m", latencyMs: -1, status: "failed" }));
    store.createSession("s", "business");
    store.createTurn({ id: "t", sessionId: "s", role: "user", text: "x", traceId: "tr", status: "completed", mode: "business" });
    store.createToolCall({ id: "tc", turnId: "t", toolName: "harness.create_job", argumentsJson: JSON.stringify({ kind: "x" }), riskLevel: "approval_required", status: "pending_approval" });
    const base = { turnId: "t", sessionId: "s", toolCallId: "tc", toolName: "harness.create_job", argumentsJson: JSON.stringify({ kind: "x" }), argumentsHash: argumentsDigest({ kind: "x" }), riskLevel: "approval_required" as const, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    store.createApproval({ id: "a1", ...base });
    assert.throws(() => store.createApproval({ id: "a2", ...base }));
    assert.throws(() => store.createApproval({ id: "bad-hash", ...base, toolCallId: "different", argumentsHash: "bad" }));
  } finally { store.close(); }
});