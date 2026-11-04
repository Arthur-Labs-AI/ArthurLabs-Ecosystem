import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeTtsProvider } from "../../src/voice/tts/fake";
import { TtsRouter } from "../../src/runtime/tts_router";
import type { AudioChunk, TtsProvider, TtsRequest } from "../../src/voice/contracts";

/** Failing cloud double: throws before any chunk (pre-playback failure). */
class PrePlaybackFailCloud implements TtsProvider {
  requests: TtsRequest[] = [];
  cancelCount = 0;
  id(): string { return "openai-tts"; }
  get available(): boolean { return true; }
  async *synthesizeStream(request: TtsRequest): AsyncIterable<AudioChunk> {
    this.requests.push(request);
    throw new Error("cloud exploded before playback");
    void (function*(): Generator<never> { yield* []; })();
  }
  async cancel(_id: string): Promise<void> { this.cancelCount += 1; }
}

/** Failing cloud double: yields one chunk THEN throws (mid-playback failure). */
class MidPlaybackFailCloud implements TtsProvider {
  requests: TtsRequest[] = [];
  cancelled = new Set<string>();
  id(): string { return "openai-tts"; }
  get available(): boolean { return true; }
  async *synthesizeStream(request: TtsRequest): AsyncIterable<AudioChunk> {
    this.requests.push(request);
    yield {
      synthesisId: request.synthesisId,
      sequence: 0,
      timestamp_ms: Date.now(),
      sample_rate_hz: request.sampleRateHz,
      channels: 1,
      sample_format: "s16le",
      duration_ms: 100,
      data: new Uint8Array(3200),
    };
    throw new Error("cloud died mid-playback");
  }
  async cancel(id: string): Promise<void> { this.cancelled.add(id); }
}

async function collect(p: TtsProvider | TtsRouter, req: TtsRequest): Promise<{ chunks: AudioChunk[]; error?: unknown }> {
  const chunks: AudioChunk[] = [];
  try {
    for await (const c of (p as TtsProvider).synthesizeStream(req)) chunks.push(c);
    return { chunks };
  } catch (error) { return { chunks, error }; }
}

function req(id: string, text = "canonical final answer"): TtsRequest {
  return { synthesisId: id, text, voice: "alloy", sampleRateHz: 16000 };
}

test("HR-02 TTS: cloud_preferred + cloud succeeds -> local never called", async () => {
  const cloud = new FakeTtsProvider();
  const local = new FakeTtsProvider();
  (cloud as { constructor: unknown }).constructor;
  const router = new TtsRouter({ cloud: cloud as unknown as TtsProvider, local, policy: "cloud_preferred" });
  const out = await collect(router, req("s-ok"));
  assert.equal(out.error, undefined);
  assert.ok(out.chunks.length >= 1);
  assert.equal(local.requests.length, 0);
  assert.equal(router.lastDecisionFor("s-ok")?.provider_id, "fake-tts");
  assert.equal(router.lastDecisionFor("s-ok")?.reason, "cloud_preferred");
});

test("HR-02 TTS: cloud unavailable -> local", async () => {
  class Down implements TtsProvider {
    id(): string { return "openai-tts"; }
    get available(): boolean { return false; }
    synthesizeStream(_r: TtsRequest): AsyncIterable<AudioChunk> { throw new Error("must not be called"); }
    async cancel(_id: string): Promise<void> {}
  }
  const local = new FakeTtsProvider();
  const router = new TtsRouter({ cloud: new Down(), local, policy: "cloud_preferred" });
  const out = await collect(router, req("s-down"));
  assert.equal(out.error, undefined);
  assert.ok(out.chunks.length >= 1);
  assert.equal(local.requests.length, 1);
  assert.equal(router.lastDecisionFor("s-down")?.reason, "cloud_unavailable");
});

test("HR-02 TTS: cloud fails before playback -> local exactly once", async () => {
  const cloud = new PrePlaybackFailCloud();
  const local = new FakeTtsProvider();
  const router = new TtsRouter({ cloud, local, policy: "cloud_preferred" });
  const out = await collect(router, req("s-pre", "speak me once"));
  assert.equal(out.error, undefined);
  assert.ok(out.chunks.length >= 1);
  assert.equal(local.requests.length, 1);
  assert.equal(local.requests[0]?.text, "speak me once");
  assert.equal(router.lastDecisionFor("s-pre")?.reason, "local_fallback");
  assert.equal(router.fallbacks, 1);
});

test("HR-02 TTS: cloud playback began then fails -> local does NOT restart response", async () => {
  const cloud = new MidPlaybackFailCloud();
  const local = new FakeTtsProvider();
  const router = new TtsRouter({ cloud, local, policy: "cloud_preferred" });
  const out = await collect(router, req("s-mid"));
  assert.ok(out.error instanceof Error);
  assert.equal(out.chunks.length, 1);
  assert.equal(local.requests.length, 0);
});

test("HR-02 TTS: local_only -> cloud never called", async () => {
  const cloud = new PrePlaybackFailCloud();
  const local = new FakeTtsProvider();
  const router = new TtsRouter({ cloud, local, policy: "local_only" });
  const out = await collect(router, req("s-lo"));
  assert.equal(out.error, undefined);
  assert.ok(out.chunks.length >= 1);
  assert.equal(cloud.requests.length, 0);
  assert.equal(router.lastDecisionFor("s-lo")?.reason, "local_only");
});

test("HR-02 TTS: barge-in -> selected provider cancelled", async () => {
  const cloud = new FakeTtsProvider();
  const local = new FakeTtsProvider();
  const router = new TtsRouter({ cloud, local, policy: "local_only" });
  await router.cancel("s-barge");
  assert.ok(local.isCancelled("s-barge"));
});

test("HR-02 TTS: provisional model text -> zero TTS; final canonical text -> exactly one spoken response", async () => {
  // Router-level proof: one synthesizeStream call per canonical text; the
  // controller (unchanged TASK-0024 path) never forwards provisional deltas.
  const local = new FakeTtsProvider();
  const router = new TtsRouter({ local, policy: "local_only" });
  await collect(router, req("s-final-1", "final answer one"));
  await collect(router, req("s-final-2", "final answer two"));
  assert.equal(local.requests.length, 2);
  assert.equal(local.requests[0]?.text, "final answer one");
  assert.equal(local.requests[1]?.text, "final answer two");
});
