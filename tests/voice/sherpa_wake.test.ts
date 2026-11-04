/**
 * Deterministic tests for the True Wake Word v1 provider (TASK-0009).
 *
 * The native sherpa-onnx addon and real ONNX models are NOT required here:
 * every engine interaction goes through the injectable SherpaKwsEngine
 * factory. The opt-in native integration test lives in
 * sherpa_wake.native.test.ts and is guarded by an env flag.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_DECODES_PER_FRAME,
  SherpaWakeWordProvider,
  normalizeKeywordText,
  resolveSherpaModelFiles,
} from "../../src/voice/wake/sherpa_provider";
import type { SherpaKwsEngine, SherpaKwsResult, SherpaKwsStream } from "../../src/voice/wake/sherpa_provider";
import { WakeWordGateway } from "../../src/voice/wake/gateway";
import { frameFromInt16 } from "../../src/voice/contracts";
import type { PcmFrame, WakeEvent, WakeWordConfig } from "../../src/voice/contracts";
import { VoiceErrorCode, VoiceState } from "../../src/voice/contracts";
import { DEFAULT_VOICE_SETTINGS, loadVoiceSettings, validateVoiceSettings } from "../../src/voice/config";
import { buildTestApp, validTurn } from "../helpers";
import { FakeAudioCapture } from "../../src/voice/audio/capture";
import type { VoiceClientEvent } from "../../src/voice/events";

// ---------------------------------------------------------------------------
// Deterministic KWS engine fake
// ---------------------------------------------------------------------------

class FakeKwsStream implements SherpaKwsStream {
  /** Retained ONLY by the fake (for assertions); the provider never keeps these. */
  readonly accepted: Float32Array[] = [];
  readonly rates: number[] = [];

  constructor(private readonly engine: FakeKwsEngine) {}

  acceptWaveform(samples: Float32Array, sampleRateHz: number): void {
    this.rates.push(sampleRateHz);
    this.accepted.push(samples);
    this.engine.acceptedCount += 1;
  }
}

class FakeKwsEngine implements SherpaKwsEngine {
  decodeCount = 0;
  resetCount = 0;
  releasedStreams = 0;
  released = 0;
  acceptedCount = 0;
  /** Like the real engine: ready while undecoded audio is buffered. */
  ready = false;
  result: SherpaKwsResult | undefined;

  constructor(readonly config: unknown) {}

