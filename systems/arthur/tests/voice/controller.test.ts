import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTestApp, validTurn } from "../helpers";
import { FakeAudioCapture } from "../../src/voice/audio/capture";
import { FakeAudioPlayback } from "../../src/voice/audio/playback";
import { FakeWakeWordProvider } from "../../src/voice/wake/fake";
import { FakeVadProvider } from "../../src/voice/vad/fake";
import { FakeSttProvider } from "../../src/voice/stt/fake";
import { FakeTtsProvider } from "../../src/voice/tts/fake";
import { FakeProvider } from "../../src/models/providers/fake";
import { frameFromInt16, PcmFrame, VoiceErrorCode, VoiceState } from "../../src/voice/contracts";
import type { ModelStreamEvent, ModelRequest } from "../../src/models/contracts";
import type { VoiceClientEvent } from "../../src/voice/events";
import type { App } from "../../src/app";

interface Harness {
  app: App;
  capture: FakeAudioCapture;
  playback: FakeAudioPlayback;
  wake: FakeWakeWordProvider;
  vad: FakeVadProvider;
  stt: FakeSttProvider;
  tts: FakeTtsProvider;
  events: VoiceClientEvent[];
  sessionId: string;
}

function silenceFrame(sequence: number, atMs: number): PcmFrame {
  return frameFromInt16(new Int16Array(320), sequence, atMs);
}

function speechFrame(sequence: number, atMs: number): PcmFrame {
  const samples = new Int16Array(320);
  samples.fill(3000);
  return frameFromInt16(samples, sequence, atMs);
}

