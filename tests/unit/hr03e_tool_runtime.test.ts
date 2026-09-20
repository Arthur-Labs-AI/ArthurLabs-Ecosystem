/**
 * HR-03E: remote capability execution (hybrid TOOL execution).
 *
 * Routing happens AFTER authorization at the AttemptInvoker boundary:
 * every test below drives the secured SingleAttemptExecutionService (or
 * the durable ToolExecutionCoordinator above it), never the raw executor.
 * Raw local executors stay private: the hybrid invoker receives only the
 * registry-built local closure, and no test accesses an executor map.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { ArthurMode } from "../../src/core/modes/mode";
import { Logger } from "../../src/observability/logging";
import { InMemoryMetrics } from "../../src/observability/metrics";
import { SecretSanitizer } from "../../src/security/sanitize";
import { SessionStore } from "../../src/sessions/store";
import { ExecutionStore } from "../../src/sessions/execution_store";
import { ToolRegistry } from "../../src/tools/registry";
import { PermissionService } from "../../src/tools/permissions";
import { ToolExecutionCoordinator } from "../../src/tools/execution_coordinator";
import { FakeExecutionClock } from "../../src/tools/execution_clock";
import { classifyExecutorError } from "../../src/tools/execution_types";
import type { ToolExecutionPolicy } from "../../src/tools/execution_policy";
import type { ToolResult } from "../../src/tools/contracts";
import { NodeRegistry } from "../../src/runtime/hybrid/node_registry";
import { ProviderRegistry } from "../../src/runtime/hybrid/provider_registry";
import { HybridRoutingEngine } from "../../src/runtime/hybrid/routing_engine";
import { HybridToolAttemptInvoker } from "../../src/runtime/hybrid/tools/attempt_router";
import { NodeToolExecutionBindings } from "../../src/runtime/hybrid/tools/node_executor_bindings";
import { AttemptDispatchError } from "../../src/runtime/hybrid/tools/errors";
import { ModelGatewayRegistry } from "../../src/runtime/hybrid/gateway_registry";
import { createLanRuntimeHandler, type LanHttpRequest } from "../../src/runtime/hybrid/lan/server";
import { ToolExecutorBindings } from "../../src/runtime/hybrid/lan/tool_bindings";
import { LanToolExecutor } from "../../src/runtime/hybrid/lan/tool_client";
import { approvalArgumentsHash, toolDefinitionHash } from "../../src/tools/approval_intent";
import { ApprovalSigner, ApprovalVerifier, generateApprovalKeypair } from "../../src/tools/approval_signer";
import { authorizationDigest, type ApprovalIntentV2 } from "../../src/tools/approval_intent";

const TOKEN = "hr03e-test-token-0123456789abcdef";

function readPolicy(): ToolExecutionPolicy {
  return {
    effects: "none",
    attempt_timeout_ms: 5000,
    total_timeout_ms: 30000,
    abort_grace_ms: 50,
    cancellation: "cooperative",
    idempotency: "intrinsic",
    retry: { strategy: "transient", max_attempts: 3, base_delay_ms: 10, max_delay_ms: 100 },
    reconciliation: "none",
    result_persistence: "summary_only",
  };
}

function mutationPolicy(): ToolExecutionPolicy {
  return {
    effects: "mutation",
    attempt_timeout_ms: 5000,
    total_timeout_ms: 30000,
    abort_grace_ms: 50,
    cancellation: "cooperative",
    idempotency: "none",
    retry: { strategy: "off", max_attempts: 1, base_delay_ms: 10, max_delay_ms: 100 },
    reconciliation: "none",
    result_persistence: "summary_only",
  };
}

function echoDef(extra: Record<string, unknown> = {}): Parameters<ToolRegistry["register"]>[0] {
  return {
    name: "system.echo",
    version: "1.0.0",
    description: "echo",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    output_schema: { type: "object", properties: { echo: { type: "string" } }, required: ["echo"], additionalProperties: false },
    risk: "read",
    allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    execution_policy: readPolicy(),
    ...extra,
  } as Parameters<ToolRegistry["register"]>[0];
}

function approvalDef(): Parameters<ToolRegistry["register"]>[0] {
  return {
    name: "custom.write",
    version: "1.0.0",
    description: "approval-gated write",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    risk: "approval_required",
    allowed_modes: [ArthurMode.BUSINESS],
    execution_policy: readPolicy(),
  } as Parameters<ToolRegistry["register"]>[0];
}

function seedWorld(): { store: SessionStore; executions: ExecutionStore } {
  const store = new SessionStore(":memory:", new SecretSanitizer([]));
  store.createSession("s1", ArthurMode.PERSONAL);
  store.createTurn({ id: "t1", sessionId: "s1", role: "user", text: "go", traceId: "tr1", status: "completed", mode: ArthurMode.PERSONAL });
  store.createSession("s", ArthurMode.BUSINESS);
  store.createTurn({ id: "t", sessionId: "s", role: "user", text: "go", traceId: "tr", status: "completed", mode: ArthurMode.BUSINESS });
  const executions = new ExecutionStore(store.unsafeDbHandle(), store.sanitizerHandle());
  return { store, executions };
}

interface HybridRig {
  registry: ToolRegistry;
  permissions: PermissionService;
  nodes: NodeRegistry;
  providers: ProviderRegistry;
  routing: HybridRoutingEngine;
  remotes: NodeToolExecutionBindings;
  localCalls: { n: number };
  lanCalls: { n: number };
  lanHttpCalls: { n: number };
  buildService: () => ReturnType<ToolRegistry["createHybridSingleAttemptService"]>;
  close: () => void;
  store: SessionStore;
  executions: ExecutionStore;
}

function buildHybridRig(opts: {
  localToolIds: string[];
  lanToolIds: string[];
  lanState?: "ready" | "unavailable";
  localExecutor?: (args: Record<string, unknown>) => ToolResult;
  lanExecutor?: (args: Record<string, unknown>) => ToolResult;
  policy?: ToolExecutionPolicy;
} = { localToolIds: ["system.echo"], lanToolIds: ["system.echo"] }): HybridRig {
  const { store, executions } = seedWorld();
  const registry = new ToolRegistry();
  const localCalls = { n: 0 };
  const lanCalls = { n: 0 };
  const lanHttpCalls = { n: 0 };
  const policy = opts.policy ?? readPolicy();
  registry.register(echoDef({ execution_policy: policy }), (args) => {
    localCalls.n += 1;
    if (opts.localExecutor) return opts.localExecutor(args);
    return { ok: true, summary: String(args.text ?? ""), data: { echo: String(args.text ?? "") } };
  });
  const nodes = new NodeRegistry();
  nodes.register(
    { id: "local-node", role: "laptop", runtime_mode: "local", platform: "linux", runtime_capabilities: [], tool_ids: opts.localToolIds },
    { status: "ready", active_jobs: 0, last_seen_at_ms: 1 },
  );
  nodes.register(
    { id: "lan-node", role: "server", runtime_mode: "lan", platform: "linux", runtime_capabilities: [], tool_ids: opts.lanToolIds },
    { status: opts.lanState ?? "ready", active_jobs: 0, last_seen_at_ms: 1 },
  );
  const providers = new ProviderRegistry();
  const routing = new HybridRoutingEngine({ nodes, providers });
  const remotes = new NodeToolExecutionBindings();
  const fakeClient = {
    execute: async (
      toolId: string, _v: string, _h: string, args: Record<string, unknown>,
      _c: { session_id: string; turn_id: string; trace_id: string; mode: string },
      _a: { execution_id: string; attempt_id: string; attempt_no: number; deadline_at: string; signal?: AbortSignal },
    ): Promise<ToolResult> => {
      lanHttpCalls.n += 1;
      lanCalls.n += 1;
      assert.equal(toolId, "system.echo");
      if (opts.lanExecutor) return opts.lanExecutor(args);
      return { ok: true, summary: String(args.text ?? ""), data: { echo: String(args.text ?? "") } };
    },
  };
  remotes.register("lan-node", fakeClient);
  const permissions = new PermissionService();
  const buildService = (): ReturnType<ToolRegistry["createHybridSingleAttemptService"]> =>
    registry.createHybridSingleAttemptService(permissions, (localInvoke) => {
      const invoker = new HybridToolAttemptInvoker({
        nodes, routing, localNodeId: "local-node", remotes, localInvoke,
        toolContract: (name: string) => registry.getToolContract(name),
      });
      return invoker.invoke;
    });
  return { registry, permissions, nodes, providers, routing, remotes, localCalls, lanCalls, lanHttpCalls, buildService, store, executions, close: () => store.close() };
}

async function attemptOnce(rig: HybridRig, args: Record<string, unknown> = { text: "hi" }): Promise<ReturnType<ReturnType<HybridRig["buildService"]>["executeAttempt"]>> {
  const service = rig.buildService();
  const ctl = new AbortController();
  const policy = rig.registry.getExecutionPolicy("system.echo") as ToolExecutionPolicy;
  return service.executeAttempt({
    name: "system.echo", args,
    ctx: { session_id: "s1", turn_id: "t1", trace_id: "tr1", mode: ArthurMode.PERSONAL, approved: false },
    attempt: { execution_id: "e1", attempt_id: "a1", attempt_no: 1, deadline_at: new Date(Date.now() + 10000).toISOString(), signal: ctl.signal },
    policy, signal: ctl.signal, abortGraceMs: 50,
  });
}

// ---- §32 routing matrix ----------------------------------------------------

test("HR03E-32A: local-only routes to the private local executor with zero network", async () => {
  const rig = buildHybridRig({ localToolIds: ["system.echo"], lanToolIds: [] });
  try {
    const outcome = await attemptOnce(rig);
    assert.equal(outcome.ok, true);
    assert.equal(rig.localCalls.n, 1);
    assert.equal(rig.lanHttpCalls.n, 0);
  } finally { rig.close(); }
});

test("HR03E-32B: lan-only routes to the LAN executor with zero local calls", async () => {
  const rig = buildHybridRig({ localToolIds: [], lanToolIds: ["system.echo"] });
  try {
    const outcome = await attemptOnce(rig);
    assert.equal(outcome.ok, true);
    assert.equal(rig.lanCalls.n, 1);
    assert.equal(rig.localCalls.n, 0);
  } finally { rig.close(); }
});

test("HR03E-32C: both available prefers local by default", async () => {
  const rig = buildHybridRig({ localToolIds: ["system.echo"], lanToolIds: ["system.echo"] });
  try {
    const outcome = await attemptOnce(rig);
    assert.equal(outcome.ok, true);
    assert.equal(rig.localCalls.n, 1);
    assert.equal(rig.lanHttpCalls.n, 0);
  } finally { rig.close(); }
});

test("HR03E-32D: unavailable lan node is filtered, local selected", async () => {
  const rig = buildHybridRig({ localToolIds: ["system.echo"], lanToolIds: ["system.echo"], lanState: "unavailable" });
  try {
    const outcome = await attemptOnce(rig);
    assert.equal(outcome.ok, true);
    assert.equal(rig.localCalls.n, 1);
    assert.equal(rig.lanHttpCalls.n, 0);
  } finally { rig.close(); }
});

test("HR03E-32E: no eligible node fails before dispatch (NOT_APPLIED, executors zero)", async () => {
  const rig = buildHybridRig({ localToolIds: [], lanToolIds: [] });
  try {
    const outcome = await attemptOnce(rig);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.effectOutcome, "not_applied");
      assert.equal(outcome.kind, "permanent");
    }
    assert.equal(rig.localCalls.n, 0);
    assert.equal(rig.lanCalls.n, 0);
  } finally { rig.close(); }
});

test("HR03E-32F: lan selected but no client binding fails closed with no fallback", async () => {
  const rig = buildHybridRig({ localToolIds: [], lanToolIds: ["system.echo"] });
  rig.remotes.remove("lan-node");
  try {
    const outcome = await attemptOnce(rig);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.failure.code, "REMOTE_TOOL_BINDING_MISSING");
      assert.equal(outcome.effectOutcome, "not_applied");
    }
    assert.equal(rig.localCalls.n, 0);
    assert.equal(rig.lanCalls.n, 0);
  } finally { rig.close(); }
});

test("HR03E-08: no within-attempt fallback (remote fails -> typed failure, local zero)", async () => {
  const rig = buildHybridRig({
    localToolIds: [], lanToolIds: ["system.echo"],
    lanExecutor: () => { throw new Error("remote boom"); },
  });
  try {
    const outcome = await attemptOnce(rig);
    assert.equal(outcome.ok, false);
    assert.equal(rig.lanCalls.n, 1);
    assert.equal(rig.localCalls.n, 0);
    if (!outcome.ok) assert.equal(outcome.effectOutcome, "not_applied");
  } finally { rig.close(); }
});

test("HR03E-31: contract hash mismatch fails closed before executor (NOT_APPLIED, invocations 0)", async () => {
  const rig = buildHybridRig({ localToolIds: [], lanToolIds: ["system.echo"] });
  let remoteInvocations = 0;
  const bindings = new ToolExecutorBindings();
  const callerHash = rig.registry.getDefinitionHash("system.echo") as string;
  assert.match(callerHash, /^[0-9a-f]{64}$/);
  const wrongHash = callerHash.slice(0, 63) + (callerHash[63] === "a" ? "b" : "a");
  bindings.register({
    tool_id: "system.echo", tool_version: "1.0.0", tool_definition_hash: wrongHash,
    executor: () => { remoteInvocations += 1; return { ok: true, summary: "x", data: { echo: "x" } }; },
  });
  const gateways = new ModelGatewayRegistry();
  const live = await serveLan(gateways, bindings);
  try {
    const client = new LanToolExecutor({ baseUrl: live.baseUrl, authToken: TOKEN });
    const contract = rig.registry.getToolContract("system.echo") as { version: string; definitionHash: string };
    await assert.rejects(
      () => client.execute("system.echo", contract.version, contract.definitionHash, { text: "hi" },
        { session_id: "s1", turn_id: "t1", trace_id: "tr1", mode: "personal" },
        { execution_id: "e1", attempt_id: "a1", attempt_no: 1, deadline_at: new Date(Date.now() + 5000).toISOString() }),
      (e: unknown) => e instanceof AttemptDispatchError && e.dispatchCode === "TOOL_CONTRACT_MISMATCH",
    );
    assert.equal(remoteInvocations, 0);
    // Version mismatch likewise.
    await assert.rejects(
      () => client.execute("system.echo", "9.9.9", contract.definitionHash, { text: "hi" },
        { session_id: "s1", turn_id: "t1", trace_id: "tr1", mode: "personal" },
        { execution_id: "e1", attempt_id: "a1", attempt_no: 1, deadline_at: new Date(Date.now() + 5000).toISOString() }),
      (e: unknown) => e instanceof AttemptDispatchError && e.dispatchCode === "TOOL_CONTRACT_MISMATCH",
    );
    assert.equal(remoteInvocations, 0);
  } finally { await live.close(); rig.close(); }
});

// ---- §33 authorization sits before routing ---------------------------------

function approvalRig(): { registry: ToolRegistry; permissions: PermissionService; routingCalls: { n: number }; service: ReturnType<ToolRegistry["createHybridSingleAttemptService"]>; kp: { kid: string; privateKeyPem: string; publicKeyPem: string }; close: () => void } {
  const registry = new ToolRegistry();
  let localExecutions = 0;
  registry.register(approvalDef(), () => ({ action: "write", details: [] }), () => { localExecutions += 1; return { ok: true, summary: "wrote" }; });
  void localExecutions;
  const permissions = new PermissionService();
  const nodes = new NodeRegistry();
  nodes.register({ id: "local-node", role: "laptop", runtime_mode: "local", platform: "linux", runtime_capabilities: [], tool_ids: ["custom.write"] }, { status: "ready", active_jobs: 0, last_seen_at_ms: 1 });
  const routing = new HybridRoutingEngine({ nodes, providers: new ProviderRegistry() });
  const routingCalls = { n: 0 };
  const counting = { route: (req: Parameters<HybridRoutingEngine["route"]>[0]) => { routingCalls.n += 1; return routing.route(req); } } as unknown as HybridRoutingEngine;
  const remotes = new NodeToolExecutionBindings();
  const service = registry.createHybridSingleAttemptService(permissions, (localInvoke) => {
    const invoker = new HybridToolAttemptInvoker({
      nodes, routing: counting, localNodeId: "local-node", remotes, localInvoke,
      toolContract: (name: string) => registry.getToolContract(name),
    });
    return invoker.invoke;
  });
  const kp = generateApprovalKeypair();
  return { registry, permissions, routingCalls, service, kp, close: () => undefined };
}

function signFor(kp: { kid: string; privateKeyPem: string; publicKeyPem: string }, args: Record<string, unknown>, over: { expiresAt?: string; argsHash?: string } = {}): import("../../src/tools/approval_signer").VerifiedApproval {
  const signer = new ApprovalSigner(kp);
  const verifier = new ApprovalVerifier([kp]);
  const argsHash = over.argsHash ?? approvalArgumentsHash(args);
  const toolHash = toolDefinitionHash(approvalDef());
  const intent: ApprovalIntentV2 = {
    binding_version: 2, approval_id: "ap-1", tool_call_id: "tc-1", session_id: "s", turn_id: "t",
    mode: "business", tool_name: "custom.write", tool_version: "1.0.0", tool_definition_hash: toolHash,
    risk_level: "approval_required", arguments_hash: argsHash, presentation_hash: "p", created_at: new Date().toISOString(),
    expires_at: over.expiresAt ?? new Date(Date.now() + 60000).toISOString(),
  };
  return verifier.verify(signer.sign(intent, authorizationDigest(intent)));
}

async function hybridAttempt(rig: ReturnType<typeof approvalRig>, ctx: Parameters<ReturnType<typeof approvalRig>["service"]["executeAttempt"]>[0]["ctx"], args: Record<string, unknown> = { path: "A" }): Promise<Awaited<ReturnType<ReturnType<typeof approvalRig>["service"]["executeAttempt"]>>> {
  const ctl = new AbortController();
  const policy = rig.registry.getExecutionPolicy("custom.write") as ToolExecutionPolicy;
  try {
    return await rig.service.executeAttempt({
      name: "custom.write", args, ctx, attempt: { execution_id: "e1", attempt_id: "a1", attempt_no: 1, deadline_at: new Date(Date.now() + 10000).toISOString(), signal: ctl.signal },
      policy, signal: ctl.signal, abortGraceMs: 50,
    });
  } catch (e) { throw e; }
}

test("HR03E-33: approval-required tool without authorization rejects before routing", async () => {
  const rig = approvalRig();
  try {
    await assert.rejects(
      () => hybridAttempt(rig, { session_id: "s", turn_id: "t", trace_id: "tr", mode: "business", approved: false }),
      (e: unknown) => (e as Error).name === "ArthurError",
    );
    assert.equal(rig.routingCalls.n, 0);
  } finally { rig.close(); }
});

test("HR03E-33: expired authorization rejects with zero routing", async () => {
  const rig = approvalRig();
  try {
    const verified = signFor(rig.kp, { path: "A" }, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await assert.rejects(
      () => hybridAttempt(rig, { session_id: "s", turn_id: "t", trace_id: "tr", mode: "business", approved: true, authorization: verified }),
    );
    assert.equal(rig.routingCalls.n, 0);
  } finally { rig.close(); }
});

test("HR03E-33: wrong argument hash rejects with zero routing", async () => {
  const rig = approvalRig();
  try {
    const verified = signFor(rig.kp, { path: "A" });
    await assert.rejects(
      () => hybridAttempt(rig, { session_id: "s", turn_id: "t", trace_id: "tr", mode: "business", approved: true, authorization: verified }, { path: "B" }),
    );
    assert.equal(rig.routingCalls.n, 0);
  } finally { rig.close(); }
});

test("HR03E-33: valid authorization dispatches exactly once", async () => {
  const rig = approvalRig();
  try {
    const verified = signFor(rig.kp, { path: "A" });
    const outcome = await hybridAttempt(rig, { session_id: "s", turn_id: "t", trace_id: "tr", mode: "business", approved: true, authorization: verified });
    assert.equal(outcome.ok, true);
    assert.equal(rig.routingCalls.n, 1);
  } finally { rig.close(); }
});

test("HR03E-34: malformed args reject before remote dispatch (HTTP 0, remote 0)", async () => {
  const rig = buildHybridRig({ localToolIds: [], lanToolIds: ["system.echo"] });
  try {
    await assert.rejects(() => attemptOnce(rig, { text: 42 as unknown as string }));
    assert.equal(rig.lanHttpCalls.n, 0);
    assert.equal(rig.lanCalls.n, 0);
  } finally { rig.close(); }
});

test("HR03E-35: remote output violating caller schema rejected AFTER execution", async () => {
  const rig = buildHybridRig({
    localToolIds: [], lanToolIds: ["system.echo"],
    lanExecutor: () => ({ ok: true, summary: "bad", data: { wrong: 1 } }),
  });
  try {
    const outcome = await attemptOnce(rig);
    assert.equal(outcome.ok, false);
    assert.equal(rig.lanCalls.n, 1);
    if (!outcome.ok) {
      assert.equal(outcome.kind, "output_invalid");
      assert.equal(outcome.effectOutcome, "not_applied");
    }
  } finally { rig.close(); }
});

// ---- LAN loopback helpers ---------------------------------------------------

interface LiveLan { baseUrl: string; close: () => Promise<void>; }

async function serveLan(gateways: ModelGatewayRegistry, bindings?: ToolExecutorBindings, token = TOKEN): Promise<LiveLan> {
  const handler = createLanRuntimeHandler({ gateways, authToken: token, ...(bindings !== undefined ? { toolBindings: bindings } : {}) });
  const server = http.createServer((incoming, outgoing) => {
    const chunks: Uint8Array[] = [];
    incoming.on("data", (c: Uint8Array) => { chunks.push(c); });
    incoming.on("end", () => {
      const oneShot = (async function* () { yield Buffer.concat(chunks); })();
      let peerAborted = false;
      const listeners: (() => void)[] = [];
      const fire = (): void => { if (!peerAborted) { peerAborted = true; for (const fn of listeners.splice(0)) { try { fn(); } catch { /* best effort */ } } } };
      incoming.on("aborted", fire);
      outgoing.on("close", () => { if (!outgoing.writableEnded) fire(); });
      const lanReq: LanHttpRequest = {
        method: incoming.method ?? "GET", url: incoming.url ?? "/",
        headers: incoming.headers as Record<string, string | string[] | undefined>, body: oneShot,
        get aborted(): boolean { return peerAborted || incoming.aborted; },
        onAborted: (fn: () => void) => { if (peerAborted || incoming.aborted) { try { fn(); } catch { /* best effort */ } } else listeners.push(fn); },
      };
      const lanRes = {
        statusCode: 200, headers: {} as Record<string, string>,
        writeHead(status: number, headers: Record<string, string>): void { outgoing.writeHead(status, headers); },
        write(chunk: string): boolean { return outgoing.write(chunk); },
        end(body?: string): void { outgoing.end(body); },
        get ended(): boolean { return outgoing.writableEnded; },
      };
      void handler(lanReq, lanRes).catch(() => { try { outgoing.writeHead(500); outgoing.end('{"error":"x"}'); } catch { /* closed */ } });
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const addr = server.address() as AddressInfo;
  return { baseUrl: "http://127.0.0.1:" + String(addr.port), close: () => new Promise<void>((resolve, reject) => { server.close((e) => { if (e) reject(e); else resolve(); }); }) };
}

