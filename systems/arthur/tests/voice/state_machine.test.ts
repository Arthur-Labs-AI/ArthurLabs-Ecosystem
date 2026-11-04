import { test } from "node:test";
import assert from "node:assert/strict";

import { VoiceState, VoiceError, VoiceErrorCode } from "../../src/voice/contracts";
import { VoiceStateMachine } from "../../src/voice/state_machine";

function fresh(): VoiceStateMachine {
  return new VoiceStateMachine();
}

test("starts disabled; disable is the default state", () => {
  const machine = fresh();
  assert.equal(machine.state, VoiceState.DISABLED);
});

test("enable/disable cycle through the documented spine", () => {
  const machine = fresh();
  const seen: Array<[VoiceState, VoiceState, string]> = [];
  machine.subscribe((from, to, reason) => seen.push([from, to, reason]));
  machine.transition(VoiceState.IDLE, "enable");
  machine.transition(VoiceState.LISTENING, "wake_detected");
  machine.transition(VoiceState.CAPTURING, "speech_started");
  machine.transition(VoiceState.TRANSCRIBING_FINAL, "vad_end");
  machine.transition(VoiceState.THINKING, "final_transcript");
  machine.transition(VoiceState.SPEAKING, "first_speakable_chunk");
  machine.transition(VoiceState.IDLE, "response_complete");
  machine.transition(VoiceState.DISABLED, "disable");
  assert.deepEqual(
    seen.map(([, to]) => to),
    [
      VoiceState.IDLE,
      VoiceState.LISTENING,
      VoiceState.CAPTURING,
      VoiceState.TRANSCRIBING_FINAL,
      VoiceState.THINKING,
      VoiceState.SPEAKING,
      VoiceState.IDLE,
      VoiceState.DISABLED,
    ],
  );
});

test("interrupt path: speaking -> interrupting -> listening", () => {
  const machine = fresh();
  machine.transition(VoiceState.IDLE, "enable");
  machine.transition(VoiceState.LISTENING, "wake_detected");
  machine.transition(VoiceState.CAPTURING, "speech_started");
  machine.transition(VoiceState.TRANSCRIBING_FINAL, "vad_end");
  machine.transition(VoiceState.THINKING, "final_transcript");
  machine.transition(VoiceState.SPEAKING, "first_speakable_chunk");
  machine.transition(VoiceState.INTERRUPTING, "barge_in");
  machine.transition(VoiceState.LISTENING, "barge_in_listen");
  assert.equal(machine.state, VoiceState.LISTENING);
});

test("error state is recoverable to idle", () => {
  const machine = fresh();
  machine.transition(VoiceState.IDLE, "enable");
  machine.transition(VoiceState.ERROR, "hard_failure");
  assert.equal(machine.state, VoiceState.ERROR);
  machine.transition(VoiceState.IDLE, "recover");
  assert.equal(machine.state, VoiceState.IDLE);
});

test("illegal transitions throw VOICE_STATE_INVALID and keep state", () => {
  const machine = fresh();
  // DISABLED -> CAPTURING is illegal (must pass through idle/listening).
  assert.throws(
    () => machine.transition(VoiceState.CAPTURING, "illegal"),
    (err: unknown) =>
      err instanceof VoiceError && err.code === VoiceErrorCode.VOICE_STATE_INVALID,
  );
  assert.equal(machine.state, VoiceState.DISABLED);
  // IDLE -> THINKING is illegal (must pass through listening/capturing).
  machine.transition(VoiceState.IDLE, "enable");
  machine.transition(VoiceState.LISTENING, "wake_detected");
  machine.transition(VoiceState.CAPTURING, "speech_started");
  machine.transition(VoiceState.TRANSCRIBING_FINAL, "vad_end");
  machine.transition(VoiceState.THINKING, "final_transcript");
  machine.transition(VoiceState.SPEAKING, "first_speakable_chunk");
  assert.throws(() => machine.transition(VoiceState.THINKING, "illegal"));
  assert.equal(machine.state, VoiceState.SPEAKING);
});

test("enterError transitions to ERROR and listeners observe it", () => {
  const machine = fresh();
  const seen: Array<[VoiceState, VoiceState, string]> = [];
  machine.subscribe((from, to, reason) => seen.push([from, to, reason]));
  machine.transition(VoiceState.IDLE, "enable");
  machine.enterError("hard_failure");
  assert.equal(machine.state, VoiceState.ERROR);
  assert.deepEqual(seen[seen.length - 1], [VoiceState.IDLE, VoiceState.ERROR, "hard_failure"]);
  machine.transition(VoiceState.IDLE, "recover");
  assert.equal(machine.state, VoiceState.IDLE);
});

test("proactive speech extension: idle -> speaking is allowed (documented)", () => {
  const machine = fresh();
  machine.transition(VoiceState.IDLE, "enable");
  machine.transition(VoiceState.SPEAKING, "proactive_speech");
  assert.equal(machine.state, VoiceState.SPEAKING);
});