async function buildHarness(opts: {
  mode?: string;
  streamResponder?: (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>;
  noSpeechTimeoutMs?: number;
  maxUtteranceMs?: number;
  /** FakeVadProvider realisticTransitions mode (speech_started once per episode). */
  vadRealistic?: boolean;
} = {}): Promise<Harness> {
  const capture = new FakeAudioCapture();
  const playback = new FakeAudioPlayback(undefined, { delayPerChunkMs: 25 });
  const wake = new FakeWakeWordProvider();
  const vad = new FakeVadProvider(undefined, opts.vadRealistic ? { realisticTransitions: true } : undefined);
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider();
  const app = buildTestApp(
    {
      voice: {
        voiceEnabled: true,
        wakeEnabled: true,
        wakeWord: "arthur",
        ttsMaxQueueChunks: 8,
        noSpeechTimeoutMs: opts.noSpeechTimeoutMs ?? 5000,
        maxUtteranceMs: opts.maxUtteranceMs ?? 30000,
      },
    },
    {
      provider: new FakeProvider({
        streamResponder:
          opts.streamResponder ??
          (async function* () {
            yield { type: "text_delta", text: "Hello there!" };
            yield {
              type: "usage",
              usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            };
            yield { type: "done", finish_reason: "stop" };
          }) as (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>,
      }),
      voice: { capture, playback, wake, vad, stt, tts },
    },
  );
  const events: VoiceClientEvent[] = [];
  app.voice.subscribe((event) => events.push(event));
  const first = await app.conversation.handleTurn(
    validTurn({ mode: opts.mode ?? "personal", message: "setup" }),
  );
  await app.voice.enable(first.session_id);
  return { app, capture, playback, wake, vad, stt, tts, events, sessionId: first.session_id };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function feedUtterance(h: Harness, startAtMs: number, frames: number): void {
  for (let i = 0; i < frames; i++) {
    h.capture.feedFrame(speechFrame(i, startAtMs + i * 20));
  }
}

test("enable binds a session and starts capture + wake; disable releases them", async () => {
  const h = await buildHarness();
  assert.equal(h.app.voice.state, VoiceState.IDLE);
  assert.equal(h.capture.startCount, 1);
  assert.equal(h.wake.startCount, 1);
  await h.app.voice.disable();
  assert.equal(h.app.voice.state, VoiceState.DISABLED);
  assert.equal(h.capture.stopCount, 1);
  assert.equal(h.wake.stopCount, 1);
  await h.app.close();
});

test("enable rejects an unknown session id", async () => {
  const h = await buildHarness();
  await h.app.voice.disable();
  await assert.rejects(
    () => h.app.voice.enable("no-such-session"),
    (err: unknown) => err instanceof Error && err.message.includes("Unknown session"),
  );
  await h.app.close();
});

test("wake word -> utterance -> transcript -> streaming answer -> speech", async () => {
  const h = await buildHarness();
  h.stt.setDefaultScript({
    partials: ["arthur ", "arthur set a "],
    final: "arthur set a reminder",
    language: "en",
    confidence: 0.9,
  });
  h.vad.setScript(["silence", "speech", "speech", "speech", "end"]);
  const t0 = Date.now();
  h.wake.triggerWake(t0);
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  feedUtterance(h, t0 + 40, 3);
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  h.capture.feedFrame(silenceFrame(10, t0 + 100));
  h.capture.feedFrame(silenceFrame(10, t0 + 120));
  await waitFor(() => h.app.voice.state === VoiceState.SPEAKING);
  const events = h.events;
  assert.ok(events.some((e) => e.type === "wake.detected"));
  assert.ok(events.some((e) => e.type === "stt.partial"));
  assert.ok(events.some((e) => e.type === "stt.final"));
  assert.ok(events.some((e) => e.type === "assistant.speech.started"));
  await waitFor(() => h.app.voice.state === VoiceState.IDLE);
  assert.ok(events.some((e) => e.type === "assistant.speech.ended"));
  assert.ok(events.some((e) => e.type === "assistant.turn.completed"));
  const completed = events.filter((e) => e.type === "assistant.turn.completed")[0];
  assert.ok(completed && completed.type === "assistant.turn.completed");
  assert.equal(completed.status, "completed");
  assert.equal(h.playback.stopRequested, false);
  await h.app.close();
});

test("STT failure fails closed: no turn is created and voice returns to idle", async () => {
  const h = await buildHarness();
  h.stt.setDefaultScript({ error: "STT_FAILED" });
  h.vad.setScript(["silence", "speech", "speech", "end"]);
  const before = h.events.filter((e) => e.type === "assistant.turn.completed").length;
  h.wake.triggerWake(Date.now());
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  feedUtterance(h, Date.now() + 40, 2);
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  h.capture.feedFrame(silenceFrame(10, Date.now() + 80));
  h.capture.feedFrame(silenceFrame(10, Date.now() + 100));
  await waitFor(() => h.app.voice.state === VoiceState.IDLE);
  const errors = h.events.filter((e) => e.type === "voice.error" && e.code === "STT_FAILED");
  assert.equal(errors.length, 1);
  const after = h.events.filter((e) => e.type === "assistant.turn.completed").length;
  assert.equal(after, before, "no completed turn may exist after STT failure");
  await h.app.close();
});
test("barge-in interrupts generation, cancels the model stream, and persists an interrupted turn", async () => {
  let releaseStream!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  const h = await buildHarness({
    streamResponder: (async function* (_req: ModelRequest, signal?: AbortSignal) {
      // TASK-0024: tool-capable partial text is provisional — held for UI,
      // never spoken. The generation stays open (THINKING) until cancelled.
      yield { type: "text_delta", text: "Partial answer that will be cut off. " };
      await Promise.race([
        gate,
        new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
      if (signal?.aborted) return;
      yield { type: "done", finish_reason: "stop" };
    }) as (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>,
  });
  h.stt.setDefaultScript({ final: "speak about the weather" });
  h.vad.setScript(["silence", "speech", "speech", "speech", "end"]);
  const t0 = Date.now();
  h.wake.triggerWake(t0);
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  feedUtterance(h, t0 + 40, 3);
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  h.capture.feedFrame(silenceFrame(10, t0 + 100));
  h.capture.feedFrame(silenceFrame(10, t0 + 120));
  // Generation is open (provisional text visible for UI, nothing spoken yet).
  await waitFor(() => h.app.voice.state === VoiceState.THINKING);
  assert.ok(h.events.some((e) => e.type === "assistant.text.delta"), "provisional text stays UI-visible");
  assert.equal(h.tts.requests.length, 0, "provisional text must never reach TTS");
  // User talks over ARTHUR while generation is still active: sustained
  // high-probability speech (>= bargeInMinSpeechMs = 150 ms = 8 frames at
  // 20 ms) must trigger the barge-in.
  h.vad.setScript(["silence", "speech", "speech", "speech", "speech", "speech", "speech", "speech", "speech", "speech"]);
  feedUtterance(h, Date.now(), 10);
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING || h.app.voice.state === VoiceState.CAPTURING);
  assert.ok(
    h.events.some((e) => e.type === "voice.error" && e.code === VoiceErrorCode.VOICE_CANCELLED),
    "barge-in must surface VOICE_CANCELLED",
  );
  releaseStream();
  // The interrupted turn is persisted as interrupted, never completed.
  await waitFor(() =>
    h.app.store
      .getRecentTurns(h.sessionId, "personal", 10)
      .some((t) => t.role === "assistant" && t.status === "interrupted"),
  );
  await h.app.close();
});

test("voice yes binds to the exact single pending approval and executes it", async () => {
  const h = await buildHarness({
    mode: "business",
    streamResponder: (async function* () {
      yield {
        type: "tool_call",
        call: {
          id: "tc-1",
          name: "harness.create_job",
          arguments: { kind: "build", payload: { target: "test" } },
        },
      };
      yield {
        type: "usage",
        usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
      };
      yield { type: "done", finish_reason: "tool_calls" };
    }) as (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>,
  });
  h.stt.setDefaultScript({ final: "create a job" });
  h.vad.setScript(["silence", "speech", "speech", "end"]);
  h.wake.triggerWake(Date.now());
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  feedUtterance(h, Date.now() + 40, 2);
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  h.capture.feedFrame(silenceFrame(10, Date.now() + 80));
  h.capture.feedFrame(silenceFrame(10, Date.now() + 100));
  // The tool requires approval: the voice layer must wait, not execute.
  await waitFor(() => h.events.some((e) => e.type === "approval.required"));
  const approvals = h.app.store.listPendingApprovals(h.sessionId);
  assert.equal(approvals.length, 1);
  const pending = approvals[0];
  assert.ok(pending);
  const result = await h.app.voice.handleApprovalIntent("yes");
  assert.equal(result.handled, true);
  await waitFor(() => h.events.some((e) => e.type === "approval.outcome"));
  const outcome = h.events.filter((e) => e.type === "approval.outcome")[0];
  assert.ok(outcome && outcome.type === "approval.outcome");
  assert.equal(outcome.status, "approved");
  assert.equal(h.app.store.getApproval(pending.id)?.status, "approved");
  await h.app.close();
});

test("generic yes with multiple pending approvals is ambiguous: nothing executes", async () => {
  const h = await buildHarness({
    mode: "business",
    streamResponder: (async function* () {
      yield {
        type: "tool_call",
        call: {
          id: "tc-1",
          name: "harness.create_job",
          arguments: { kind: "build", payload: { target: "one" } },
        },
      };
      yield { type: "done", finish_reason: "tool_calls" };
    }) as (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>,
  });
  h.stt.setDefaultScript({ final: "first request" });
  h.vad.setScript(["silence", "speech", "speech", "end"]);
  h.wake.triggerWake(Date.now());
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  feedUtterance(h, Date.now() + 40, 2);
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  h.capture.feedFrame(silenceFrame(10, Date.now() + 80));
  h.capture.feedFrame(silenceFrame(10, Date.now() + 100));
  await waitFor(() => h.events.some((e) => e.type === "approval.required"));
  // The approval prompt is spoken first; the second wake only counts when idle.
  await waitFor(() => h.app.voice.state === VoiceState.IDLE);
  // Second pending approval from a second utterance.
  h.stt.setDefaultScript({ final: "second request" });
  h.vad.setScript(["silence", "speech", "speech", "end"]);
  h.wake.triggerWake(Date.now());
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  feedUtterance(h, Date.now() + 40, 2);
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  h.capture.feedFrame(silenceFrame(10, Date.now() + 80));
  h.capture.feedFrame(silenceFrame(10, Date.now() + 100));
  await waitFor(() => h.app.store.listPendingApprovals(h.sessionId).length >= 2);
  const result = await h.app.voice.handleApprovalIntent("yes please");
  assert.equal(result.handled, true);
  await waitFor(() => h.events.some((e) => e.type === "approval.ambiguous"));
  const remaining = h.app.store.listPendingApprovals(h.sessionId);
  assert.equal(remaining.filter((a) => a.status === "pending").length, 2, "nothing may execute on ambiguity");
  await h.app.close();
});

test("push-to-talk works without wake and times out on no speech", async () => {
  const h = await buildHarness({ noSpeechTimeoutMs: 500 });
  await h.app.voice.disable();
  // Wake disabled entirely: PTT is the only path.
  const app2 = h.app;
  await app2.voice.enable(h.sessionId);
  await app2.voice.pttStart();
  assert.equal(app2.voice.state, VoiceState.LISTENING);
  // No speech arrives -> VOICE_TIMEOUT after noSpeechTimeoutMs.
  await waitFor(() => app2.voice.state === VoiceState.IDLE, 2000);
  assert.ok(h.events.some((e) => e.type === "voice.error" && e.code === VoiceErrorCode.VOICE_TIMEOUT));
  // PTT with speech produces a turn.
  h.stt.setDefaultScript({ final: "ptt utterance" });
  h.vad.setScript(["speech", "speech", "end"]);
  await app2.voice.pttStart();
  await waitFor(() => app2.voice.state === VoiceState.LISTENING);
  feedUtterance(h, Date.now(), 2);
  await waitFor(() => app2.voice.state === VoiceState.CAPTURING);
  h.capture.feedFrame(silenceFrame(10, Date.now() + 40));
  await app2.voice.pttStop();
  await waitFor(() => app2.voice.state === VoiceState.IDLE, 4000);
  assert.ok(h.events.some((e) => e.type === "assistant.turn.completed"));
  await h.app.close();
});

test("wake word is muted while ARTHUR speaks (echo protection)", async () => {
  const h = await buildHarness();
  h.stt.setDefaultScript({ final: "tell me a story" });
  h.vad.setScript(["silence", "speech", "speech", "end"]);
  h.wake.triggerWake(Date.now());
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  feedUtterance(h, Date.now() + 40, 2);
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  h.capture.feedFrame(silenceFrame(10, Date.now() + 80));
  h.capture.feedFrame(silenceFrame(10, Date.now() + 100));
  await waitFor(() => h.app.voice.state === VoiceState.SPEAKING);
  // ARTHUR's own speech must not wake it up again.
  h.wake.triggerWake(Date.now() + 200);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(h.app.voice.state, VoiceState.SPEAKING, "wake must stay muted while speaking");
  await waitFor(() => h.app.voice.state === VoiceState.IDLE);
  // Back to idle the wake word works again.
  h.wake.triggerWake(Date.now());
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  await h.app.close();
});

test("interrupt command cancels speech and returns to idle", async () => {
  const h = await buildHarness();
  h.stt.setDefaultScript({ final: "long story please" });
  h.vad.setScript(["silence", "speech", "speech", "end"]);
  h.wake.triggerWake(Date.now());
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  feedUtterance(h, Date.now() + 40, 2);
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  h.capture.feedFrame(silenceFrame(10, Date.now() + 80));
  h.capture.feedFrame(silenceFrame(10, Date.now() + 100));
  await waitFor(() => h.app.voice.state === VoiceState.SPEAKING);
  await h.app.voice.interrupt("user_stop");
  assert.equal(h.app.voice.state, VoiceState.IDLE);
  assert.ok(h.playback.stopRequested, "playback must stop on interrupt");
  await h.app.close();
});

// ---------------------------------------------------------------------------
// TASK-0007 BUG 1: PTT owns utterance finalization
// ---------------------------------------------------------------------------

test("PTT utterance is not finalized by temporary VAD silence while the button is held", async () => {
  const h = await buildHarness();
  await h.app.voice.disable();
  await h.app.voice.enable(h.sessionId);
  h.stt.setDefaultScript({ final: "count from one to one hundred slowly" });
  // Speech, a VAD end-of-speech episode, more silence, speech again - the
  // button is never released, so nothing may finalize until pttStop.
  h.vad.setScript(["speech", "speech", "end", "end", "end", "speech", "speech"]);
  await h.app.voice.pttStart();
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  feedUtterance(h, Date.now(), 3);
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  h.capture.feedFrame(silenceFrame(20, Date.now() + 100));
  h.capture.feedFrame(silenceFrame(21, Date.now() + 120));
  h.capture.feedFrame(silenceFrame(22, Date.now() + 140));
  assert.equal(
    h.app.voice.state,
    VoiceState.CAPTURING,
    "temporary VAD silence must not finalize an active PTT utterance",
  );
  assert.ok(
    !h.events.some((e) => e.type === "voice.state" && e.reason === "vad_end"),
    "no vad_end finalization may occur while PTT is active",
  );
  h.capture.feedFrame(speechFrame(30, Date.now() + 160));
  h.capture.feedFrame(speechFrame(31, Date.now() + 180));
  await h.app.voice.pttStop();
  assert.equal(h.app.voice.state, VoiceState.TRANSCRIBING_FINAL);
  await waitFor(() => h.app.voice.state === VoiceState.IDLE, 4000);
  assert.ok(h.events.some((e) => e.type === "assistant.turn.completed"), "the full utterance must complete as one turn");
  await h.app.close();
});

test("PTT max-utterance safety timeout still finalizes a held utterance", async () => {
  const h = await buildHarness({ maxUtteranceMs: 1000 });
  await h.app.voice.disable();
  await h.app.voice.enable(h.sessionId);
  h.stt.setDefaultScript({ final: "held too long" });
  h.vad.setScript(["speech"]);
  await h.app.voice.pttStart();
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  feedUtterance(h, Date.now(), 2);
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  // Keep the button held (no pttStop): only the safety timeout may finalize.
  await waitFor(
    () => h.events.some((e) => e.type === "voice.state" && e.reason === "max_utterance"),
    4000,
    "max-utterance safety timeout",
  );
  await waitFor(() => h.app.voice.state === VoiceState.IDLE, 4000);
  await h.app.close();
});

test("pttStop with no speech returns to idle without creating a turn", async () => {
  const h = await buildHarness();
  await h.app.voice.disable();
  await h.app.voice.enable(h.sessionId);
  h.vad.setScript(["silence"]);
  await h.app.voice.pttStart();
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  h.capture.feedFrame(silenceFrame(1, Date.now()));
  h.capture.feedFrame(silenceFrame(2, Date.now() + 20));
  await h.app.voice.pttStop();
  assert.equal(h.app.voice.state, VoiceState.IDLE);
  assert.ok(!h.events.some((e) => e.type === "assistant.turn.completed"));
  await h.app.close();
});

// ---------------------------------------------------------------------------
// TASK-0007 BUG 2: pre-roll is drained into the utterance STT stream
// ---------------------------------------------------------------------------

test("pre-roll captured before speech_started reaches STT in order without duplication", async () => {
  const h = await buildHarness();
  await h.app.voice.disable();
  await h.app.voice.enable(h.sessionId);
  h.stt.recordFrames = true;
  h.stt.setDefaultScript({ final: "count from one to one hundred slowly" });
  // Ten silent frames, then speech: the speech_started boundary must land on
  // the 11th fed frame.
  h.vad.setScript(["silence", "silence", "silence", "silence", "silence", "silence", "silence", "silence", "silence", "silence", "speech", "speech", "end"]);
  await h.app.voice.pttStart();
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  // Ten frames of audio BEFORE the speech_started frame: exactly the first
  // words the old LISTENING path lost (pre-roll was never drained).
  for (let i = 0; i < 10; i++) {
    h.capture.feedFrame(silenceFrame(i, Date.now() + i * 20));
  }
  assert.equal(h.app.voice.state, VoiceState.LISTENING);
  h.capture.feedFrame(speechFrame(10, Date.now() + 200));
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  await waitFor(() => h.stt.receivedFrames.length >= 11, 2000, "pre-roll frames to reach STT");
  const received = h.stt.receivedFrames.map((f) => f.sequence);
  assert.equal(received.length, 11, "exactly the 10 pre-roll frames plus the current frame");
  assert.deepEqual(
    received,
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    "pre-roll must precede the current frame and no frame may be duplicated",
  );
  await h.app.voice.pttStop();
  await h.app.close();
});

test("pre-roll injection stays within the bounded ring buffer window", async () => {
  const h = await buildHarness();
  await h.app.voice.disable();
  await h.app.voice.enable(h.sessionId);
  h.stt.recordFrames = true;
  h.stt.setDefaultScript({ final: "bounded pre-roll" });
  h.vad.setScript([...Array(80).fill("silence"), "speech", "end"]);
  await h.app.voice.pttStart();
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  // 80 frames (~1.6 s) far exceed the ~700 ms pre-roll window: eviction must
  // keep the injected window bounded.
  for (let i = 0; i < 80; i++) {
    h.capture.feedFrame(silenceFrame(i, Date.now() + i * 20));
  }
  h.capture.feedFrame(speechFrame(80, Date.now() + 1600));
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  await waitFor(() => h.stt.receivedFrames.length >= 1, 2000, "frames to reach STT");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const count = h.stt.receivedFrames.length;
  const maxWindowFrames = Math.ceil(700 / 20) + 1 + 2;
  assert.ok(count <= maxWindowFrames, `injected pre-roll must stay bounded (got ${count}, max ${maxWindowFrames})`);
  await h.app.voice.pttStop();
  await h.app.close();
});

test("pre-roll is cleared after ownership transfers so stale audio never repeats", async () => {
  const h = await buildHarness();
  await h.app.voice.disable();
  await h.app.voice.enable(h.sessionId);
  h.stt.recordFrames = true;
  h.stt.setDefaultScript({ final: "two utterances" });
  h.vad.setScript(["silence", "speech", "end"]);
  // Utterance 1.
  await h.app.voice.pttStart();
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  for (let i = 0; i < 3; i++) h.capture.feedFrame(silenceFrame(i, Date.now() + i * 20));
  h.capture.feedFrame(speechFrame(3, Date.now() + 60));
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  await h.app.voice.pttStop();
  await waitFor(() => h.app.voice.state === VoiceState.IDLE, 4000);
  h.stt.clearReceivedFrames();
  // Utterance 2: only frames from this utterance may reach STT.
  h.vad.setScript(["silence", "speech", "end"]);
  await h.app.voice.pttStart();
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  h.capture.feedFrame(silenceFrame(100, Date.now() + 200));
  h.capture.feedFrame(silenceFrame(101, Date.now() + 220));
  h.capture.feedFrame(speechFrame(102, Date.now() + 240));
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  await waitFor(() => h.stt.receivedFrames.length >= 3, 2000, "second utterance frames to reach STT");
  const sequences = h.stt.receivedFrames.map((f) => f.sequence);
  assert.equal(sequences[0], 100, "second utterance must start at its own pre-roll, no stale frames");
  assert.ok(sequences.every((s) => s >= 100), `no stale pre-utterance frames may repeat (got ${sequences.join(",")})`);
  await h.app.voice.pttStop();
  await h.app.close();
});

// ---------------------------------------------------------------------------
// TASK-0007 BUG 4: barge-in requires sustained high-probability speech
// ---------------------------------------------------------------------------

test("a short transient during playback does not barge in", async () => {
  const h = await buildHarness();
  h.stt.setDefaultScript({ final: "tell me a story" });
  h.vad.setScript(["silence", "speech", "speech", "end"]);
  h.wake.triggerWake(Date.now());
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  feedUtterance(h, Date.now() + 40, 2);
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  h.capture.feedFrame(silenceFrame(10, Date.now() + 80));
  h.capture.feedFrame(silenceFrame(10, Date.now() + 100));
  await waitFor(() => h.app.voice.state === VoiceState.SPEAKING);
  // 3 speech frames (~60 ms) then silence: far below the 150 ms sustained bar.
  h.vad.setScript(["speech", "speech", "speech", "silence", "silence", "silence", "silence"]);
  feedUtterance(h, Date.now(), 7);
  assert.equal(h.app.voice.state, VoiceState.SPEAKING, "a short transient must not cancel playback");
  assert.ok(
    !h.events.some((e) => e.type === "voice.error" && e.code === VoiceErrorCode.VOICE_CANCELLED),
  );
  await waitFor(() => h.app.voice.state === VoiceState.IDLE, 4000);
  await h.app.close();
});

test("sustained speech barges in even without repeated speech_started transitions", async () => {
  let releaseStream!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  const h = await buildHarness({
    vadRealistic: true,
    streamResponder: (async function* (_req: ModelRequest, signal?: AbortSignal) {
      yield { type: "text_delta", text: "A long answer that will be interrupted. " };
      await Promise.race([
        gate,
        new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
      if (signal?.aborted) return;
      yield { type: "done", finish_reason: "stop" };
    }) as (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>,
  });
  h.stt.setDefaultScript({ final: "speak about the weather" });
  h.vad.setScript(["silence", "speech", "speech", "end"]);
  h.wake.triggerWake(Date.now());
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  feedUtterance(h, Date.now() + 40, 3);
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  h.capture.feedFrame(silenceFrame(10, Date.now() + 80));
  h.capture.feedFrame(silenceFrame(10, Date.now() + 100));
  // TASK-0024: provisional text is UI-only while the round can still become
  // a tool round — the generation stays open (THINKING) until cancelled.
  await waitFor(() => h.app.voice.state === VoiceState.THINKING);
  assert.equal(h.tts.requests.length, 0, "provisional text must never reach TTS");
  const deltasBefore = h.events.filter((e) => e.type === "assistant.text.delta").length;
  // Realistic VAD shape: ONE speech_started transition, then sustained speech
  // frames without transitions (1 silence + 8 speech = 160 ms >= 150 ms bar).
  h.vad.setScript(["silence", "speech", "speech", "speech", "speech", "speech", "speech", "speech", "speech"]);
  feedUtterance(h, Date.now(), 9);
  // LISTENING is entered only after the VOICE_CANCELLED error is emitted, so
  // waiting for it avoids racing the async cancellation.
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING, 4000, "sustained speech to barge in");
  assert.ok(
    h.events.some((e) => e.type === "voice.error" && e.code === VoiceErrorCode.VOICE_CANCELLED),
    "barge-in must surface VOICE_CANCELLED",
  );
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING, 4000, "state to return to listening");
  releaseStream();
  // The interrupted generation is dead: no further deltas, turn persisted as
  // interrupted, and no stale audio resumes.
  await waitFor(() =>
    h.app.store
      .getRecentTurns(h.sessionId, "personal", 10)
      .some((t) => t.role === "assistant" && t.status === "interrupted"),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  const deltasAfter = h.events.filter((e) => e.type === "assistant.text.delta").length;
  assert.equal(deltasAfter, deltasBefore, "stale generation must never emit more deltas after barge-in");
  await h.app.close();
});

test("sustained but below-threshold speech during playback does not barge in", async () => {
  const h = await buildHarness();
  h.stt.setDefaultScript({ final: "tell me a story" });
  h.vad.setScript(["silence", "speech", "speech", "end"]);
  h.wake.triggerWake(Date.now());
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  feedUtterance(h, Date.now() + 40, 2);
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  h.capture.feedFrame(silenceFrame(10, Date.now() + 80));
  h.capture.feedFrame(silenceFrame(10, Date.now() + 100));
  await waitFor(() => h.app.voice.state === VoiceState.SPEAKING);
  // Sustained (10 frames) but probability 0.75 < 0.8 playback threshold:
  // likely speaker echo, not a deliberate user interruption.
  h.vad.setScript(["speech_low", "speech_low", "speech_low", "speech_low", "speech_low", "speech_low", "speech_low", "speech_low", "speech_low", "speech_low"]);
  feedUtterance(h, Date.now(), 10);
  assert.equal(h.app.voice.state, VoiceState.SPEAKING, "echo-level sustained sound must not cancel playback");
  assert.ok(
    !h.events.some((e) => e.type === "voice.error" && e.code === VoiceErrorCode.VOICE_CANCELLED),
  );
  await waitFor(() => h.app.voice.state === VoiceState.IDLE, 4000);
  await h.app.close();
});

// ---------------------------------------------------------------------------
// TASK-0007 follow-up: fresh PTT start discards pre-button pre-roll
// ---------------------------------------------------------------------------

/** Frame with a unique marker amplitude so recorded audio is identifiable. */
function markedFrame(sequence: number, atMs: number, marker: number): PcmFrame {
  const samples = new Int16Array(320);
  samples.fill(marker);
  return frameFromInt16(samples, sequence, atMs);
}

test("fresh PTT start discards pre-button pre-roll and resets the VAD boundary", async () => {
  const h = await buildHarness();
  await h.app.voice.disable();
  await h.app.voice.enable(h.sessionId);
  h.stt.recordFrames = true;
  h.stt.setDefaultScript({ final: "post button speech" });
  // 1. While IDLE, feed uniquely identifiable pre-button frames (marker 111).
  for (let i = 0; i < 5; i++) {
    h.capture.feedFrame(markedFrame(i, Date.now() + i * 20, 111));
  }
  assert.equal(h.app.voice.state, VoiceState.IDLE);
  const resetCountBefore = h.vad.resetCount;
  // 2. PTT start: the pre-button audio belongs to no PTT utterance.
  await h.app.voice.pttStart();
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  assert.ok(h.vad.resetCount > resetCountBefore, "PTT boundary must reset the VAD episode");
  // The boundary vad.reset() replays the script from the start, so the
  // speech_started boundary lands on the 6th post-PTT frame.
  h.vad.setScript(["silence", "silence", "silence", "silence", "silence", "speech", "speech", "end"]);
  // 3. Uniquely identifiable LISTENING frames captured AFTER the press.
  for (let i = 0; i < 5; i++) {
    h.capture.feedFrame(markedFrame(100 + i, Date.now() + 100 + i * 20, 222));
  }
  // 4. Trigger speech_started with one more post-PTT frame.
  h.capture.feedFrame(markedFrame(105, Date.now() + 200, 222));
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  await waitFor(() => h.stt.receivedFrames.length >= 6, 2000, "post-PTT frames to reach STT");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const received = h.stt.receivedFrames;
  // 5. STT receives ONLY frames captured after PTT start.
  assert.equal(received.length, 6, "exactly the 5 post-PTT pre-roll frames plus the started frame");
  assert.deepEqual(
    received.map((f) => f.sequence),
    [100, 101, 102, 103, 104, 105],
    "no pre-button frame may leak into the PTT utterance",
  );
  for (const frame of received) {
    const firstSample = new DataView(frame.data.buffer, frame.data.byteOffset, 2).getInt16(0, true);
    assert.equal(firstSample, 222, "received audio must be the post-button audio, not pre-button noise");
  }
  // 6. Post-PTT pre-roll arrives in FIFO order with no duplication.
  for (let i = 1; i < received.length; i++) {
    assert.equal((received[i] as PcmFrame).sequence - (received[i - 1] as PcmFrame).sequence, 1);
  }
  await h.app.voice.pttStop();
  await h.app.close();
});

test("wake-triggered listening keeps its pre-wake pre-roll (unchanged contract)", async () => {
  const h = await buildHarness();
  h.stt.recordFrames = true;
  h.stt.setDefaultScript({ final: "wake utterance" });
  // Pre-wake IDLE audio (marker 333) must be RETAINED for the wake utterance.
  for (let i = 0; i < 5; i++) {
    h.capture.feedFrame(markedFrame(i, Date.now() + i * 20, 333));
  }
  assert.equal(h.app.voice.state, VoiceState.IDLE);
  h.wake.triggerWake(Date.now());
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  h.vad.setScript(["silence", "silence", "speech", "speech", "end"]);
  h.capture.feedFrame(markedFrame(5, Date.now() + 100, 333));
  h.capture.feedFrame(markedFrame(6, Date.now() + 120, 333));
  h.capture.feedFrame(markedFrame(7, Date.now() + 140, 333));
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  await waitFor(() => h.stt.receivedFrames.length >= 8, 2000, "wake utterance frames to reach STT");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const received = h.stt.receivedFrames;
  assert.deepEqual(
    received.map((f) => f.sequence),
    [0, 1, 2, 3, 4, 5, 6, 7],
    "wake mode must keep the pre-wake pre-roll and stream it FIFO before the started frame",
  );
  for (const frame of received) {
    const firstSample = new DataView(frame.data.buffer, frame.data.byteOffset, 2).getInt16(0, true);
    assert.equal(firstSample, 333, "wake utterance audio includes the pre-wake window");
  }
  await h.app.close();
});

test("TASK-0024 Bug 1: provisional tool-round text is held from TTS and never spoken as final truth", async () => {
  // Live order: provisional text deltas arrive BEFORE the round's tool call.
  // The provisional sentence is long enough to cross a speakable boundary so
  // this test FAILS on the pre-fix code (which spoke it immediately).
  const PROVISIONAL = "I'll check that. Let me look at the repository state now. ";
  const FINAL = "The last commit is abc1234, fixing the voice loop.";
  let rounds = 0;
  let releaseFinal!: () => void;
  const finalGate = new Promise<void>((resolve) => {
    releaseFinal = resolve;
  });
  const h = await buildHarness({
    streamResponder: (async function* (_req: ModelRequest, signal?: AbortSignal) {
      rounds += 1;
      if (rounds === 1) {
        yield { type: "text_delta", text: PROVISIONAL };
        // Hold the round open briefly so any premature speech would surface.
        await new Promise((resolve) => setTimeout(resolve, 150));
        yield {
          type: "tool_call",
          call: { id: "tc-provisional", name: "system.echo", arguments: { text: "probe" } },
        };
        yield { type: "done", finish_reason: "tool_calls" };
      } else {
        // Follow-up round: hold open so the pre-completion TTS count is exact.
        yield { type: "text_delta", text: FINAL };
        await Promise.race([
          finalGate,
          new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
        if (signal?.aborted) return;
        yield { type: "done", finish_reason: "stop" };
      }
    }) as (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>,
  });
  h.stt.setDefaultScript({ final: "check the repository and tell me the last commit" });
  h.vad.setScript(["silence", "speech", "speech", "speech", "end"]);
  const t0 = Date.now();
  h.wake.triggerWake(t0);
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  feedUtterance(h, t0 + 40, 3);
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  h.capture.feedFrame(silenceFrame(10, t0 + 100));
  h.capture.feedFrame(silenceFrame(10, t0 + 120));
  // The tool round must complete with NO TTS before the follow-up round
  // completes: provisional text is UI-only.
  await waitFor(() => rounds >= 2, 4000, "tool round to complete and follow-up to start");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    h.events.some((e) => e.type === "assistant.text.delta" && e.text.includes("I'll check that")),
    "provisional text stays visible as a UI delta",
  );
  assert.equal(h.tts.requests.length, 0, "TTS chunks before round completion must be 0");
  // Full turn: the tool executes and only the final follow-up answer is spoken.
  releaseFinal();
  await waitFor(() => h.app.voice.state === VoiceState.IDLE);
  const spoken = h.tts.requests.map((r) => r.text).join(" ");
  assert.ok(rounds >= 2 && h.events.some((e) => e.type === "assistant.turn.completed"), "tool round + follow-up must run");
  assert.equal(h.tts.requests.length, 1, "final answer is spoken exactly once, got: " + spoken);
  assert.ok(spoken.includes("abc1234"), "final follow-up answer is spoken, got: " + spoken);
  assert.equal(
    spoken.includes("I'll check that"),
    false,
    "provisional tool-round text must never be spoken as final truth, got: " + spoken,
  );
  await h.app.close();
});

test("TASK-0024 Bug 3: failed continuation never promotes provisional text to final speech", async () => {
  // Round 1 is a tool round with provisional text; the round-2 continuation
  // fails like the live HTTP 400. Bounded fallback (tool summary) is the only
  // speech-eligible text; provisional text must never be spoken as final truth.
  const PROVISIONAL = "I'll check that. Let me look at the repository state now. ";
  let rounds = 0;
  const h = await buildHarness({
    streamResponder: (async function* () {
      rounds += 1;
      if (rounds === 1) {
        yield { type: "text_delta", text: PROVISIONAL };
        yield {
          type: "tool_call",
          call: { id: "tc-fallback", name: "system.echo", arguments: { text: "probe-summary" } },
        };
        yield { type: "done", finish_reason: "tool_calls" };
      } else {
        throw new Error("DeepSeek HTTP 400: Failed to parse the request body as JSON");
      }
    }) as (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>,
  });
  h.stt.setDefaultScript({ final: "check the repository and tell me the last commit" });
  h.vad.setScript(["silence", "speech", "speech", "speech", "end"]);
  const t0 = Date.now();
  h.wake.triggerWake(t0);
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  feedUtterance(h, t0 + 40, 3);
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  h.capture.feedFrame(silenceFrame(10, t0 + 100));
  h.capture.feedFrame(silenceFrame(10, t0 + 120));
  await waitFor(() => h.app.voice.state === VoiceState.IDLE);
  const completed = h.events.filter((e) => e.type === "assistant.turn.completed");
  assert.equal(completed.length, 1, "exactly one terminal turn event");
  assert.equal(completed[0]?.type === "assistant.turn.completed" ? completed[0].status : "", "completed");
  const spoken = h.tts.requests.map((r) => r.text).join(" ");
  assert.equal(spoken.includes("I'll check that"), false, "provisional text cannot qualify as final answer, got: " + spoken);
  assert.ok(spoken.includes("probe-summary"), "bounded fallback summary is spoken per contract, got: " + spoken);
  await h.app.close();
});

test("TASK-0024 Bug 3: failed first round yields no speech and no completed turn", async () => {
  const h = await buildHarness({
    streamResponder: (async function* () {
      throw new Error("DeepSeek HTTP 400: Failed to parse the request body as JSON");
    }) as (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>,
  });
  h.stt.setDefaultScript({ final: "check the repository" });
  h.vad.setScript(["silence", "speech", "speech", "speech", "end"]);
  const t0 = Date.now();
  h.wake.triggerWake(t0);
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING);
  feedUtterance(h, t0 + 40, 3);
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING);
  h.capture.feedFrame(silenceFrame(10, t0 + 100));
  h.capture.feedFrame(silenceFrame(10, t0 + 120));
  await waitFor(() => h.app.voice.state === VoiceState.IDLE);
  assert.equal(h.tts.requests.length, 0, "no valid final answer means no speech at all");
  assert.equal(
    h.events.filter((e) => e.type === "assistant.turn.completed").length,
    0,
    "a failed turn must not complete as a normal successful turn",
  );
  assert.ok(h.events.some((e) => e.type === "voice.error"), "failure surfaces as a voice error");
  await h.app.close();
});