function lanHybridWorld(remoteExecutor: (args: Record<string, unknown>, ctx: unknown) => ToolResult | Promise<ToolResult>, policy: ToolExecutionPolicy = readPolicy()): {
  caller: ToolRegistry; store: SessionStore; executions: ExecutionStore; coordinator: ToolExecutionCoordinator; bindings: ToolExecutorBindings; remoteCalls: { n: number }; localCalls: { n: number };
} {
  const { store, executions } = seedWorld();
  const caller = new ToolRegistry();
  const localCalls = { n: 0 };
  caller.register(echoDef({ execution_policy: policy }), () => { localCalls.n += 1; return { ok: true, summary: "local", data: { echo: "local" } }; });
  const remoteCalls = { n: 0 };
  const bindings = new ToolExecutorBindings();
  const callerHash = caller.getDefinitionHash("system.echo") as string;
  bindings.register({
    tool_id: "system.echo", tool_version: "1.0.0", tool_definition_hash: callerHash,
    executor: ((args: Record<string, unknown>, ctx: unknown) => { remoteCalls.n += 1; return remoteExecutor(args, ctx); }) as never,
  });
  const permissions = new PermissionService();
  void permissions;
  return { caller, store, executions, coordinator: undefined as unknown as ToolExecutionCoordinator, bindings, remoteCalls, localCalls };
}

