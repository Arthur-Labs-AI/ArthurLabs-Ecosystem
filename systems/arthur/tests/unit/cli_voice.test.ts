/**
 * DEV-VOICE-CLI-1: deterministic tests for the voice developer console.
 *
 * The voice command runs in-process over the real VoiceTurnController with
 * fake voice components and an injected line source, so no microphone, TTY,
 * child process, or network is involved. Letters reference the task
 * section 15 test matrix (A-T).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildApp } from "../../src/app";
import type { App } from "../../src/app";
import { ArthurError } from "../../src/core/errors/errors";
import { ArthurMode } from "../../src/core/modes/mode";
import { FakeProvider } from "../../src/models/providers/fake";
import type { ModelRequest, ModelStreamEvent } from "../../src/models/contracts";
import { FakeAudioCapture } from "../../src/voice/audio/capture";
import { FakeAudioPlayback } from "../../src/voice/audio/playback";
import { FakeWakeWordProvider } from "../../src/voice/wake/fake";
import { FakeVadProvider } from "../../src/voice/vad/fake";
import { FakeSttProvider } from "../../src/voice/stt/fake";
import { FakeTtsProvider } from "../../src/voice/tts/fake";
import { frameFromInt16, PcmFrame, VoiceErrorCode, VoiceState } from "../../src/voice/contracts";
import type { VoiceClientEvent } from "../../src/voice/events";
import {
  runTools,
  runAsk,
  runVoice,
  renderVoiceStartup,
  VoiceConsoleRenderer,
  type CliIO,
} from "../../apps/cli/index";
import { validTurn } from "../helpers";

// ---- fixtures ----------------------------------------------------------------

interface Harness {
  app: App;
  capture: FakeAudioCapture;
  playback: FakeAudioPlayback;
  wake: FakeWakeWordProvider;
  vad: FakeVadProvider;
  stt: FakeSttProvider;
  tts: FakeTtsProvider;
  source: LineSource;
  io: CliIO;
  out: () => string;
  err: () => string;
  sessionId: string;
}

/** Deterministic async line source standing in for the TTY. */
interface LineSource {
  lines: AsyncIterable<string>;
  push(line: string): void;
  end(): void;
}

function createLineSource(): LineSource {
  const queue: string[] = [];
  const waiters: Array<(value: IteratorResult<string>) => void> = [];
  let ended = false;
  const deliver = (line: string): void => {
    const waiter = waiters.shift();
    if (waiter) waiter({ value: line, done: false });
    else queue.push(line);
  };
  const finish = (): void => {
    ended = true;
    while (waiters.length > 0) waiters.shift()?.({ value: undefined as unknown as string, done: true });
  };
  return {
    lines: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            if (queue.length > 0) return { value: queue.shift() as string, done: false };
            if (ended) return { value: undefined as unknown as string, done: true };
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    },
    push: deliver,
    end: finish,
  };
}

function captureIo(): { io: CliIO; out: () => string; err: () => string } {
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  return {
    io: { out: (t) => outBuf.push(t), err: (t) => errBuf.push(t) },
    out: () => outBuf.join(""),
    err: () => errBuf.join(""),
  };
}

function silenceFrame(sequence: number, atMs: number): PcmFrame {
  return frameFromInt16(new Int16Array(320), sequence, atMs);
}

