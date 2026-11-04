'use strict';
// DEV-VOICE-CLI-1-F1: deterministic slow-exit playback stub.
// Reads stdin until EOF, then waits FIXTURE_DRAIN_MS before exiting with
// FIXTURE_EXIT_CODE (default 0). Models a healthy player (ffplay) draining
// real buffered audio after stdin EOF: the exit delay is *audio-duration
// driven*, independent of when PCM arrived. No audio is played.
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
let bytes = 0;
process.stdin.on('data', (c) => { bytes += c.length; });
process.stdin.on('end', () => {
  const drainMs = num('FIXTURE_DRAIN_MS', 0);
  const code = num('FIXTURE_EXIT_CODE', 0);
  setTimeout(() => { process.exit(code); }, drainMs);
});
process.stdin.resume();
