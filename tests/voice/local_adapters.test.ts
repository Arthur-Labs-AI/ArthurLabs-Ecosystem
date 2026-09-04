import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTestApp } from "../helpers";
import { LocalAudioCapture } from "../../src/voice/audio/capture";
import { LocalAudioPlayback } from "../../src/voice/audio/playback";
import { LocalSttProvider } from "../../src/voice/stt/local_provider";
import { LocalTtsProvider } from "../../src/voice/tts/local_provider";
import { frameFromInt16, PcmFrame, AudioChunk, SttEvent } from "../../src/voice/contracts";
import { syntheticAudioChunk } from "../../src/voice/tts/contracts";
import type { LogSink, TextSanitizer } from "../../src/voice/process_util";

// ---------------------------------------------------------------------------
// Deterministic fixture child processes (tools/voice/fixtures/*.cjs)
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(__dirname, "..", "..", "..", "tools", "voice", "fixtures");
const captureFixture = join(FIXTURE_DIR, "capture_fixture.cjs");
const sttFixture = join(FIXTURE_DIR, "stt_fixture.cjs");
const ttsFixture = join(FIXTURE_DIR, "tts_fixture.cjs");
const sinkFixture = join(FIXTURE_DIR, "playback_sink_fixture.cjs");

/** Quoted command line (exercises the argument-safe tokenizer with spaces). */
function nodeCmd(script: string): string {
  return String.fromCharCode(34) + process.execPath + String.fromCharCode(34) + " " + String.fromCharCode(34) + script + String.fromCharCode(34);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for " + what);
}

function readPid(pidFile: string): number {
  return Number(readFileSync(pidFile, "utf8").trim());
}

function newTempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), "arthur-voice-" + tag + "-"));
}

async function* speechFrames(count: number, delayMs = 5): AsyncIterable<PcmFrame> {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const samples = new Int16Array(320);
    samples.fill(1000);
    yield frameFromInt16(samples, i, Date.now());
  }
}

async function collectStt(provider: LocalSttProvider, frames: AsyncIterable<PcmFrame>, utteranceId: string): Promise<SttEvent[]> {
  const events: SttEvent[] = [];
  for await (const event of provider.transcribeStream(frames, { utteranceId, maxTranscriptChars: 8000 })) {
    events.push(event);
  }
  return events;
}

async function* chunkIter(chunks: AudioChunk[]): AsyncIterable<AudioChunk> {
  for (const chunk of chunks) yield chunk;
}

