import { test } from 'node:test';
import assert from 'node:assert/strict';

import { silenceFrame, frameFromInt16 } from '../../src/voice/contracts';
import { analyzePcmLevel, SILENCE_RMS_THRESHOLD } from '../../src/audio/readiness';
import { buildValidationTone, chunkPcmForPlayback, defaultValidationTone, validateCaptureTransport, validatePlaybackTransport, VALIDATION_TONE_HZ } from '../../src/audio/validate';
import type { AudioChunk, PcmFrame } from '../../src/voice/contracts';

function framesOf(kind: 'tone' | 'silence', count: number): PcmFrame[] {
  const out: PcmFrame[] = [];
  for (let i = 0; i < count; i += 1) {
    if (kind === 'silence') { out.push(silenceFrame(i, i * 20)); continue; }
    const samples = new Int16Array(320);
    for (let s = 0; s < 320; s += 1) samples[s] = Math.round(Math.sin((2 * Math.PI * 440 * s) / 16000) * 5000);
    out.push(frameFromInt16(samples, i, i * 20));
  }
  return out;
}

function fakeCapture(frames: PcmFrame[] | 'throw-start' | 'none', seen: { command?: string; stops?: number }): { start(onFrame: (frame: PcmFrame) => void): Promise<void>; stop(): Promise<void> } {
  return {
    start: async (onFrame: (frame: PcmFrame) => void) => {
      if (frames === 'throw-start') throw new Error('spawn ENOENT');
      if (frames === 'none') return;
      for (const f of frames) onFrame(f);
    },
    stop: async () => { seen.stops = (seen.stops ?? 0) + 1; },
  };
}

test('D1: frames received => transport ready + signal detected', async () => {
  const seen: { command?: string; stops?: number } = {};
  const result = await validateCaptureTransport('ffmpeg -i x', { createCapture: (cmd: string) => { seen.command = cmd; return fakeCapture(framesOf('tone', 5), seen); }, windowMs: 5 });
  assert.equal(result.transportReady, true);
  assert.equal(result.signalDetected, true);
  assert.equal(result.metrics.framesReceived, 5);
  assert.equal(seen.command, 'ffmpeg -i x');
  assert.equal(seen.stops, 1);
});

test('D2: silence frames => transport ready, signal low (not a failure)', async () => {
  const seen: { stops?: number } = {};
  const result = await validateCaptureTransport('cmd', { createCapture: () => fakeCapture(framesOf('silence', 4), seen), windowMs: 5 });
  assert.equal(result.transportReady, true);
  assert.equal(result.signalDetected, false);
  assert.equal(result.failure, undefined);
});

test('D3: no bytes => transport failure with safe detail', async () => {
  const seen: { stops?: number } = {};
  const result = await validateCaptureTransport('cmd', { createCapture: () => fakeCapture('none', seen), windowMs: 5 });
  assert.equal(result.transportReady, false);
  assert.ok((result.failure ?? '').includes('no audio frames'));
  assert.equal(seen.stops, 1);
});

test('D4: spawn failure => failed to start, stop attempted safely', async () => {
  const result = await validateCaptureTransport('cmd', { createCapture: () => fakeCapture('throw-start', {}), windowMs: 5 });
  assert.equal(result.transportReady, false);
  assert.equal(result.failure, 'capture failed to start');
});

test('E1: tone is deterministic 660 Hz mono 16k s16le', () => {
  const a = defaultValidationTone();
  const b = buildValidationTone(16000, 750, VALIDATION_TONE_HZ);
  assert.deepEqual(a, b);
  assert.equal(a.length, 12000 * 2);
  const level = analyzePcmLevel(a);
  assert.ok(level.rms > SILENCE_RMS_THRESHOLD);
  assert.ok(level.peak <= 32768);
});

test('E2: successful playback => transport ready with counts', async () => {
  let played = 0;
  const result = await validatePlaybackTransport('ffplay -i -', {
    createPlayback: () => ({ play: async (chunks: AsyncIterable<AudioChunk>) => { for await (const c of chunks) { played += 1; void c; } }, stop: async () => undefined }),
  });
  assert.equal(result.transportReady, true);
  assert.ok(result.chunksAccepted > 0 && result.bytesAccepted > 0);
  assert.equal(played, result.chunksAccepted);
});

test('E3: spawn failure / abnormal exit => transport failure, no disk', async () => {
  const spawnFail = await validatePlaybackTransport('cmd', { createPlayback: () => { throw new Error('ENOENT'); } });
  assert.equal(spawnFail.transportReady, false);
  const exitFail = await validatePlaybackTransport('cmd', {
    createPlayback: () => ({ play: async () => { throw new Error('code 1'); }, stop: async () => undefined }),
  });
  assert.equal(exitFail.transportReady, false);
  assert.equal(exitFail.failure, 'playback exited abnormally');
});

test('E4: tone chunks are canonical AudioChunks (no files)', () => {
  const chunks = chunkPcmForPlayback(defaultValidationTone(), 's');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.sample_rate_hz === 16000 && c.channels === 1 && c.sample_format === 's16le'));
});
/*MORE*/
