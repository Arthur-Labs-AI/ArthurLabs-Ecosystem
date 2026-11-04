/**
 * OPT-IN native integration test for True Wake Word v1 (TASK-0009).
 *
 * Uses the REAL sherpa-onnx-node addon, the REAL downloaded KWS model and
 * the REAL generated keywords file. It is deliberately NOT part of normal
 * `npm test` runs (no model download, no native load in CI): every test in
 * this file is skipped unless
 *
 *   ARTHUR_SHERPA_WAKE_NATIVE_TEST=1
 *
 * is set. Fixtures are tiny 16 kHz mono s16le WAV files (tests/fixtures/wake):
 *   arthur.wav  - "Arthur"  -> must wake
 *   banana.wav  - "banana"  -> must NOT wake
 *   hello.wav   - "hello there" -> must NOT wake
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { SherpaWakeWordProvider } from "../../src/voice/wake/sherpa_provider";
import { frameFromInt16 } from "../../src/voice/contracts";
import type { PcmFrame, WakeEvent, WakeWordConfig } from "../../src/voice/contracts";

const ENABLED = process.env.ARTHUR_SHERPA_WAKE_NATIVE_TEST === "1";
const SKIP_REASON = "opt-in native test: set ARTHUR_SHERPA_WAKE_NATIVE_TEST=1 (plus model + keywords file) to run";

// dist/tests/voice -> repo root
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const MODEL_DIR =
  process.env.ARTHUR_SHERPA_WAKE_NATIVE_MODEL_DIR ??
  join(REPO_ROOT, "models", "wake", "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01");
const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "wake");

/** Minimal RIFF/WAVE reader for mono 16-bit PCM fixtures (chunk walker). */
function readPcm16Mono(path: string): { samples: Int16Array; sampleRateHz: number } {
  const buf = readFileSync(path);
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`not a WAV file: ${path}`);
  }
  let offset = 12;
  let sampleRateHz = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRateHz = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (chunkId === "data") {
      dataOffset = body;
      dataLength = chunkSize;
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  if (dataOffset < 0 || channels !== 1 || bitsPerSample !== 16) {
    throw new Error(`expected mono 16-bit PCM WAV: ${path}`);
  }
  const sampleCount = Math.floor(dataLength / 2);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = buf.readInt16LE(dataOffset + i * 2);
  }
  return { samples, sampleRateHz };
}

/** Feed a fixture exactly like the controller feeds microphone frames. */
async function runFixture(name: string): Promise<WakeEvent[]> {
  const { samples, sampleRateHz } = readPcm16Mono(join(FIXTURE_DIR, name));
  assert.equal(sampleRateHz, 16000, "fixtures must be 16 kHz");
  const provider = new SherpaWakeWordProvider({
    modelDir: MODEL_DIR,
    keywordsScore: Number(process.env.ARTHUR_WAKE_KEYWORDS_SCORE ?? 1),
    keywordsThreshold: Number(process.env.ARTHUR_WAKE_KEYWORDS_THRESHOLD ?? 0.25),
    numThreads: 1,
  });
  assert.equal(provider.available, true, "model + generated keywords file must be present");
  const events: WakeEvent[] = [];
  await provider.start(
    { wakeWord: "arthur", sampleRateHz: 16000, frameDurationMs: 20, preRollMs: 400, threshold: 0.6 } satisfies WakeWordConfig,
    (event) => events.push(event),
  );
  try {
    let atMs = 0;
    const push = (chunk: Int16Array): void => {
      for (let i = 0; i < chunk.length; i += 320) {
        const part = chunk.subarray(i, Math.min(i + 320, chunk.length));
        const frame: PcmFrame = frameFromInt16(part, atMs / 20, atMs);
        provider.processFrame(frame);
        atMs += 20;
      }
    };
    // 0.5 s of lead-in silence, the utterance, 0.5 s of tail silence - the
    // same shape the controller sees around a spoken wake word.
    push(new Int16Array(8000));
    push(samples);
    push(new Int16Array(8000));
  } finally {
    await provider.stop();
  }
  return events;
}

test("native KWS: 'Arthur' fixture wakes", { skip: ENABLED ? false : SKIP_REASON }, async () => {
  assert.ok(existsSync(join(FIXTURE_DIR, "arthur.wav")), "missing arthur.wav fixture");
  const events = await runFixture("arthur.wav");
  assert.equal(events.length, 1, `expected exactly one wake, got ${events.length}`);
  assert.equal(events[0]?.kind, "wake_detected");
  assert.equal(events[0]?.provider, "sherpa-kws-wake");
});

test("native KWS: 'banana' fixture does not wake", { skip: ENABLED ? false : SKIP_REASON }, async () => {
  const events = await runFixture("banana.wav");
  assert.deepEqual(events, []);
});

test("native KWS: 'hello there' fixture does not wake", { skip: ENABLED ? false : SKIP_REASON }, async () => {
  const events = await runFixture("hello.wav");
  assert.deepEqual(events, []);
});