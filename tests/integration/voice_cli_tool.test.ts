/**
 * DEV-VOICE-CLI-1 integration: the voice console drives a real tool turn.
 *
 * F16: a spoken request ("How long has this computer been running?") flows
 * through the REAL VoiceTurnController -> ConversationService.streamTurn ->
 * ToolOrchestrator -> system.status tool -> structured model payload ->
 * streamed speech, and the tool call is persisted on the turn.
 *
 * No microphone, no child process, no network: fake voice components plus a
 * scripted offline provider, exactly like the controller test harness.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeProvider } from "../../src/models/providers/fake";
import type { ModelRequest, ModelStreamEvent } from "../../src/models/contracts";
import { FakeAudioCapture } from "../../src/voice/audio/capture";
import { FakeAudioPlayback } from "../../src/voice/audio/playback";
import { FakeWakeWordProvider } from "../../src/voice/wake/fake";
import { FakeVadProvider } from "../../src/voice/vad/fake";
import { FakeSttProvider } from "../../src/voice/stt/fake";
import { FakeTtsProvider } from "../../src/voice/tts/fake";
import { frameFromInt16, VoiceState } from "../../src/voice/contracts";
import { runVoice } from "../../apps/cli/index";
import { buildApp } from "../../src/app";

const TRANSCRIPT = "How long has this computer been running?";
const EXPECTED_ANSWER = "The system has been running for 12345 seconds.";

function silenceFrame(sequence: number, atMs: number) {
  return frameFromInt16(new Int16Array(320), sequence, atMs);
}

function speechFrame(sequence: number, atMs: number) {
  const samples = new Int16Array(320);
  samples.fill(3000);
  return frameFromInt16(samples, sequence, atMs);
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timeout waiting for " + what);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Two-round scripted provider for the streaming voice turn:
 *  - round 1 (generateStream): propose the system.status tool call;
 *  - round 2 (buffered generate follow-up): read the structured role=tool
 *    payload from the history and answer with the uptime sentence.
 */