  createStream(): SherpaKwsStream {
    return new FakeKwsStream(this);
  }
  isReady(_stream: SherpaKwsStream): boolean {
    return this.ready;
  }
  /** One decode consumes the pending chunk (mirrors the real API). */
  decode(_stream: SherpaKwsStream): void {
    this.decodeCount += 1;
    this.ready = false;
  }
  getResult(_stream: SherpaKwsStream): SherpaKwsResult {
    return this.result ?? {};
  }
  reset(_stream: SherpaKwsStream): void {
    this.resetCount += 1;
    this.ready = false;
  }
  releaseStream(_stream: SherpaKwsStream): void {
    this.releasedStreams += 1;
  }
  release(): void {
    this.released += 1;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ProviderHandle {
  provider: SherpaWakeWordProvider;
  /** Set once start() created the engine (the factory runs inside start). */
  holder: { current?: FakeKwsEngine };
  events: WakeEvent[];
  engine(): FakeKwsEngine;
  /** Stop the provider and remove its temp model directory. */
  dispose(): Promise<void>;
}

function makeProvider(opts: {
  keywordsScore?: number;
  keywordsThreshold?: number;
  numThreads?: number;
  modelDir?: string;
} = {}): ProviderHandle {
  const holder: { current?: FakeKwsEngine } = {};
  // The provider always gates on real model files before building the
  // engine, so tests run against a deterministic temp model directory.
  const modelDir = opts.modelDir ?? makeTempModelDir();
  const provider = new SherpaWakeWordProvider({
    modelDir,
    keywordsScore: opts.keywordsScore ?? 1,
    keywordsThreshold: opts.keywordsThreshold ?? 0.25,
    numThreads: opts.numThreads ?? 1,
    engineFactory: (config) => {
      const engine = new FakeKwsEngine(config);
      holder.current = engine;
      return engine;
    },
  });
  const events: WakeEvent[] = [];
  return {
    provider,
    holder,
    events,
    engine(): FakeKwsEngine {
      if (!holder.current) throw new Error("engine not created yet");
      return holder.current;
    },
    async dispose(): Promise<void> {
      await provider.stop();
      rmSync(modelDir, { recursive: true, force: true });
    },
  };
}

async function startedProvider(keyword = "arthur"): Promise<ProviderHandle> {
  const handle = makeProvider();
  await handle.provider.start(wakeConfig({ wakeWord: keyword }), (event) => handle.events.push(event));
  return handle;
}

function wakeConfig(overrides: Partial<WakeWordConfig> = {}): WakeWordConfig {
  return { wakeWord: "arthur", sampleRateHz: 16000, frameDurationMs: 20, preRollMs: 400, threshold: 0.6, ...overrides };
}

function frame(sequence: number, atMs: number): PcmFrame {
  return frameFromInt16(new Int16Array(320), sequence, atMs);
}

function int16Frame(sequence: number, atMs: number, values: number[]): PcmFrame {
  const samples = new Int16Array(320);
  values.forEach((v, i) => {
    samples[i] = v;
  });
  return frameFromInt16(samples, sequence, atMs);
}

/** A frame containing EXACTLY the given samples (no zero padding). */
function exactFrame(sequence: number, atMs: number, values: number[]): PcmFrame {
  return frameFromInt16(Int16Array.from(values), sequence, atMs);
}

/** Build a temp model dir that passes resolveSherpaModelFiles(). */
function makeTempModelDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "arthur-kws-"));
  for (const name of [
    "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
    "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
    "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
    "tokens.txt",
    "keywords_arthur.txt",
  ]) {
    writeFileSync(join(dir, name), "placeholder");
  }
  return dir;
}

// ---------------------------------------------------------------------------
// A/B/C - provider selection via configuration
// ---------------------------------------------------------------------------

test("A: ARTHUR_WAKE_PROVIDER=sherpa selects the sherpa-kws-wake provider through the app", () => {
  const modelDir = makeTempModelDir();
  try {
    const app = buildTestApp({ voice: { wakeProvider: "sherpa", wakeModelDir: modelDir } });
    try {
      const status = app.voice.status();
      assert.equal(status.wake.id, "sherpa-kws-wake");
      // Files exist and the pinned sherpa-onnx-node package resolves.
      assert.equal(status.wake.available, true);
      // No machine paths or file names ever leak through status.
      const statusJson = JSON.stringify(status);
      assert.ok(!statusJson.includes("arthur-kws-"), "temp model dir must not leak");
      assert.ok(!statusJson.includes("encoder-epoch"), "model file names must not leak");
    } finally {
      app.close();
    }
  } finally {
    rmSync(modelDir, { recursive: true, force: true });
  }
});

test("B: the default/local wake provider still selects the energy detector", () => {
  const app = buildTestApp();
  try {
    const status = app.voice.status();
    assert.equal(status.wake.id, "local-energy-wake");
    assert.equal(status.wake.available, true);
  } finally {
    app.close();
  }
});

test("C: the fake wake provider still works for deterministic tests", () => {
  const app = buildTestApp({ voice: { wakeProvider: "fake" } });
  try {
    assert.equal(app.voice.status().wake.id, "fake-wake");
  } finally {
    app.close();
  }
});

test("wake provider ids stay separated: wake accepts sherpa, vad/stt/tts do not", () => {
  assert.deepEqual(validateVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, wakeProvider: "sherpa" }), []);
  const badVad = validateVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, vadProvider: "sherpa" as unknown as "local" });
  assert.equal(badVad.length, 1);
  assert.ok(badVad[0]?.includes("ARTHUR_VAD_PROVIDER"));
  const badWake = validateVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, wakeProvider: "nope" as unknown as "local" });
  assert.equal(badWake.length, 1);
  assert.ok(badWake[0]?.includes("ARTHUR_WAKE_PROVIDER"));
});

