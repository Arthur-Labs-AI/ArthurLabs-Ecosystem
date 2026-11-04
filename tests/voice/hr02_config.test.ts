import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_VOICE_SETTINGS, loadVoiceSettings, validateVoiceSettings } from "../../src/voice/config";
import { isRoutingReason } from "../../src/runtime/routing";
import { isVoiceFailureCategory, isFallbackSafe } from "../../src/runtime/voice_errors";
import { isSttPolicy, isTtsPolicy, HR02_DEFAULTS } from "../../src/runtime/voice_policy";

test("HR-02 config: production defaults are cloud_preferred + pinned models", () => {
  assert.equal(DEFAULT_VOICE_SETTINGS.sttPolicy, "cloud_preferred");
  assert.equal(DEFAULT_VOICE_SETTINGS.ttsPolicy, "cloud_preferred");
  assert.equal(DEFAULT_VOICE_SETTINGS.cloudSttModel, "gpt-4o-transcribe");
  assert.equal(DEFAULT_VOICE_SETTINGS.cloudTtsModel, "gpt-4o-mini-tts");
  assert.equal(DEFAULT_VOICE_SETTINGS.localSttModel, "nvidia/parakeet-tdt-0.6b-v3");
  assert.equal(HR02_DEFAULTS.cloudSttModel, "gpt-4o-transcribe");
  assert.equal(HR02_DEFAULTS.cloudTtsModel, "gpt-4o-mini-tts");
});

test("HR-02 config: env loading honors ARTHUR_ keys", () => {
  process.env.ARTHUR_STT_POLICY = "local_only";
  process.env.ARTHUR_CLOUD_TTS_VOICE = "verse";
  try {
    const s = loadVoiceSettings();
    assert.equal(s.sttPolicy, "local_only");
    assert.equal(s.cloudTtsVoice, "verse");
  } finally {
    delete process.env.ARTHUR_STT_POLICY;
    delete process.env.ARTHUR_CLOUD_TTS_VOICE;
  }
});

test("HR-02 config: invalid enum values fail closed", () => {
  const bad = { ...DEFAULT_VOICE_SETTINGS, sttPolicy: "cloud_only" as never };
  const problems = validateVoiceSettings(bad);
  assert.ok(problems.some((p) => p.includes("ARTHUR_STT_POLICY")));
  const badTts = { ...DEFAULT_VOICE_SETTINGS, ttsPolicy: "sometimes" as never };
  assert.ok(validateVoiceSettings(badTts).some((p) => p.includes("ARTHUR_TTS_POLICY")));
});

test("HR-02 routing reasons bounded + machine-readable", () => {
  for (const r of ["cloud_preferred", "cloud_unavailable", "cloud_failed", "local_only", "local_fallback"]) {
    assert.equal(isRoutingReason(r), true);
  }
  assert.equal(isRoutingReason("please use cloud now"), false);
  assert.equal(isSttPolicy("cloud_preferred"), true);
  assert.equal(isSttPolicy("cloud_only"), false);
  assert.equal(isTtsPolicy("local_only"), true);
});

test("HR-02 failure taxonomy bounded; cancel never falls back", () => {
  for (const c of ["provider_unavailable", "provider_auth_failure", "provider_timeout", "local_worker_crashed", "transcription_failed", "speech_synthesis_failed"]) {
    assert.equal(isVoiceFailureCategory(c), true);
    assert.equal(isFallbackSafe(c as never), true);
  }
  assert.equal(isVoiceFailureCategory("provider_cancelled"), true);
  assert.equal(isFallbackSafe("provider_cancelled"), false);
  assert.equal(isVoiceFailureCategory("mysterious prose failure"), false);
});

test("HR-02 endpoint/model contract: REST STT uses gpt-4o-transcribe, speech uses gpt-4o-mini-tts", async () => {
  const { isTranscriptionEndpointModel } = await import("../../src/voice/stt/openai_provider");
  const { isSpeechEndpointModel } = await import("../../src/voice/tts/openai_provider");
  // Defaults land on verified endpoint models.
  assert.equal(isTranscriptionEndpointModel(DEFAULT_VOICE_SETTINGS.cloudSttModel), true);
  assert.equal(isSpeechEndpointModel(DEFAULT_VOICE_SETTINGS.cloudTtsModel), true);
  // Realtime-only model is NOT valid on the REST transcription path.
  assert.equal(isTranscriptionEndpointModel("gpt-live-transcribe"), false);
  // Realtime conversational models are NEVER valid on /v1/audio/speech.
  assert.equal(isSpeechEndpointModel("gpt-realtime-1.5"), false);
  assert.equal(isSpeechEndpointModel("gpt-4o-mini-tts"), true);
});