function ttsRequest(partial: Record<string, unknown> = {}): { synthesisId: string; text: string; voice: string; sampleRateHz: number } {
  return { synthesisId: "synth-test", text: "Hello ARTHUR, this is a test.", voice: "arthur", sampleRateHz: 16000, ...partial };
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

test("capture streams bounded s16le PCM frames from the fixture process", async () => {
  const dir = newTempDir("capture");
  const pidFile = join(dir, "pid.txt");
  const capture = new LocalAudioCapture(nodeCmd(captureFixture), 16000, "default", {
    frameDurationMs: 20,
    env: { FIXTURE_SAMPLE_RATE: "16000", FIXTURE_FRAME_MS: "20", FIXTURE_FRAMES: "50", FIXTURE_PID_FILE: pidFile },
  });
  assert.equal(capture.available, true);
  const frames: PcmFrame[] = [];
  await capture.start((frame) => frames.push(frame));
  assert.equal(capture.active, true);
  await waitFor(() => frames.length === 50, 4000, "50 capture frames");
  const first = frames[0] as PcmFrame;
  assert.equal(first.channels, 1);
  assert.equal(first.sample_format, "s16le");
  assert.equal(first.sample_rate_hz, 16000);
  assert.equal(first.duration_ms, 20);
  assert.equal(first.data.byteLength, 640);
  const sequences = frames.map((f) => f.sequence);
  assert.deepEqual(sequences, Array.from({ length: 50 }, (_, i) => i));
  for (let i = 1; i < frames.length; i += 1) {
    assert.ok((frames[i] as PcmFrame).timestamp_ms >= (frames[i - 1] as PcmFrame).timestamp_ms, "timestamps are monotonic");
  }
  await capture.stop();
  assert.equal(capture.active, false);
  const pid = readPid(pidFile);
  await waitFor(() => !isAlive(pid), 3000, "capture child to exit");
  rmSync(dir, { recursive: true, force: true });
});

test("capture reassembles fragmented PCM chunks into exact frames", async () => {
  const dir = newTempDir("capture-frag");
  const capture = new LocalAudioCapture(nodeCmd(captureFixture), 16000, "default", {
    frameDurationMs: 20,
    env: {
      FIXTURE_SAMPLE_RATE: "16000",
      FIXTURE_FRAME_MS: "20",
      FIXTURE_FRAMES: "30",
      FIXTURE_CHUNK_SPLIT: "13",
    },
  });
  const frames: PcmFrame[] = [];
  await capture.start((frame) => frames.push(frame));
  await waitFor(() => frames.length === 30, 4000, "30 fragmented frames");
  for (const frame of frames) {
    assert.equal(frame.data.byteLength, 640, "fragmentation must not leak into frames");
  }
  await capture.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("capture child crash stops the stream without throwing", async () => {
  const dir = newTempDir("capture-crash");
  const capture = new LocalAudioCapture(nodeCmd(captureFixture), 16000, "default", {
    frameDurationMs: 20,
    env: { FIXTURE_FRAMES: "10", FIXTURE_EXIT_CODE: "3" },
  });
  const frames: PcmFrame[] = [];
  await capture.start((frame) => frames.push(frame));
  await waitFor(() => frames.length === 10, 4000, "frames before crash");
  await waitFor(() => !capture.active, 4000, "capture to deactivate after crash");
  await capture.stop(); // idempotent, must not throw
  rmSync(dir, { recursive: true, force: true });
});

test("capture unavailable without a command and fails cleanly on a missing executable", async () => {
  const empty = new LocalAudioCapture("", 16000, "default");
  assert.equal(empty.available, false);
  await assert.rejects(empty.start(() => undefined), /AUDIO_INPUT_UNAVAILABLE/);
  const missing = new LocalAudioCapture("C:\\arthur-no-such-capture-engine-xyz-12345.exe", 16000, "default");
  await assert.rejects(missing.start(() => undefined), /AUDIO_INPUT_UNAVAILABLE/);
  assert.equal(missing.active, false);
});

// ---------------------------------------------------------------------------
// STT
// ---------------------------------------------------------------------------

test("STT returns a strictly validated final transcript", async () => {
  const dir = newTempDir("stt");
  const inputFile = join(dir, "input.json");
  const pidFile = join(dir, "pid.txt");
  const stt = new LocalSttProvider(nodeCmd(sttFixture), "model.bin", "auto", {
    env: {
      FIXTURE_JSON: JSON.stringify({ text: "hello world", language: "bg", confidence: 0.93 }),
      FIXTURE_INPUT_FILE: inputFile,
      FIXTURE_PID_FILE: pidFile,
    },
  });
  assert.equal(stt.available, true);
  const events = await collectStt(stt, speechFrames(3), "utt-1");
  assert.equal(events.length, 1);
  const final = events[0] as { type: string; text?: string; language?: string; confidence?: number };
  assert.equal(final.type, "final");
  assert.equal(final.text, "hello world");
  assert.equal(final.language, "bg");
  assert.equal(final.confidence, 0.93);
  const received = JSON.parse(readFileSync(inputFile, "utf8")) as { bytes: number };
  assert.equal(received.bytes, 3 * 640, "raw mono s16le PCM must be fed via stdin");
  const pid = readPid(pidFile);
  await waitFor(() => !isAlive(pid), 3000, "stt engine to exit");
  rmSync(dir, { recursive: true, force: true });
});

test("STT enforces the transcript length limit", async () => {
  const longText = "word ".repeat(400).trim();
  const stt = new LocalSttProvider(nodeCmd(sttFixture), "model.bin", "en", {
    env: { FIXTURE_JSON: JSON.stringify({ text: longText }) },
  });
  const events: SttEvent[] = [];
  for await (const event of stt.transcribeStream(speechFrames(1), { utteranceId: "utt-len", maxTranscriptChars: 100 })) {
    events.push(event);
  }
  const final = events[0] as { type: string; text?: string };
  assert.equal(final.type, "final");
  assert.equal((final.text as string).length, 100);
});

test("STT malformed JSON yields STT_FAILED", async () => {
  const stt = new LocalSttProvider(nodeCmd(sttFixture), "model.bin", "auto", {
    env: { FIXTURE_MALFORMED: "1" },
  });
  const events = await collectStt(stt, speechFrames(1), "utt-bad");
  assert.deepEqual(events, [{ type: "error", code: "STT_FAILED" }]);
});

test("STT oversized output yields STT_FAILED without unbounded buffering", async () => {
  const dir = newTempDir("stt-over");
  const stt = new LocalSttProvider(nodeCmd(sttFixture), "model.bin", "auto", {
    maxStdoutBytes: 64 * 1024,
    env: { FIXTURE_OVERSIZE_KB: "512" },
  });
  const started = Date.now();
  const events = await collectStt(stt, speechFrames(1), "utt-over");
  assert.deepEqual(events, [{ type: "error", code: "STT_FAILED" }]);
  assert.ok(Date.now() - started < 5000, "oversized output must fail fast");
  rmSync(dir, { recursive: true, force: true });
});

test("STT non-zero exit yields STT_FAILED even with valid JSON", async () => {
  const stt = new LocalSttProvider(nodeCmd(sttFixture), "model.bin", "auto", {
    env: { FIXTURE_JSON: JSON.stringify({ text: "late crash" }), FIXTURE_EXIT_CODE: "3" },
  });
  const events = await collectStt(stt, speechFrames(1), "utt-crash");
  assert.deepEqual(events, [{ type: "error", code: "STT_FAILED" }]);
});

test("STT engine timeout yields STT_FAILED and terminates the child", async () => {
  const dir = newTempDir("stt-timeout");
  const pidFile = join(dir, "pid.txt");
  const stt = new LocalSttProvider(nodeCmd(sttFixture), "model.bin", "auto", {
    sttTimeoutMs: 300,
    env: { FIXTURE_STALL_MS: "30000", FIXTURE_PID_FILE: pidFile },
  });
  const started = Date.now();
  const events = await collectStt(stt, speechFrames(1), "utt-slow");
  assert.deepEqual(events, [{ type: "error", code: "STT_FAILED" }]);
  assert.ok(Date.now() - started < 5000, "timeout must fire promptly");
  const pid = readPid(pidFile);
  await waitFor(() => !isAlive(pid), 3000, "timed-out engine to be terminated");
  rmSync(dir, { recursive: true, force: true });
});

test("STT cancellation terminates the engine and ends the stream", async () => {
  const dir = newTempDir("stt-cancel");
  const pidFile = join(dir, "pid.txt");
  const stt = new LocalSttProvider(nodeCmd(sttFixture), "model.bin", "auto", {
    env: { FIXTURE_STALL_MS: "30000", FIXTURE_PID_FILE: pidFile },
  });
  const events: SttEvent[] = [];
  const consuming = (async () => {
    for await (const event of stt.transcribeStream(speechFrames(200, 10), { utteranceId: "utt-cx", maxTranscriptChars: 8000 })) {
      events.push(event);
    }
  })();
  await waitFor(() => existsSync(pidFile), 3000, "engine to start");
  const pid = readPid(pidFile);
  assert.ok(isAlive(pid), "engine alive before cancel");
  await stt.cancel("utt-cx");
  await consuming;
  assert.deepEqual(events, [], "cancelled utterance must not emit transcript events");
  await waitFor(() => !isAlive(pid), 3000, "cancelled engine to be terminated");
  rmSync(dir, { recursive: true, force: true });
});

test("STT unavailable and missing executable yield STT_FAILED", async () => {
  const empty = new LocalSttProvider("", "", "en");
  assert.equal(empty.available, false);
  const events = await collectStt(empty, speechFrames(1), "utt-none");
  assert.deepEqual(events, [{ type: "error", code: "STT_FAILED" }]);
  const missing = new LocalSttProvider("C:\\arthur-no-such-stt-engine-xyz-12345.exe", "model.bin", "auto");
  const events2 = await collectStt(missing, speechFrames(1), "utt-missing");
  assert.deepEqual(events2, [{ type: "error", code: "STT_FAILED" }]);
});

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

test("TTS yields incremental bounded chunks with a final flag", async () => {
  const dir = newTempDir("tts");
  const textFile = join(dir, "text.txt");
  const pidFile = join(dir, "pid.txt");
  const tts = new LocalTtsProvider(nodeCmd(ttsFixture), "arthur", {
    chunkDurationMs: 100,
    env: {
      FIXTURE_CHUNKS: "5",
      FIXTURE_CHUNK_BYTES: "3200",
      FIXTURE_CHUNK_DELAY_MS: "10",
      FIXTURE_TEXT_FILE: textFile,
      FIXTURE_PID_FILE: pidFile,
    },
  });
  assert.equal(tts.available, true);
  const chunks: AudioChunk[] = [];
  for await (const chunk of tts.synthesizeStream(ttsRequest())) {
    chunks.push(chunk);
  }
  assert.equal(chunks.length, 5);
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.channels, 1);
    assert.equal(chunk.sample_format, "s16le");
    assert.equal(chunk.sample_rate_hz, 16000);
    assert.equal(chunk.duration_ms, 100);
    assert.equal(chunk.data.byteLength, 3200);
    assert.equal(chunk.sequence, index);
    assert.equal(chunk.synthesisId, "synth-test");
    if (index < 4) assert.notEqual(chunk.final, true);
  }
  assert.equal((chunks[4] as AudioChunk).final, true, "last chunk carries the final flag");
  const timestamps = chunks.map((c) => c.timestamp_ms);
  for (let i = 1; i < timestamps.length; i += 1) {
    assert.ok((timestamps[i] as number) >= (timestamps[i - 1] as number), "chunk timestamps are monotonic");
  }
  assert.equal(readFileSync(textFile, "utf8"), "Hello ARTHUR, this is a test.", "speech text must arrive via stdin");
  const pid = readPid(pidFile);
  await waitFor(() => !isAlive(pid), 3000, "tts engine to exit");
  rmSync(dir, { recursive: true, force: true });
});

test("TTS emits a short final chunk for trailing partial PCM", async () => {
  const tts = new LocalTtsProvider(nodeCmd(ttsFixture), "arthur", {
    chunkDurationMs: 100,
    env: { FIXTURE_CHUNKS: "2", FIXTURE_CHUNK_BYTES: "3200", FIXTURE_TRAILER_BYTES: "640" },
  });
  const chunks: AudioChunk[] = [];
  for await (const chunk of tts.synthesizeStream(ttsRequest())) {
    chunks.push(chunk);
  }
  assert.equal(chunks.length, 3);
  const last = chunks[2] as AudioChunk;
  assert.equal(last.final, true);
  assert.equal(last.data.byteLength, 640);
  assert.equal(last.duration_ms, 20);
  assert.equal((chunks[0] as AudioChunk).data.byteLength, 3200);
  assert.equal((chunks[1] as AudioChunk).data.byteLength, 3200);
  assert.notEqual((chunks[1] as AudioChunk).final, true);
});

test("TTS cancellation terminates the engine and ends the stream", async () => {
  const dir = newTempDir("tts-cancel");
  const pidFile = join(dir, "pid.txt");
  const tts = new LocalTtsProvider(nodeCmd(ttsFixture), "arthur", {
    chunkDurationMs: 100,
    env: { FIXTURE_CHUNKS: "200", FIXTURE_CHUNK_BYTES: "3200", FIXTURE_CHUNK_DELAY_MS: "20", FIXTURE_PID_FILE: pidFile },
  });
  const chunks: AudioChunk[] = [];
  const consuming = (async () => {
    for await (const chunk of tts.synthesizeStream(ttsRequest())) {
      chunks.push(chunk);
    }
  })();
  await waitFor(() => existsSync(pidFile), 3000, "tts engine to start");
  const pid = readPid(pidFile);
  await tts.cancel("synth-test");
  await consuming;
  assert.ok(chunks.length < 200, "cancelled synthesis must not run to completion");
  assert.ok(chunks.every((c) => c.final !== true), "no final flag on cancelled synthesis");
  await waitFor(() => !isAlive(pid), 3000, "cancelled tts engine to be terminated");
  rmSync(dir, { recursive: true, force: true });
});

test("TTS engine timeout throws TTS failure and terminates the child", async () => {
  const dir = newTempDir("tts-timeout");
  const pidFile = join(dir, "pid.txt");
  const tts = new LocalTtsProvider(nodeCmd(ttsFixture), "arthur", {
    ttsTimeoutMs: 300,
    env: { FIXTURE_STALL_MS: "30000", FIXTURE_PID_FILE: pidFile },
  });
  const started = Date.now();
  await assert.rejects(
    (async () => {
      for await (const _chunk of tts.synthesizeStream(ttsRequest())) {
        void _chunk;
      }
    })(),
    /timed out/,
  );
  assert.ok(Date.now() - started < 5000, "timeout must fire promptly");
  const pid = readPid(pidFile);
  await waitFor(() => !isAlive(pid), 3000, "timed-out tts engine to be terminated");
  rmSync(dir, { recursive: true, force: true });
});

test("TTS engine crash mid-stream throws after yielding partial audio", async () => {
  const tts = new LocalTtsProvider(nodeCmd(ttsFixture), "arthur", {
    chunkDurationMs: 100,
    env: { FIXTURE_CHUNKS: "2", FIXTURE_CHUNK_BYTES: "3200", FIXTURE_EXIT_CODE: "3" },
  });
  const chunks: AudioChunk[] = [];
  await assert.rejects(
    (async () => {
      for await (const chunk of tts.synthesizeStream(ttsRequest())) {
        chunks.push(chunk);
      }
    })(),
    /exited with code 3/,
  );
  assert.ok(chunks.length >= 1, "partial audio must be delivered before the failure surfaces");
});

test("TTS unavailable yields an empty stream; missing executable throws", async () => {
  const empty = new LocalTtsProvider("", "arthur");
  assert.equal(empty.available, false);
  let count = 0;
  for await (const _chunk of empty.synthesizeStream(ttsRequest())) {
    count += 1;
  }
  assert.equal(count, 0);
  const missing = new LocalTtsProvider("C:\\arthur-no-such-tts-engine-xyz-12345.exe", "arthur");
  await assert.rejects(
    (async () => {
      for await (const _chunk of missing.synthesizeStream(ttsRequest())) {
        void _chunk;
      }
    })(),
    /failed to start/,
  );
});

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

test("playback streams chunks in order with byte-exact delivery", async () => {
  const dir = newTempDir("pb");
  const resultFile = join(dir, "result.json");
  const headFile = join(dir, "head.txt");
  const pidFile = join(dir, "pid.txt");
  const playback = new LocalAudioPlayback(nodeCmd(sinkFixture), {
    env: { FIXTURE_RESULT_FILE: resultFile, FIXTURE_HEAD_FILE: headFile, FIXTURE_PID_FILE: pidFile },
  });
  assert.equal(playback.available, true);
  const chunks: AudioChunk[] = [];
  for (let i = 0; i < 10; i += 1) {
    chunks.push(syntheticAudioChunk("s", i, Date.now() + i, 20, 16000, i + 1));
  }
  await playback.play(chunkIter(chunks));
  const result = JSON.parse(readFileSync(resultFile, "utf8")) as { bytes: number };
  const total = chunks.reduce((sum, c) => sum + c.data.byteLength, 0);
  assert.equal(result.bytes, total, "every byte must reach the sink");
  const headHex = readFileSync(headFile, "utf8");
  const firstChunkHex = Buffer.from((chunks[0] as AudioChunk).data).subarray(0, 64).toString("hex");
  assert.equal(headHex, firstChunkHex, "chunk order must be preserved");
  const pid = readPid(pidFile);
  await waitFor(() => !isAlive(pid), 3000, "sink to exit");
  rmSync(dir, { recursive: true, force: true });
});

test("playback applies backpressure to a slow sink without losing chunks", async () => {
  const dir = newTempDir("pb-backpressure");
  const resultFile = join(dir, "result.json");
  const playback = new LocalAudioPlayback(nodeCmd(sinkFixture), {
    // 640 KiB of audio far exceeds the OS pipe buffer (~64 KiB), so the
    // adapter must stall on write() backpressure instead of buffering.
    env: { FIXTURE_RESULT_FILE: resultFile, FIXTURE_SLOW_DRAIN_MS: "50" },
  });
  const chunks: AudioChunk[] = [];
  for (let i = 0; i < 1000; i += 1) {
    chunks.push(syntheticAudioChunk("s", i, Date.now() + i, 20, 16000, i + 1));
  }
  const started = Date.now();
  await playback.play(chunkIter(chunks));
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 400, "slow sink must throttle the producer (elapsed " + elapsed + " ms)");
  const result = JSON.parse(readFileSync(resultFile, "utf8")) as { bytes: number };
  const total = chunks.reduce((sum, c) => sum + c.data.byteLength, 0);
  assert.equal(result.bytes, total, "backpressure must not drop bytes");
  rmSync(dir, { recursive: true, force: true });
});

