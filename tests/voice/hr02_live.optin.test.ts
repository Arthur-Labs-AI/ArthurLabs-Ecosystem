/**
 * HR-02 real-provider tests (OPT-IN ONLY — never run in the standard suite).
 *
 * Each test skips unless its env gate is set, so `npm test` requires:
 *   no internet, no OpenAI account, no NVIDIA GPU, no Parakeet weights.
 *
 * Gates:
 *   ARTHUR_LIVE_OPENAI_STT=1  + OPENAI_API_KEY  -> OpenAI cloud STT
 *   ARTHUR_LIVE_OPENAI_TTS=1  + OPENAI_API_KEY  -> OpenAI cloud TTS
 *   ARTHUR_LIVE_PARAKEET=1                      -> Parakeet local STT worker
 *   ARTHUR_LIVE_VOICE_FLOW=1 + OPENAI_API_KEY   -> full cloud voice flow shape
 *   ARTHUR_LIVE_STT_FALLBACK=1                  -> cloud-fail -> Parakeet fallback
 *
 * Microphone/speaker acceptance stays manual (see docs/hr02-voice-plane.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { OpenAiSttProvider } from "../../src/voice/stt/openai_provider";
import { OpenAiTtsProvider } from "../../src/voice/tts/openai_provider";
import { ParakeetSttProvider } from "../../src/voice/stt/parakeet_provider";
import { SttRouter } from "../../src/runtime/stt_router";
import { frameFromInt16 } from "../../src/voice/contracts";
import type { PcmFrame } from "../../src/voice/contracts";

function silenceUtterance(seconds = 1): AsyncIterable<PcmFrame> {
  const n = Math.ceil((seconds * 1000) / 20);
  return {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<PcmFrame> {
      for (let i = 0; i < n; i++) yield frameFromInt16(new Int16Array(320), i, i * 20);
    },
  };
}

test("LIVE opt-in: OpenAI cloud STT transcribes silence without crashing", async (t) => {
  if (process.env.ARTHUR_LIVE_OPENAI_STT !== "1" || !process.env.OPENAI_API_KEY) {
    t.skip("opt-in only: set ARTHUR_LIVE_OPENAI_STT=1 + OPENAI_API_KEY");
    return;
  }
  const p = new OpenAiSttProvider({ apiKey: process.env.OPENAI_API_KEY, model: process.env.ARTHUR_CLOUD_STT_MODEL ?? "gpt-4o-transcribe" });
  assert.equal(p.available, true);
  const started = Date.now();
  for await (const e of p.transcribeStream(silenceUtterance(), { utteranceId: "live-stt", maxTranscriptChars: 8000 })) {
    if (e.type === "final") {
      console.log(`[live-stt] final in ${Date.now() - started}ms: ${JSON.stringify(e.text)}`);
      break;
    }
    if (e.type === "error") throw new Error(`live STT failed: ${e.code}`);
  }
});

test("LIVE opt-in: OpenAI cloud TTS synthesizes canonical text", async (t) => {
  if (process.env.ARTHUR_LIVE_OPENAI_TTS !== "1" || !process.env.OPENAI_API_KEY) {
    t.skip("opt-in only: set ARTHUR_LIVE_OPENAI_TTS=1 + OPENAI_API_KEY");
    return;
  }
  const p = new OpenAiTtsProvider({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.ARTHUR_CLOUD_TTS_MODEL ?? "gpt-4o-mini-tts",
    voice: process.env.ARTHUR_CLOUD_TTS_VOICE ?? "alloy",
  });
  const started = Date.now();
  let chunks = 0;
  let firstMs = -1;
  for await (const c of p.synthesizeStream({ synthesisId: "live-tts", text: "Hello from ARTHUR.", voice: "alloy", sampleRateHz: 16000 })) {
    if (firstMs < 0) firstMs = Date.now() - started;
    chunks += 1;
    void c;
  }
  console.log(`[live-tts] first audio in ${firstMs}ms, chunks=${chunks}`);
  assert.ok(chunks >= 1);
});

test("LIVE opt-in: Parakeet local STT worker transcribes silence", async (t) => {
  if (process.env.ARTHUR_LIVE_PARAKEET !== "1") {
    t.skip("opt-in only: set ARTHUR_LIVE_PARAKEET=1 (run setup_parakeet.ps1 first)");
    return;
  }
  const path = await import("node:path");
  const worker = path.join(process.cwd(), "tools", "voice", "parakeet_worker.py");
  const p = new ParakeetSttProvider({ command: ["python", worker] });
  const started = Date.now();
  try {
    for await (const e of p.transcribeStream(silenceUtterance(), { utteranceId: "live-pq", maxTranscriptChars: 8000 })) {
      if (e.type === "final") {
        console.log(`[live-parakeet] final in ${Date.now() - started}ms: ${JSON.stringify(e.text)}`);
        break;
      }
      if (e.type === "error") throw new Error("live Parakeet failed");
    }
  } finally {
    await p.shutdown();
  }
});

test("LIVE opt-in: cloud-STT failure falls back to Parakeet (same utterance)", async (t) => {
  if (process.env.ARTHUR_LIVE_STT_FALLBACK !== "1") {
    t.skip("opt-in only: set ARTHUR_LIVE_STT_FALLBACK=1");
    return;
  }
  const cloud = new OpenAiSttProvider({ apiKey: "sk-invalid-deliberate", model: "gpt-4o-transcribe", requestTimeoutMs: 15000 });
  const path = await import("node:path");
  const worker = path.join(process.cwd(), "tools", "voice", "parakeet_worker.py");
  const local = new ParakeetSttProvider({ command: ["python", worker] });
  const router = new SttRouter({ cloud, local, policy: "cloud_preferred" });
  try {
    const out = await router.transcribeFinal(silenceUtterance(), { utteranceId: "live-fb", maxTranscriptChars: 8000 });
    console.log(`[live-fallback] provider=${out.provider} text=${JSON.stringify(out.text)}`);
    assert.equal(out.provider, "parakeet-stt");
  } finally {
    await local.shutdown();
  }
});