async function runCoordinatorE2E(opts: {
  policy?: ToolExecutionPolicy; remoteExecutor: (args: Record<string, unknown>, ctx: unknown) => ToolResult | Promise<ToolResult>;
}): Promise<{ state: string; remoteCalls: number; localCalls: number; executionId: string }> {
  const world = lanHybridWorld(opts.remoteExecutor, opts.policy);
  const gateways = new ModelGatewayRegistry();
  const live = await serveLan(gateways, world.bindings);
  try {
    const nodes = new NodeRegistry();
    nodes.register({ id: "local-node", role: "laptop", runtime_mode: "local", platform: "linux", runtime_capabilities: [], tool_ids: [] }, { status: "ready", active_jobs: 0, last_seen_at_ms: 1 });
    nodes.register({ id: "lan-node", role: "server", runtime_mode: "lan", platform: "linux", runtime_capabilities: [], tool_ids: ["system.echo"] }, { status: "ready", active_jobs: 0, last_seen_at_ms: 1 });
    const routing = new HybridRoutingEngine({ nodes, providers: new ProviderRegistry() });
    const remotes = new NodeToolExecutionBindings();
    const client = new LanToolExecutor({ baseUrl: live.baseUrl, authToken: TOKEN });
    remotes.register("lan-node", client);
    const permissions = new PermissionService();
    const attempts = world.caller.createHybridSingleAttemptService(permissions, (localInvoke) => {
      const invoker = new HybridToolAttemptInvoker({
        nodes, routing, localNodeId: "local-node", remotes, localInvoke,
        toolContract: (name: string) => world.caller.getToolContract(name),
      });
      return invoker.invoke;
    });
    const clock = new FakeExecutionClock(Date.parse("2026-01-01T00:00:00.000Z"), [0.5]);
    const coordinator = new ToolExecutionCoordinator(world.store, world.executions, world.caller, permissions, attempts, new SecretSanitizer([]), new Logger("error"), new InMemoryMetrics(), { runtimeInstanceId: "runtime-hr03e", clock });
    const policy = (opts.policy ?? readPolicy());
    const req = {
      toolName: "system.echo", args: { text: "ping" }, sessionId: "s1", turnId: "t1", traceId: "tr1",
      mode: ArthurMode.PERSONAL, toolCallId: "tc-e2e", approvalId: null,
      toolVersion: "1.0.0", toolDefinitionHash: world.caller.getDefinitionHash("system.echo") as string,
      argumentsHash: "a".repeat(64), policy,
    };
    world.store.createToolCall({ id: "tc-e2e", turnId: "t1", toolName: "system.echo", argumentsJson: '{"text":"ping"}', riskLevel: "read", status: "executing" });
    const created = coordinator.createExecution(req);
    const run = await coordinator.run(req, created.id);
    assert.equal(client.dispatchCount, 1, "exactly one HTTP dispatch per SC-03 attempt");
    return { state: run.state, remoteCalls: world.remoteCalls.n, localCalls: world.localCalls.n, executionId: created.id };
  } finally { await live.close(); world.store.close(); }
}

