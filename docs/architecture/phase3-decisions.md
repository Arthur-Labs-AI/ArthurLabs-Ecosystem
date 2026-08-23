# Phase 3 Decisions - Local Voice Layer

Status: implemented (TASK-0004 + local runtime task). Spec: ARTHUR_Phase_3_Voice_DeepSeek_Implementation_Spec_v1.0.

## Goal and scope

A fully local voice layer in front of the existing Phase 1/2 core: wake word,
VAD, local STT, DeepSeek-backed reasoning through the existing
ConversationService/ModelGateway, local TTS, streaming playback, barge-in,
push-to-talk fallback, approval-by-voice, a deterministic voice state
machine, HTTP control endpoints and a realtime WebSocket channel.

Constraints honored: zero new npm dependencies (RFC 6455 implemented
in-repo), no raw audio ever sent to DeepSeek, engine-agnostic providers
(local engines plug in behind command/path configuration), fail-closed
semantics, and no Phase 1/2 regressions (full suite green).

## Key decisions

### 1. Provider abstraction (spec section 7)

Every engine boundary is an interface in `src/voice/contracts.ts`:
WakeWordProvider, VadProvider, SttProvider, TtsProvider, AudioCapture,
AudioPlayback. Each has `local` (command/energy based) and `fake`
(deterministic) implementations plus a metrics/availability gateway
(`src/voice/{wake,vad,stt,tts}/gateway.ts`). The controller depends only on
the gateways, so engines are swappable without touching the state machine.

### 2. Wake word: documented local limitation + PTT fallback (spec 7.1, DoD)

The local provider (`src/voice/wake/local_provider.ts`) is an energy-burst
detector, NOT a keyword spotter - a documented Phase 3 limitation. Per the
DoD, the wake path remains provider-abstracted and push-to-talk is always
available as the fallback. A real keyword engine can be added behind the
same WakeWordProvider interface (commands/config only, no controller
changes).

### 3. Deterministic voice state machine (spec 9)

`src/voice/state_machine.ts` is a fixed transition TABLE; illegal
transitions throw VOICE_STATE_INVALID (fail closed). Documented additive
deviations:

- IDLE -> SPEAKING is allowed as an extension for proactive spoken
  confirmations (mode switch, approval outcome).
- VoiceErrorCode.MODEL_FAILED added for streaming-turn model failures.

### 4. Wake/VAD echo protection (spec 18)

Wake detection is paused while ARTHUR speaks (gateway-level event drop plus
frame routing suppression). Barge-in requires sustained speech while
playback is active: speech probability >= 0.7 for >= 3 consecutive frames
(BARGE_IN_MIN_PROBABILITY / BARGE_IN_MIN_RUN in the controller).

### 5. Barge-in cancels the model stream (spec 17/18)

Barge-in and interrupt route through cancelActive: CancellationScope abort,
TTS cancel, playback stop, frame stream end, chunker reset, queue clear,
then a generation bump so in-flight callbacks cannot resurrect stale
state. The ConversationService persists the partial assistant text as an
`interrupted` audit turn (migration v6) - it is never recorded as
completed.

### 6. Approval by voice (spec 20)

A spoken "yes" binds only when exactly one unambiguous pending approval
exists for the active session (store-backed, expiry-checked). Multiple
pending approvals emit approval.ambiguous and execute nothing. Explicit
`approve <uuid>` / `yes <uuid>` binds by id (regex requires a UUID so
phrases like "yes please" can never be misread as an id). Outcomes flow
through the Phase 1 ApprovalService approve/reject path and are spoken
back.

### 7. No raw audio to the model (spec 4/privacy)

STT runs locally; only the transcript enters the conversation turn
(client_type=voice). `/v1/voice/status` and the realtime session payload
expose availability/state only - never commands, paths, secrets, or raw
audio (privacy tests assert this).

### 8. Speak pipeline (spec 16/43)

Text deltas are buffered by SpeakableChunker into sentence-boundary
chunks (with a bounded phrase fallback and hard cap), queued into a
BoundedQueue (ttsMaxQueueChunks backpressure) and consumed by a single
speak pump guarded by generation/epoch counters (stale pumps from a
cancelled turn can never emit audio). TTS never sees token-fragmented
text.

