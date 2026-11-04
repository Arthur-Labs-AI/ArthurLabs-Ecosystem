import { test } from "node:test";
import assert from "node:assert/strict";

import { LocalWakeWordProvider } from "../../src/voice/wake/local_provider";
import { FakeWakeWordProvider } from "../../src/voice/wake/fake";
import { WakeWordGateway } from "../../src/voice/wake/gateway";
import { frameFromInt16 } from "../../src/voice/contracts";
import type { PcmFrame, WakeEvent, WakeWordConfig } from "../../src/voice/contracts";

function wakeConfig(): WakeWordConfig {
  return { wakeWord: "arthur", sampleRateHz: 16000, frameDurationMs: 20, preRollMs: 400, threshold: 0.6 };
}

function frame(sequence: number, atMs: number, loud = false): PcmFrame {
  const samples = new Int16Array(320);
  if (loud) samples.fill(5000);
  return frameFromInt16(samples, sequence, atMs);
}

test("fake wake provider triggers deterministically and tracks lifecycle", async () => {
  const provider = new FakeWakeWordProvider();
  assert.equal(provider.available, true);
  assert.equal(provider.startCount, 0);
  const events: WakeEvent[] = [];
  await provider.start(wakeConfig(), (event) => events.push(event));
  assert.equal(provider.startCount, 1);
  provider.triggerWake(1000);
  provider.triggerWake(2000);
  assert.deepEqual(events.map((e) => e.detected_at_ms), [1000, 2000]);
  assert.equal(provider.detections.length, 2);
  await provider.stop();
  assert.equal(provider.stopCount, 1);
  // After stop, triggerWake goes nowhere.
  provider.triggerWake(3000);
  assert.equal(events.length, 2);
});

test("local wake provider is a documented energy-burst detector, not a keyword spotter", () => {
  const provider = new LocalWakeWordProvider();
  // Always available (no external model), so PTT is always a fallback.
  assert.equal(provider.available, true);
  // It must never crash on silence or garbage frames.
  provider.processFrame(frame(0, 0));
  provider.processFrame(frame(1, 20, true));
});

test("wake gateway drops detections while paused (echo protection)", async () => {
  const provider = new FakeWakeWordProvider();
  const gateway = new WakeWordGateway(provider, { frameBased: true });
  const events: number[] = [];
  await gateway.start(wakeConfig(), (event) => events.push(event.detected_at_ms));
  gateway.setPaused(true);
  provider.triggerWake(100);
  assert.deepEqual(events, []);
  gateway.setPaused(false);
  provider.triggerWake(200);
  assert.deepEqual(events, [200]);
  await gateway.stop();
});

test("wake gateway ignores detections before start and after stop", async () => {
  const provider = new FakeWakeWordProvider();
  const gateway = new WakeWordGateway(provider, { frameBased: true });
  const events: number[] = [];
  provider.triggerWake(1);
  await gateway.start(wakeConfig(), (event) => events.push(event.detected_at_ms));
  provider.triggerWake(2);
  await gateway.stop();
  provider.triggerWake(3);
  assert.deepEqual(events, [2]);
});
