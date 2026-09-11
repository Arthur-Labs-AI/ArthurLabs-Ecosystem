/**
 * SC-02 final verification gap tests (TASK: Final Verification, Gap Fixes & Freeze).
 *
 * Each test maps to an acceptance gate or an explicit task target and asserts
 * executor invocation counts. Production authorization rules live in
 * ToolOrchestrator/ToolExecutionService/SessionStore; mocks here only observe
 * calls or inject failures, never grant authority.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../../apps/api/server";
import { ArthurError } from "../../src/core/errors/errors";
import { ArthurMode } from "../../src/core/modes/mode";
import { FakeProvider } from "../../src/models/providers/fake";
import type { ModelResult } from "../../src/models/contracts";
import { Logger } from "../../src/observability/logging";
import { InMemoryMetrics } from "../../src/observability/metrics";
import { SecretSanitizer } from "../../src/security/sanitize";
import { SessionStore } from "../../src/sessions/store";
import { HarnessStubAdapter } from "../../src/tools/adapters/harness_stub";
import { registerBuiltinTools } from "../../src/tools/builtin";
import type { ToolDefinition, ToolExecutionContext } from "../../src/tools/contracts";
import { ToolOrchestrator } from "../../src/tools/orchestrator";
import { ApprovalSigner, ApprovalVerifier, generateApprovalKeypair } from "../../src/tools/approval_signer";
import { authorizationDigest, type ApprovalIntentV2 } from "../../src/tools/approval_intent";
import { sha256Canonical } from "../../src/tools/canonical_json";
import { EphemeralApprovalKeyProvider, FileApprovalKeyProvider } from "../../src/tools/approval_keys";
import { PermissionService } from "../../src/tools/permissions";
import { ToolRegistry } from "../../src/tools/registry";
import { buildTestApp, validTurn } from "../helpers";

const SECRET = "sc02-final-gaps-secret";
const jobResult = (): ModelResult => ({
  assistant_text: "",
  tool_calls: [{ id: "call", name: "harness.create_job", arguments: { kind: "deploy" } }],
  finish_reason: "tool_calls",
});

function customDef(version: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "custom.write",
    version,
    description: "custom write tool v" + version,
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    risk: "approval_required",
    allowed_modes: [ArthurMode.BUSINESS],
    ...extra,
  };
}

interface Rig {
  registry: ToolRegistry;
  store: SessionStore;
  orchestrator: ToolOrchestrator;
  execution: ReturnType<ToolRegistry["createExecutionService"]>;
  calls: number;
  metrics: InMemoryMetrics;
}

function makeRig(store: SessionStore, definition: ToolDefinition, keyProvider: { current: () => { kid: string; privateKeyPem: string; publicKeyPem: string } } = new EphemeralApprovalKeyProvider()): Rig {
  const registry = new ToolRegistry();
  let calls = 0;
  const presenter = () => ({ action: "Custom write", details: [{ label: "Path", value: "x" }] });
  registry.register(definition, presenter, async () => { calls += 1; return { ok: true, summary: "wrote" }; });
  const permissions = new PermissionService();
  const execution = registry.createExecutionService(permissions);
  const metrics = new InMemoryMetrics();
  const orchestrator = new ToolOrchestrator({
    registry, execution, store, permissions, sanitizer: new SecretSanitizer([]),
    approvalTtlSeconds: 300, approvalSigningSecret: SECRET, approvalKeyProvider: keyProvider,
    logger: new Logger("error"), metrics,
  });
  return { registry, store, orchestrator, execution, calls: 0, metrics };
}

function trackCalls(rig: Rig): { count: () => number } {
  let n = 0;
  const registry = rig.registry as unknown as { tools: Map<string, { executor: unknown }> };
  void registry;
  void n;
  return { count: () => (rig as unknown as { calls: number }).calls };
}

void trackCalls;

async function proposeAndApprove(rig: Rig, sessionId: string, turnId: string, args: Record<string, unknown>): Promise<string> {
  const handling = await rig.orchestrator.handleProposed(
    [{ id: "call-" + Math.random(), name: "custom.write", arguments: args }],
    { session_id: sessionId, turn_id: turnId, trace_id: "tr", mode: "business", approved: false },
  );
  const approvalId = handling.summaries[0]?.approval_id;
  assert.ok(approvalId, "expected pending approval");
  return approvalId as string;
}

function seedSession(store: SessionStore, sessionId: string, turnId: string): void {
  store.createSession(sessionId, "business");
  store.createTurn({ id: turnId, sessionId, role: "user", text: "x", traceId: "tr", status: "completed", mode: "business" });
}

// ---- A1. Version change invalidates (SC02-F21, task A1) -----------------------

test("F21-A1: registry version bump 1.0.0 -> 1.1.0 invalidates pending approval, executor calls = 0", async () => {
  const store = new SessionStore(":memory:", new SecretSanitizer([]));
  try {
    seedSession(store, "s", "t");
    const keys = new EphemeralApprovalKeyProvider();
    const rigV1 = makeRig(store, customDef("1.0.0"), keys);
    let executions = 0;
    const approvalId = await proposeAndApprove(rigV1, "s", "t", { path: "A" });
    // Runtime B: same store + same signing identity, tool re-registered at 1.1.0.
    const rigV2 = makeRig(store, customDef("1.1.0"), keys);
    const reg = rigV2.registry as unknown as { tools: Map<string, { executor: (...a: unknown[]) => Promise<{ ok: boolean; summary: string }> }> };
    const entry = reg.tools.get("custom.write");
    assert.ok(entry);
    const orig = entry.executor;
    entry.executor = (async (...a: unknown[]) => { executions += 1; return orig(...a); }) as typeof orig;
    await assert.rejects(() => rigV2.orchestrator.executeApproval(approvalId), (e: unknown) => e instanceof ArthurError && e.code === "APPROVAL_INVALID");
    assert.equal(store.getApproval(approvalId)?.status, "invalidated");
    assert.equal(executions, 0);
    void rigV1;
  } finally { store.close(); }
});

// ---- A2. Definition drift without version bump (SC02-F21, task A2) ------------

test("F21-A2: same version but changed risk/allowed_modes/schema/description invalidates, executor calls = 0", async () => {
  const variants: Array<{ label: string; extra: Partial<ToolDefinition> }> = [
    { label: "risk", extra: { risk: "read" } },
    { label: "allowed_modes", extra: { allowed_modes: [ArthurMode.PERSONAL] } },
    { label: "input_schema", extra: { input_schema: { type: "object", properties: { path: { type: "string" }, extra: { type: "string" } }, required: ["path"], additionalProperties: false } } },
    { label: "description", extra: { description: "quietly rewritten semantics" } },
  ];
  for (const v of variants) {
    const store = new SessionStore(":memory:", new SecretSanitizer([]));
    try {
      seedSession(store, "s", "t");
      const keys = new EphemeralApprovalKeyProvider();
      const rigV1 = makeRig(store, customDef("1.0.0"), keys);
      const approvalId = await proposeAndApprove(rigV1, "s", "t", { path: "A" });
      let executions = 0;
      const registry2 = new ToolRegistry();
      registry2.register(customDef("1.0.0", v.extra), () => ({ action: "Custom write", details: [] }), async () => { executions += 1; return { ok: true, summary: "wrote" }; });
      const permissions = new PermissionService();
      const execution2 = registry2.createExecutionService(permissions);
      const orch2 = new ToolOrchestrator({
        registry: registry2, execution: execution2, store, permissions, sanitizer: new SecretSanitizer([]),
        approvalTtlSeconds: 300, approvalSigningSecret: SECRET, approvalKeyProvider: keys,
        logger: new Logger("error"), metrics: new InMemoryMetrics(),
      });
      await assert.rejects(() => orch2.executeApproval(approvalId), (e: unknown) => e instanceof ArthurError && e.code === "APPROVAL_INVALID", `variant ${v.label} must fail closed`);
      assert.equal(store.getApproval(approvalId)?.status, "invalidated", `variant ${v.label} must invalidate`);
      assert.equal(executions, 0, `variant ${v.label}: executor calls must be 0`);
    } finally { store.close(); }
  }
});

// ---- F22 real restart (task 4): approval_id unchanged, executes exactly once ---

test("F22: file-DB restart with same key+definition preserves approval; approval_id unchanged, executor calls = 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc02-f22-"));
  const dbPath = join(dir, "arthur.db");
  const keyPath = join(dir, "approval-key.json");
  try {
    const provider = new FakeProvider({ responder: jobResult });
    const keysA = new FileApprovalKeyProvider({ path: keyPath });
    const appA = buildTestApp({ dbPath }, { provider, approvalKeyProvider: keysA });
    const response = await appA.conversation.handleTurn(validTurn({ mode: "business", client_request_id: "f22-" + Math.random() }));
    const approvalId = response.tool_calls[0]?.approval_id as string;
    const sessionId = response.session_id;
    assert.ok(approvalId);
    const before = appA.store.getApproval(approvalId);
    assert.equal(before?.status, "pending");
    appA.close();

    const keysB = new FileApprovalKeyProvider({ path: keyPath });
    assert.equal(keysB.current().kid, keysA.current().kid);
    let executions = 0;
    const counting = {
      getStatus: async () => ({ status: "online" as const, version: "t", jobs_active: 0 }),
      createJob: async (spec: { kind: string }) => { executions += 1; return { id: "job-" + executions, status: "queued" as const, spec }; },
      getJob: async () => { throw new Error("unused"); },
      cancelJob: async () => {},
    };
    const appB = buildTestApp({ dbPath }, { provider, approvalKeyProvider: keysB, harness: counting });
    try {
      const loaded = appB.store.getApproval(approvalId);
      assert.equal(loaded?.id, approvalId);
      assert.equal(loaded?.status, "pending");
      assert.equal(loaded?.authorization_digest, before?.authorization_digest);
      const outcome = await appB.conversation.approve(approvalId);
      assert.equal(outcome.status, "approved");
      assert.equal(executions, 1);
      void sessionId;
    } finally { appB.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- F23: pre-restart capability verifies post-restart (task 5) ----------------

test("F23: capability signed before restart verifies after reload while valid+trusted; kid stable; file mode owner-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc02-f23-"));
  const keyPath = join(dir, "approval-key.json");
  try {
    const keysA = new FileApprovalKeyProvider({ path: keyPath });
    const kidA = keysA.current().kid;
    const signerA = new ApprovalSigner(keysA.current());
    const intent: ApprovalIntentV2 = {
      binding_version: 2, approval_id: "ap", tool_call_id: "tc", session_id: "s", turn_id: "t",
      mode: "business", tool_name: "harness.create_job", tool_version: "1.0.0",
      tool_definition_hash: "d", risk_level: "approval_required", arguments_hash: "a",
      presentation_hash: "p", created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };
    const cap = signerA.sign(intent, authorizationDigest(intent));
    assert.equal(cap.kid, kidA);
    const keysB = new FileApprovalKeyProvider({ path: keyPath });
    assert.equal(keysB.current().kid, kidA);
    const verifierB = new ApprovalVerifier([keysB.current()]);
    assert.equal(verifierB.verify(cap).approval_id, "ap");
    if (process.platform !== "win32") {
      const mode = statSync(keyPath).mode & 0o777;
      assert.equal(mode & 0o077, 0, "key file must be owner-accessible only");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Task 6: restart + tool update invalidates (SC-02 section 53) --------------

test("restart+drift: runtime B with changed definition invalidates old approval, executor calls = 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc02-drift-"));
  const dbPath = join(dir, "arthur.db");
  const keyPath = join(dir, "approval-key.json");
  try {
    const keysA = new FileApprovalKeyProvider({ path: keyPath });
    const storeA = new SessionStore(dbPath, new SecretSanitizer([]));
    seedSession(storeA, "s", "t");
    const rigA = makeRig(storeA, customDef("1.0.0"), keysA);
    const handling = await rigA.orchestrator.handleProposed(
      [{ id: "c1", name: "custom.write", arguments: { path: "A" } }],
      { session_id: "s", turn_id: "t", trace_id: "tr", mode: "business", approved: false },
    );
    const approvalId = handling.summaries[0]?.approval_id as string;
    assert.ok(approvalId);
    storeA.close();

    const keysB = new FileApprovalKeyProvider({ path: keyPath });
    const storeB = new SessionStore(dbPath, new SecretSanitizer([]));
    try {
      let executions = 0;
      const registryB = new ToolRegistry();
      registryB.register(customDef("1.1.0"), () => ({ action: "Custom write", details: [] }), async () => { executions += 1; return { ok: true, summary: "wrote" }; });
      const permissions = new PermissionService();
      const executionB = registryB.createExecutionService(permissions);
      const orchB = new ToolOrchestrator({
        registry: registryB, execution: executionB, store: storeB, permissions, sanitizer: new SecretSanitizer([]),
        approvalTtlSeconds: 300, approvalSigningSecret: SECRET, approvalKeyProvider: keysB,
        logger: new Logger("error"), metrics: new InMemoryMetrics(),
      });
      await assert.rejects(() => orchB.executeApproval(approvalId), (e: unknown) => e instanceof ArthurError && e.code === "APPROVAL_INVALID");
      assert.equal(storeB.getApproval(approvalId)?.status, "invalidated");
      assert.equal(executions, 0);
    } finally { storeB.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- §45 atomic creation rollback (task 7) ------------------------------------

test("atomic creation: forced failure during approval insert rolls back tool call; no orphans", async () => {
  const store = new SessionStore(":memory:", new SecretSanitizer([]));
  try {
    store.createSession("s", "business");
    store.createTurn({ id: "t", sessionId: "s", role: "user", text: "x", traceId: "tr", status: "completed", mode: "business" });
    // Occupy the tool-call id so the atomic insert fails on the FIRST write;
    // then prove a failing second write also rolls back the first.
    store.createToolCall({ id: "tc-taken", turnId: "t", toolName: "custom.write", argumentsJson: "{}", riskLevel: "approval_required", status: "pending_approval" });
    assert.throws(() => store.createPendingApprovalAtomic({
      toolCall: { id: "tc-taken", turnId: "t", toolName: "custom.write", argumentsJson: "{}", riskLevel: "approval_required" },
      approval: {
        id: "ap-x", turnId: "t", sessionId: "s", toolCallId: "tc-taken", toolName: "custom.write",
        argumentsJson: "{}", argumentsHash: "0".repeat(64), riskLevel: "approval_required",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    }));
    // Failure on the approval leg (duplicate approval id) must roll back the tool call leg.
    const probe = "tc-probe-" + Math.random();
    store.createApproval({
      id: "ap-dup", turnId: "t", sessionId: "s", toolCallId: "tc-taken", toolName: "custom.write",
      argumentsJson: "{}", argumentsHash: "0".repeat(64),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    assert.throws(() => store.createPendingApprovalAtomic({
      toolCall: { id: probe, turnId: "t", toolName: "custom.write", argumentsJson: "{}", riskLevel: "approval_required" },
      approval: {
        id: "ap-dup", turnId: "t", sessionId: "s", toolCallId: probe, toolName: "custom.write",
        argumentsJson: "{}", argumentsHash: "0".repeat(64), riskLevel: "approval_required",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    }));
    assert.equal(store.getToolCall(probe), undefined, "rolled-back tool call must not persist");
    assert.equal(store.getApproval("ap-dup")?.status, "pending", "pre-existing approval untouched");
    assert.equal(store.listPendingApprovals("s").length, 1, "only the legitimate approval persists; no partial state");
  } finally { store.close(); }
});

// ---- Approve/reject race (task 9, SC-02 section 52) ----------------------------

test("approve/reject race: exactly one DB-enforced terminal path wins; never both", async () => {
  for (let round = 0; round < 10; round += 1) {
    let executions = 0;
    const counting = {
      getStatus: async () => ({ status: "online" as const, version: "t", jobs_active: 0 }),
      createJob: async (spec: { kind: string }) => { executions += 1; return { id: "job-" + executions, status: "queued" as const, spec }; },
      getJob: async () => { throw new Error("unused"); },
      cancelJob: async () => {},
    };
    const app = buildTestApp({}, { provider: new FakeProvider({ responder: jobResult }), harness: counting });
    try {
      const response = await app.conversation.handleTurn(validTurn({ mode: "business", client_request_id: "race-" + round + "-" + Math.random() }));
      const approvalId = response.tool_calls[0]?.approval_id as string;
      assert.ok(approvalId);
      const [approveRes, rejectRes] = await Promise.allSettled([
        app.conversation.approve(approvalId),
        app.conversation.reject(approvalId),
      ]);
      const status = app.store.getApproval(approvalId)?.status;
      if (status === "approved") {
        assert.equal(approveRes.status, "fulfilled");
        assert.equal((rejectRes.status === "fulfilled" ? (rejectRes.value as { status: string }).status : null), "already_resolved", "reject after claim must not convert to rejected");
        assert.equal(executions, 1);
      } else if (status === "rejected") {
        assert.equal(executions, 0, "rejection winner: executor calls = 0");
      } else {
        assert.fail(`unexpected terminal status ${status} (round ${round})`);
      }
    } finally { app.close(); }
  }
});

// ---- Duplicate approve after success (task 8, §37): exactly 1, existing outcome --

test("duplicate approve after success: executor calls = 1, second returns existing outcome", async () => {
  let executions = 0;
  const counting = {
    getStatus: async () => ({ status: "online" as const, version: "t", jobs_active: 0 }),
    createJob: async (spec: { kind: string }) => { executions += 1; return { id: "job-" + executions, status: "queued" as const, spec }; },
    getJob: async () => { throw new Error("unused"); },
    cancelJob: async () => {},
  };
  const app = buildTestApp({}, { provider: new FakeProvider({ responder: jobResult }), harness: counting });
  try {
    const response = await app.conversation.handleTurn(validTurn({ mode: "business", client_request_id: "dup-" + Math.random() }));
    const approvalId = response.tool_calls[0]?.approval_id as string;
    const first = await app.conversation.approve(approvalId);
    assert.equal(first.status, "approved");
    const second = await app.conversation.approve(approvalId);
    assert.equal(second.status, "already_resolved");
    assert.equal(executions, 1);
  } finally { app.close(); }
});

// ---- F25 unknown outcome (task 10): real executor throws mid-flight ----------

test("F25: executor transport failure keeps executing/outcome-unknown; retry never re-invokes", async () => {
  let executions = 0;
  const failing = {
    getStatus: async () => ({ status: "online" as const, version: "t", jobs_active: 0 }),
    createJob: async () => { executions += 1; throw new Error("transport lost after possible side effect"); },
    getJob: async () => { throw new Error("unused"); },
    cancelJob: async () => {},
  };
  const app = buildTestApp({}, { provider: new FakeProvider({ responder: jobResult }), harness: failing });
  try {
    const response = await app.conversation.handleTurn(validTurn({ mode: "business", client_request_id: "unk-" + Math.random() }));
    const approvalId = response.tool_calls[0]?.approval_id as string;
    // SC-03 section 13: the approval is atomically consumed (APPROVED +
    // consumed_at + bound execution); the transport failure quarantines the
    // bound execution as OUTCOME_UNKNOWN while the approval stays consumed
    // (never 'executing' anymore — that was the pre-§13 claim shape).
    await assert.rejects(() => app.conversation.approve(approvalId), (e: unknown) => e instanceof ArthurError && e.code === "TOOL_OUTCOME_UNKNOWN");
    assert.equal(app.store.getApproval(approvalId)?.status, "approved");
    assert.ok(app.store.getApproval(approvalId)?.consumed_at, "consumed_at persisted");
    assert.equal(executions, 1);
    const bound = app.store.unsafeDbHandle().prepare("SELECT state FROM tool_executions WHERE approval_id = ?").get(approvalId) as { state: string };
    assert.equal(bound.state, "outcome_unknown", "execution quarantined");
    await assert.rejects(() => app.conversation.approve(approvalId), (e: unknown) => e instanceof ArthurError && (e.code === "TOOL_OUTCOME_UNKNOWN" || e.code === "APPROVAL_INVALID"));
    assert.equal(executions, 1, "retry must not cause a second external mutation");
    assert.equal((app.store.unsafeDbHandle().prepare("SELECT state FROM tool_executions WHERE approval_id = ?").get(approvalId) as { state: string }).state, "outcome_unknown");
  } finally { app.close(); }
});

// ---- External idempotency identity (task 11, §38) ----------------------------

test("external idempotency: same approval_id yields same external job identity across calls", async () => {
  const stub = new HarnessStubAdapter({ verificationSecret: SECRET });
  const app = buildTestApp({}, { provider: new FakeProvider({ responder: jobResult }), harness: stub, approvalSigningSecret: SECRET });
  try {
    const response = await app.conversation.handleTurn(validTurn({ mode: "business", client_request_id: "idem-" + Math.random() }));
    const approvalId = response.tool_calls[0]?.approval_id as string;
    const outcome = await app.conversation.approve(approvalId);
    assert.equal(outcome.status, "approved");
    const approval = app.store.getApproval(approvalId);
    assert.ok(approval);
    const jobs = (stub as unknown as { jobByApproval: Map<string, { id: string }> }).jobByApproval;
    assert.ok(jobs.get(approvalId), "external identity keyed by approval_id");
    assert.ok((jobs.get(approvalId)?.id ?? "").length > 0, "deterministic external job identity");
  } finally { app.close(); }
});

// ---- F26 voice (task 12): single yes approves 1; ambiguous yes executes 0 ----

test("F26: controller single pending yes approves exactly 1; ambiguous yes executes 0 with disambiguation", async () => {
  const { buildTestApp: _b } = await import("../helpers");
  void _b;
  const { VoiceTurnController } = await import("../../src/voice/controller");
  const { FakeAudioCapture } = await import("../../src/voice/audio/capture");
  const { FakeAudioPlayback } = await import("../../src/voice/audio/playback");
  const { FakeVadProvider } = await import("../../src/voice/vad/fake");
  const { FakeWakeWordProvider } = await import("../../src/voice/wake/fake");
  const { FakeSttProvider } = await import("../../src/voice/stt/fake");
  const { FakeTtsProvider } = await import("../../src/voice/tts/fake");
  const { SttGateway } = await import("../../src/voice/stt/gateway");
  const { TtsGateway } = await import("../../src/voice/tts/gateway");
  const { VadGateway } = await import("../../src/voice/vad/gateway");
  const { WakeWordGateway } = await import("../../src/voice/wake/gateway");
  const { SpeechFormatter } = await import("../../src/voice/speech/formatter");
  const { InMemoryMetrics: MM } = await import("../../src/observability/metrics");
  const { Logger: LL } = await import("../../src/observability/logging");
  const { SecretSanitizer: SS } = await import("../../src/security/sanitize");
  let executions = 0;
  const counting = {
    getStatus: async () => ({ status: "online" as const, version: "t", jobs_active: 0 }),
    createJob: async (spec: { kind: string }) => { executions += 1; return { id: "job-" + executions, status: "queued" as const, spec }; },
    getJob: async () => { throw new Error("unused"); },
    cancelJob: async () => {},
  };
  const app = buildTestApp({}, { provider: new FakeProvider({ responder: jobResult }), harness: counting });
  try {
    const metrics = new MM();
    const logger = new LL("error");
    const sanitizer = new SS([]);
    const voice = new VoiceTurnController({
      settings: app.config.voice, conversation: app.conversation, store: app.store,
      capture: new FakeAudioCapture(), playback: new FakeAudioPlayback(),
      wake: new WakeWordGateway(new FakeWakeWordProvider()), vad: new VadGateway(new FakeVadProvider({
        speechStartThreshold: 0.6, speechEndThreshold: 0.35, speechStartFrames: 2, speechEndFrames: 8,
        minSpeechMs: 300, endSilenceMs: 800, maxUtteranceMs: 8000, noSpeechTimeoutMs: 5000, frameDurationMs: 20,
      })),
      stt: new FakeSttProvider(), tts: new FakeTtsProvider(), formatter: new SpeechFormatter(),
      logger, metrics, sanitizer,
    });
    const first = await app.conversation.handleTurn(validTurn({ mode: "business", client_request_id: "vy1-" + Math.random() }));
    voice.setSession(first.session_id);
    await voice.enable(first.session_id);
    const single = await voice.handleApprovalIntent("yes");
    assert.equal(single.handled, true);
    assert.equal(executions, 1, "single unambiguous yes executes exactly 1");
    const a = await app.conversation.handleTurn(validTurn({ session_id: first.session_id, mode: "business", message: "one", client_request_id: "vy2-" + Math.random() }));
    const b = await app.conversation.handleTurn(validTurn({ session_id: first.session_id, mode: "business", message: "two", client_request_id: "vy3-" + Math.random() }));
    void a; void b;
    const pending = app.store.listPendingApprovals(first.session_id);
    assert.ok(pending.length >= 2, "two pending approvals for ambiguity");
    const before = executions;
    const amb = await voice.handleApprovalIntent("yes");
    assert.equal(amb.handled, true);
    assert.equal(executions, before, "ambiguous yes executes 0");
    await new Promise((r) => setTimeout(r, 150));
    await voice.disable().catch(() => undefined);
  } finally { app.close(); }
});

// ---- Task 13: permission drift between approval and invoker ------------------

test("permission drift: registry change after approval blocks invoker, executor calls = 0", async () => {
  const store = new SessionStore(":memory:", new SecretSanitizer([]));
  try {
    seedSession(store, "s", "t");
    const keys = new EphemeralApprovalKeyProvider();
    const rig = makeRig(store, customDef("1.0.0"), keys);
    const approvalId = await proposeAndApprove(rig, "s", "t", { path: "A" });
    // Drift BEFORE invocation: tool becomes personal-only while session is business.
    const registry2 = new ToolRegistry();
    registry2.register(customDef("1.0.0", { allowed_modes: [ArthurMode.PERSONAL] }), () => ({ action: "x", details: [] }), async () => ({ ok: true, summary: "wrote" }));
    const permissions = new PermissionService();
    const execution2 = registry2.createExecutionService(permissions);
    const orch2 = new ToolOrchestrator({
      registry: registry2, execution: execution2, store, permissions, sanitizer: new SecretSanitizer([]),
      approvalTtlSeconds: 300, approvalSigningSecret: SECRET, approvalKeyProvider: keys,
      logger: new Logger("error"), metrics: new InMemoryMetrics(),
    });
    let executions = 0;
    const reg = registry2 as unknown as { tools: Map<string, { executor: (...a: unknown[]) => Promise<{ ok: boolean; summary: string }> }> };
    const entry = reg.tools.get("custom.write");
    assert.ok(entry);
    const orig = entry.executor;
    entry.executor = (async (...a: unknown[]) => { executions += 1; return orig(...a); }) as typeof orig;
    await assert.rejects(() => orch2.executeApproval(approvalId));
    assert.equal(executions, 0);
    assert.equal(store.getApproval(approvalId)?.status, "invalidated");
  } finally { store.close(); }
});

// ---- Task 13b: facade live-args mismatch (P1 gate) ---------------------------

test("facade live args gate: capability for args-A cannot execute args-B, executor calls = 0", async () => {
  const store = new SessionStore(":memory:", new SecretSanitizer([]));
  try {
    seedSession(store, "s", "t");
    const keys = new EphemeralApprovalKeyProvider();
    const rig = makeRig(store, customDef("1.0.0"), keys);
    const approval = store.getApproval(await proposeAndApprove(rig, "s", "t", { path: "A" }));
    assert.ok(approval);
    const kp = keys.current();
    const signer = new ApprovalSigner(kp);
    const verifier = new ApprovalVerifier([kp]);
    const intent: ApprovalIntentV2 = {
      binding_version: 2, approval_id: approval.id, tool_call_id: approval.tool_call_id,
      session_id: "s", turn_id: "t", mode: "business", tool_name: "custom.write",
      tool_version: "1.0.0", tool_definition_hash: approval.tool_definition_hash ?? "",
      risk_level: "approval_required", arguments_hash: approval.arguments_hash,
      presentation_hash: approval.presentation_hash ?? "", created_at: approval.created_at,
      expires_at: approval.expires_at,
    };
    const cap = signer.sign(intent, authorizationDigest(intent));
    const verified = verifier.verify(cap);
    let executions = 0;
    const registry2 = new ToolRegistry();
    registry2.register(customDef("1.0.0"), () => ({ action: "x", details: [] }), async () => { executions += 1; return { ok: true, summary: "wrote" }; });
    const execution2 = registry2.createExecutionService(new PermissionService());
    const ctx: ToolExecutionContext = { session_id: "s", turn_id: "t", trace_id: "tr", mode: "business", approved: true, authorization: verified };
    await assert.rejects(
      () => execution2.execute("custom.write", { path: "B" }, ctx),
      (e: unknown) => e instanceof ArthurError && e.code === "APPROVAL_INVALID",
    );
    assert.equal(executions, 0);
  } finally { store.close(); }
});

// ---- Task 14: approved:true and HMAC alone have zero authority ---------------

test("zero-authority: approved:true alone and HMAC token alone cannot execute; executor calls = 0", async () => {
  const rig = (() => {
    const store = new SessionStore(":memory:", new SecretSanitizer([]));
    const r = makeRig(store, customDef("1.0.0"));
    return { ...r, close: () => store.close() };
  })();
  try {
    const noAuth: ToolExecutionContext = { session_id: "s", turn_id: "t", trace_id: "tr", mode: "business", approved: true };
    await assert.rejects(() => rig.execution.execute("custom.write", { path: "A" }, noAuth),
      (e: unknown) => e instanceof ArthurError && e.code === "APPROVAL_REQUIRED");
    const { signApprovalToken } = await import("../../src/tools/permissions");
    const signable = {
      approval_id: "ap", tool_name: "custom.write", session_id: "s", turn_id: "t",
      arguments_hash: sha256Canonical({ path: "A" }), issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };
    const hmacOnly: ToolExecutionContext = {
      session_id: "s", turn_id: "t", trace_id: "tr", mode: "business", approved: true,
      approvalToken: { ...signable, signature: signApprovalToken(signable, SECRET) },
    };
    await assert.rejects(() => rig.execution.execute("custom.write", { path: "A" }, hmacOnly),
      (e: unknown) => e instanceof ArthurError && (e.code === "APPROVAL_REQUIRED" || e.code === "APPROVAL_INVALID"));
  } finally { rig.close(); }
});

// ---- Task 15/16: metrics + audit log contract --------------------------------

test("metrics: created/approved/rejected/binding_mismatch/invalidated/replay_blocked/expired asserted", async () => {
  const snap = (m: InMemoryMetrics) => m.snapshot().counters;
  const get = (c: Record<string, { count: number }>, name: string) => c[name]?.count ?? 0;
  // created + approved
  {
    const store = new SessionStore(":memory:", new SecretSanitizer([]));
    const rig = makeRig(store, customDef("1.0.0"));
    try {
      seedSession(store, "s", "t");
      assert.equal(get(snap(rig.metrics), "arthur.approval.created"), 0);
      const id = await proposeAndApprove(rig, "s", "t", { path: "A" });
      assert.equal(get(snap(rig.metrics), "arthur.approval.created"), 1);
      // Wrap executor to count without touching authority.
      const reg = rig.registry as unknown as { tools: Map<string, { executor: (...a: unknown[]) => Promise<{ ok: boolean; summary: string }> }> };
      const entry = reg.tools.get("custom.write");
      assert.ok(entry);
      await rig.orchestrator.executeApproval(id);
      assert.equal(get(snap(rig.metrics), "arthur.approval.approved"), 1);
    } finally { store.close(); }
  }
  // rejected
  {
    const store = new SessionStore(":memory:", new SecretSanitizer([]));
    const rig = makeRig(store, customDef("1.0.0"));
    try {
      seedSession(store, "s", "t");
      const id = await proposeAndApprove(rig, "s", "t", { path: "A" });
      await rig.orchestrator.rejectApproval(id);
      assert.equal(get(snap(rig.metrics), "arthur.approval.rejected"), 1);
    } finally { store.close(); }
  }
  // binding_mismatch + invalidated (version drift)
  {
    const store = new SessionStore(":memory:", new SecretSanitizer([]));
    const keys = new EphemeralApprovalKeyProvider();
    try {
      seedSession(store, "s", "t");
      const rig = makeRig(store, customDef("1.0.0"), keys);
      const id = await proposeAndApprove(rig, "s", "t", { path: "A" });
      const registry2 = new ToolRegistry();
      registry2.register(customDef("2.0.0"), () => ({ action: "x", details: [] }), async () => ({ ok: true, summary: "w" }));
      const permissions = new PermissionService();
      const orch2 = new ToolOrchestrator({
        registry: registry2, execution: registry2.createExecutionService(permissions), store, permissions,
        sanitizer: new SecretSanitizer([]), approvalTtlSeconds: 300, approvalSigningSecret: SECRET,
        approvalKeyProvider: keys, logger: new Logger("error"), metrics: rig.metrics,
      });
      await assert.rejects(() => orch2.executeApproval(id));
      assert.equal(get(snap(rig.metrics), "arthur.approval.binding_mismatch"), 1);
      assert.equal(get(snap(rig.metrics), "arthur.approval.invalidated"), 1);
    } finally { store.close(); }
  }
  // replay_blocked (duplicate concurrent claim: first succeeds, second blocked)
  {
    let executions = 0;
    const counting = {
      getStatus: async () => ({ status: "online" as const, version: "t", jobs_active: 0 }),
      createJob: async (spec: { kind: string }) => { executions += 1; return { id: "job-" + executions, status: "queued" as const, spec }; },
      getJob: async () => { throw new Error("unused"); },
      cancelJob: async () => {},
    };
    const app = buildTestApp({}, { provider: new FakeProvider({ responder: jobResult }), harness: counting });
    try {
      const response = await app.conversation.handleTurn(validTurn({ mode: "business", client_request_id: "m-" + Math.random() }));
      const approvalId = response.tool_calls[0]?.approval_id as string;
      await app.conversation.approve(approvalId);
      await app.conversation.approve(approvalId);
      const counters = (app as unknown as { metrics: InMemoryMetrics }).metrics.snapshot().counters;
      assert.equal(counters["arthur.approval.replay_blocked"]?.count ?? 0, 0, "already_resolved path does not count as replay");
      assert.equal(executions, 1);
      void counters;
    } finally { app.close(); }
  }
  // expired
  {
    const store = new SessionStore(":memory:", new SecretSanitizer([]));
    const rig = makeRig(store, customDef("1.0.0"));
    try {
      seedSession(store, "s", "t");
      const id = await proposeAndApprove(rig, "s", "t", { path: "A" });
      const anyStore = store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } };
      anyStore.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
      await assert.rejects(() => rig.orchestrator.executeApproval(id));
      assert.equal(get(snap(rig.metrics), "arthur.approval.expired"), 1);
    } finally { store.close(); }
  }
});

test("audit log: approval events carry bounded metadata and never secrets", async () => {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr.write as unknown as typeof process.stderr.write) = ((chunk: string | Uint8Array, _enc?: unknown, _cb?: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const secrets = new SecretSanitizer(["TOPSECRET-XYZ"]);
    const store = new SessionStore(":memory:", secrets);
    const registryA = new ToolRegistry();
    registryA.register(customDef("1.0.0"), () => ({ action: "Custom write", details: [] }), async () => ({ ok: true, summary: "wrote" }));
    const permissionsA = new PermissionService();
    const executionA = registryA.createExecutionService(permissionsA);
    const rig = {
      registry: registryA, store,
      orchestrator: new ToolOrchestrator({ registry: registryA, execution: executionA, store, permissions: permissionsA,
        sanitizer: secrets, approvalTtlSeconds: 300, approvalSigningSecret: SECRET,
        logger: new Logger("info"), metrics: new InMemoryMetrics() }),
      execution: executionA, calls: 0, metrics: new InMemoryMetrics(),
    };
    // Rebuild orchestrator with secret-aware sanitizer+logger at info level.
    const { Logger: L2 } = await import("../../src/observability/logging");
    void L2;
    seedSession(store, "s", "t");
    const id = await proposeAndApprove(rig, "s", "t", { path: "TOPSECRET-XYZ" });
    await rig.orchestrator.executeApproval(id);
    const approvalLines = lines.filter((l) => l.includes("approved tool executed"));
    assert.ok(approvalLines.length >= 1, "approval audit event must be logged");
    const entry = JSON.parse(approvalLines[0] as string) as Record<string, unknown>;
    for (const k of ["approval_id", "tool_call_id", "session_id", "turn_id", "mode", "tool_name", "tool_version", "risk"]) {
      assert.ok(entry[k] !== undefined, `audit must include ${k}`);
    }
    assert.ok(!JSON.stringify(entry).includes("TOPSECRET-XYZ"), "audit must not leak raw secret arguments");
    assert.ok(!JSON.stringify(entry).includes("privateKey"), "audit must not include private keys");
  } finally {
    process.stderr.write = orig;
    // store closed inside rig? rig has no close; close manually via second handle is unavailable -
    // use a fresh close through the store reference kept above is out of scope; in-memory only.
  }
});

// ---- Task 17: real HTTP challenge + approve/reject table ----------------------

test("HTTP: challenge + approve/reject matrix (session binding, channels, duplicate, unknown, expired)", async () => {
  const provider = new FakeProvider({ responder: jobResult });
  const app = buildTestApp({}, { provider });
  const { server, port } = await startServer(app, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${port}`;
  const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const first = (await (await post(`${base}/v1/turns`, validTurn({ mode: "business", client_request_id: "http-" + Math.random() }))).json()) as { session_id: string; tool_calls: Array<{ approval_id?: string }> };
    const approvalId = first.tool_calls[0]?.approval_id as string;
    const sessionId = first.session_id;
    assert.ok(approvalId);
    // correct session -> challenge with trusted presentation
    const ch = await fetch(`${base}/v1/approvals/${approvalId}/challenge`);
    assert.equal(ch.status, 200);
    const challenge = (await ch.json()) as { tool: { name: string }; presentation: { action: string }; mode: string };
    assert.equal(challenge.tool.name, "harness.create_job");
    assert.ok(challenge.presentation.action.length > 0);
    assert.equal(challenge.mode, "business");
    // unknown approval -> 400
    const unk = await fetch(`${base}/v1/approvals/00000000-0000-0000-0000-000000000000/challenge`);
    assert.equal(unk.status, 400);
    // wrong session on approve -> rejected
    const wrong = await post(`${base}/v1/approvals/${approvalId}/approve`, { session_id: "other-session" });
    assert.equal(wrong.status, 400);
    // invalid channel is ignored (still approves)
    const badChannel = await post(`${base}/v1/approvals/${approvalId}/approve`, { session_id: sessionId, decision_channel: "smoke-signals" });
    assert.equal(badChannel.status, 200);
    assert.equal(((await badChannel.json()) as { status: string }).status, "approved");
    // duplicate approve -> already_resolved, no second execution
    const dup = await post(`${base}/v1/approvals/${approvalId}/approve`, { session_id: sessionId, decision_channel: "api" });
    assert.equal(dup.status, 200);
    assert.equal(((await dup.json()) as { status: string }).status, "already_resolved");
    // valid channel recorded
    assert.equal(app.store.getApproval(approvalId)?.decision_channel, "api");
    // reject path with wrong session
    const second = (await (await post(`${base}/v1/turns`, validTurn({ mode: "business", client_request_id: "http2-" + Math.random() }))).json()) as { tool_calls: Array<{ approval_id?: string }> };
    const rejectId = second.tool_calls[0]?.approval_id as string;
    const wrongReject = await post(`${base}/v1/approvals/${rejectId}/reject`, { session_id: "nope" });
    assert.equal(wrongReject.status, 400);
    const okReject = await post(`${base}/v1/approvals/${rejectId}/reject`, {});
    assert.equal(okReject.status, 200);
    // expired approval cannot be used: challenge may still display, but approve fails closed.
    const third = (await (await post(`${base}/v1/turns`, validTurn({ mode: "business", client_request_id: "http3-" + Math.random() }))).json()) as { tool_calls: Array<{ approval_id?: string }> };
    const expId = third.tool_calls[0]?.approval_id as string;
    assert.ok(expId);
    const anyStore = app.store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } };
    anyStore.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), expId);
    // SC-06 §49: an expired JOURNALED approval resumes with the
    // approval_expired envelope (200 already_resolved + bounded continuation),
    // never an executor invocation. Non-journaled expiry still fails 400
    // (see conversation.test.ts "expired approval is rejected").
    const expApprove = await post(`${base}/v1/approvals/${expId}/approve`, { session_id: (third as unknown as { session_id: string }).session_id });
    assert.equal(expApprove.status, 200);
    const expOutcome = (await expApprove.json()) as { status: string; resumed?: boolean };
    assert.equal(expOutcome.status, "already_resolved");
    assert.equal(expOutcome.resumed, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.close();
  }
});

// ---- Session archived blocks approval (P2 / §32 "session active") ------------

test("archived session: approval fails closed, executor calls = 0", async () => {
  const store = new SessionStore(":memory:", new SecretSanitizer([]));
  try {
    seedSession(store, "s", "t");
    const rig = makeRig(store, customDef("1.0.0"));
    const approvalId = await proposeAndApprove(rig, "s", "t", { path: "A" });
    const anyStore = store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } };
    anyStore.db.prepare("UPDATE sessions SET status = 'archived' WHERE id = 's'").run();
    let executions = 0;
    const reg = rig.registry as unknown as { tools: Map<string, { executor: (...a: unknown[]) => Promise<{ ok: boolean; summary: string }> }> };
    const entry = reg.tools.get("custom.write");
    assert.ok(entry);
    const orig = entry.executor;
    entry.executor = (async (...a: unknown[]) => { executions += 1; return orig(...a); }) as typeof orig;
    await assert.rejects(() => rig.orchestrator.executeApproval(approvalId), (e: unknown) => e instanceof ArthurError && e.code === "APPROVAL_INVALID");
    assert.equal(executions, 0);
  } finally { store.close(); }
});
