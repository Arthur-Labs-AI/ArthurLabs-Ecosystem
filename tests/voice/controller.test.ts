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
} = {}): Promise<Harness> {
  const capture = new FakeAudioCapture();
  const playback = new FakeAudioPlayback(undefined, { delayPerChunkMs: 25 });
  const wake = new FakeWakeWordProvider();
  const vad = new FakeVadProvider();
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

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
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
test("barge-in interrupts speech, cancels the model stream, and persists an interrupted turn", async () => {
  let releaseStream!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  const h = await buildHarness({
    streamResponder: (async function* (_req: ModelRequest, signal?: AbortSignal) {
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
  // ARTHUR starts speaking the partial answer.
  await waitFor(() => h.app.voice.state === VoiceState.SPEAKING);
  assert.equal(h.playback.stopRequested, false);
  // User talks over ARTHUR while playback is still active: sustained
  // speech_started runs (>= 3) while SPEAKING trigger the barge-in.
  h.vad.setScript(["silence", "speech", "speech", "speech", "speech", "speech"]);
  feedUtterance(h, Date.now(), 6);
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING || h.app.voice.state === VoiceState.CAPTURING);
  assert.ok(
    h.events.some((e) => e.type === "voice.error" && e.code === VoiceErrorCode.VOICE_CANCELLED),
    "barge-in must surface VOICE_CANCELLED",
  );
  await waitFor(() => h.playback.stopRequested, 2000);
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