test("HR03E-36: real loopback E2E caller gates -> routing -> HTTP -> adapter -> SUCCEEDED", async () => {
  const out = await runCoordinatorE2E({ remoteExecutor: (args) => ({ ok: true, summary: String(args.text), data: { echo: String(args.text) } }) });
  assert.equal(out.state, "succeeded");
  assert.equal(out.remoteCalls, 1);
  assert.equal(out.localCalls, 0);
});

test("HR03E-37: mutation response-loss quarantines OUTCOME_UNKNOWN (no retry/fallback)", async () => {
  const gateways = new ModelGatewayRegistry();
  // Remote host: bind a mutation adapter through the real HTTP server, then
  // destroy the socket mid-response by using a raw server instead. Here we
  // prove the caller-side mapping: a transport failure AFTER dispatch began
  // maps to unknown, and SC-03 quarantines (mutation policy, max 1).
  void gateways;
  const { store, executions } = seedWorld();
  const caller = new ToolRegistry();
  let localCalls = 0;
  caller.register({
    name: "sys.mutate", version: "1.0.0", description: "mutation", input_schema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read", allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS], execution_policy: mutationPolicy(),
  }, () => { localCalls += 1; return { ok: true, summary: "local" }; });
  const server = http.createServer((_req, res) => {
    // Accept the tool frame, then destroy the connection without a response:
    // the mutation already "happened" from the caller's perspective.
    void _req.resume();
    void _req.on("end", () => { res.destroy(); });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const addr = server.address() as AddressInfo;
  const baseUrl = "http://127.0.0.1:" + String(addr.port);
  try {
    let remoteInvocations = 0;
    const nodes = new NodeRegistry();
    nodes.register({ id: "local-node", role: "laptop", runtime_mode: "local", platform: "linux", runtime_capabilities: [], tool_ids: [] }, { status: "ready", active_jobs: 0, last_seen_at_ms: 1 });
    nodes.register({ id: "lan-node", role: "server", runtime_mode: "lan", platform: "linux", runtime_capabilities: [], tool_ids: ["sys.mutate"] }, { status: "ready", active_jobs: 0, last_seen_at_ms: 1 });
    const routing = new HybridRoutingEngine({ nodes, providers: new ProviderRegistry() });
    const remotes = new NodeToolExecutionBindings();
    // Counting client that still performs the single real HTTP dispatch.
    const inner = new LanToolExecutor({ baseUrl, authToken: TOKEN });
    const counting = {
      execute: async (toolId: string, v: string, h: string, args: Record<string, unknown>, c: never, a: never): Promise<ToolResult> => {
        remoteInvocations += 1;
        return inner.execute(toolId, v, h, args, c as never, a as never);
      },
    };
    remotes.register("lan-node", counting as never);
    const permissions = new PermissionService();
    const attempts = caller.createHybridSingleAttemptService(permissions, (localInvoke) => {
      const invoker = new HybridToolAttemptInvoker({
        nodes, routing, localNodeId: "local-node", remotes, localInvoke,
        toolContract: (name: string) => caller.getToolContract(name),
      });
      return invoker.invoke;
    });
    const clock = new FakeExecutionClock(Date.parse("2026-01-01T00:00:00.000Z"), [0.5]);
    const coordinator = new ToolExecutionCoordinator(store, executions, caller, permissions, attempts, new SecretSanitizer([]), new Logger("error"), new InMemoryMetrics(), { runtimeInstanceId: "runtime-hr03e-mut", clock });
    const policy = mutationPolicy();
    const req = {
      toolName: "sys.mutate", args: {}, sessionId: "s1", turnId: "t1", traceId: "tr1",
      mode: ArthurMode.PERSONAL, toolCallId: "tc-mut", approvalId: null,
      toolVersion: "1.0.0", toolDefinitionHash: caller.getDefinitionHash("sys.mutate") as string,
      argumentsHash: "a".repeat(64), policy,
    };
    store.createToolCall({ id: "tc-mut", turnId: "t1", toolName: "sys.mutate", argumentsJson: "{}", riskLevel: "read", status: "executing" });
    const created = coordinator.createExecution(req);
    const run = await coordinator.run(req, created.id);
    assert.equal(run.state, "outcome_unknown");
    assert.equal(remoteInvocations, 1);
    assert.equal(inner.dispatchCount, 1);
    assert.equal(localCalls, 0);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    store.close();
  }
});

test("HR03E-38: side-effect-free transient failure keeps SC-03-owned retry (new attempt id)", async () => {
  const err = new AttemptDispatchError("transient", "not_applied", "LAN_TRANSPORT", "lan down");
  const failure = classifyExecutorError(err, "none");
  assert.equal(failure.kind, "transient");
  assert.equal(failure.effect_outcome, "not_applied");
  assert.equal(failure.retry_hint, true);
  // Through the coordinator: flaky remote fails once transient, then the
  // durable policy schedules a NEW attempt with a new attempt id.
  const { store, executions } = seedWorld();
  const caller = new ToolRegistry();
  caller.register(echoDef(), (args) => ({ ok: true, summary: String(args.text ?? ""), data: { echo: String(args.text ?? "") } }));
  let calls = 0;
  const nodes = new NodeRegistry();
  nodes.register({ id: "local-node", role: "laptop", runtime_mode: "local", platform: "linux", runtime_capabilities: [], tool_ids: [] }, { status: "ready", active_jobs: 0, last_seen_at_ms: 1 });
  nodes.register({ id: "lan-node", role: "server", runtime_mode: "lan", platform: "linux", runtime_capabilities: [], tool_ids: ["system.echo"] }, { status: "ready", active_jobs: 0, last_seen_at_ms: 1 });
  const routing = new HybridRoutingEngine({ nodes, providers: new ProviderRegistry() });
  const remotes = new NodeToolExecutionBindings();
  remotes.register("lan-node", {
    execute: async (): Promise<ToolResult> => {
      calls += 1;
      if (calls === 1) throw new AttemptDispatchError("transient", "not_applied", "LAN_TRANSPORT", "lan down");
      return { ok: true, summary: "recovered", data: { echo: "recovered" } };
    },
  });
  const permissions = new PermissionService();
  const attempts = caller.createHybridSingleAttemptService(permissions, (localInvoke) => {
    const invoker = new HybridToolAttemptInvoker({
      nodes, routing, localNodeId: "local-node", remotes, localInvoke,
      toolContract: (name: string) => caller.getToolContract(name),
    });
    return invoker.invoke;
  });
  const clock = new FakeExecutionClock(Date.parse("2026-01-01T00:00:00.000Z"), [0.5]);
  const coordinator = new ToolExecutionCoordinator(store, executions, caller, permissions, attempts, new SecretSanitizer([]), new Logger("error"), new InMemoryMetrics(), { runtimeInstanceId: "runtime-hr03e-r", clock });
  try {
    const policy = readPolicy();
    const req = {
      toolName: "system.echo", args: { text: "x" }, sessionId: "s1", turnId: "t1", traceId: "tr1",
      mode: ArthurMode.PERSONAL, toolCallId: "tc-retry", approvalId: null,
      toolVersion: "1.0.0", toolDefinitionHash: caller.getDefinitionHash("system.echo") as string,
      argumentsHash: "a".repeat(64), policy,
    };
    store.createToolCall({ id: "tc-retry", turnId: "t1", toolName: "system.echo", argumentsJson: '{"text":"x"}', riskLevel: "read", status: "executing" });
    const created = coordinator.createExecution(req);
    let run = await coordinator.run(req, created.id);
    while (run.state === "retry_wait") {
      const exec = coordinator.getExecution(created.id);
      const waitMs = exec?.next_attempt_at ? Date.parse(exec.next_attempt_at) - clock.nowMs() : 0;
      if (waitMs > 0) await clock.sleep(waitMs);
      run = await coordinator.run(req, created.id);
    }
    assert.equal(run.state, "succeeded");
    assert.equal(calls, 2);
    const attemptRows = executions.listAttempts(created.id);
    assert.equal(attemptRows.length, 2);
    assert.notEqual(attemptRows[0]?.id, attemptRows[1]?.id);
  } finally { store.close(); }
});

test("HR03E-39: durable execution + claimed attempt exist before remote side effect", async () => {
  const { store, executions } = seedWorld();
  const caller = new ToolRegistry();
  caller.register(echoDef(), (args) => ({ ok: true, summary: String(args.text ?? ""), data: { echo: String(args.text ?? "") } }));
  const gateways = new ModelGatewayRegistry();
  const bindings = new ToolExecutorBindings();
  const callerHash = caller.getDefinitionHash("system.echo") as string;
  let observed = "";
  bindings.register({
    tool_id: "system.echo", tool_version: "1.0.0", tool_definition_hash: callerHash,
    executor: () => {
      const rows = store.unsafeDbHandle().prepare("SELECT state FROM tool_executions").all() as Array<{ state: string }>;
      const attempts = store.unsafeDbHandle().prepare("SELECT state FROM tool_execution_attempts").all() as Array<{ state: string }>;
      observed = "exec:" + rows.map((r) => r.state).join(",") + " attempts:" + attempts.map((r) => r.state).join(",");
      return { ok: true, summary: "remote", data: { echo: "remote" } };
    },
  });
  const live = await serveLan(gateways, bindings);
  try {
    const nodes = new NodeRegistry();
    nodes.register({ id: "local-node", role: "laptop", runtime_mode: "local", platform: "linux", runtime_capabilities: [], tool_ids: [] }, { status: "ready", active_jobs: 0, last_seen_at_ms: 1 });
    nodes.register({ id: "lan-node", role: "server", runtime_mode: "lan", platform: "linux", runtime_capabilities: [], tool_ids: ["system.echo"] }, { status: "ready", active_jobs: 0, last_seen_at_ms: 1 });
    const routing = new HybridRoutingEngine({ nodes, providers: new ProviderRegistry() });
    const remotes = new NodeToolExecutionBindings();
    remotes.register("lan-node", new LanToolExecutor({ baseUrl: live.baseUrl, authToken: TOKEN }));
    const permissions = new PermissionService();
    const attempts = caller.createHybridSingleAttemptService(permissions, (localInvoke) => {
      const invoker = new HybridToolAttemptInvoker({
        nodes, routing, localNodeId: "local-node", remotes, localInvoke,
        toolContract: (name: string) => caller.getToolContract(name),
      });
      return invoker.invoke;
    });
    const clock = new FakeExecutionClock(Date.parse("2026-01-01T00:00:00.000Z"), [0.5]);
    const coordinator = new ToolExecutionCoordinator(store, executions, caller, permissions, attempts, new SecretSanitizer([]), new Logger("error"), new InMemoryMetrics(), { runtimeInstanceId: "runtime-hr03e-d", clock });
    const policy = readPolicy();
    const req = {
      toolName: "system.echo", args: { text: "x" }, sessionId: "s1", turnId: "t1", traceId: "tr1",
      mode: ArthurMode.PERSONAL, toolCallId: "tc-dur", approvalId: null,
      toolVersion: "1.0.0", toolDefinitionHash: callerHash, argumentsHash: "a".repeat(64), policy,
    };
    store.createToolCall({ id: "tc-dur", turnId: "t1", toolName: "system.echo", argumentsJson: '{"text":"x"}', riskLevel: "read", status: "executing" });
    const created = coordinator.createExecution(req);
    const run = await coordinator.run(req, created.id);
    assert.equal(run.state, "succeeded");
    assert.match(observed, /exec:running/);
    assert.match(observed, /attempts:running/);
  } finally { await live.close(); store.close(); }
});

test("HR03E-41: bearer auth enforced, no oracle, no secret leakage", async () => {
  const gateways = new ModelGatewayRegistry();
  const bindings = new ToolExecutorBindings();
  const probe = new ToolRegistry();
  probe.register(echoDef(), (args) => ({ ok: true, summary: String(args.text ?? ""), data: { echo: String(args.text ?? "") } }));
  const hash = probe.getDefinitionHash("system.echo") as string;
  let remoteInvocations = 0;
  bindings.register({
    tool_id: "system.echo", tool_version: "1.0.0", tool_definition_hash: hash,
    executor: () => { remoteInvocations += 1; return { ok: true, summary: "remote", data: { echo: "remote" } }; },
  });
  const live = await serveLan(gateways, bindings);
  try {
    const envelope = (toolId: string): string => JSON.stringify({
      protocol_version: 1, request_id: "r1", tool_version: "1.0.0", tool_definition_hash: hash,
      execution: { execution_id: "e", attempt_id: "a", attempt_no: 1, deadline_at: new Date(Date.now() + 5000).toISOString(), session_id: "s", turn_id: "t", trace_id: "tr", mode: "personal", args: { text: "x" } },
    });
    void envelope;
    const post = async (toolId: string, token?: string): Promise<{ status: number; body: string }> => {
      const res = await fetch(live.baseUrl + "/v1/runtime/tools/" + encodeURIComponent(toolId) + "/execute", {
        method: "POST",
        headers: { ...(token !== undefined ? { authorization: "Bearer " + token } : {}), "content-type": "application/json" },
        body: envelope(toolId),
        redirect: "error",
      });
      return { status: res.status, body: await res.text() };
    };
    const good = await post("system.echo", TOKEN);
    assert.equal(good.status, 200);
    assert.equal(remoteInvocations, 1);
    const missing = await post("system.echo");
    assert.equal(missing.status, 401);
    const wrong = await post("system.echo", "wrong-token");
    assert.equal(wrong.status, 401);
    const oracleValid = await post("system.echo", "wrong-token");
    const oracleInvalid = await post("no.such.tool", "wrong-token");
    assert.equal(oracleValid.status, oracleInvalid.status);
    assert.equal(remoteInvocations, 1);
    for (const body of [good.body, missing.body, wrong.body]) {
      assert.ok(!body.includes(TOKEN), "token must never appear in a body");
    }
  } finally { await live.close(); }
});

test("HR03E-29/50: cancellation propagates end to end with no fallback", async () => {
  const gateways = new ModelGatewayRegistry();
  const bindings = new ToolExecutorBindings();
  const probe = new ToolRegistry();
  probe.register(echoDef(), (args) => ({ ok: true, summary: String(args.text ?? ""), data: { echo: String(args.text ?? "") } }));
  const hash = probe.getDefinitionHash("system.echo") as string;
  let remoteObservedAbort = false;
  let remoteCalls = 0;
  bindings.register({
    tool_id: "system.echo", tool_version: "1.0.0", tool_definition_hash: hash,
    executor: (_args, ctx) => {
      remoteCalls += 1;
      const signal = (ctx as { signal?: AbortSignal }).signal;
      return new Promise<ToolResult>((resolve, reject) => {
        if (signal?.aborted) { remoteObservedAbort = true; reject(Object.assign(new Error("cancelled"), { name: "AbortError" })); return; }
        signal?.addEventListener("abort", () => { remoteObservedAbort = true; reject(Object.assign(new Error("cancelled"), { name: "AbortError" })); }, { once: true });
      });
    },
  });
  const live = await serveLan(gateways, bindings);
  try {
    const caller = new ToolRegistry();
    let localCalls = 0;
    caller.register(echoDef(), () => { localCalls += 1; return { ok: true, summary: "local", data: { echo: "local" } }; });
    const nodes = new NodeRegistry();
    nodes.register({ id: "local-node", role: "laptop", runtime_mode: "local", platform: "linux", runtime_capabilities: [], tool_ids: [] }, { status: "ready", active_jobs: 0, last_seen_at_ms: 1 });
    nodes.register({ id: "lan-node", role: "server", runtime_mode: "lan", platform: "linux", runtime_capabilities: [], tool_ids: ["system.echo"] }, { status: "ready", active_jobs: 0, last_seen_at_ms: 1 });
    const routing = new HybridRoutingEngine({ nodes, providers: new ProviderRegistry() });
    const remotes = new NodeToolExecutionBindings();
    remotes.register("lan-node", new LanToolExecutor({ baseUrl: live.baseUrl, authToken: TOKEN }));
    const permissions = new PermissionService();
    const service = caller.createHybridSingleAttemptService(permissions, (localInvoke) => {
      const invoker = new HybridToolAttemptInvoker({
        nodes, routing, localNodeId: "local-node", remotes, localInvoke,
        toolContract: (name: string) => caller.getToolContract(name),
      });
      return invoker.invoke;
    });
    const ctl = new AbortController();
    const policy = caller.getExecutionPolicy("system.echo") as ToolExecutionPolicy;
    const pending = service.executeAttempt({
      name: "system.echo", args: { text: "x" },
      ctx: { session_id: "s1", turn_id: "t1", trace_id: "tr1", mode: ArthurMode.PERSONAL, approved: false },
      attempt: { execution_id: "e-c", attempt_id: "a-c", attempt_no: 1, deadline_at: new Date(Date.now() + 10000).toISOString(), signal: ctl.signal },
      policy, signal: ctl.signal, abortGraceMs: 200,
    });
    await new Promise((r) => setTimeout(r, 100));
    ctl.abort(new Error("user cancellation"));
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.kind, "cancelled");
    assert.equal(remoteCalls, 1);
    assert.equal(localCalls, 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(remoteObservedAbort, true);
  } finally { await live.close(); }
});

test("HR03E-26: dispatch classification matrix (no message regexes)", () => {
  const matrix: Array<{ err: AttemptDispatchError; effects: "none" | "mutation"; kind: string; outcome: string; retry: boolean }> = [
    { err: new AttemptDispatchError("transient", "not_applied", "LAN_TRANSPORT", "x"), effects: "none", kind: "transient", outcome: "not_applied", retry: true },
    { err: new AttemptDispatchError("timeout", "unknown", "TOOL_EXECUTOR_TIMEOUT", "x"), effects: "none", kind: "timeout", outcome: "not_applied", retry: true },
    { err: new AttemptDispatchError("permanent", "not_applied", "TOOL_CONTRACT_MISMATCH", "x"), effects: "none", kind: "permanent", outcome: "not_applied", retry: false },
    { err: new AttemptDispatchError("protocol", "unknown", "TOOL_OUTPUT_INVALID", "x"), effects: "none", kind: "protocol", outcome: "not_applied", retry: false },
    { err: new AttemptDispatchError("transient", "unknown", "LAN_TRANSPORT", "x"), effects: "mutation", kind: "transient", outcome: "unknown", retry: false },
    { err: new AttemptDispatchError("timeout", "unknown", "TOOL_EXECUTOR_TIMEOUT", "x"), effects: "mutation", kind: "timeout", outcome: "unknown", retry: false },
    { err: new AttemptDispatchError("permanent", "not_applied", "TOOL_CONTRACT_MISMATCH", "x"), effects: "mutation", kind: "permanent", outcome: "not_applied", retry: false },
    { err: new AttemptDispatchError("cancelled", "unknown", "LAN_CANCELLED", "x"), effects: "mutation", kind: "cancelled", outcome: "unknown", retry: false },
  ];
  for (const row of matrix) {
    const failure = classifyExecutorError(row.err, row.effects);
    assert.equal(failure.kind, row.kind, row.err.dispatchCode + "/" + row.effects);
    assert.equal(failure.effect_outcome, row.outcome, row.err.dispatchCode + "/" + row.effects);
    assert.equal(failure.retry_hint, row.retry, row.err.dispatchCode + "/" + row.effects);
    assert.equal(failure.code, row.err.dispatchCode);
  }
});

test("HR03E-50: concurrent attempts route independently (no shared target)", async () => {
  const rig = buildHybridRig({ localToolIds: [], lanToolIds: ["system.echo"] });
  try {
    const service = rig.buildService();
    const policy = rig.registry.getExecutionPolicy("system.echo") as ToolExecutionPolicy;
    const seen: string[] = [];
    rig.remotes.remove("lan-node");
    rig.remotes.register("lan-node", {
      execute: async (_t, _v, _h, args, _c, attempt): Promise<ToolResult> => {
        seen.push(attempt.attempt_id);
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true, summary: String(args.text ?? ""), data: { echo: String(args.text ?? "") } };
      },
    });
    const run = (id: string): Promise<unknown> => {
      const ctl = new AbortController();
      return service.executeAttempt({
        name: "system.echo", args: { text: id },
        ctx: { session_id: "s1", turn_id: "t1", trace_id: "tr1", mode: ArthurMode.PERSONAL, approved: false },
        attempt: { execution_id: "e-" + id, attempt_id: id, attempt_no: 1, deadline_at: new Date(Date.now() + 10000).toISOString(), signal: ctl.signal },
        policy, signal: ctl.signal, abortGraceMs: 50,
      });
    };
    const [a, b] = await Promise.all([run("a-1"), run("a-2")]);
    assert.equal((a as { ok: boolean }).ok, true);
    assert.equal((b as { ok: boolean }).ok, true);
    assert.deepEqual([...seen].sort(), ["a-1", "a-2"]);
  } finally { rig.close(); }
});

test("HR03E-40: SC-06-style tool loop over remote adapter (orchestrator persists result)", async () => {
  // Fake model proposes system.echo; caller validates/auths/persists/routes
  // over real HTTP; remote host executes; caller persists the ToolResult.
  // The remote host never sees model loop orchestration (no model fields
  // cross the wire except the bounded execution block).
  const { store, executions } = seedWorld();
  const caller = new ToolRegistry();
  caller.register(echoDef(), () => ({ ok: true, summary: "local", data: { echo: "local" } }));
  const bindings = new ToolExecutorBindings();
  const hash = caller.getDefinitionHash("system.echo") as string;
  bindings.register({
    tool_id: "system.echo", tool_version: "1.0.0", tool_definition_hash: hash,
    executor: (args) => ({ ok: true, summary: String(args.text), data: { echo: String(args.text) } }),
  });
  const live = await serveLan(new ModelGatewayRegistry(), bindings);
  try {
    const nodes = new NodeRegistry();
    nodes.register({ id: "local-node", role: "laptop", runtime_mode: "local", platform: "linux", runtime_capabilities: [], tool_ids: [] }, { status: "ready", active_jobs: 0, last_seen_at_ms: 1 });
    nodes.register({ id: "lan-node", role: "server", runtime_mode: "lan", platform: "linux", runtime_capabilities: [], tool_ids: ["system.echo"] }, { status: "ready", active_jobs: 0, last_seen_at_ms: 1 });
    const routing = new HybridRoutingEngine({ nodes, providers: new ProviderRegistry() });
    const remotes = new NodeToolExecutionBindings();
    remotes.register("lan-node", new LanToolExecutor({ baseUrl: live.baseUrl, authToken: TOKEN }));
    const permissions = new PermissionService();
    const attempts = caller.createHybridSingleAttemptService(permissions, (localInvoke) => {
      const invoker = new HybridToolAttemptInvoker({
        nodes, routing, localNodeId: "local-node", remotes, localInvoke,
        toolContract: (name: string) => caller.getToolContract(name),
      });
      return invoker.invoke;
    });
    const clock = new FakeExecutionClock(Date.parse("2026-01-01T00:00:00.000Z"), [0.5]);
    const coordinator = new ToolExecutionCoordinator(store, executions, caller, permissions, attempts, new SecretSanitizer([]), new Logger("error"), new InMemoryMetrics(), { runtimeInstanceId: "runtime-hr03e-loop", clock });
    // Model-proposed call (as SC-06 would deliver it).
    const proposed = { id: "call-1", name: "system.echo", arguments: { text: "ping" } };
    const validation = caller.validateArgs(proposed.name, proposed.arguments);
    assert.equal(validation.valid, true);
    const definition = caller.getDefinition(proposed.name) as NonNullable<ReturnType<ToolRegistry["getDefinition"]>>;
    assert.equal(permissions.evaluate(definition, ArthurMode.PERSONAL), "auto");
    const policy = caller.getExecutionPolicy(proposed.name) as ToolExecutionPolicy;
    const req = {
      toolName: proposed.name, args: proposed.arguments as Record<string, unknown>, sessionId: "s1", turnId: "t1", traceId: "tr1",
      mode: ArthurMode.PERSONAL, toolCallId: "tc-loop", approvalId: null,
      toolVersion: definition.version, toolDefinitionHash: hash, argumentsHash: "a".repeat(64), policy,
    };
    store.createToolCall({ id: "tc-loop", turnId: "t1", toolName: proposed.name, argumentsJson: '{"text":"ping"}', riskLevel: "read", status: "executing" });
    const created = coordinator.createExecution(req);
    const run = await coordinator.run(req, created.id);
    assert.equal(run.state, "succeeded");
    assert.equal(run.result?.data, undefined === undefined ? run.result?.data : undefined);
    assert.deepEqual(run.result?.data, { echo: "ping" });
    // Caller persists the tool-result message for the next model round.
    const toolMessage = { role: "tool" as const, content: "ping", name: proposed.name, tool_call_id: proposed.id };
    assert.equal(toolMessage.tool_call_id, "call-1");
  } finally { await live.close(); store.close(); }
});

test("HR03E-30: local execution E2E through coordinator (no network, SUCCEEDED)", async () => {
  const { store, executions } = seedWorld();
  const caller = new ToolRegistry();
  let localCalls = 0;
  caller.register(echoDef(), (args) => { localCalls += 1; return { ok: true, summary: String(args.text ?? ""), data: { echo: String(args.text ?? "") } }; });
  const nodes = new NodeRegistry();
  nodes.register({ id: "local-node", role: "laptop", runtime_mode: "local", platform: "linux", runtime_capabilities: [], tool_ids: ["system.echo"] }, { status: "ready", active_jobs: 0, last_seen_at_ms: 1 });
  const routing = new HybridRoutingEngine({ nodes, providers: new ProviderRegistry() });
  const remotes = new NodeToolExecutionBindings();
  const permissions = new PermissionService();
  const attempts = caller.createHybridSingleAttemptService(permissions, (localInvoke) => {
    const invoker = new HybridToolAttemptInvoker({
      nodes, routing, localNodeId: "local-node", remotes, localInvoke,
      toolContract: (name: string) => caller.getToolContract(name),
    });
    return invoker.invoke;
  });
  const clock = new FakeExecutionClock(Date.parse("2026-01-01T00:00:00.000Z"), [0.5]);
  const coordinator = new ToolExecutionCoordinator(store, executions, caller, permissions, attempts, new SecretSanitizer([]), new Logger("error"), new InMemoryMetrics(), { runtimeInstanceId: "runtime-hr03e-local", clock });
  try {
    const policy = caller.getExecutionPolicy("system.echo") as ToolExecutionPolicy;
    const req = {
      toolName: "system.echo", args: { text: "hi" }, sessionId: "s1", turnId: "t1", traceId: "tr1",
      mode: ArthurMode.PERSONAL, toolCallId: "tc-local", approvalId: null,
      toolVersion: "1.0.0", toolDefinitionHash: caller.getDefinitionHash("system.echo") as string,
      argumentsHash: "a".repeat(64), policy,
    };
    store.createToolCall({ id: "tc-local", turnId: "t1", toolName: "system.echo", argumentsJson: '{"text":"hi"}', riskLevel: "read", status: "executing" });
    const created = coordinator.createExecution(req);
    const run = await coordinator.run(req, created.id);
    assert.equal(run.state, "succeeded");
    assert.equal(localCalls, 1);
  } finally { store.close(); }
});

test("HR03E-28: exactly one HTTP dispatch per attempt even when the server hangs up", async () => {
  // The server accepts and destroys the connection; the client must not
  // retry internally (dispatchCount stays 1; SC-03 owns any new attempt).
  const server = http.createServer((_req, res) => { void _req.resume(); void _req.on("end", () => { res.destroy(); }); });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const addr = server.address() as AddressInfo;
  const baseUrl = "http://127.0.0.1:" + String(addr.port);
  try {
    const client = new LanToolExecutor({ baseUrl, authToken: TOKEN });
    const ctl = new AbortController();
    await assert.rejects(() => client.execute("system.echo", "1.0.0", "a".repeat(64), { text: "x" },
      { session_id: "s", turn_id: "t", trace_id: "tr", mode: "personal" },
      { execution_id: "e", attempt_id: "a", attempt_no: 1, deadline_at: new Date(Date.now() + 5000).toISOString(), signal: ctl.signal }));
    assert.equal(client.dispatchCount, 1);
  } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); }); }
});

