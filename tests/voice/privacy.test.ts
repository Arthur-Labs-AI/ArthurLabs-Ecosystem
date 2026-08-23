import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTestApp, validTurn } from "../helpers";
import { FakeAudioCapture } from "../../src/voice/audio/capture";
import { FakeAudioPlayback } from "../../src/voice/audio/playback";
import { FakeWakeWordProvider } from "../../src/voice/wake/fake";
import { FakeVadProvider } from "../../src/voice/vad/fake";
import { FakeSttProvider } from "../../src/voice/stt/fake";
import { FakeTtsProvider } from "../../src/voice/tts/fake";

test("voice status never exposes raw audio, engine internals, or secrets", async () => {
  const app = buildTestApp({
    voice: {
      voiceEnabled: true,
      audioCaptureCommand: "arecord -D plughw:1",
      sttEngineCommand: "whisper --model secret-model",
      ttsEngineCommand: "piper -m /opt/secret/voice.onnx",
      deepseekApiKey: "sk-secret-key-value",
    },
  });
  const first = await app.conversation.handleTurn(validTurn());
  await app.voice.enable(first.session_id);
  const raw = JSON.stringify(app.voice.status());
  assert.equal(raw.includes("arecord"), false);
  assert.equal(raw.includes("whisper"), false);
  assert.equal(raw.includes("piper"), false);
  assert.equal(raw.includes("onnx"), false);
  assert.equal(raw.includes("secret"), false);
  assert.equal(raw.includes("sk-secret-key-value"), false);
  assert.equal(raw.includes("/opt/"), false);
  assert.equal(raw.includes("PCM"), false);
  assert.equal(raw.includes("audio_input"), true, "availability metadata is fine; raw bytes are not");
  assert.equal(raw.includes("sample_rate"), false, "no engine internals either");
  await app.close();
});

test("voice errors are sanitized before reaching subscribers", async () => {
  const app = buildTestApp({
    voice: {
      voiceEnabled: true,
      noSpeechTimeoutMs: 500,
    },
  });
  const events: unknown[] = [];
  app.voice.subscribe((event) => events.push(event));
  const first = await app.conversation.handleTurn(validTurn());
  await app.voice.enable(first.session_id);
  // Let the no-speech timer fire (no frames are fed).
  await new Promise((resolve) => setTimeout(resolve, 800));
  const serialized = JSON.stringify(events);
  assert.ok(events.some((e) => (e as { type?: string }).type === "voice.error"));
  assert.equal(serialized.includes("sk-"), false);
  await app.close();
});

test("voice session payload contains only safe identifiers and modes", async () => {
  const app = buildTestApp(
    { voice: { voiceEnabled: true } },
    {
      voice: {
        capture: new FakeAudioCapture(),
        playback: new FakeAudioPlayback(),
        wake: new FakeWakeWordProvider(),
        vad: new FakeVadProvider(),
        stt: new FakeSttProvider(),
        tts: new FakeTtsProvider(),
      },
    },
  );
  const first = await app.conversation.handleTurn(validTurn());
  await app.voice.enable(first.session_id);
  const session = app.voice.voiceSession();
  assert.equal(typeof session.voice_session_id, "string");
  assert.equal(session.arthur_session_id, first.session_id);
  assert.equal(session.wake_enabled, true);
  assert.equal(session.state, "idle");
  await app.close();
});