test("playback interruption stops quickly, kills the child, and discards queued audio", async () => {
  const dir = newTempDir("pb-interrupt");
  const pidFile = join(dir, "pid.txt");
  const events: string[] = [];
  const playback = new LocalAudioPlayback(nodeCmd(sinkFixture), {
    env: { FIXTURE_PID_FILE: pidFile },
    events: { onStopped: (reason) => events.push(reason) },
  });
  const chunkSource = (async function* () {
    for (let i = 0; i < 500; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield syntheticAudioChunk("s", i, Date.now(), 20, 16000, i + 1);
    }
  })();
  const playing = playback.play(chunkSource);
  await waitFor(() => existsSync(pidFile), 3000, "sink to start");
  const pid = readPid(pidFile);
  assert.ok(isAlive(pid));
  const stopStarted = Date.now();
  await playback.stop();
  const stopMs = Date.now() - stopStarted;
  assert.ok(stopMs < 1000, "stop() must settle quickly (took " + stopMs + " ms)");
  await playing;
  assert.equal(playback.playing, false);
  assert.deepEqual(events, ["stopped"]);
  await waitFor(() => !isAlive(pid), 3000, "interrupted sink to be terminated");
  rmSync(dir, { recursive: true, force: true });
});

test("playback unavailable without a command and fails cleanly on a missing executable", async () => {
  const empty = new LocalAudioPlayback("");
  assert.equal(empty.available, false);
  await assert.rejects(empty.play(chunkIter([])), /AUDIO_OUTPUT_UNAVAILABLE/);
  const missing = new LocalAudioPlayback("C:\\arthur-no-such-playback-engine-xyz-12345.exe");
  await assert.rejects(missing.play(chunkIter([])), /AUDIO_OUTPUT_UNAVAILABLE/);
});