// ---------------------------------------------------------------------------
// Sherpa tuning validation + env mapping
// ---------------------------------------------------------------------------

test("sherpa tuning validation: score/threshold/threads finite and bounded", () => {
  const base = { ...DEFAULT_VOICE_SETTINGS, wakeProvider: "sherpa" as const };
  assert.deepEqual(validateVoiceSettings({ ...base, wakeKeywordsScore: 1, wakeKeywordsThreshold: 0.25, wakeNumThreads: 1 }), []);
  const cases: Array<[Record<string, number>, string]> = [
    [{ wakeKeywordsScore: Number.NaN }, "ARTHUR_WAKE_KEYWORDS_SCORE"],
    [{ wakeKeywordsScore: 0 }, "ARTHUR_WAKE_KEYWORDS_SCORE"],
    [{ wakeKeywordsScore: 50 }, "ARTHUR_WAKE_KEYWORDS_SCORE"],
    [{ wakeKeywordsThreshold: 0 }, "ARTHUR_WAKE_KEYWORDS_THRESHOLD"],
    [{ wakeKeywordsThreshold: 1.5 }, "ARTHUR_WAKE_KEYWORDS_THRESHOLD"],
    [{ wakeNumThreads: 0 }, "ARTHUR_WAKE_NUM_THREADS"],
    [{ wakeNumThreads: 99 }, "ARTHUR_WAKE_NUM_THREADS"],
    [{ wakeNumThreads: Number.NaN }, "ARTHUR_WAKE_NUM_THREADS"],
  ];
  for (const [overrides, expectedKey] of cases) {
    const problems = validateVoiceSettings({ ...base, ...overrides });
    assert.equal(problems.length, 1, JSON.stringify(overrides));
    assert.ok(problems[0]?.includes(expectedKey));
  }
  // Tuning bounds are not enforced for other wake providers.
  assert.deepEqual(validateVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, wakeProvider: "local" }), []);
});

test("wake env variables map into VoiceSettings with documented defaults", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "ARTHUR_WAKE_MODEL_DIR",
    "ARTHUR_WAKE_KEYWORDS_FILE",
    "ARTHUR_WAKE_KEYWORDS_SCORE",
    "ARTHUR_WAKE_KEYWORDS_THRESHOLD",
    "ARTHUR_WAKE_NUM_THREADS",
  ];
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    const defaults = loadVoiceSettings();
    assert.equal(defaults.wakeModelDir, "models/wake/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01");
    assert.equal(defaults.wakeKeywordsFile, "");
    assert.equal(defaults.wakeKeywordsScore, 1);
    assert.equal(defaults.wakeKeywordsThreshold, 0.25);
    assert.equal(defaults.wakeNumThreads, 1);
    process.env.ARTHUR_WAKE_MODEL_DIR = "models/wake/custom";
    process.env.ARTHUR_WAKE_KEYWORDS_FILE = "models/wake/custom/kw.txt";
    process.env.ARTHUR_WAKE_KEYWORDS_SCORE = "1.5";
    process.env.ARTHUR_WAKE_KEYWORDS_THRESHOLD = "0.4";
    process.env.ARTHUR_WAKE_NUM_THREADS = "2";
    const fromEnv = loadVoiceSettings();
    assert.equal(fromEnv.wakeModelDir, "models/wake/custom");
    assert.equal(fromEnv.wakeKeywordsFile, "models/wake/custom/kw.txt");
    assert.equal(fromEnv.wakeKeywordsScore, 1.5);
    assert.equal(fromEnv.wakeKeywordsThreshold, 0.4);
    assert.equal(fromEnv.wakeNumThreads, 2);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
  }
});

