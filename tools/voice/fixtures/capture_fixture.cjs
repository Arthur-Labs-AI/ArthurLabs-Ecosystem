'use strict';
// Deterministic capture engine for ARTHUR adapter tests.
// Writes raw mono s16le PCM to stdout, one frame per FIXTURE_FRAME_MS.
// Env: FIXTURE_SAMPLE_RATE FIXTURE_FRAME_MS FIXTURE_FRAMES FIXTURE_CHUNK_SPLIT
//      FIXTURE_CHUNK_DELAY_MS FIXTURE_STALL_MS FIXTURE_EXIT_CODE
//      FIXTURE_PID_FILE FIXTURE_EXIT_MARKER FIXTURE_STDERR
const fs = require('node:fs');
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
const sampleRate = num('FIXTURE_SAMPLE_RATE', 16000);
const frameMs = num('FIXTURE_FRAME_MS', 20);
const frames = num('FIXTURE_FRAMES', 50);
const split = num('FIXTURE_CHUNK_SPLIT', 0);
const delayMs = num('FIXTURE_CHUNK_DELAY_MS', 0);
const stallMs = num('FIXTURE_STALL_MS', 0);
const exitCode = num('FIXTURE_EXIT_CODE', 0);
const silent = process.env.FIXTURE_SILENT === '1';
if (process.env.FIXTURE_PID_FILE) fs.writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid));
if (process.env.FIXTURE_STDERR) process.stderr.write(process.env.FIXTURE_STDERR);
const bytesPerFrame = Math.round((sampleRate * frameMs) / 1000) * 2;
const payload = Buffer.alloc(bytesPerFrame * frames);
for (let i = 0; i < frames; i++) {
  const value = silent ? 0 : i % 2 === 0 ? 1000 : -1000;
  for (let j = 0; j < bytesPerFrame / 2; j++) payload.writeInt16LE(value, i * bytesPerFrame + j * 2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeAll = async (buf, step) => {
  if (step > 0) {
    for (let off = 0; off < buf.length; off += step) {
      const end = Math.min(off + step, buf.length);
      if (!process.stdout.write(buf.subarray(off, end))) {
        await new Promise((r) => process.stdout.once('drain', r));
      }
    }
  } else if (!process.stdout.write(buf)) {
    await new Promise((r) => process.stdout.once('drain', r));
  }
};
const main = async () => {
  if (stallMs > 0) await sleep(stallMs);
  if (delayMs > 0 && split === 0) {
    for (let i = 0; i < frames; i++) {
      await writeAll(payload.subarray(i * bytesPerFrame, (i + 1) * bytesPerFrame), 0);
      await sleep(delayMs);
    }
  } else {
    await writeAll(payload, split);
  }
  process.stdout.end(() => {
    if (process.env.FIXTURE_EXIT_MARKER) {
      try { fs.writeFileSync(process.env.FIXTURE_EXIT_MARKER, 'exited'); } catch {}
    }
    process.exit(exitCode);
  });
};
main().catch((e) => { process.stderr.write('capture fixture error: ' + e.message + '\n'); process.exit(1); });