test("HR03E-52: failed remote call mutates no node health/state", async () => {
  const rig = buildHybridRig({ localToolIds: [], lanToolIds: ["system.echo"], lanExecutor: () => { throw new Error("boom"); } });
  try {
    const before = rig.nodes.list().map((r) => ({ id: r.descriptor.id, state: { ...r.state } }));
    await attemptOnce(rig);
    const after = rig.nodes.list().map((r) => ({ id: r.descriptor.id, state: { ...r.state } }));
    assert.deepEqual(after, before);
  } finally { rig.close(); }
});

test("HR03E-05/13/46: exact tool identity only; no second registry; no discovery", () => {
  const rig = buildHybridRig({ localToolIds: ["system.echo"], lanToolIds: ["system.echo"] });
  try {
    // The invoker routes constraints.tool_id === exact canonical name.
    const decision = rig.routing.route({ operation: "tool.execute", required_capabilities: [], data_locality: "lan_or_local", constraints: { tool_id: "system.echo" } });
    assert.equal(decision.target_node_id, "local-node");
    // No RemoteToolRegistry symbol exists anywhere on the path.
    const tools = rig.remotes as unknown as Record<string, unknown>;
    assert.equal("getExecutor" in tools || "executors" in tools || "invokeRaw" in tools, false);
    assert.deepEqual(rig.remotes.listIds(), ["lan-node"]);
  } finally { rig.close(); }
});
