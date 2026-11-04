import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeTtsProvider } from "../../src/voice/tts/fake";
import { TtsGateway } from "../../src/voice/tts/gateway";
import { LocalTtsProvider } from "../../src/voice/tts/local_provider";
import { estimateSpeechMs, syntheticAudioChunk } from "../../src/voice/tts/contracts";
import { InMemoryMetrics } from "../../src/observability/metrics";
import type { TtsRequest } from "../../src/voice/contracts";

function request(partial: Partial<TtsRequest> = {}): TtsRequest {
  return { synthesisId: "s-1", text: "hello", voice: "arthur", sampleRateHz: 16000, ...partial };
}

test("fake TTS emits deterministic chunks and honors cancellation", async () => {
  const tts = new FakeTtsProvider();
  const chunks = [];
  for await (const chunk of tts.synthesizeStream(
    request({ synthesisId: "s-1", text: "hello world this is a longer sentence" }),
  )) {
    chunks.push(chunk);
  }
  assert.ok(chunks.length > 0);
  const first = chunks[0];
  assert.ok(first);
  assert.equal(first.synthesisId, "s-1");
  assert.equal(first.sample_rate_hz, 16000);
  assert.ok(first.data.length > 0, "chunks carry PCM audio data");
  assert.ok(chunks[chunks.length - 1]?.final, "last chunk is marked final");
  assert.equal(tts.isCancelled("s-1"), false);
  assert.equal(tts.cancelCount, 0);
  tts.cancel("s-1");
  assert.equal(tts.isCancelled("s-1"), true);
});

test("TTS gateway records first-audio latency", async () => {
  const tts = new FakeTtsProvider();
  const metrics = new InMemoryMetrics();
  const gateway = new TtsGateway(tts, metrics);
  for await (const _chunk of gateway.synthesizeStream(request({ synthesisId: "s-2", text: "hi" }))) {
    /* drain */
  }
  const snapshot = metrics.snapshot();
  assert.ok(
    Object.keys(snapshot.timers).some((k) => k.startsWith("tts.first_audio_ms")),
    "first-audio latency must be recorded",
  );
});

test("local TTS provider yields an empty stream when no engine is configured", async () => {
  const tts = new LocalTtsProvider("", "voice");
  assert.equal(tts.available, false);
  let count = 0;
  for await (const _chunk of tts.synthesizeStream(request())) {
    count += 1;
  }
  assert.equal(count, 0);
});

test("speech duration estimate and synthetic chunk shape", () => {
  assert.equal(estimateSpeechMs("a".repeat(55)), 3025); // 55 ms per non-space char
  assert.ok(estimateSpeechMs("a") >= 100, "estimates have a floor");
  const chunk = syntheticAudioChunk("s-9", 0, 100, 20, 16000);
  assert.equal(chunk.sample_rate_hz, 16000);
  assert.equal(chunk.duration_ms, 20);
  assert.equal(chunk.synthesisId, "s-9");
  assert.ok(chunk.data.length > 0);
});