// ---------------------------------------------------------------------------
// Model file resolution
// ---------------------------------------------------------------------------

test("model resolution prefers INT8 files and defaults the keywords file", () => {
  const dir = makeTempModelDir();
  try {
    const files = resolveSherpaModelFiles(dir, "");
    assert.ok(files);
    assert.ok(files.encoderPath.includes("encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"));
    assert.ok(files.decoderPath.includes("decoder-epoch-12-avg-2-chunk-16-left-64.onnx"));
    assert.ok(files.joinerPath.includes("joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"));
    assert.equal(files.usedInt8, true);
    assert.ok(files.keywordsFile.endsWith("keywords_arthur.txt"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("model resolution fails closed on missing directory or files", () => {
  assert.equal(resolveSherpaModelFiles("D:\\definitely-not-a-real-dir-arthur", ""), null);
  const dir = mkdtempSync(join(tmpdir(), "arthur-kws-empty-"));
  try {
    assert.equal(resolveSherpaModelFiles(dir, ""), null, "empty dir has no model files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D - PCM conversion (int16 -> float32, frame boundaries)
// ---------------------------------------------------------------------------

test("D: s16le PCM converts to normalized float32 (-32768 ~ -1, 0 = 0, 32767 ~ 0.99997)", async () => {
  const handle = await startedProvider();
  const engine = handle.engine();
  handle.provider.processFrame(int16Frame(0, 0, [-32768, 0, 32767]));
  assert.equal(engine.acceptedCount, 1, "one frame accepted");
  await handle.dispose();
});

test("D (exact values): accepted samples carry exact normalized values", async () => {
  const accepted: Float32Array[] = [];
  let lastRate = 0;
  const modelDir = makeTempModelDir();
  try {
  const provider = new SherpaWakeWordProvider({
    modelDir,
    keywordsScore: 1,
    keywordsThreshold: 0.25,
    numThreads: 1,
    engineFactory: () => ({
      createStream: () => ({
        acceptWaveform: (samples: Float32Array, rate: number) => {
          accepted.push(samples);
          lastRate = rate;
        },
      }),
      isReady: () => false,
      decode: () => undefined,
      getResult: () => ({}),
      reset: () => undefined,
      releaseStream: () => undefined,
      release: () => undefined,
    }),
  });
  await provider.start(wakeConfig(), () => undefined);
  provider.processFrame(exactFrame(0, 0, [-32768, 0, 32767]));
  assert.equal(accepted.length, 1);
  assert.equal(lastRate, 16000);
  const samples = accepted[0] as Float32Array;
  assert.equal(samples.length, 3);
  assert.ok(Math.abs(samples[0]! - -1) < 1e-6, "-32768 must map to -1");
  assert.equal(samples[1], 0, "0 must map to 0");
  assert.ok(Math.abs(samples[2]! - 32767 / 32768) < 1e-9, "32767 must map to ~0.99997");
  await provider.stop();
  } finally {
    rmSync(modelDir, { recursive: true, force: true });
  }
});

test("D: odd-length PCM frames carry the trailing byte into the next frame", async () => {
  const accepted: Float32Array[] = [];
  const modelDir = makeTempModelDir();
  try {
  const provider = new SherpaWakeWordProvider({
    modelDir,
    keywordsScore: 1,
    keywordsThreshold: 0.25,
    numThreads: 1,
    engineFactory: () => ({
      createStream: () => ({
        acceptWaveform: (samples: Float32Array) => {
          accepted.push(samples);
        },
      }),
      isReady: () => false,
      decode: () => undefined,
      getResult: () => ({}),
      reset: () => undefined,
      releaseStream: () => undefined,
      release: () => undefined,
    }),
  });
  await provider.start(wakeConfig(), () => undefined);
  // Frame 1: 3 bytes -> one full sample (bytes 0,1) + carried LOW byte 0x01.
  const f1 = frame(0, 0);
  f1.data = new Uint8Array([0x00, 0x40, 0x01]); // sample 0x4000 = 16384; carry 0x01
  provider.processFrame(f1);
  // Frame 2: 1 byte (0x00, the HIGH byte) -> completes the split sample
  // 0x01 | (0x00 << 8) = 1 (little-endian: the carry is the LOW byte).
  const f2 = frame(1, 20);
  f2.data = new Uint8Array([0x00]);
  provider.processFrame(f2);
  assert.equal(accepted.length, 2);
  const first = accepted[0] as Float32Array;
  const second = accepted[1] as Float32Array;
  assert.equal(first.length, 1);
  assert.equal(first[0], 16384 / 32768);
  assert.equal(second.length, 1);
  assert.equal(second[0], 1 / 32768);
  assert.equal(provider.stats().carriedBytes, 0, "no leftover byte after an even boundary");
  await provider.stop();
  } finally {
    rmSync(modelDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E/F/G/H - detection semantics
// ---------------------------------------------------------------------------

test("E: no KWS result produces no wake event", async () => {
  const handle = await startedProvider();
  const engine = handle.engine();
  handle.provider.processFrame(frame(0, 0));
  engine.result = undefined;
  engine.ready = true;
  handle.provider.processFrame(frame(1, 20));
  engine.result = {};
  engine.ready = true;
  handle.provider.processFrame(frame(2, 40));
  assert.deepEqual(handle.events, []);
  assert.equal(engine.resetCount, 0);
  await handle.dispose();
});

test("F: result 'ARTHUR' (any case/spacing/BPE markers) wakes exactly once", async () => {
  for (const keywordText of ["ARTHUR", "arthur", "Arthur", "▁AR THUR", "▁A R THUR", " ARTHUR "]) {
    const handle = await startedProvider();
    const engine = handle.engine();
    engine.result = { keyword: keywordText, tokens: [keywordText] };
    engine.ready = true;
    handle.provider.processFrame(frame(0, 1000));
    assert.equal(handle.events.length, 1, keywordText);
    assert.equal(handle.events[0]?.kind, "wake_detected");
    assert.equal(handle.events[0]?.provider, "sherpa-kws-wake");
    assert.equal(handle.events[0]?.detected_at_ms, 1000);
    await handle.dispose();
  }
});

test("F: tokens-only result still wakes exactly once when it equals the keyword", async () => {
  const handle = await startedProvider();
  const engine = handle.engine();
  engine.result = { tokens: ["▁AR", "THUR"] };
  engine.ready = true;
  handle.provider.processFrame(frame(0, 0));
  assert.equal(handle.events.length, 1);
  await handle.dispose();
});

test("G: unrelated, empty or partial results never wake", async () => {
  const cases: SherpaKwsResult[] = [
    { keyword: "banana" },
    { keyword: "HELLO WORLD" },
    { keyword: "" },
    { keyword: "Arthurian" }, // extension, not an exact match
    { keyword: "arthur2" },
    { tokens: ["▁AR"] }, // partial token sequence
    { tokens: ["▁AR", "THUR", "S"] }, // longer than the keyword
    { keyword: "▁BANANA" },
  ];
  for (const result of cases) {
    const handle = await startedProvider();
    const engine = handle.engine();
    engine.result = result;
    engine.ready = true;
    handle.provider.processFrame(frame(0, 0));
    assert.deepEqual(handle.events, [], JSON.stringify(result));
    assert.equal(engine.resetCount, 0, "no reset without a detection");
    await handle.dispose();
  }
});

test("H: detection resets the KWS stream and the reset clears readiness", async () => {
  const handle = await startedProvider();
  const engine = handle.engine();
  engine.result = { keyword: "Arthur" };
  engine.ready = true;
  handle.provider.processFrame(frame(0, 100));
  assert.equal(handle.events.length, 1);
  assert.equal(engine.resetCount, 1);
  assert.equal(engine.ready, false, "the KWS API reset cleared the stream");
  // A frame without new decoded audio cannot re-fire.
  handle.provider.processFrame(frame(1, 120));
  assert.equal(handle.events.length, 1);
  assert.equal(engine.resetCount, 1);
  await handle.dispose();
});

test("H: a second genuine detection emits a second event and resets again", async () => {
  const handle = await startedProvider();
  const engine = handle.engine();
  engine.result = { keyword: "Arthur" };
  engine.ready = true;
  handle.provider.processFrame(frame(0, 100));
  engine.ready = true; // new audio decoded into a new detection
  handle.provider.processFrame(frame(1, 120));
  assert.equal(handle.events.length, 2);
  assert.equal(engine.resetCount, 2);
  await handle.dispose();
});

// ---------------------------------------------------------------------------
// I - gateway pause semantics are preserved
// ---------------------------------------------------------------------------

test("I: paused WakeWordGateway drops sherpa wake events (echo protection)", async () => {
  const handle = makeProvider();
  const provider = handle.provider;
  const gateway = new WakeWordGateway(provider, { frameBased: true });
  const events: WakeEvent[] = [];
  await gateway.start(wakeConfig(), (event) => events.push(event));
  const engine = handle.engine();
  engine.result = { keyword: "Arthur" };
  gateway.setPaused(true);
  engine.ready = true;
  // Frames still reach the provider, but the gateway drops the in-flight
  // event while paused (same semantics as the energy provider).
  provider.processFrame(frame(0, 0));
  assert.deepEqual(events, []);
  gateway.setPaused(false);
  engine.ready = true;
  provider.processFrame(frame(1, 20));
  assert.equal(events.length, 1);
  await gateway.stop();
});

test("I: paused gateway does not route frames into the KWS engine at all", async () => {
  const handle = makeProvider();
  const gateway = new WakeWordGateway(handle.provider, { frameBased: true });
  await gateway.start(wakeConfig(), () => undefined);
  gateway.setPaused(true);
  gateway.processFrame(frame(0, 0));
  gateway.processFrame(frame(1, 20));
  assert.equal(handle.engine().acceptedCount, 0, "paused gateway must not feed KWS");
  gateway.setPaused(false);
  gateway.processFrame(frame(2, 40));
  assert.equal(handle.engine().acceptedCount, 1);
  await gateway.stop();
});

// ---------------------------------------------------------------------------
// J - lifecycle (start/stop/start)
// ---------------------------------------------------------------------------

test("J: start/stop/start creates clean streams without duplicate callbacks", async () => {
  const engines: FakeKwsEngine[] = [];
  const modelDir = makeTempModelDir();
  try {
  const provider = new SherpaWakeWordProvider({
    modelDir,
    keywordsScore: 1,
    keywordsThreshold: 0.25,
    numThreads: 1,
    engineFactory: (config) => {
      const engine = new FakeKwsEngine(config);
      engines.push(engine);
      return engine;
    },
  });
  const first: WakeEvent[] = [];
  const second: WakeEvent[] = [];
  await provider.start(wakeConfig(), (e) => first.push(e));
  assert.equal(engines.length, 1);
  await provider.stop();
  assert.equal(engines[0]?.released, 1);
  assert.equal(engines[0]?.releasedStreams, 1);
  await provider.start(wakeConfig(), (e) => second.push(e));
  assert.equal(engines.length, 2, "a fresh stream per start");
  // Detection after restart goes ONLY to the new handler.
  const engine2 = engines[1] as FakeKwsEngine;
  engine2.result = { keyword: "Arthur" };
  engine2.ready = true;
  provider.processFrame(frame(0, 0));
  assert.equal(first.length, 0, "the old handler must never fire again");
  assert.equal(second.length, 1);
  await provider.stop();
  assert.equal(engines[1]?.released, 1);
  // Repeated stop stays safe and never double-releases.
  await provider.stop();
  await provider.stop();
  assert.equal(engines[0]?.released, 1);
  assert.equal(engines[1]?.released, 1);
  } finally {
    rmSync(modelDir, { recursive: true, force: true });
  }
});

test("J: double start without stop restarts cleanly (no stacked handlers)", async () => {
  const engines: FakeKwsEngine[] = [];
  const modelDir = makeTempModelDir();
  try {
  const provider = new SherpaWakeWordProvider({
    modelDir,
    keywordsScore: 1,
    keywordsThreshold: 0.25,
    numThreads: 1,
    engineFactory: (config) => {
      const engine = new FakeKwsEngine(config);
      engines.push(engine);
      return engine;
    },
  });
  const events: WakeEvent[] = [];
  await provider.start(wakeConfig(), () => events.push({ kind: "wake_detected", detected_at_ms: -1, provider: "orphan" }));
  await provider.start(wakeConfig(), (e) => events.push(e));
  assert.equal(engines.length, 2);
  assert.equal(engines[0]?.released, 1, "the first engine was released on restart");
  const engine2 = engines[1] as FakeKwsEngine;
  engine2.result = { keyword: "Arthur" };
  engine2.ready = true;
  provider.processFrame(frame(0, 0));
  assert.equal(events.length, 1, "exactly one live handler");
  assert.equal(events[0]?.detected_at_ms, 0);
  await provider.stop();
  } finally {
    rmSync(modelDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// K - missing model/config fails closed
// ---------------------------------------------------------------------------

test("K: missing model dir => unavailable and start rejects with a path-free error", async () => {
  const provider = new SherpaWakeWordProvider({
    modelDir: "D:\\definitely-not-a-real-arthur-kws-dir",
    keywordsScore: 1,
    keywordsThreshold: 0.25,
    numThreads: 1,
    // A factory would succeed; the file gate must still fail closed.
    engineFactory: () => new FakeKwsEngine({}),
  });
  assert.equal(provider.available, false);
  await assert.rejects(
    () => provider.start(wakeConfig(), () => undefined),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /missing or incomplete/);
      assert.doesNotMatch(err.message, /definitely-not-a-real-arthur-kws-dir/, "no machine paths in errors");
      return true;
    },
  );
});

test("K: missing keywords file => unavailable", () => {
  const dir = makeTempModelDir();
  try {
    rmSync(join(dir, "keywords_arthur.txt"));
    const provider = new SherpaWakeWordProvider({
      modelDir: dir,
      keywordsScore: 1,
      keywordsThreshold: 0.25,
      numThreads: 1,
      engineFactory: () => new FakeKwsEngine({}),
    });
    assert.equal(provider.available, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// L - PTT remains operational when sherpa is unavailable
// ---------------------------------------------------------------------------

test("L: voice enables with PTT fallback when the sherpa model is missing", async () => {
  const capture = new FakeAudioCapture();
  const events: VoiceClientEvent[] = [];
  const app = buildTestApp(
    {
      voice: {
        wakeProvider: "sherpa",
        wakeModelDir: "D:\\definitely-not-a-real-arthur-kws-dir",
      },
    },
    { voice: { capture } },
  );
  try {
    app.voice.subscribe((event) => events.push(event));
    const turn = await app.conversation.handleTurn(validTurn({ message: "setup" }));
    await app.voice.enable(turn.session_id);
    assert.equal(app.voice.status().wake.available, false);
    assert.ok(
      events.some((e) => e.type === "voice.error" && e.code === VoiceErrorCode.WAKE_UNAVAILABLE),
      "wake unavailability is reported, not fatal",
    );
    // PTT path is fully operational without any wake/KWS engine.
    await app.voice.pttStart();
    assert.equal(app.voice.state, VoiceState.LISTENING);
    await app.voice.pttStop();
    assert.equal(app.voice.state, VoiceState.IDLE);
    await app.voice.disable();
  } finally {
    app.close();
  }
});

// ---------------------------------------------------------------------------
// M/N - memory discipline and bounded processing
// ---------------------------------------------------------------------------

test("M: no raw audio retention across frames (at most one carried byte)", async () => {
  const handle = await startedProvider();
  for (let i = 0; i < 1000; i++) {
    handle.provider.processFrame(frame(i, i * 20));
  }
  const stats = handle.provider.stats();
  assert.equal(stats.framesProcessed, 1000);
  assert.equal(stats.carriedBytes, 0, "320-sample frames are even; nothing carried");
  assert.equal(stats.detectionCount, 0);
  await handle.dispose();
});

test("N: long-running frame processing stays bounded and responsive", async () => {
  const handle = await startedProvider();
  const total = 30_000;
  const start = Date.now();
  for (let i = 0; i < total; i++) {
    // Alternate even/odd byte counts to exercise the carry path constantly.
    const f = frame(i, i * 20);
    if (i % 2 === 1) f.data = new Uint8Array(641);
    handle.provider.processFrame(f);
  }
  const elapsedMs = Date.now() - start;
  const stats = handle.provider.stats();
  assert.equal(stats.framesProcessed, total);
  assert.ok(stats.carriedBytes <= 1, "carry never exceeds one byte");
  assert.ok(elapsedMs < 10_000, `30k frames processed in ${elapsedMs}ms (bounded, no accumulation)`);
  await handle.dispose();
});

test("N: per-frame decode budget fails closed instead of spinning forever", async () => {
  const handle = await startedProvider();
  const engine = handle.engine();
  // An engine that reports ready forever must hit the guard, not hang.
  engine.isReady = () => true;
  engine.decode = () => undefined; // never consumes readiness
  engine.getResult = () => ({ keyword: "nope" });
  handle.provider.processFrame(frame(0, 0));
  const stats = handle.provider.stats();
  assert.equal(stats.failed, true, "provider failed closed");
  assert.ok(engine.decodeCount <= MAX_DECODES_PER_FRAME);
  assert.deepEqual(handle.events, [], "a failing engine never fabricates a wake");
  // Further frames are ignored after the failure (no repeated work/errors).
  handle.provider.processFrame(frame(1, 20));
  assert.ok(engine.decodeCount <= MAX_DECODES_PER_FRAME);
  await handle.dispose();
});

test("engine exceptions during processFrame fail closed without throwing", async () => {
  const handle = await startedProvider();
  const engine = handle.engine();
  engine.isReady = () => {
    throw new Error("native crash");
  };
  assert.doesNotThrow(() => handle.provider.processFrame(frame(0, 0)));
  assert.equal(handle.provider.stats().failed, true);
  assert.deepEqual(handle.events, []);
  await handle.dispose();
});

test("normalizeKeywordText strips case, whitespace and sentencepiece markers", () => {
  assert.equal(normalizeKeywordText("ARTHUR"), "arthur");
  assert.equal(normalizeKeywordText("▁AR THUR"), "arthur");
  assert.equal(normalizeKeywordText("  arthur "), "arthur");
  assert.notEqual(normalizeKeywordText("arthur2"), "arthur");
});

test("engine config carries the tuned KWS parameters", async () => {
  const handle = makeProvider({ keywordsScore: 1.5, keywordsThreshold: 0.4, numThreads: 2 });
  await handle.provider.start(wakeConfig({ wakeWord: "Arthur", sampleRateHz: 16000 }), () => undefined);
  const config = handle.engine().config as {
    keywordsScore: number;
    keywordsThreshold: number;
    numThreads: number;
    sampleRateHz: number;
    featureDim: number;
  };
  assert.equal(config.keywordsScore, 1.5);
  assert.equal(config.keywordsThreshold, 0.4);
  assert.equal(config.numThreads, 2);
  assert.equal(config.sampleRateHz, 16000);
  assert.equal(config.featureDim, 80);
  await handle.dispose();
});

test("inactive provider ignores frames completely", async () => {
  const handle = makeProvider();
  // No start(): frames must be ignored without ever creating an engine.
  handle.provider.processFrame(frame(0, 0));
  assert.equal(handle.holder.current, undefined, "no engine was ever created");
  assert.deepEqual(handle.events, []);
});
