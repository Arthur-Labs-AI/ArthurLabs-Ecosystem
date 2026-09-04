'use strict';
// Deterministic playback sink for ARTHUR adapter tests.
// Reads stdin until EOF, records byte count and the first bytes received.
// FIXTURE_SLOW_DRAIN_MS throttles consumption to exercise backpressure.
// FIXTURE_EOF_DRAIN_MS makes the sink linger after stdin EOF before exiting
// (models ffplay draining its internal buffer on normal completion).
// Env: FIXTURE_RESULT_FILE FIXTURE_HEAD_FILE FIXTURE_SLOW_DRAIN_MS
//      FIXTURE_PID_FILE FIXTURE_EXIT_MARKER FIXTURE_STDERR
//      FIXTURE_EOF_DRAIN_MS FIXTURE_EXIT_CODE
const fs = require('node:fs');
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
if (process.env.FIXTURE_PID_FILE) fs.writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid));
if (process.env.FIXTURE_STDERR) process.stderr.write(process.env.FIXTURE_STDERR);
let bytes = 0;
let head = Buffer.alloc(0);
const slowMs = num('FIXTURE_SLOW_DRAIN_MS', 0);
process.stdin.on('data', (c) => {
  bytes += c.length;
  if (head.length < 64) {
    head = Buffer.concat([head, c]).subarray(0, 64);
  }
  if (slowMs > 0) {
    process.stdin.pause();
    setTimeout(() => process.stdin.resume(), slowMs);
  }
});
process.stdin.on('end', () => {
  const finish = () => {
    if (process.env.FIXTURE_RESULT_FILE) {
      fs.writeFileSync(process.env.FIXTURE_RESULT_FILE, JSON.stringify({ bytes }));
    }
    if (process.env.FIXTURE_HEAD_FILE) {
      fs.writeFileSync(process.env.FIXTURE_HEAD_FILE, head.toString('hex'));
    }
    if (process.env.FIXTURE_EXIT_MARKER) {
      try { fs.writeFileSync(process.env.FIXTURE_EXIT_MARKER, 'exited'); } catch {}
    }
    process.exit(num('FIXTURE_EXIT_CODE', 0));
  };
  const eofDrainMs = num('FIXTURE_EOF_DRAIN_MS', 0);
  if (eofDrainMs > 0) setTimeout(finish, eofDrainMs);
  else finish();
});
