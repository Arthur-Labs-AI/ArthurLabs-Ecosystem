import { test } from "node:test";
import assert from "node:assert/strict";

import { join } from "node:path";
import { startServer } from "../../apps/api/server";
import { buildTestApp, validTurn } from "../helpers";

test("voice HTTP control endpoints: status, enable, devices, disable", async () => {
  // The capture fixture reads this from its environment (silent = no wake/VAD churn).
  process.env.FIXTURE_SILENT = "1";
  const app = buildTestApp({
    voice: {
      voiceEnabled: false,
      wakeEnabled: true,
      // Deterministic real adapter: silent PCM fixture (no OS audio needed).
      audioCaptureCommand:
        String.fromCharCode(34) + process.execPath + String.fromCharCode(34) +
        " " +
        String.fromCharCode(34) +
        join(__dirname, "..", "..", "..", "tools", "voice", "fixtures", "capture_fixture.cjs") +
        String.fromCharCode(34),
      sttEngineCommand: "fake-stt-command",
      ttsEngineCommand: "fake-tts-command",
      deepseekApiKey: "super-secret-voice-key",
    },
  });
  const { server, port } = await startServer(app, { host: "127.0.0.1", port: 0 });
  const base = "http://127.0.0.1:" + port;
  try {
    const post = (url: string, body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // Status: must never leak engine commands, api keys, paths, or raw audio.
    const statusRes = await fetch(base + "/v1/voice/status");
    assert.equal(statusRes.status, 200);
    const status = (await statusRes.json()) as Record<string, unknown>;
    const raw = JSON.stringify(status);
    assert.equal(raw.includes("command"), false);
    assert.equal(raw.includes("secret"), false);
    assert.equal(raw.includes("key"), false);
    assert.equal(raw.includes("path"), false);
    assert.equal(raw.includes("pcm"), false);
    assert.equal(status.enabled, false);
    assert.equal(status.state, "disabled");
    assert.equal(status.wake_word, "arthur");

    // Enable without a session -> session binding error (409 via VOICE_STATE_INVALID).
    const noSession = await post(base + "/v1/voice/enable", {});
    assert.equal(noSession.status, 409);

    // Create a session and enable voice with it.
    const turn = (await (await post(base + "/v1/turns", validTurn())).json()) as { session_id: string };
    const enabled = await post(base + "/v1/voice/enable", { session_id: turn.session_id });
    assert.equal(enabled.status, 200);
    const enabledBody = (await enabled.json()) as { state: string };
    assert.equal(enabledBody.state, "idle");

    // Devices endpoints.
    const devices = (await (await fetch(base + "/v1/voice/devices")).json()) as Record<string, unknown>;
    assert.ok(Array.isArray(devices.input_devices));
    const setDevices = await post(base + "/v1/voice/devices", { input_device_id: "default", output_device_id: "default" });
    assert.equal(setDevices.status, 200);

    // Interrupt + PTT start/stop on idle voice (no turn in progress).
    const interrupt = await post(base + "/v1/voice/interrupt", {});
    assert.equal(interrupt.status, 200);
    const ptt = await post(base + "/v1/voice/ptt/start", {});
    assert.equal(ptt.status, 200);
    const pttStop = await post(base + "/v1/voice/ptt/stop", {});
    assert.equal(pttStop.status, 200);

    // Disable.
    const disabled = await post(base + "/v1/voice/disable", {});
    assert.equal(disabled.status, 200);
    const disabledBody = (await disabled.json()) as { state: string };
    assert.equal(disabledBody.state, "disabled");

    // PTT while disabled -> VOICE_DISABLED (409).
    const pttDisabled = await post(base + "/v1/voice/ptt/start", {});
    assert.equal(pttDisabled.status, 409);
  } finally {
    server.close();
    await app.close();
  }
});

test("unknown voice routes 404 with the standard error shape", async () => {
  const app = buildTestApp();
  const { server, port } = await startServer(app, { host: "127.0.0.1", port: 0 });
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/v1/voice/teleport");
    // Unmatched routes use the app-wide fallthrough shape.
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "INVALID_REQUEST");
  } finally {
    server.close();
    await app.close();
  }
});