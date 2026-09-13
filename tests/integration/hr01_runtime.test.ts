/**
 * HR-01 Hybrid Runtime foundation (Phase 1, architectural only).
 *
 * Deterministic, offline, fakes only: no internet, no GPU, no model
 * downloads, no OpenAI/NVIDIA/Qwen/LAN/discovery/failover. Covers the
 * contracts and the three router seams plus the frozen-behavior guards:
 *
 * - RuntimeMode cloud/lan/local accepted; invalid explicit value fails closed
 * - ModelRouter returns the configured provider, invokes exactly one provider
 * - SttRouter/TtsRouter route to the existing configured providers
 * - provider identity stable + bounded (no secrets/paths/commands)
 * - provider status representable without secrets
 * - routing decision exposes selected provider + configured_default reason
 * - VoiceController: one final transcript; provisional never reaches TTS;
 *   final spoken once; barge-in still cancels active TTS
 * - ConversationLoopRunner multi-tool behavior unchanged (SC-06)
 * - tool calls still flow through SC-02 + SC-03 (approval barrier intact)
 * - app.list/app.launch + git tools unaffected
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTestApp, validTurn } from "../helpers";
import { loadSettings } from "../../src/config/settings";
import { validateSettings } from "../../src/config/validation";
import { FakeProvider } from "../../src/models/providers/fake";
import { ModelGateway } from "../../src/models/gateway";
import type { ModelRequest, ModelResult, ModelStreamEvent } from "../../src/models/contracts";
import { FakeSttProvider } from "../../src/voice/stt/fake";
import { FakeTtsProvider } from "../../src/voice/tts/fake";
import { FakeAudioCapture } from "../../src/voice/audio/capture";
import { FakeAudioPlayback } from "../../src/voice/audio/playback";
import { FakeWakeWordProvider } from "../../src/voice/wake/fake";
import { FakeVadProvider } from "../../src/voice/vad/fake";
import { frameFromInt16, VoiceErrorCode, VoiceState, type PcmFrame } from "../../src/voice/contracts";
import type { VoiceClientEvent } from "../../src/voice/events";
import type { App } from "../../src/app";
import {
  ModelRouter,
  SttRouter,
  TtsRouter,
  isRuntimeMode,
  isRoutingReason,
  isProviderState,
  type RuntimeMode,
} from "../../src/runtime/index";

function result(text: string, toolCalls: ModelResult["tool_calls"] = []): ModelResult {
  return {
    assistant_text: text,
    tool_calls: toolCalls,
    finish_reason: "stop",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

// ---- RuntimeMode locality contract --------------------------------------------
// RuntimeMode is provider execution locality (cloud = remote API, lan =
// local-network node, local = on-device/in-process) — never a global routing
// policy. There is deliberately no ARTHUR_RUNTIME_MODE setting in HR-01.

test("HR-01: RuntimeMode cloud/lan/local accepted as locality values", () => {
  for (const mode of ["cloud", "lan", "local"] as RuntimeMode[]) {
    assert.ok(isRuntimeMode(mode));
  }
  assert.equal(isRuntimeMode("orbital"), false);
});

test("HR-01: no ARTHUR_RUNTIME_MODE env dependency remains", () => {
  // loadSettings must not read any runtime-mode env key: production startup
  // behavior is unchanged with or without the legacy variable present.
  const before = process.env["ARTHUR_RUNTIME_MODE"];
  try {
    process.env["ARTHUR_RUNTIME_MODE"] = "local";
    const settings = validateSettings(loadSettings({ modelProvider: "fake" }));
    assert.equal((settings as unknown as Record<string, unknown>)["runtimeMode"], undefined);
    assert.equal(settings.modelProvider, "fake");
  } finally {
    if (before === undefined) delete process.env["ARTHUR_RUNTIME_MODE"];
    else process.env["ARTHUR_RUNTIME_MODE"] = before;
  }
});

test("HR-01: invalid routing reason/state rejected by guards", () => {
  assert.equal(isRoutingReason("configured_default"), true);
  assert.equal(isRoutingReason("telepathy"), false);
  assert.equal(isProviderState("ready"), true);
  assert.equal(isProviderState("vibing"), false);
});

// ---- ModelRouter ----------------------------------------------------------

test("HR-01: ModelRouter returns the configured existing model provider", async () => {
  const provider = new FakeProvider({ id: "fake", responder: () => result("hi") });
  // In-process fake executes on-device: explicit locality "local".
  const router = new ModelRouter({ gateway: new ModelGateway(provider), locality: "local" });
  assert.equal(router.id, "fake");
  const out = await router.generate({
    systemContract: "s",
    modeContract: "m",
    history: [],
    toolSchemas: [],
    userMessage: "hi",
    model: "fake-model",
    reasoningProfile: "fast",
  });
  assert.equal(out.assistant_text, "hi");
  const decision = router.routingDecision();
  assert.equal(decision.provider_id, "fake");
  assert.equal(decision.runtime_mode, "local");
  assert.equal(decision.reason, "configured_default");
});

test("HR-01: ModelRouter does not invoke multiple providers (single generate call)", async () => {
  let a = 0;
  let b = 0;
  const providerA = new FakeProvider({
    id: "a",
    responder: () => {
      a += 1;
      return result("from-a");
    },
  });
  const providerB = new FakeProvider({
    id: "b",
    responder: () => {
      b += 1;
      return result("from-b");
    },
  });
  const router = new ModelRouter({ gateway: new ModelGateway(providerA), locality: "cloud" });
  const out = await router.generate({
    systemContract: "s",
    modeContract: "m",
    history: [],
    toolSchemas: [],
    userMessage: "hi",
    model: "fake-model",
    reasoningProfile: "fast",
  });
  assert.equal(out.assistant_text, "from-a");
  assert.equal(a, 1);
  assert.equal(b, 0, "second provider must never be invoked in one turn");
  assert.equal(router.routingDecision().provider_id, "a");
  void providerB;
});

test("HR-01: ModelRouter preserves streaming + capabilities of the configured provider", async () => {
  const provider = new FakeProvider({ id: "fake" });
  const router = new ModelRouter({ gateway: new ModelGateway(provider), locality: "lan" });
  assert.equal(router.capabilities().supportsTools, true);
  assert.deepEqual(router.runtimeCapabilities(), ["model.generate", "model.tools"]);
  const events: string[] = [];
  for await (const e of router.generateStream({
    systemContract: "s",
    modeContract: "m",
    history: [],
    toolSchemas: [],
    userMessage: "hi",
    model: "fake-model",
    reasoningProfile: "fast",
  })) {
    events.push(e.type);
  }
  assert.deepEqual(events, ["text_delta", "usage", "done"]);
  assert.equal(router.identity().runtime_mode, "lan");
});

// ---- STT/TTS routers ------------------------------------------------------

test("HR-01: SttRouter routes to the existing STT provider (id + cancel delegated)", async () => {
  const inner = new FakeSttProvider();
  const router = new SttRouter({ provider: inner, locality: "local" });
  assert.equal(router.id(), "fake-stt");
  assert.equal(router.available, true);
  assert.equal(router.routingDecision().reason, "configured_default");
  assert.equal(router.routingDecision().provider_id, "fake-stt");
  await router.cancel("u-1");
  assert.ok(inner.isCancelled("u-1"));
});

test("HR-01: SttRouter normalized final result carries provider + latency, partials excluded", async () => {
  const inner = new FakeSttProvider();
  inner.setDefaultScript({ partials: ["hel", "hello "], final: "hello world", language: "en", confidence: 0.9 });
  const router = new SttRouter({ provider: inner, locality: "local" });
  async function* frames(): AsyncIterable<PcmFrame> {
    yield frameFromInt16(new Int16Array(320), 0, 0);
  }
  const out = await router.transcribeFinal(frames(), { utteranceId: "u-norm", maxTranscriptChars: 8000 });
  assert.equal(out.text, "hello world");
  assert.equal(out.provider, "fake-stt");
  assert.equal(out.language, "en");
  assert.equal(out.confidence, 0.9);
  assert.ok(out.latency_ms >= 0);
});

test("HR-01: TtsRouter routes to the existing TTS provider (id + cancel delegated)", async () => {
  const inner = new FakeTtsProvider();
  const router = new TtsRouter({ provider: inner, locality: "local" });
  assert.equal(router.id(), "fake-tts");
  assert.equal(router.available, true);
  assert.equal(router.routingDecision().reason, "configured_default");
  await router.cancel("s-1");
  assert.ok(inner.isCancelled("s-1"));
  const chunks: unknown[] = [];
  for await (const c of router.synthesizeStream({ synthesisId: "s-2", text: "hi", voice: "v", sampleRateHz: 16000 })) {
    chunks.push(c);
  }
  assert.ok(chunks.length >= 1);
});

// ---- identity / status bounded --------------------------------------------

test("HR-01: provider identity is stable and bounded (no secrets/paths/commands)", () => {
  const app = buildTestApp();
  try {
    for (const identity of [app.modelRouter.identity(), app.sttRouter.identity(), app.ttsRouter.identity()]) {
      const json = JSON.stringify(identity);
      assert.ok(identity.id.length > 0 && identity.id.length <= 128);
      assert.ok(["stt", "model", "tts"].includes(identity.kind));
      assert.ok(isRuntimeMode(identity.runtime_mode));
      for (const needle of ["sk-", "BEGIN", ".exe", ".bin", ".onnx", "D:\\", "/home", "--prompt"]) {
        assert.equal(json.includes(needle), false, `identity leaks ${needle}: ${json}`);
      }
    }
    assert.equal(app.modelRouter.identity().id, app.modelRouter.id);
  } finally {
    app.close();
  }
});

test("HR-01: provider status is representable without secrets or stack traces", () => {
  const app = buildTestApp();
  try {
    for (const status of [app.modelRouter.status(), app.sttRouter.status(), app.ttsRouter.status()]) {
      assert.ok(isProviderState(status.state));
      const json = JSON.stringify(status);
      assert.ok(!json.includes("Error:"));
      assert.ok(!json.includes("\n    at "));
      assert.ok(status.provider_id.length > 0);
    }
  } finally {
    app.close();
  }
});

test("HR-01: routing decision exposes selected provider + bounded reason", () => {
  const app = buildTestApp();
  try {
    // HR-02 minimal integration correction: the default keyless app builds
    // multi-provider voice routers, so STT/TTS report cloud_unavailable
    // (HR-02 bounded vocabulary) instead of the HR-01 single-provider
    // configured_default. The RoutingDecision contract shape is unchanged;
    // legacy single-provider construction still yields configured_default.
    assert.equal(app.modelRouter.routingDecision().reason, "configured_default");
    for (const d of [app.sttRouter.routingDecision(), app.ttsRouter.routingDecision()]) {
      assert.ok(d.provider_id.length > 0);
      assert.ok(isRuntimeMode(d.runtime_mode));
      assert.ok(isRoutingReason(d.reason));
      assert.equal(d.reason, "cloud_unavailable");
    }
  } finally {
    app.close();
  }
});

test("HR-01: mixed provider locality — each decision reports its own actual locality", () => {
  // buildTestApp uses the fake model (in-process => local) with local-voice
  // shaped defaults; production uses DeepSeek (cloud) with the same voice.
  const fakeApp = buildTestApp({}, { provider: new FakeProvider({ id: "fake" }) });
  try {
    assert.equal(fakeApp.modelRouter.routingDecision().provider_id, "fake");
    assert.equal(fakeApp.modelRouter.routingDecision().runtime_mode, "local");
    assert.equal(fakeApp.sttRouter.routingDecision().runtime_mode, "local");
    assert.equal(fakeApp.ttsRouter.routingDecision().runtime_mode, "local");
  } finally {
    fakeApp.close();
  }
  // Explicit heterogeneous trio: cloud model + local speech, each owning
  // its own locality in the same session.
  const model = new ModelRouter({ gateway: new ModelGateway(new FakeProvider({ id: "deepseek-like" })), locality: "cloud" });
  const stt = new SttRouter({ provider: new FakeSttProvider(), locality: "local" });
  const tts = new TtsRouter({ provider: new FakeTtsProvider(), locality: "local" });
  assert.equal(model.routingDecision().runtime_mode, "cloud");
  assert.equal(stt.routingDecision().runtime_mode, "local");
  assert.equal(tts.routingDecision().runtime_mode, "local");
  assert.equal(model.identity().runtime_mode, "cloud");
  assert.equal(stt.identity().runtime_mode, "local");
  assert.equal(tts.identity().runtime_mode, "local");
});

// ---- ConversationService explicit-locality fallback --------------------------
// The service reuses an injected ModelRouter, else wraps a raw gateway ONCE
// with explicit modelLocality. capabilities().online must never control
// RuntimeMode: flip online both ways and locality must not move.

function stubModelProvider(id: string, online: boolean): FakeProvider {
  const inner = new FakeProvider({ id, responder: () => result("stub:" + id) });
  const caps = inner.capabilities();
  inner.capabilities = () => ({ ...caps, online });
  return inner;
}

test("HR-01: buildApp fake model reports local execution locality", () => {
  const app = buildTestApp({}, { provider: stubModelProvider("stub-fake", false) });
  try {
    assert.equal(app.modelRouter.routingDecision().provider_id, "stub-fake");
    assert.equal(app.modelRouter.routingDecision().runtime_mode, "local");
  } finally {
    app.close();
  }
});

test("HR-01: service wraps a raw gateway once with explicit locality (cloud/lan/local)", async () => {
  const { ConversationService } = await import("../../src/core/conversation/service");
  const { ContextBuilder } = await import("../../src/core/conversation/context_builder");
  const { SessionStore } = await import("../../src/sessions/store");
  const { SecretSanitizer } = await import("../../src/security/sanitize");
  const { Logger } = await import("../../src/observability/logging");
  const { InMemoryMetrics } = await import("../../src/observability/metrics");
  const { ToolRegistry } = await import("../../src/tools/registry");
  const { PermissionService } = await import("../../src/tools/permissions");
  const { HarnessStubAdapter } = await import("../../src/tools/adapters/harness_stub");
  const { ToolOrchestrator } = await import("../../src/tools/orchestrator");
  const { registerBuiltinTools, buildDefaultLocalHost } = await import("../../src/tools/builtin");
  const { NodeLocalSystemAdapter } = await import("../../src/tools/adapters/local_system");
  for (const locality of ["cloud", "lan", "local"] as RuntimeMode[]) {
    const sanitizer = new SecretSanitizer([]);
    const logger = new Logger("error");
    const metrics = new InMemoryMetrics();
    const store = new SessionStore(":memory:", sanitizer);
    try {
      const settings = validateSettings(loadSettings({ modelProvider: "fake" }));
      const registry = new ToolRegistry();
      registerBuiltinTools(
        registry,
        new HarnessStubAdapter({ verificationSecret: "hr01-secret" }),
        { host: buildDefaultLocalHost(new NodeLocalSystemAdapter()) },
      );
      const permissions = new PermissionService();
      const execution = registry.createExecutionService(permissions);
      const orchestrator = new ToolOrchestrator({
        registry,
        execution,
        store,
        permissions,
        sanitizer,
        approvalTtlSeconds: 300,
        approvalSigningSecret: "hr01-secret",
        logger,
        metrics,
      });
      const service = new ConversationService({
        gateway: new ModelGateway(stubModelProvider("raw-" + locality, false)),
        modelLocality: locality,
        store,
        contextBuilder: new ContextBuilder({ historyMaxTurns: 5, tokenBudget: 2000 }),
        orchestrator,
        registry,
        sanitizer,
        config: settings,
        logger,
        metrics,
      });
      const router = service.modelRouterForTests();
      assert.equal(router.routingDecision().provider_id, "raw-" + locality);
      assert.equal(router.routingDecision().runtime_mode, locality);
      assert.equal(router.routingDecision().reason, "configured_default");
      assert.equal(router.identity().runtime_mode, locality);
      // Single provider, no fan-out: one turn, one model call family.
      const response = await service.handleTurn(validTurn({ message: "hello " + locality }));
      assert.equal(response.status, "completed");
      assert.equal(response.model.provider, "raw-" + locality);
    } finally {
      store.close();
    }
  }
});

test("HR-01: capabilities().online does not change locality (both directions)", async () => {
  const { ConversationService } = await import("../../src/core/conversation/service");
  const { ContextBuilder } = await import("../../src/core/conversation/context_builder");
  const { SessionStore } = await import("../../src/sessions/store");
  const { SecretSanitizer } = await import("../../src/security/sanitize");
  const { Logger } = await import("../../src/observability/logging");
  const { InMemoryMetrics } = await import("../../src/observability/metrics");
  const { ToolRegistry } = await import("../../src/tools/registry");
  const { PermissionService } = await import("../../src/tools/permissions");
  const { HarnessStubAdapter } = await import("../../src/tools/adapters/harness_stub");
  const { ToolOrchestrator } = await import("../../src/tools/orchestrator");
  const { registerBuiltinTools, buildDefaultLocalHost } = await import("../../src/tools/builtin");
  const { NodeLocalSystemAdapter } = await import("../../src/tools/adapters/local_system");
  async function localityFor(online: boolean, locality: RuntimeMode): Promise<RuntimeMode> {
    const sanitizer = new SecretSanitizer([]);
    const logger = new Logger("error");
    const metrics = new InMemoryMetrics();
    const store = new SessionStore(":memory:", sanitizer);
    try {
      const settings = validateSettings(loadSettings({ modelProvider: "fake" }));
      const registry = new ToolRegistry();
      registerBuiltinTools(
        registry,
        new HarnessStubAdapter({ verificationSecret: "hr01-secret" }),
        { host: buildDefaultLocalHost(new NodeLocalSystemAdapter()) },
      );
      const permissions = new PermissionService();
      const execution = registry.createExecutionService(permissions);
      const orchestrator = new ToolOrchestrator({
        registry,
        execution,
        store,
        permissions,
        sanitizer,
        approvalTtlSeconds: 300,
        approvalSigningSecret: "hr01-secret",
        logger,
        metrics,
      });
      const service = new ConversationService({
        gateway: new ModelGateway(stubModelProvider("flip", online)),
        modelLocality: locality,
        store,
        contextBuilder: new ContextBuilder({ historyMaxTurns: 5, tokenBudget: 2000 }),
        orchestrator,
        registry,
        sanitizer,
        config: settings,
        logger,
        metrics,
      });
      return service.modelRouterForTests().routingDecision().runtime_mode;
    } finally {
      store.close();
    }
  }
  // online=true must not pull locality to cloud; online=false must not
  // pull it to local. Locality is explicit construction metadata only.
  assert.equal(await localityFor(true, "local"), "local");
  assert.equal(await localityFor(false, "cloud"), "cloud");
  assert.equal(await localityFor(true, "lan"), "lan");
  assert.equal(await localityFor(false, "lan"), "lan");
});

test("HR-01: injected ModelRouter is reused, not rewrapped (same instance)", async () => {
  const { ConversationService } = await import("../../src/core/conversation/service");
  const { ContextBuilder } = await import("../../src/core/conversation/context_builder");
  const { SessionStore } = await import("../../src/sessions/store");
  const { SecretSanitizer } = await import("../../src/security/sanitize");
  const { Logger } = await import("../../src/observability/logging");
  const { InMemoryMetrics } = await import("../../src/observability/metrics");
  const { ToolRegistry } = await import("../../src/tools/registry");
  const { PermissionService } = await import("../../src/tools/permissions");
  const { HarnessStubAdapter } = await import("../../src/tools/adapters/harness_stub");
  const { ToolOrchestrator } = await import("../../src/tools/orchestrator");
  const { registerBuiltinTools, buildDefaultLocalHost } = await import("../../src/tools/builtin");
  const { NodeLocalSystemAdapter } = await import("../../src/tools/adapters/local_system");
  const sanitizer = new SecretSanitizer([]);
  const logger = new Logger("error");
  const metrics = new InMemoryMetrics();
  const store = new SessionStore(":memory:", sanitizer);
  try {
    const settings = validateSettings(loadSettings({ modelProvider: "fake" }));
    const registry = new ToolRegistry();
    registerBuiltinTools(
      registry,
      new HarnessStubAdapter({ verificationSecret: "hr01-secret" }),
      { host: buildDefaultLocalHost(new NodeLocalSystemAdapter()) },
    );
    const permissions = new PermissionService();
    const execution = registry.createExecutionService(permissions);
    const orchestrator = new ToolOrchestrator({
      registry,
      execution,
      store,
      permissions,
      sanitizer,
      approvalTtlSeconds: 300,
      approvalSigningSecret: "hr01-secret",
      logger,
      metrics,
    });
    const inner = new ModelRouter({ gateway: new ModelGateway(stubModelProvider("kept", true)), locality: "lan" });
    const service = new ConversationService({
      gateway: inner,
      store,
      contextBuilder: new ContextBuilder({ historyMaxTurns: 5, tokenBudget: 2000 }),
      orchestrator,
      registry,
      sanitizer,
      config: settings,
      logger,
      metrics,
    });
    // online=true on the wrapped provider must not matter: the injected
    // router keeps its explicit lan locality, same object, no rewrap.
    assert.equal(service.modelRouterForTests(), inner);
    assert.equal(service.modelRouterForTests().routingDecision().runtime_mode, "lan");
    assert.equal(service.modelRouterForTests().routingDecision().reason, "configured_default");
    const response = await service.handleTurn(validTurn({ message: "reuse me" }));
    assert.equal(response.status, "completed");
    assert.equal(response.model.provider, "kept");
  } finally {
    store.close();
  }
});

test("HR-01: buildApp exposes routers resolving the configured providers", () => {
  const provider = new FakeProvider({ id: "fake" });
  const app = buildTestApp({}, { provider });
  try {
    assert.equal(app.modelRouter.id, "fake");
    assert.equal(app.gateway.id, "fake");
    // Default test voice settings select the local STT/TTS backends (same
    // as production config shape); the routers resolve those backends.
    assert.equal(app.sttRouter.id(), "local-stt");
    assert.equal(app.ttsRouter.id(), "local-tts");
    // Fake model executes in-process: locality is local, not cloud.
    assert.equal(app.modelRouter.routingDecision().runtime_mode, "local");
    assert.equal(app.sttRouter.routingDecision().runtime_mode, "local");
    assert.equal(app.ttsRouter.routingDecision().runtime_mode, "local");
    assert.equal(app.voice.state, VoiceState.DISABLED);
  } finally {
    app.close();
  }
});

// ---- voice behavior guards (TASK-0024 + barge-in preserved) ----------------

interface VoiceHarness {
  app: App;
  capture: FakeAudioCapture;
  playback: FakeAudioPlayback;
  wake: FakeWakeWordProvider;
  vad: FakeVadProvider;
  stt: FakeSttProvider;
  tts: FakeTtsProvider;
  events: VoiceClientEvent[];
  sessionId: string;
}

function silenceFrame(sequence: number, atMs: number): PcmFrame {
  return frameFromInt16(new Int16Array(320), sequence, atMs);
}

function speechFrame(sequence: number, atMs: number): PcmFrame {
  const samples = new Int16Array(320);
  samples.fill(3000);
  return frameFromInt16(samples, sequence, atMs);
}

async function buildVoiceHarness(opts: {
  streamResponder?: (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>;
} = {}): Promise<VoiceHarness> {
  const capture = new FakeAudioCapture();
  const playback = new FakeAudioPlayback(undefined, { delayPerChunkMs: 25 });
  const wake = new FakeWakeWordProvider();
  const vad = new FakeVadProvider();
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider();
  const app = buildTestApp(
    { voice: { voiceEnabled: true, wakeEnabled: true, wakeWord: "arthur", ttsMaxQueueChunks: 8 } },
    {
      provider: new FakeProvider({
        streamResponder:
          opts.streamResponder ??
          ((async function* () {
            yield { type: "text_delta", text: "Hello there!" };
            yield { type: "usage", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
            yield { type: "done", finish_reason: "stop" };
          }) as (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>),
      }),
      voice: { capture, playback, wake, vad, stt, tts },
    },
  );
  const events: VoiceClientEvent[] = [];
  app.voice.subscribe((event) => events.push(event));
  const first = await app.conversation.handleTurn(validTurn({ mode: "personal", message: "setup" }));
  await app.voice.enable(first.session_id);
  return { app, capture, playback, wake, vad, stt, tts, events, sessionId: first.session_id };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function feedUtterance(h: VoiceHarness, startAtMs: number, frames: number): void {
  for (let i = 0; i < frames; i++) {
    h.capture.feedFrame(speechFrame(i, startAtMs + i * 20));
  }
}

test("HR-01: VoiceController still uses one final transcript (STT through SttRouter)", async () => {
  const h = await buildVoiceHarness();
  try {
    h.stt.setDefaultScript({ partials: ["open vis"], final: "open visual studio code", language: "en", confidence: 0.9 });
    h.vad.setScript(["silence", "speech", "speech", "speech", "end"]);
    const t0 = Date.now();
    h.wake.triggerWake(t0);
    await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
    feedUtterance(h, t0 + 40, 3);
    await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
    h.capture.feedFrame(silenceFrame(10, t0 + 100));
    h.capture.feedFrame(silenceFrame(10, t0 + 120));
    await waitFor(() => h.app.voice.state === VoiceState.IDLE);
    const finals = h.events.filter((e) => e.type === "stt.final");
    assert.equal(finals.length, 1, "exactly one final transcript commits");
    assert.equal(h.stt.startedUtterances.length, 1);
    assert.equal(h.app.sttRouter.routingDecision().provider_id, h.stt.id());
  } finally {
    await h.app.close();
  }
});

test("HR-01: voice provisional text never reaches TTS; final response spoken once", async () => {
  const PROVISIONAL = "I'll check that. Let me look at the repository state now. ";
  const FINAL = "The last commit is abc1234, fixing the voice loop.";
  let rounds = 0;
  let releaseFinal!: () => void;
  const finalGate = new Promise<void>((resolve) => {
    releaseFinal = resolve;
  });
  const h = await buildVoiceHarness({
    streamResponder: (async function* (_req: ModelRequest, signal?: AbortSignal) {
      rounds += 1;
      if (rounds === 1) {
        yield { type: "text_delta", text: PROVISIONAL };
        await new Promise((resolve) => setTimeout(resolve, 150));
        yield { type: "tool_call", call: { id: "tc-hr01", name: "system.echo", arguments: { text: "probe" } } };
        yield { type: "done", finish_reason: "tool_calls" };
      } else {
        yield { type: "text_delta", text: FINAL };
        await Promise.race([
          finalGate,
          new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
        if (signal?.aborted) return;
        yield { type: "done", finish_reason: "stop" };
      }
    }) as (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>,
  });
  try {
    h.stt.setDefaultScript({ final: "check the repository and tell me the last commit" });
    h.vad.setScript(["silence", "speech", "speech", "speech", "end"]);
    const t0 = Date.now();
    h.wake.triggerWake(t0);
    await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
    feedUtterance(h, t0 + 40, 3);
    await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
    h.capture.feedFrame(silenceFrame(10, t0 + 100));
    h.capture.feedFrame(silenceFrame(10, t0 + 120));
    await waitFor(() => rounds >= 2, 4000, "tool round to complete and follow-up to start");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(h.tts.requests.length, 0, "provisional text must never reach TTS");
    releaseFinal();
    await waitFor(() => h.app.voice.state === VoiceState.IDLE);
    const spoken = h.tts.requests.map((r) => r.text).join(" ");
    assert.equal(h.tts.requests.length, 1, "final answer spoken exactly once, got: " + spoken);
    assert.equal(spoken.includes("I'll check that"), false, "provisional text never spoken, got: " + spoken);
    assert.ok(spoken.includes("abc1234"), "final answer spoken, got: " + spoken);
  } finally {
    await h.app.close();
  }
});

test("HR-01: barge-in still cancels active TTS", async () => {
  let releaseStream!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  const h = await buildVoiceHarness({
    streamResponder: (async function* (_req: ModelRequest, signal?: AbortSignal) {
      yield { type: "text_delta", text: "Partial answer that will be cut off. " };
      await Promise.race([
        gate,
        new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
      if (signal?.aborted) return;
      yield { type: "done", finish_reason: "stop" };
    }) as (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>,
  });
  try {
    h.stt.setDefaultScript({ final: "speak about the weather" });
    h.vad.setScript(["silence", "speech", "speech", "speech", "end"]);
    const t0 = Date.now();
    h.wake.triggerWake(t0);
    await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
    feedUtterance(h, t0 + 40, 3);
    await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
    h.capture.feedFrame(silenceFrame(10, t0 + 100));
    h.capture.feedFrame(silenceFrame(10, t0 + 120));
    await waitFor(() => h.app.voice.state === VoiceState.THINKING);
    assert.equal(h.tts.requests.length, 0, "provisional text must never reach TTS");
    h.vad.setScript(["silence", "speech", "speech", "speech", "speech", "speech", "speech", "speech", "speech", "speech"]);
    feedUtterance(h, Date.now(), 10);
    await waitFor(() => h.app.voice.state === VoiceState.LISTENING || h.app.voice.state === VoiceState.CAPTURING);
    assert.ok(
      h.events.some((e) => e.type === "voice.error" && e.code === VoiceErrorCode.VOICE_CANCELLED),
      "barge-in must surface VOICE_CANCELLED",
    );
    releaseStream();
    await waitFor(() =>
      h.app.store.getRecentTurns(h.sessionId, "personal", 10).some((t) => t.role === "assistant" && t.status === "interrupted"),
    );
  } finally {
    await h.app.close();
  }
});

// ---- loop + authorization + tools unchanged --------------------------------

test("HR-01: ConversationLoopRunner multi-tool behavior unchanged (SC-06)", async () => {
  let calls = 0;
  const provider = new FakeProvider({
    responder: (req: ModelRequest) => {
      calls += 1;
      if (calls === 1) return result("", [{ id: "call-1", name: "system.echo", arguments: { text: "step-one" } }]);
      if (calls === 2) {
        const toolMsg = req.history.find((m) => m.role === "tool");
        assert.ok(toolMsg, "round 2 must see the round-1 tool result");
        return result("", [{ id: "call-2", name: "system.echo", arguments: { text: "step-two" } }]);
      }
      return result("done after two rounds");
    },
  });
  const app = buildTestApp({}, { provider });
  try {
    const response = await app.conversation.handleTurn(validTurn({ message: "multi step" }));
    assert.equal(response.status, "completed");
    assert.equal(response.display_text, "done after two rounds");
    assert.equal(response.tool_calls.length, 2);
    assert.equal(calls, 3);
    assert.equal(response.model.provider, "fake");
  } finally {
    app.close();
  }
});

test("HR-01: tool calls still flow through SC-02 + SC-03 (approval barrier intact)", async () => {
  const provider = new FakeProvider({
    responder: () => result("", [{ id: "m-1", name: "harness.create_job", arguments: { kind: "deploy" } }]),
  });
  const app = buildTestApp({}, { provider });
  try {
    const response = await app.conversation.handleTurn(validTurn({ mode: "business", message: "deploy it" }));
    assert.equal(response.status, "needs_approval");
    const barrier = response.tool_calls.find((t) => t.status === "pending_approval");
    assert.ok(barrier);
    assert.equal(barrier.name, "harness.create_job");
    const stored = app.store.getToolCallsForTurn(response.turn_id);
    assert.equal(stored.length, 1, "SC-03 persists exactly the barrier call");
    const pending = app.store.listPendingApprovals(response.session_id);
    assert.equal(pending.length, 1, "SC-02 approval still pending");
  } finally {
    app.close();
  }
});

test("HR-01: app.list/app.launch unaffected (routed through ModelRouter + tool lifecycle)", async () => {
  let calls = 0;
  const provider = new FakeProvider({
    responder: () => {
      calls += 1;
      if (calls === 1) return result("", [{ id: "ap-1", name: "app.list", arguments: {} }]);
      return result("one application available");
    },
  });
  const localConfig = {
    filesystem_roots: [{ id: "workspace", label: "Workspace", physical_root: process.cwd(), permissions: ["list", "stat", "read", "search"] }],
    filesystem_bounds: {
      list_limit_max: 100,
      read_max_lines: 200,
      read_max_bytes: 65536,
      search_max_results: 20,
      search_max_files: 50,
      search_max_bytes_per_file: 65536,
      search_max_total_bytes: 1048576,
    },
    applications: [{ id: "vscode", display_name: "Visual Studio Code", executable: process.execPath, args: [] }],
  };
  const app = buildTestApp({}, { provider, localConfig: localConfig as never });
  try {
    const response = await app.conversation.handleTurn(validTurn({ message: "which applications can you open" }));
    assert.equal(response.status, "completed");
    assert.equal(response.tool_calls[0]?.name, "app.list");
    assert.equal(response.tool_calls[0]?.status, "completed");
    assert.equal(app.modelRouter.routingDecision().provider_id, "fake");
  } finally {
    app.close();
  }
});

test("HR-01: git tools unaffected (git.status through the same lifecycle)", async () => {
  let calls = 0;
  const provider = new FakeProvider({
    responder: () => {
      calls += 1;
      if (calls === 1) return result("", [{ id: "g-1", name: "git.status", arguments: { repo_id: "arthur" } }]);
      return result("working tree status shown");
    },
  });
  const localConfig = {
    filesystem_roots: [{ id: "workspace", label: "Workspace", physical_root: process.cwd(), permissions: ["list", "stat", "read", "search"] }],
    applications: [],
  };
  const gitConfig = {
    repositories: [{ id: "arthur", label: "ARTHUR", root_id: "workspace", path: ".", allowed_modes: ["personal", "business"] }],
  };
  const app = buildTestApp({}, { provider, localConfig: localConfig as never, gitConfig: gitConfig as never });
  try {
    const response = await app.conversation.handleTurn(validTurn({ message: "show git status" }));
    assert.equal(response.status, "completed");
    assert.equal(response.tool_calls[0]?.name, "git.status");
    assert.equal(response.tool_calls[0]?.status, "completed");
  } finally {
    app.close();
  }
});
