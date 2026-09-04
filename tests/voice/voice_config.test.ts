import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_VOICE_SETTINGS,
  STT_INITIAL_PROMPT_MAX_CHARS,
  loadVoiceSettings,
  validateVoiceSettings,
} from "../../src/voice/config";
import { buildTestApp } from "../helpers";

/** Run a callback with one environment variable temporarily set/unset. */
function withEnv(key: string, value: string | undefined, run: () => void): void {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

test("sttInitialPrompt defaults to empty and the language default stays auto", () => {
  withEnv("ARTHUR_STT_INITIAL_PROMPT", undefined, () => {
    withEnv("ARTHUR_STT_LANGUAGE", undefined, () => {
      const settings = loadVoiceSettings();
      assert.equal(settings.sttInitialPrompt, "", "no prompt by default (backwards compatible)");
      assert.equal(settings.sttLanguage, "auto", "language default must stay auto");
      assert.equal(DEFAULT_VOICE_SETTINGS.sttInitialPrompt, "");
    });
  });
});

test("ARTHUR_STT_INITIAL_PROMPT maps into VoiceSettings and overrides win", () => {
  withEnv("ARTHUR_STT_INITIAL_PROMPT", "ARTHUR, Nexus, AutoPulse", () => {
    const fromEnv = loadVoiceSettings();
    assert.equal(fromEnv.sttInitialPrompt, "ARTHUR, Nexus, AutoPulse");
    const overridden = loadVoiceSettings({ sttInitialPrompt: "Engineering Mode" });
    assert.equal(overridden.sttInitialPrompt, "Engineering Mode");
  });
});

test("voice validation bounds the initial prompt without echoing it", () => {
  const ok = validateVoiceSettings({
    ...DEFAULT_VOICE_SETTINGS,
    sttInitialPrompt: "x".repeat(STT_INITIAL_PROMPT_MAX_CHARS),
  });
  assert.deepEqual(ok, []);
  const tooLong = validateVoiceSettings({
    ...DEFAULT_VOICE_SETTINGS,
    sttInitialPrompt: "SECRET-MARKER" + "x".repeat(STT_INITIAL_PROMPT_MAX_CHARS),
  });
  assert.equal(tooLong.length, 1);
  assert.ok(tooLong[0]?.includes("ARTHUR_STT_INITIAL_PROMPT"));
  assert.ok(!JSON.stringify(tooLong).includes("SECRET-MARKER"), "validation must never echo prompt content");
});

test("buildApp accepts the initial prompt and never exposes it via voice status", () => {
  const app = buildTestApp({
    voice: {
      voiceEnabled: true,
      sttInitialPrompt: "SECRET-DOMAIN-VOCAB-MARKER",
      sttLanguage: "en",
    },
  });
  try {
    const status = app.voice.status();
    assert.ok(!JSON.stringify(status).includes("SECRET-DOMAIN-VOCAB-MARKER"), "status must never expose the prompt");
    assert.equal(status.stt_language, "en");
  } finally {
    app.close();
  }
});