// ---------------------------------------------------------------------------
// TASK-0007: normal EOF drain vs explicit cancellation
// ---------------------------------------------------------------------------

test("playback slow natural EOF drains and completes without a false failure", async () => {
  const dir = newTempDir("pb-eof");
  const exitMarker = join(dir, "exit.txt");
  const pidFile = join(dir, "pid.txt");
  const events: string[] = [];
  const playback = new LocalAudioPlayback(nodeCmd(sinkFixture), {
    env: { FIXTURE_PID_FILE: pidFile, FIXTURE_EXIT_MARKER: exitMarker, FIXTURE_EOF_DRAIN_MS: "1500" },
    events: { onStopped: (reason) => events.push(reason) },
  });
  // ~4.8 s of audio written far faster than realtime; the sink lingers
  // 1.5 s after stdin EOF exactly like ffplay draining its internal buffer.
  // The old shared 250 ms kill grace reported this as code:null TTS_FAILED.
  const chunks: AudioChunk[] = [];
  for (let i = 0; i < 240; i += 1) {
    chunks.push(syntheticAudioChunk("s", i, Date.now() + i, 20, 16000, i + 1));
  }
  await playback.play(chunkIter(chunks));
  assert.equal(playback.playing, false);
  assert.deepEqual(events, ["completed"]);
  await waitFor(() => existsSync(exitMarker), 3000, "sink to exit after drain");
  rmSync(dir, { recursive: true, force: true });
});

