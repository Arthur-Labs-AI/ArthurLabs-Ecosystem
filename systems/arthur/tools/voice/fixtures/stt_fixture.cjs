'use strict';
// Deterministic STT engine for ARTHUR adapter tests.
// Reads raw s16le PCM from stdin, then writes one JSON line to stdout.
// Env: FIXTURE_JSON FIXTURE_MALFORMED FIXTURE_OVERSIZE_KB FIXTURE_STALL_MS
//      FIXTURE_EXIT_CODE FIXTURE_PID_FILE FIXTURE_EXIT_MARKER FIXTURE_STDERR
//      FIXTURE_INPUT_FILE (records received stdin byte count)
const fs = require('node:fs');
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
if (process.env.FIXTURE_PID_FILE) fs.writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid));
if (process.env.FIXTURE_ENV_FILE && process.env.FIXTURE_ENV_KEYS) {
  const envRecord = {};
  for (const key of process.env.FIXTURE_ENV_KEYS.split(',')) envRecord[key] = process.env[key];
  fs.writeFileSync(process.env.FIXTURE_ENV_FILE, JSON.stringify(envRecord));
}
if (process.env.FIXTURE_STDERR) process.stderr.write(process.env.FIXTURE_STDERR);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  if (process.env.FIXTURE_INPUT_FILE) {
    fs.writeFileSync(process.env.FIXTURE_INPUT_FILE, JSON.stringify({ bytes: input.length }));
  }
  const stallMs = num('FIXTURE_STALL_MS', 0);
  const exitCode = num('FIXTURE_EXIT_CODE', 0);
  const finish = () => {
    process.stdout.end(() => {
      if (process.env.FIXTURE_EXIT_MARKER) {
        try { fs.writeFileSync(process.env.FIXTURE_EXIT_MARKER, 'exited'); } catch {}
      }
      process.exit(exitCode);
    });
  };
  if (stallMs > 0) { setTimeout(finish, stallMs); return; }
  const oversizeKb = num('FIXTURE_OVERSIZE_KB', 0);
  if (oversizeKb > 0) {
    process.stdout.write(Buffer.alloc(oversizeKb * 1024, 0x20));
    finish();
    return;
  }
  if (process.env.FIXTURE_MALFORMED === '1') {
    process.stdout.write('this is not valid json\n');
    finish();
    return;
  }
  const json = process.env.FIXTURE_JSON || JSON.stringify({ text: 'hello from stt fixture', language: 'en', confidence: 0.9 });
  process.stdout.write(json + '\n');
  finish();
});