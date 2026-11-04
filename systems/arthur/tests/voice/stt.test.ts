import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeSttProvider } from "../../src/voice/stt/fake";
import { SttGateway } from "../../src/voice/stt/gateway";
import { InMemoryMetrics } from "../../src/observability/metrics";
import { LocalSttProvider } from "../../src/voice/stt/local_provider";
import { normalizeTranscript, isUsableTranscript, boundTranscript } from "../../src/voice/stt/contracts";
import type { PcmFrame } from "../../src/voice/contracts";

/**
 * Empty frame stream: completes immediately, so STT fakes never wait on
 * audio. The controller owns real frame feeding; unit tests exercise the
 * scripted provider behavior.
 */
function noFrames(): AsyncIterable<PcmFrame> {
  return {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<PcmFrame> {
      /* no frames */
    },
  };
}

test("fake STT replays scripted partials and a final deterministically", async () => {
  const stt = new FakeSttProvider();
  stt.setScript("utt-1", {
    partials: ["hel", "hello "],
    final: "hello world",
    language: "en",
    confidence: 0.93,
  });
  const events: Array<{ type: string; text?: string }> = [];
  const fakeStream = noFrames();
  for await (const event of stt.transcribeStream(
    fakeStream,
    { utteranceId: "utt-1", maxTranscriptChars: 8000 },
  )) {
    if (event.type === "partial" || event.type === "final") events.push({ type: event.type, text: event.text });
  }
  assert.deepEqual(events, [
    { type: "partial", text: "hel" },
    { type: "partial", text: "hello " },
    { type: "final", text: "hello world" },
  ]);
  assert.equal(stt.isCancelled("utt-1"), false);
  assert.deepEqual(stt.startedUtterances, ["utt-1"]);
});

test("fake STT scripted error fails the stream (fail closed)", async () => {
  const stt = new FakeSttProvider();
  stt.setScript("utt-bad", { error: "STT_FAILED" });
  const events: string[] = [];
  const fakeStream = noFrames();
  for await (const event of stt.transcribeStream(
    fakeStream,
    { utteranceId: "utt-bad", maxTranscriptChars: 8000 },
  )) {
    events.push(event.type);
  }
  assert.deepEqual(events, ["error"]);
  assert.equal(stt.cancelCount, 0);
});

test("STT gateway records latency and realtime-factor metrics", async () => {
  const stt = new FakeSttProvider();
  stt.setScript("utt-m", { final: "metrics", latencyMs: 400 });
  const metrics = new InMemoryMetrics();
  const gateway = new SttGateway(stt, metrics);
  const fakeStream = noFrames();
  for await (const _event of gateway.transcribeStream(
    fakeStream,
    { utteranceId: "utt-m", maxTranscriptChars: 8000, audioDurationMs: 2000 },
  )) {
    /* drain */
  }
  const snapshot = metrics.snapshot();
  assert.ok(
    Object.keys(snapshot.timers).some((k) => k.startsWith("stt.latency_ms")),
    "latency metric recorded",
  );
  assert.ok(
    Object.keys(snapshot.timers).some((k) => k.startsWith("stt.realtime_factor")),
    "realtime factor recorded",
  );
});

test("transcript normalization and usability rules", () => {
  assert.equal(normalizeTranscript("  Hello   World!  "), "Hello World!");
  assert.equal(isUsableTranscript("hello"), true);
  assert.equal(isUsableTranscript("12345"), true);
  assert.equal(isUsableTranscript("!!!"), false);
  assert.equal(isUsableTranscript(""), false);
  assert.equal(boundTranscript("x".repeat(100), 10).length, 10);
});

test("local STT provider fails closed when no engine is configured", async () => {
  const stt = new LocalSttProvider("", "", "en");
  assert.equal(stt.available, false);
  const events: string[] = [];
  const fakeStream = noFrames();
  for await (const event of stt.transcribeStream(
    fakeStream,
    { utteranceId: "x", maxTranscriptChars: 8000 },
  )) {
    events.push(event.type);
  }
  assert.deepEqual(events, ["error"]);
});