test("playback player that never exits after EOF is reaped and reported as failure", async () => {
  const dir = newTempDir("pb-stuck");
  const pidFile = join(dir, "pid.txt");
  const playback = new LocalAudioPlayback(nodeCmd(sinkFixture), {
    env: { FIXTURE_PID_FILE: pidFile, FIXTURE_EOF_DRAIN_MS: "30000" },
    // Small normal-drain deadline so the test stays fast.
    eofDrainGraceMs: 300,
  });
  const chunks: AudioChunk[] = [];
  for (let i = 0; i < 2; i += 1) {
    chunks.push(syntheticAudioChunk("s", i, Date.now() + i, 20, 16000, i + 1));
  }
  await assert.rejects(() => playback.play(chunkIter(chunks)), /playback process exited with code/);
  const pid = readPid(pidFile);
  await waitFor(() => !isAlive(pid), 3000, "stuck sink to be reaped");
  rmSync(dir, { recursive: true, force: true });
});

test("playback non-zero exit after a normal drain still reports failure", async () => {
  const dir = newTempDir("pb-eof-code");
  const playback = new LocalAudioPlayback(nodeCmd(sinkFixture), {
    env: { FIXTURE_EOF_DRAIN_MS: "100", FIXTURE_EXIT_CODE: "3" },
  });
  const chunks: AudioChunk[] = [];
  for (let i = 0; i < 5; i += 1) {
    chunks.push(syntheticAudioChunk("s", i, Date.now() + i, 20, 16000, i + 1));
  }
  await assert.rejects(() => playback.play(chunkIter(chunks)), /playback process exited with code 3/);
  rmSync(dir, { recursive: true, force: true });
});

