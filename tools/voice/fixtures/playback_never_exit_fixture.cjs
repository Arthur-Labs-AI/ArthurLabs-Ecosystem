'use strict';
// DEV-VOICE-CLI-1-F1: deterministic never-exit playback stub.
// Reads stdin until EOF and then never exits. Models a genuinely hung
// player: the adapter must reap it after the bounded drain deadline and
// fail closed (never resolve successfully, never wait unbounded).
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  // Intentionally never exit; hold the event loop so the child stays alive.
  setInterval(() => {}, 1000);
});
process.stdin.resume();