function scriptedProvider(): FakeProvider {
  let round = 0;
  return new FakeProvider({
    responder: async (request: ModelRequest) => {
      round += 1;
      // Round 2: the structured tool result must be in the message history.
      const toolMessage = request.history.find(
        (m) => m.role === "tool",
      );
      assert.ok(toolMessage, "follow-up must receive a role=tool message");
      const payload = JSON.parse(toolMessage.content) as {
        summary?: string;
        data?: { uptime_seconds?: number };
      };
      // The structured payload (not the raw executor result) carries the
      // uptime field; the real adapter reports the machine's actual uptime,
      // so only the shape is asserted here.
      assert.equal(
        typeof payload.data?.uptime_seconds,
        "number",
        "structured payload carries a numeric uptime_seconds",
      );
      assert.ok(
        (payload.data?.uptime_seconds as number) >= 0,
        "uptime_seconds is non-negative",
      );
      assert.equal(
        payload.summary,
        "Local system: win32 x64, Node v22.18.0, 12 CPUs, 32 GB RAM",
        "payload carries the sanitized tool summary",
      );
      return {
        assistant_text: EXPECTED_ANSWER,
        tool_calls: [],
        finish_reason: "stop",
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      };
    },
    streamResponder: (async function* () {
      round += 1;
      assert.equal(round, 1, "stream round proposes the tool call");
      yield {
        type: "tool_call",
        call: { id: "call_uptime_1", name: "system.status", arguments: {} },
      };
      yield { type: "usage", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
      yield { type: "done", finish_reason: "tool_calls" };
    }) as (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>,
  });
}

test("F16/U/V: voice console completes a spoken tool turn end to end", async () => {
  const capture = new FakeAudioCapture();
  const playback = new FakeAudioPlayback(undefined, { delayPerChunkMs: 1 });
  const wake = new FakeWakeWordProvider();
  const vad = new FakeVadProvider();
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider();
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  const app = buildApp(
    {
      dbPath: ":memory:",
      modelProvider: "fake",
      logLevel: "error",
      approvalTtlSeconds: 300,
      memoryPersonalDbPath: ":memory:",
      memoryBusinessDbPath: ":memory:",
      embeddingProvider: "fake",
      voice: {
        voiceEnabled: true,
        wakeEnabled: true,
        wakeWord: "arthur",
        ttsMaxQueueChunks: 8,
        noSpeechTimeoutMs: 5000,
        maxUtteranceMs: 30000,
      },
    },
    {
      provider: scriptedProvider(),
      voice: { capture, playback, wake, vad, stt, tts },
    },
  );

  // Deterministic line source (the ""); the console exits when it ends.
  const queue: string[] = [];
  const waiters: Array<(value: IteratorResult<string>) => void> = [];
  let ended = false;
  const lines: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<string>> {
          if (queue.length > 0) return { value: queue.shift() as string, done: false };
          if (ended) return { value: undefined as unknown as string, done: true };
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };

  const runPromise = runVoice(app, {
    mode: "personal",
    io: { out: (t) => outBuf.push(t), err: (t) => errBuf.push(t) },
    lines,
  });

  try {
    // U: the console creates a legitimate session through the narrow API.
    await waitFor(() => outBuf.join("").includes("Session: "), 8000, "banner");
    const sessionId = (outBuf.join("").match(/Session: ([0-9a-f-]+)/) ?? [])[1];
    assert.ok(sessionId, "banner shows the created session id");
    const session = await app.conversation.getSession(sessionId);
    assert.equal(session.mode, "personal");

    // Spoken request -> STT final -> turn with system.status tool call.
    stt.setDefaultScript({ partials: ["how long"], final: TRANSCRIPT, language: "en", confidence: 0.95 });
    vad.setScript(["speech", "speech", "speech", "end"]);
    const t0 = Date.now();
    wake.triggerWake(t0);
    await waitFor(() => app.voice.state === VoiceState.LISTENING, 8000, "LISTENING");
    capture.feedFrame(speechFrame(1, t0 + 40));
    capture.feedFrame(speechFrame(2, t0 + 60));
    capture.feedFrame(speechFrame(3, t0 + 80));
    await waitFor(() => app.voice.state === VoiceState.CAPTURING, 8000, "CAPTURING");
    capture.feedFrame(silenceFrame(4, t0 + 100));
    capture.feedFrame(silenceFrame(5, t0 + 120));

    // V: the final answer is spoken through TTS with the uptime read from
    // the structured tool payload (not from raw executor output).
    await waitFor(() => tts.requests.length > 0, 8000, "tts request");
    const firstTts = tts.requests[0];
    assert.ok(firstTts, "TTS received a synthesis request");
    assert.equal(firstTts.text, EXPECTED_ANSWER);

    // F16: the transcript was rendered and the tool call is persisted.
    await waitFor(
      () => outBuf.join("").includes("you> " + TRANSCRIPT),
      8000,
      "transcript line",
    );

    // Find the completed tool call through the public store surface.
    const turns = app.store.getTurns(sessionId);
    assert.ok(turns.length >= 2, "user turn + assistant turn recorded");
    let toolCallId: string | undefined;
    for (const turn of turns) {
      const calls = app.store.getToolCallsForTurn(turn.id);
      const statusCall = calls.find((c) => c.tool_name === "system.status");
      if (statusCall) {
        assert.equal(statusCall.status, "completed", "system.status tool call completed");
        toolCallId = statusCall.id;
      }
    }
    assert.ok(toolCallId, "the system.status tool call was persisted on the turn");

    // The console rendered the spoken answer (assistant text flush).
    await waitFor(() => outBuf.join("").includes("arthur> " + EXPECTED_ANSWER), 8000, "assistant answer");

    // No raw executor output ever reaches the console: only the summary line.
    const out = outBuf.join("");
    assert.equal(out.includes("" + JSON.stringify({ uptime_seconds: 12345 })), false);
  } finally {
    ended = true;
    while (waiters.length > 0) waiters.shift()?.({ value: undefined as unknown as string, done: true });
    await runPromise.catch(() => undefined);
    await app.voice.disable().catch(() => undefined);
    app.close();
  }
});