test("playback stop() during the EOF drain stays fast and discards stale audio", async () => {
  const dir = newTempDir("pb-eof-stop");
  const pidFile = join(dir, "pid.txt");
  const events: string[] = [];
  const playback = new LocalAudioPlayback(nodeCmd(sinkFixture), {
    env: { FIXTURE_PID_FILE: pidFile, FIXTURE_EOF_DRAIN_MS: "5000" },
    events: { onStopped: (reason) => events.push(reason) },
  });
  let yielded = 0;
  const source = (async function* () {
    for (let i = 0; i < 500; i += 1) {
      yield syntheticAudioChunk("s", i, Date.now(), 20, 16000, i + 1);
      yielded += 1;
    }
  })();
  const playing = playback.play(source);
  await waitFor(() => existsSync(pidFile), 3000, "sink to start");
  const stopStarted = Date.now();
  await playback.stop();
  assert.ok(Date.now() - stopStarted < 1000, "stop() must stay fast even during EOF drain");
  await playing;
  assert.equal(playback.playing, false);
  assert.deepEqual(events, ["stopped"]);
  const yieldedAtStop = yielded;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(yielded, yieldedAtStop, "no stale audio may be pulled after cancellation");
  const pid = readPid(pidFile);
  await waitFor(() => !isAlive(pid), 3000, "cancelled sink to be terminated");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Process hygiene
// ---------------------------------------------------------------------------

test("no zombie children: stop/cancel reaps every spawned engine", async () => {
  const dir = newTempDir("zombies");
  const capturePid = join(dir, "c.txt");
  const sttPid = join(dir, "s.txt");
  const ttsPid = join(dir, "t.txt");
  const sinkPid = join(dir, "p.txt");
  const capture = new LocalAudioCapture(nodeCmd(captureFixture), 16000, "default", {
    frameDurationMs: 20,
    env: { FIXTURE_FRAMES: "1000", FIXTURE_CHUNK_DELAY_MS: "10", FIXTURE_PID_FILE: capturePid },
  });
  await capture.start(() => undefined);
  const stt = new LocalSttProvider(nodeCmd(sttFixture), "model", "auto", {
    env: { FIXTURE_STALL_MS: "30000", FIXTURE_PID_FILE: sttPid },
  });
  const sttConsuming = collectStt(stt, speechFrames(500, 10), "utt-z");
  const tts = new LocalTtsProvider(nodeCmd(ttsFixture), "arthur", {
    chunkDurationMs: 100,
    env: { FIXTURE_CHUNKS: "500", FIXTURE_CHUNK_DELAY_MS: "10", FIXTURE_PID_FILE: ttsPid },
  });
  const ttsConsuming = (async () => {
    for await (const _c of tts.synthesizeStream(ttsRequest())) {
      void _c;
    }
  })();
  const playback = new LocalAudioPlayback(nodeCmd(sinkFixture), { env: { FIXTURE_PID_FILE: sinkPid } });
  const pbConsuming = playback.play((async function* () {
    for (let i = 0; i < 5000; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      yield syntheticAudioChunk("s", i, Date.now(), 20, 16000, 1);
    }
  })());
  await waitFor(() =>
    existsSync(capturePid) && existsSync(sttPid) && existsSync(ttsPid) && existsSync(sinkPid),
    4000,
    "all four children to start",
  );
  const pids = [readPid(capturePid), readPid(sttPid), readPid(ttsPid), readPid(sinkPid)];
  for (const pid of pids) {
    assert.ok(isAlive(pid), "child " + pid + " must be running before cleanup");
  }
  await capture.stop();
  await stt.cancel("utt-z");
  await tts.cancel("synth-test");
  await playback.stop();
  await Promise.all([sttConsuming, ttsConsuming, pbConsuming]);
  for (const pid of pids) {
    await waitFor(() => !isAlive(pid), 4000, "child " + pid + " to be reaped");
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// stderr hygiene
// ---------------------------------------------------------------------------

test("stderr is only surfaced through the secret-safe log sink", async () => {
  const calls: { msg: string; fields: Record<string, unknown> }[] = [];
  const spy: LogSink = {
    warn: (msg, fields) => calls.push({ msg, fields: fields ?? {} }),
    error: (msg, fields) => calls.push({ msg, fields: fields ?? {} }),
  };
  const redactor: TextSanitizer = { sanitizeText: (s) => s.replace(/sk-secret123/g, "***") };
  const stt = new LocalSttProvider(nodeCmd(sttFixture), "model", "auto", {
    logger: spy,
    sanitizer: redactor,
    env: { FIXTURE_EXIT_CODE: "3", FIXTURE_STDERR: "WARNING: API_KEY=sk-secret123 engine noise" },
  });
  const events = await collectStt(stt, speechFrames(1), "utt-secret");
  assert.deepEqual(events, [{ type: "error", code: "STT_FAILED" }]);
  assert.ok(calls.length > 0, "failure must be logged");
  const serialized = JSON.stringify(calls);
  assert.ok(!serialized.includes("sk-secret123"), "raw secret must never reach the log");
  assert.ok(serialized.includes("***"), "sanitized stderr tail must be logged");
  const stt2 = new LocalSttProvider(nodeCmd(sttFixture), "model", "auto", {
    logger: spy,
    sanitizer: redactor,
    env: { FIXTURE_STALL_MS: "30000", FIXTURE_STDERR: "SECRET_TOKEN=sk-secret123" },
  });
  const stt2Consuming = collectStt(stt2, speechFrames(1), "utt-secret2");
  await stt2.cancel("utt-secret2");
  await stt2Consuming;
  const serialized2 = JSON.stringify(calls);
  assert.ok(!serialized2.includes("sk-secret123"), "cancellation path must not leak stderr either");
});

// ---------------------------------------------------------------------------
// Startup status availability
// ---------------------------------------------------------------------------

test("voice status reflects configured engine availability without probing", () => {
  const configured = buildTestApp({
    voice: {
      voiceEnabled: true,
      audioCaptureCommand: "C:\\arthur-test\\ffmpeg.exe -f dshow -i audio=test -ac 1 -ar 16000 -f s16le pipe:1",
      audioPlaybackCommand: "C:\\arthur-test\\ffplay.exe -f s16le -ar 16000 -ac 1 -",
      sttEngineCommand: "C:\\arthur-test\\whisper-cli.exe",
      sttModelPath: "C:\\arthur-test\\ggml.bin",
      ttsEngineCommand: "C:\\arthur-test\\piper.exe",
      ttsVoice: "en_US-lessac-medium",
    },
  });
  const status = configured.voice.status();
  assert.equal(status.audio_input.available, true);
  assert.equal(status.audio_output.available, true);
  assert.equal(status.stt.available, true);
  assert.equal(status.tts.available, true);
  assert.ok(!JSON.stringify(status).includes("arthur-test"), "status must never expose engine paths");
  configured.close();
  const bare = buildTestApp({ voice: { voiceEnabled: true } });
  const bareStatus = bare.voice.status();
  assert.equal(bareStatus.audio_input.available, false);
  assert.equal(bareStatus.audio_output.available, false);
  assert.equal(bareStatus.stt.available, false);
  assert.equal(bareStatus.tts.available, false);
  bare.close();
});