### 9. Realtime WebSocket (spec 23)

`src/voice/realtime/websocket.ts` implements RFC 6455 (handshake, masked
client frames, ping/pong, close, broadcast of voice events) with zero
dependencies. Clients sync on connect (voice.session), send commands
(voice.enable/disable, ptt.start/stop, interrupt, set_device, set_session,
mode, answer_approval), and receive the same event stream as subscribers.
A broken client can never crash the voice loop.

### 10. Real local runtime (child-process adapters)

`LocalAudioCapture`, `LocalAudioPlayback`, `LocalSttProvider` and
`LocalTtsProvider` are real `child_process.spawn` adapters (never exec):

- Commands are trusted startup config tokenized into argv by
  `splitCommandLine` (quoted segments, `\"` escapes, no shell); STT/TTS
  text or model output can never alter the executable or its arguments.
- Capture spawns the command and converts its raw mono s16le stdout into
  bounded PcmFrames at the configured rate (20 ms default); a bounded
  pending buffer drops overflow instead of growing; stop() kills and reaps
  the child; stderr is captured in a bounded tail and only ever logged
  through the secret-safe logger/sanitizer.
- STT feeds raw PCM via stdin with drain backpressure, strictly validates
  the single final JSON line ({"text", "language"?, "confidence"?}),
  enforces stdout byte and transcript length limits, waits for a natural
  exit 0 (bounded), and maps non-zero exit / malformed JSON / timeout /
  oversize to STT_FAILED. cancel() terminates the engine promptly.
- TTS sends plain text on stdin and yields raw PCM as incremental bounded
  AudioChunks (100 ms default, one-chunk lookahead puts `final` on the
  last audio chunk; short trailing PCM is kept as a final partial chunk).
  Non-zero exit / timeout / oversize throw, which the controller surfaces
  as TTS_FAILED while display text stays available.
- Playback streams chunks into the player's stdin in order with drain
  backpressure; stop() kills the child immediately (<250 ms target) and
  latches the loop so stale-generation audio can never resume after an
  interruption.
- Cleanup is bounded everywhere (kill grace + tree-kill via
  `taskkill /T /F` on Windows so wrappers cannot orphan engines); tests
  assert every spawned pid is reaped (no zombies).
- Windows v1: FFmpeg capture, FFplay playback, whisper.cpp via
  `tools/voice/stt_wrapper.cjs`, piper via `tools/voice/tts_wrapper.cjs`
  (with a streaming 22050->16000 Hz resampler). Deterministic fixture
  child processes under `tools/voice/fixtures/` drive the adapter tests
  (tests/voice/local_adapters.test.ts) - no OS audio needed in CI.
### 11. Fail-closed startup (spec 37)

Missing engines (no capture/playback/STT/TTS command, no wake provider)
never fail startup: voice reports the component unavailable (503-class
voice errors), stays disabled where capture is missing, and the text path
is unaffected. Invalid numeric configuration IS rejected at startup
(validation ranges in `src/voice/config.ts`).

### 12. Settings (spec 25)

ARTHUR_VOICE_* environment variables (see `.env.example`). Voice is
disabled by default. `Settings.voice` carries VoiceSettings; overrides in
tests may be passed nested as `{ voice: {...} }` (loadVoiceSettings
unpacks the nested bag) or flat.

## Deviations from spec (all documented)

| Item | Spec | Implementation |
| --- | --- | --- |
| Wake keyword spotter | local keyword detection | energy-burst detector; PTT fallback; provider-abstracted |
| IDLE -> SPEAKING | not in table | allowed for proactive confirmations (documented extension) |
| MODEL_FAILED | not in spec | added VoiceErrorCode for streamed turn failures |
| VoiceSession.mode/wake_word | suggested fields | omitted; mode lives in the ARTHUR session, wake state in wake_enabled |

## Verification

- `npm run typecheck`, `npm run build`, `npm run test` (269 tests: 268 pass, 1 skipped - live DeepSeek contract),
  `npm run test:integration` - all green.
- Privacy: status/session payloads never leak commands, keys, paths, or
  raw audio (tests/voice/privacy.test.ts).