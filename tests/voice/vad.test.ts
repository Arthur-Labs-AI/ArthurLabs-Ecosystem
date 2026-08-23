import { test } from "node:test";
import assert from "node:assert/strict";

import { LocalEnergyVadProvider } from "../../src/voice/vad/local_provider";
import { FakeVadProvider } from "../../src/voice/vad/fake";
import { frameFromInt16 } from "../../src/voice/contracts";
import type { PcmFrame, VadConfig } from "../../src/voice/contracts";

function config(): VadConfig {
  return {
    speechStartThreshold: 0.6,
    speechEndThreshold: 0.35,
    speechStartFrames: 2,
    speechEndFrames: 4,
    minSpeechMs: 100,
    endSilenceMs: 60,
    maxUtteranceMs: 30000,
    noSpeechTimeoutMs: 6000,
    frameDurationMs: 20,
  };
}

function frame(sequence: number, atMs: number, loud = false): PcmFrame {
  const samples = new Int16Array(320);
  if (loud) samples.fill(4000);
  return frameFromInt16(samples, sequence, atMs);
}

test("local VAD emits speech_started only after sustained energy (debounce)", () => {
  const vad = new LocalEnergyVadProvider(config());
  const transitions: string[] = [];
  const note = (result: { transition?: string }): void => {
    if (result.transition) transitions.push(result.transition);
  };
  // One loud frame is not enough (speechStartFrames = 2).
  note(vad.process(frame(0, 0, true)));
  assert.deepEqual(transitions, []);
  note(vad.process(frame(1, 20, true)));
  assert.deepEqual(transitions, ["speech_started"]);
  // Sustained silence ends the utterance (speechEndFrames = 4).
  note(vad.process(frame(2, 40)));
  note(vad.process(frame(3, 60)));
  note(vad.process(frame(4, 80)));
  note(vad.process(frame(5, 100)));
  assert.deepEqual(transitions, ["speech_started", "speech_ended"]);
});

test("fake VAD follows its script deterministically", () => {
  const vad = new FakeVadProvider(config());
  const transitions: string[] = [];
  const note = (result: { transition?: string }): void => {
    if (result.transition) transitions.push(result.transition);
  };
  vad.setScript(["silence", "speech", "speech", "end"]);
  note(vad.process(frame(0, 0)));
  note(vad.process(frame(1, 20)));
  note(vad.process(frame(2, 40)));
  note(vad.process(frame(3, 60)));
  // Every "speech" step emits speech_started (deterministic script
  // boundaries; the controller counts runs for barge-in eligibility).
  assert.deepEqual(transitions, ["speech_started", "speech_started", "speech_ended"]);
});

test("VAD reset clears state", () => {
  const vad = new LocalEnergyVadProvider(config());
  const transitions: string[] = [];
  const note = (result: { transition?: string }): void => {
    if (result.transition) transitions.push(result.transition);
  };
  note(vad.process(frame(0, 0, true)));
  note(vad.process(frame(1, 20, true)));
  assert.deepEqual(transitions, ["speech_started"]);
  vad.reset();
  // Reset clears the debounce run: two loud frames are needed again.
  note(vad.process(frame(2, 40, true)));
  assert.deepEqual(transitions, ["speech_started"]);
  note(vad.process(frame(3, 60, true)));
  assert.deepEqual(transitions, ["speech_started", "speech_started"]);
});