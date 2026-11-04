'use strict';
// Deterministic TTS engine for ARTHUR adapter tests.
// Reads plain text from stdin, then writes FIXTURE_CHUNKS chunks of
// FIXTURE_CHUNK_BYTES s16le PCM to stdout (optionally a trailer).
// Env: FIXTURE_CHUNKS FIXTURE_CHUNK_BYTES FIXTURE_TRAILER_BYTES
//      FIXTURE_CHUNK_DELAY_MS FIXTURE_STALL_MS FIXTURE_EXIT_CODE
//      FIXTURE_PID_FILE FIXTURE_EXIT_MARKER FIXTURE_STDERR FIXTURE_TEXT_FILE
const fs = require('node:fs');
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
if (process.env.FIXTURE_PID_FILE) fs.writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid));
if (process.env.FIXTURE_STDERR) process.stderr.write(process.env.FIXTURE_STDERR);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const text = Buffer.concat(chunks).toString('utf8');
  if (process.env.FIXTURE_TEXT_FILE) fs.writeFileSync(process.env.FIXTURE_TEXT_FILE, text);
  const chunkBytes = num('FIXTURE_CHUNK_BYTES', 3200);
  const chunkCount = num('FIXTURE_CHUNKS', 5);
  const trailerBytes = num('FIXTURE_TRAILER_BYTES', 0);
  const delayMs = num('FIXTURE_CHUNK_DELAY_MS', 0);
  const stallMs = num('FIXTURE_STALL_MS', 0);
  const exitCode = num('FIXTURE_EXIT_CODE', 0);
  const payload = Buffer.alloc(chunkBytes * chunkCount + trailerBytes);
  for (let i = 0; i < payload.length / 2; i++) payload.writeInt16LE(500, i * 2);
  if (stallMs > 0) await sleep(stallMs);
  for (let i = 0; i < chunkCount; i++) {
    if (!process.stdout.write(payload.subarray(i * chunkBytes, (i + 1) * chunkBytes))) {
      await new Promise((r) => process.stdout.once('drain', r));
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  if (trailerBytes > 0) {
    if (!process.stdout.write(payload.subarray(chunkCount * chunkBytes))) {
      await new Promise((r) => process.stdout.once('drain', r));
    }
  }
  process.stdout.end(() => {
    if (process.env.FIXTURE_EXIT_MARKER) {
      try { fs.writeFileSync(process.env.FIXTURE_EXIT_MARKER, 'exited'); } catch {}
    }
    process.exit(exitCode);
  });
});