function speechFrame(sequence: number, atMs: number): PcmFrame {
  const samples = new Int16Array(320);
  samples.fill(3000);
  return frameFromInt16(samples, sequence, atMs);
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timeout waiting for " + what);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Build an offline App with the real voice controller wired to fake voice
 * components and a scripted provider; create a legitimate session through
 * the existing text path (handleTurn), as real users have one.
 */
async function buildHarness(opts: { mode?: ArthurMode } = {}): Promise<Harness> {
  const capture = new FakeAudioCapture();
  const playback = new FakeAudioPlayback(undefined, { delayPerChunkMs: 1 });
  const wake = new FakeWakeWordProvider();
  const vad = new FakeVadProvider();
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider();
  const app = buildTestVoiceApp({ capture, playback, wake, vad, stt, tts });
  const source = createLineSource();
  const io = captureIo();
  const first = await app.conversation.handleTurn(validTurn({ mode: opts.mode ?? "personal", message: "setup" }));
  return { app, capture, playback, wake, vad, stt, tts, source, io: io.io, out: io.out, err: io.err, sessionId: first.session_id };
}

function buildTestVoiceApp(voice: {
  capture: FakeAudioCapture;
  playback: FakeAudioPlayback;
  wake: FakeWakeWordProvider;
  vad: FakeVadProvider;
  stt: FakeSttProvider;
  tts: FakeTtsProvider;
}, provider?: FakeProvider, logLevel: "error" | "info" = "error"): App {
  return buildApp(
    {
      dbPath: ":memory:",
      modelProvider: "fake",
      logLevel,
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
      provider:
        provider ??
        new FakeProvider({
          streamResponder: (async function* () {
            yield { type: "text_delta", text: "Hello there!" };
            yield { type: "usage", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
            yield { type: "done", finish_reason: "stop" };
          }) as (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>,
        }),
      voice,
    },
  );
}

/** Start the voice console against a harness and wait for the banner. */
function startConsole(
  h: Harness,
  opts: { verbose?: boolean; mode?: ArthurMode; sessionId?: string; json?: boolean; newSession?: boolean } = {},
): Promise<number> {
  return runVoice(h.app, {
    mode: opts.mode ?? ArthurMode.PERSONAL,
    sessionId: opts.newSession ? undefined : opts.sessionId ?? h.sessionId,
    verbose: opts.verbose ?? false,
    json: opts.json,
    io: h.io,
    lines: h.source.lines,
  });
}

/** Drive a full wake -> utterance -> STT final flow like the controller tests. */
async function driveUtterance(h: Harness, transcript: string): Promise<void> {
  h.stt.setDefaultScript({ partials: ["how long "], final: transcript, language: "en", confidence: 0.9 });
  h.vad.setScript(["speech", "speech", "speech", "end"]);
  const t0 = Date.now();
  h.wake.triggerWake(t0);
  await waitFor(() => h.app.voice.state === VoiceState.LISTENING, 4000, "LISTENING");
  h.capture.feedFrame(speechFrame(1, t0 + 40));
  h.capture.feedFrame(speechFrame(2, t0 + 60));
  h.capture.feedFrame(speechFrame(3, t0 + 80));
  await waitFor(() => h.app.voice.state === VoiceState.CAPTURING, 4000, "CAPTURING");
  h.capture.feedFrame(silenceFrame(4, t0 + 100));
  h.capture.feedFrame(silenceFrame(5, t0 + 120));
}

// ---- A: legitimate new session when --session omitted ------------------------

test("A: voice command creates a legitimate new session when --session omitted", async () => {
  const h = await buildHarness();
  try {
    const runPromise = startConsole(h, { newSession: true });
    // Wait for the banner, then read the printed session id.
    await waitFor(() => h.out().includes("Session: "), 4000, "banner");
    const sessionId = (h.out().match(/Session: ([0-9a-f-]+)/) ?? [])[1];
    assert.ok(sessionId, "banner prints a session id");
    const session = await h.app.conversation.getSession(sessionId);
    assert.equal(session.mode, "personal", "the session really exists in the requested mode");
    h.source.end();
    const code = await runPromise;
    assert.equal(code, 0);
  } finally {
    h.app.close();
  }
});

// ---- B: supplied valid session is reused --------------------------------------

test("B: supplied valid session is reused (no new session created)", async () => {
  const h = await buildHarness();
  try {
    const runPromise = startConsole(h);
    await waitFor(() => h.out().includes("Session: " + h.sessionId), 4000, "banner session id");
    assert.equal(h.app.voice.sessionId, h.sessionId);
    h.source.end();
    await runPromise;
  } finally {
    h.app.close();
  }
});

// ---- C: wrong mode fails closed ------------------------------------------------

test("C: supplied session with wrong mode fails closed without enabling voice", async () => {
  const h = await buildHarness();
  try {
    await assert.rejects(
      () => startConsole(h, { mode: ArthurMode.BUSINESS }),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
    assert.equal(h.capture.startCount, 0, "voice must never enable on a mode mismatch");
    assert.equal(h.wake.startCount, 0);
  } finally {
    h.app.close();
  }
});

// ---- D: enable() is used -------------------------------------------------------

test("D: voice console enables the existing VoiceTurnController (no second pipeline)", async () => {
  const h = await buildHarness();
  try {
    const runPromise = startConsole(h);
    await waitFor(() => h.capture.startCount === 1, 4000, "capture started");
    assert.equal(h.wake.startCount, 1, "wake detector started through the controller");
    h.source.end();
    await runPromise;
  } finally {
    h.app.close();
  }
});

// ---- E: wake.detected renders ---------------------------------------------------

test("E: wake.detected renders the wake line", async () => {
  const h = await buildHarness();
  try {
    const runPromise = startConsole(h);
    await waitFor(() => h.out().includes("Wake: READY"), 4000, "wake ready banner");
    h.wake.triggerWake(Date.now());
    await waitFor(() => h.out().includes("[wake] Arthur"), 4000, "wake line");
    h.source.end();
    await runPromise;
  } finally {
    h.app.close();
  }
});

// ---- F/G/H/O: full utterance rendering ------------------------------------------

test("F/G/H/O: utterance renders transcript, assistant answer, speech markers, no raw audio", async () => {
  const h = await buildHarness();
  try {
    const runPromise = startConsole(h);
    await waitFor(() => h.out().includes("Wake: READY"), 4000, "wake ready banner");
    await driveUtterance(h, "arthur set a reminder");
    await waitFor(() => h.out().includes("you> arthur set a reminder"), 4000, "transcript line");
    await waitFor(() => h.out().includes("arthur> Hello there!"), 4000, "assistant answer line");
    await waitFor(() => h.out().includes("[speaking]"), 4000, "speech started marker");
    await waitFor(() => h.out().includes("[speaking done]"), 4000, "speech ended marker");
    h.source.end();
    await runPromise;
    const out = h.out();
    // No raw audio or buffers are ever printed.
    assert.equal(out.toLowerCase().includes("int16array"), false);
    assert.equal(out.toLowerCase().includes("pcm"), false);
    assert.equal(out.toLowerCase().includes("dataview"), false);
  } finally {
    h.app.close();
  }
});

// ---- I: voice.error rendered safely ----------------------------------------------

test("I: voice.error renders the sanitized message without stack traces", () => {
  const io = captureIo();
  const renderer = new VoiceConsoleRenderer(io.io, false);
  renderer.onEvent({
    type: "voice.error",
    code: VoiceErrorCode.AUDIO_INPUT_UNAVAILABLE,
    message: "No usable microphone; voice stays disabled, text path is unaffected",
    component: "capture",
    ts: new Date().toISOString(),
  });
  assert.ok(io.err().includes("[voice error] No usable microphone"));
  assert.equal(io.err().includes("    at "), false, "no stack traces");
});

// ---- J: approval.required without token material ----------------------------------

test("J: approval.required renders tool name and id, never token/signature material", () => {
  const io = captureIo();
  const renderer = new VoiceConsoleRenderer(io.io, true);
  renderer.onEvent({
    type: "approval.required",
    approval_id: "appr-123",
    tool_name: "harness.create_job",
    session_id: "s1",
    pending_count: 1,
    ts: new Date().toISOString(),
  });
  const out = io.out();
  assert.ok(out.includes("[approval required]"));
  assert.ok(out.includes("Tool: harness.create_job"));
  assert.ok(out.includes("Approval ID: appr-123"));
  assert.equal(out.includes("signature"), false);
  assert.equal(out.toLowerCase().includes("token"), false);
  assert.equal(out.toLowerCase().includes("hmac"), false);
});

// ---- K/L: Enter toggles PTT deterministically --------------------------------------

test("K/L: repeated Enter alternates pttStart/pttStop deterministically", async () => {
  const h = await buildHarness();
  try {
    const runPromise = startConsole(h);
    await waitFor(() => h.out().includes("Wake: READY"), 4000, "wake ready banner");
    h.source.push("");
    await waitFor(() => h.app.voice.state === VoiceState.LISTENING, 4000, "ptt start");
    h.source.push("");
    await waitFor(() => h.app.voice.state === VoiceState.IDLE, 4000, "ptt stop");
    h.source.push("");
    await waitFor(() => h.app.voice.state === VoiceState.LISTENING, 4000, "ptt start again");
    h.source.push("");
    await waitFor(() => h.app.voice.state === VoiceState.IDLE, 4000, "ptt stop again");
    h.source.end();
    await runPromise;
    const pttLines = h.out().match(/\[ptt\] (START|STOP)/g) ?? [];
    assert.deepEqual(pttLines, ["[ptt] START", "[ptt] STOP", "[ptt] START", "[ptt] STOP"]);
    assert.equal(h.capture.startCount, 1, "capture runs once; PTT toggles the listening gate");
  } finally {
    h.app.close();
  }
});

// ---- M/N: shutdown exactly once, repeated shutdown safe ----------------------------

test("M: shutdown request calls disable exactly once logically", async () => {
  const h = await buildHarness();
  try {
    let requestShutdown: () => void = () => undefined;
    const shutdownRequested = new Promise<void>((resolve) => {
      requestShutdown = resolve;
    });
    const runPromise = runVoice(h.app, {
      mode: ArthurMode.PERSONAL,
      sessionId: h.sessionId,
      io: h.io,
      lines: h.source.lines,
      requestShutdown: () => shutdownRequested,
    });
    await waitFor(() => h.out().includes("Session: "), 4000, "banner");
    requestShutdown();
    const code = await runPromise;
    assert.equal(code, 0);
    assert.equal(h.capture.stopCount, 1, "microphone stopped exactly once");
    assert.equal(h.wake.stopCount, 1, "wake detector stopped exactly once");
  } finally {
    h.app.close();
  }
});

test("N: repeated shutdown remains safe", async () => {
  const h = await buildHarness();
  try {
    const runPromise = startConsole(h);
    await waitFor(() => h.out().includes("Session: "), 4000, "banner");
    h.source.end();
    await runPromise;
    const stopsAfterConsole = h.capture.stopCount;
    await h.app.voice.disable();
    await h.app.voice.disable();
    h.app.close();
    assert.equal(h.capture.stopCount, stopsAfterConsole, "stop is idempotent");
  } finally {
    // close() already ran; nothing more to release.
  }
});

// ---- P/Q: no direct provider or tool access from the voice CLI ---------------------

test("P/Q: voice CLI has no direct model provider, tool, or store access", () => {
  const raw = readFileSync(resolve(__dirname, "..", "..", "..", "apps", "cli", "index.ts"), "utf8");
  // Scan CODE, not comments: the file header documents the mandatory data
  // flow (including ToolExecutionService) that the CLI must NOT bypass.
  const source = raw
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
  for (const forbidden of ["ToolRegistry", "ToolExecutionService", "SessionStore", "DeepSeekProvider", "ModelGateway", "NodeLocalSystemAdapter"]) {
    assert.equal(source.includes(forbidden), false, "CLI must not reference " + forbidden);
  }
  assert.equal(/gateway\.(generate|generateStream)\(/.test(source), false, "CLI never invokes the model provider directly");
  assert.equal(/\.execute\(/.test(source), false, "CLI never executes tools directly");
  for (const bypass of ["--unsafe", "--force", "--skip-approval", "--raw-audio", "--raw-provider", "--execute-tool"]) {
    assert.equal(source.includes(bypass), false, "no bypass flag " + bypass);
  }
});

// ---- R: existing text commands unchanged -------------------------------------------

test("R: existing text CLI commands keep working (tools + ask)", async () => {
  const app = buildTestVoiceApp({
    capture: new FakeAudioCapture(),
    playback: new FakeAudioPlayback(),
    wake: new FakeWakeWordProvider(),
    vad: new FakeVadProvider(),
    stt: new FakeSttProvider(),
    tts: new FakeTtsProvider(),
  });
  try {
    assert.equal(runTools(app, { json: true, io: { out: () => undefined, err: () => undefined } }), 0);
    const io = captureIo();
    const code = await runAsk(app, { mode: "personal", message: "hello", io: io.io });
    assert.equal(code, 0);
    assert.ok(io.out().includes("fake:hello"));
  } finally {
    app.close();
  }
});

// ---- S/T: idle shutdown quiet, active voice lifecycle logged ------------------------

test("S: non-voice CLI commands emit no idle voice shutdown INFO spam", async () => {
  const app = buildApp(
    {
      dbPath: ":memory:",
      modelProvider: "fake",
      logLevel: "info",
      approvalTtlSeconds: 300,
      memoryPersonalDbPath: ":memory:",
      memoryBusinessDbPath: ":memory:",
      embeddingProvider: "fake",
    },
    {},
  );
  const chunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    assert.equal(runTools(app, { json: true, io: { out: () => undefined, err: () => undefined } }), 0);
    const io = captureIo();
    await runAsk(app, { mode: "personal", message: "hello", io: io.io });
    app.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.stderr.write = originalWrite;
  }
  const stderr = chunks.join("");
  assert.equal(stderr.includes("voice turn cancelled"), false, "no idle cancel log");
  assert.equal(stderr.includes("voice disabled"), false, "no idle disable log");
  assert.equal(stderr.includes("voice controller closed"), false, "no idle close log");
});

test("T: an actually enabled voice controller still logs its real lifecycle", async () => {
  const capture = new FakeAudioCapture();
  const playback = new FakeAudioPlayback(undefined, { delayPerChunkMs: 1 });
  const wake = new FakeWakeWordProvider();
  const vad = new FakeVadProvider();
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider();
  const app = buildTestVoiceApp({ capture, playback, wake, vad, stt, tts }, undefined, "info");
  const chunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const session = await app.conversation.handleTurn(validTurn({ message: "setup" }));
    await app.voice.enable(session.session_id);
    await app.voice.disable();
    await app.close();
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    process.stderr.write = originalWrite;
  }
  const stderr = chunks.join("");
  assert.ok(stderr.includes("voice disabled"), "disable lifecycle logged for an active controller");
  assert.ok(stderr.includes("voice controller closed"), "close lifecycle logged for an active controller");
});

// ---- startup banner + --json ---------------------------------------------------------

test("startup banner derives state from controller status (no hardcoded READY)", () => {
  const banner = renderVoiceStartup(
    {
      wake_word: "arthur",
      wake: { available: false },
      audio_input: { available: false },
      tts: { available: true },
    } as unknown as Parameters<typeof renderVoiceStartup>[0],
    { mode: ArthurMode.BUSINESS, sessionId: "s-1", verbose: false },
  );
  assert.ok(banner.includes("Mode: BUSINESS"));
  assert.ok(banner.includes("Session: s-1"));
  assert.ok(banner.includes("Wake: UNAVAILABLE"));
  assert.ok(banner.includes("Microphone: UNAVAILABLE"));
  assert.ok(banner.includes("TTS: READY"));
});

test("--json on the voice command fails cleanly with INVALID_REQUEST", async () => {
  const h = await buildHarness();
  try {
    await assert.rejects(
      () => startConsole(h, { json: true }),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
    assert.equal(h.capture.startCount, 0);
  } finally {
    h.app.close();
  }
});

