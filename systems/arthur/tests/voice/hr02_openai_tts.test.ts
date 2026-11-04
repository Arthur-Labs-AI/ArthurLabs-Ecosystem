import { test } from "node:test";
import assert from "node:assert/strict";

import {
  OpenAiTtsProvider,
  buildSpeechPayload,
  isSpeechEndpointModel,
  resampleS16le,
  serializeSpeechBody,
} from "../../src/voice/tts/openai_provider";

function pcmStream(totalSamples: number): ReadableStream<Uint8Array> {
  const data = Buffer.alloc(totalSamples * 2);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(new Uint8Array(data));
    },
  });
}

function streamFetch(pcmSamples: number, seen: { auth?: string; body?: string }): typeof fetch {
  return (async (_url: unknown, init: unknown) => {
    const h = (init as { headers: Record<string, string> }).headers;
    seen.auth = h.Authorization;
    seen.body = String((init as { body: string }).body);
    return new Response(pcmStream(pcmSamples), { status: 200 });
  }) as unknown as typeof fetch;
}

test("HR-02 OpenAI TTS: payload structured, serialization exact, auth safe", async () => {
  const seen: { auth?: string; body?: string } = {};
  const p = new OpenAiTtsProvider({
    apiKey: "sk-tts-secret",
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    fetchFn: streamFetch(24000, seen),
  });
  assert.equal(p.available, true);
  assert.equal(p.authorizationHeader(), "Bearer sk-tts-secret");
  const payload = buildSpeechPayload("gpt-4o-mini-tts", "alloy", "hello world");
  assert.deepEqual(payload, { model: "gpt-4o-mini-tts", voice: "alloy", input: "hello world", response_format: "pcm" });
  assert.equal(serializeSpeechBody(payload), JSON.stringify(payload));
  const chunks = [];
  for await (const c of p.synthesizeStream({ synthesisId: "t-auth", text: "hello world", voice: "alloy", sampleRateHz: 16000 })) {
    chunks.push(c);
  }
  assert.ok(chunks.length >= 1);
  assert.equal(p.hasPlaybackBegan("t-auth"), true);
  assert.ok((seen.auth ?? "").startsWith("Bearer "));
  assert.deepEqual(JSON.parse(seen.body ?? "{}"), payload);
});

test("HR-02 OpenAI TTS: secret-like text never corrupts outgoing JSON", async () => {
  const tricky = 'Say password="a\\b" now';
  const payload = buildSpeechPayload("gpt-4o-mini-tts", "alloy", tricky);
  const wire = serializeSpeechBody(payload);
  assert.equal(wire, JSON.stringify(payload));
  assert.equal((JSON.parse(wire) as { input: string }).input, tricky);
});

test("HR-02 OpenAI TTS: cancel stops synthesis, no stale chunks", async () => {
  const p = new OpenAiTtsProvider({
    apiKey: "k",
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    fetchFn: streamFetch(240000, {}),
  });
  await p.cancel("t-stale");
  let count = 0;
  for await (const _c of p.synthesizeStream({ synthesisId: "t-stale", text: "hello", voice: "alloy", sampleRateHz: 16000 })) {
    count += 1;
  }
  assert.equal(count, 0);
});

test("HR-02 OpenAI TTS: /v1/audio/speech never sends gpt-realtime-1.5 (regression)", async () => {
  assert.equal(isSpeechEndpointModel("gpt-realtime-1.5"), false);
  assert.throws(() => buildSpeechPayload("gpt-realtime-1.5", "alloy", "hi"), /unsupported model/);
  assert.throws(
    () =>
      new OpenAiTtsProvider({ apiKey: "k", model: "gpt-realtime-1.5", voice: "alloy" }),
    /unsupported model/,
  );
  // Explicit configured supported models are preserved verbatim.
  const kept = buildSpeechPayload("tts-1", "alloy", "hi");
  assert.equal((kept as { model: string }).model, "tts-1");
});

test("HR-02 OpenAI TTS: resample 24k->16k deterministic", () => {
  const input = Buffer.alloc(240 * 2);
  const out = resampleS16le(input, 24000, 16000);
  assert.equal(out.length, 160 * 2);
  const same = resampleS16le(input, 16000, 16000);
  assert.equal(same.length, input.length);
});
