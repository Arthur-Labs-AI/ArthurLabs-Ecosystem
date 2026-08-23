# Phase 3 Completion Summary (TASK-0004)

Spec: ARTHUR_Phase_3_Voice_DeepSeek_Implementation_Spec_v1.0 — implemented.

## Delivered

- **Engine-agnostic providers** (`src/voice/contracts.ts`): WakeWordProvider,
  VadProvider, SttProvider, TtsProvider, AudioCapture, AudioPlayback — each
  with `local` (command/energy based) and `fake` (deterministic) variants,
  wrapped by gateways that record metrics and gate echo.
- **Deterministic voice state machine** (`src/voice/state_machine.ts`):
  fixed transition table, illegal transitions throw VOICE_STATE_INVALID.
  Documented extensions: IDLE→SPEAKING (proactive confirmations) and
  VoiceErrorCode.MODEL_FAILED.
- **VoiceTurnController** (`src/voice/controller.ts`): wake → VAD → local
  STT → DeepSeek streaming reasoning (existing ConversationService/
  ModelGateway) → chunked TTS → playback, with barge-in (≥0.7 probability,
  ≥3 runs while playing), interrupt, PTT, no-speech/max-utterance timeouts,
  wake echo muting, approval-by-voice (single unambiguous bind, UUID-gated
  explicit ids), generation/epoch-guarded speak pump with bounded queue.
- **Streaming model support**: ModelGateway.generateStream + ModelStreamEvent,
  DeepSeek SSE streaming with tool-call accumulation and retries; non-
  streaming providers replay a buffered response.
- **Interrupted turns** (spec 17): migration v6 (`turn_interrupted_status`);
  barge-in/interrupt persist partial assistant text with status=interrupted,
  never completed.
- **HTTP control plane** (spec 24): GET /v1/voice/status, POST
  enable/disable/devices/interrupt/ptt/start/ptt/stop with stable error
  mapping (409 busy/state, 503 unavailable, 400 transcript/timeout).
- **Realtime WebSocket** (spec 23): dependency-free RFC 6455 server at
  /v1/voice/realtime (handshake, masked frames, ping/pong, close, event
  broadcast, command dispatch).
- **Config**: ARTHUR_VOICE_* env vars (`.env.example`), voice disabled by
  default, missing engines never fail startup, numeric ranges validated.
- **Privacy**: raw audio never sent to DeepSeek, never persisted/logged;
  status/session payloads never expose commands, paths, keys, or raw audio.
- **Docs**: docs/architecture/phase3-decisions.md, README Phase 3 section.

## DoD compliance

- Local wake word "Arthur" — the local provider is a documented
  energy-burst detector (limitation documented in decisions doc and
  README), PTT remains available, wake is provider-abstracted: the DoD
  alternative path is satisfied.
- Deterministic verification: typecheck, build, test (244 tests),
  test:integration all exit 0.
- Phase 1/2 suites green (no regressions).

## Verification evidence

```
npm run typecheck       -> exit 0
npm run build           -> exit 0
npm run test            -> 244 tests, 243 pass / 1 skipped, 0 fail
npm run test:integration-> exit 0
```
---

# Addendum: Real local voice runtime (follow-up task)

Completed after TASK-0004: the four local adapters are now REAL
child-process runtimes instead of stubs.

## Delivered

- `src/voice/process_util.ts` — shared spawn plumbing: argument-safe command
  tokenizer (quoted segments, no shell), bounded stderr tails, idempotent
  kills with Windows tree-kill (`taskkill /T /F`) so wrappers cannot orphan
  engines, bounded close waits, spawn confirmation, drain-or-close waits.
- `LocalAudioCapture` (`src/voice/audio/capture.ts`) — spawns the configured
  capture command, converts raw mono s16le stdout into bounded PcmFrames
  (20 ms default), drops overflow past a buffer cap, kills/reaps on stop(),
  logs stderr only sanitized. Fails AUDIO_INPUT_UNAVAILABLE when unconfigured
  or unspawnable.
- `LocalAudioPlayback` (`src/voice/audio/playback.ts`) — streams AudioChunks
  into the player's stdin in order with drain backpressure; stop() kills
  immediately (<250 ms barge-in target) and latches so stale-generation
  audio can never resume; non-zero exit surfaces through the controller as
  TTS_FAILED.
- `LocalSttProvider` (`src/voice/stt/local_provider.ts`) — feeds raw PCM via
  stdin with backpressure, strictly validates the single final JSON line
  ({"text", "language"?, "confidence"?}), enforces stdout-byte and
  transcript-length limits, waits for natural exit 0, and maps non-zero
  exit / malformed JSON / timeout / oversize to STT_FAILED. cancel()
  terminates the engine promptly. Never network; raw audio never leaves.
- `LocalTtsProvider` (`src/voice/tts/local_provider.ts`) — sends plain text
  via stdin; yields raw PCM as incremental bounded AudioChunks (100 ms
  default) with the final flag on the last chunk (one-chunk lookahead) and
  short trailing PCM kept as a final partial chunk; timeout/non-zero exit/
  oversize throw (controller => TTS_FAILED, display text preserved).
- `tools/voice/stt_wrapper.cjs` — Windows whisper.cpp bridge (temp WAV,
  segment-text extraction, one JSON line, env-configured).
- `tools/voice/tts_wrapper.cjs` — Windows piper bridge (`--output_raw`,
  streaming 22050→16000 Hz linear-interpolation resampler).
- `tools/voice/fixtures/*.cjs` — deterministic fixture engines (capture,
  stt, tts, playback sink) used by the adapter tests; no OS audio in CI.
- `tests/voice/local_adapters.test.ts` (27 tests) — PCM streaming,
  fragmented chunks, child crash, unavailable/missing commands, STT happy
  path + length cap + malformed + oversize + non-zero exit + timeout +
  cancellation, TTS incremental chunks + trailing partial + cancellation +
  timeout + mid-stream crash, playback ordering + backpressure +
  interruption, no-zombie reaping across all four adapters, stderr
  secret sanitization, startup status availability.
- README 'Voice - Windows setup' + `.env.example` reference block: exact
  FFmpeg/whisper.cpp/piper install steps and end-to-end .env values.

## Verification evidence (all exit 0)

```
npm run typecheck        -> exit 0
npm run build            -> exit 0
npm run test             -> 269 tests: 268 pass / 1 skipped (live DeepSeek), 0 fail
npm run test:integration -> 51/51 pass
```

Security invariants preserved: commands only from trusted startup config,
STT/TTS text never influences argv, raw audio never persisted/logged/sent,
stderr logged only via secret-safe sinks, status/session payloads expose
availability only, and every spawned child is reaped (no zombies).