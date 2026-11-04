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

### 13. STT Quality v2 (TASK-0008)

Real-device finding: for short English utterances with a Bulgarian accent,
whisper.cpp auto-language detection is unstable ("Count from one to twenty
slowly." was transcribed partly as Japanese under `auto`; the same audio with
`ARTHUR_STT_LANGUAGE=en` was clearly better). STT Quality v2 hardens the
local whisper.cpp path only - PTT ownership, VAD thresholds, pre-roll,
barge-in, TTS, playback, DeepSeek, ConversationService, history filtering,
and wake detection are untouched:

- Model strategy: `ggml-large-v3-turbo.bin` is the recommended primary
  desktop/server model. Paths stay configurable via `ARTHUR_STT_MODEL_PATH`
  (commented example in `.env.example`; no machine-specific path in source;
  `models/` is git-ignored). Any whisper.cpp-compatible model remains
  supported; quantized models may serve lower-resource future nodes.
- Language profiles: `en`/`bg` forward `-l <code>` verbatim; `auto` forwards
  `-l auto` (explicitly accepted by whisper-cli). `auto` stays the code-level
  default for backwards compatibility; short utterances should prefer an
  explicit profile when the expected language is known.
- Domain initial prompt: `ARTHUR_STT_INITIAL_PROMPT` flows VoiceSettings ->
  buildApp -> LocalSttProvider env -> stt_wrapper and reaches whisper-cli as
  ONE `--prompt` argv element (spawn, never a shell; empty/whitespace =
  omitted; over 2048 characters fails closed both at startup validation and
  inside the wrapper; never logged). Example vocabulary lives only in
  `.env.example`/README - never hardcoded in the provider.
- Language observability: whisper.cpp suppresses its library logs (including
  "auto-detected language: xx (p = ...)") under `-np`, so the wrapper no
  longer passes `-np`; segment stdout lines were verified byte-identical with
  and without `-np` on the installed whisper-cli. In auto mode the wrapper
  reports the detected code parsed from the engine log; explicit profiles are
  echoed as configured; if the engine logs no detection, `language` stays
  undefined (never fabricated).
- Honest confidence: whisper-cli's text output exposes no utterance-level
  transcript probability (`--print-confidence` is per-token ANSI coloring;
  real per-token probabilities exist only in the `--output-json-full` FILE
  output). `confidence` therefore stays undefined instead of being invented;
  the language-detection probability is explicitly NOT reused as confidence.
  TODO(STT-Quality-v3): derive a bounded score from `--output-json-full`
  probabilities or a scorer layered above the wrapper.
- Fallback hook: a future primary/fallback policy (explicit profile -> auto
  on empty/unusable transcript, suspicious reported language, or future
  quality score) belongs ABOVE the wrapper (controller/gateway layer,
  documented in src/voice/stt/contracts.ts); the wrapper stays single-shot
  with no hidden retries.
- Wrapper hardening: temp WAV deletion now also registers exit/SIGINT/SIGTERM
  handlers (best effort - `taskkill /F` bypasses JS handlers on Windows and
  can only leak into the OS temp directory); retained engine stderr is
  bounded (64 KiB); the single JSON result line is flushed via its write
  callback before exit.

### 14. True Wake Word v1 (TASK-0009, sherpa-onnx streaming KWS)

Decision: implement wake as REAL keyword spotting with the official
`sherpa-onnx-node` Node addon, pinned EXACTLY (`sherpa-onnx-node@1.13.7`
in package.json/package-lock; the addon binary comes from the matching
`sherpa-onnx-win-x64` platform package). The zero-dependency energy-burst
provider (`local-energy-wake`) is RETAINED unchanged as the compatibility/
fallback path - `local` keeps its old meaning everywhere (existing tests
and VAD/STT/TTS provider ids untouched); wake gets its own
`WakeProviderId = "local" | "sherpa" | "fake"` so the shared
`VoiceProviderId` is not polluted.

- Provider: `src/voice/wake/sherpa_provider.ts` (`id() = "sherpa-kws-wake"`)
  implements the existing `WakeWordProvider` contract plus `processFrame`,
  and rides the existing `WakeWordGateway` (`frameBased`) - no controller
  changes, no second microphone pipeline, no audio persistence, no network.
  The controller keeps: pause-while-speaking echo protection, WAKE_UNAVAILABLE
  degradation to PTT, and one-shot enable/disable lifecycle semantics.
- Engine isolation: the sherpa API is wrapped behind an injectable
  `SherpaKwsEngine` factory (createStream/isReady/decode/getResult/reset +
  explicit release hooks). Unit tests run against a deterministic fake; the
  native addon is only loaded when a sherpa provider actually starts.
- Model: `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` (English,
  BPE units, ~3.3M params, chunk-16-left-64). INT8 ONNX files are preferred
  automatically when present (deterministic resolution inside the configured
  model dir; fp32 fallback). Binaries stay machine-local under git-ignored
  `models/wake/`; config carries the directory, never absolute paths.
- Keywords: the literal word ("Arthur") must be BPE-encoded with the
  model's `tokens.txt` + `bpe.model` via the official sherpa text2token
  tooling (`tools/voice/setup_sherpa_wake.ps1` writes `keywords_raw.txt`
  = `Arthur @Arthur` and runs `sherpa-onnx-cli text2token --tokens-type
  bpe` into `keywords_arthur.txt`). The @display annotation is what the
  engine returns as result.keyword on a detection.
- Detection semantics: a wake fires ONLY when the normalized result equals
  the normalized configured wake word (lowercase, whitespace and
  sentencepiece U+2581 marker stripped) - keyword string OR full token
  sequence, EXACT equality; partial/substring/unrelated results never wake.
  After a detection the stream is reset immediately (KWS API requirement),
  which also guarantees one event per detection; a hard per-frame decode
  budget (64) fails closed instead of spinning if an engine misbehaves.
- Audio contract: mono s16le 16 kHz PCM frames are converted sample/32768
  into short-lived Float32Arrays ([-1, 1]); an odd trailing byte across a
  frame boundary is carried (max one byte). No audio is retained, logged,
  or persisted; long-run memory is bounded (framesProcessed counter +
  <=1 carried byte).
- Failure semantics (fail closed): missing model/keywords files or an
  unresolvable package => `available === false` => enable() degrades to
  PTT with WAKE_UNAVAILABLE (text mode unaffected). Native init failures
  reject start() with a PATH-FREE error; /v1/voice/status keeps exposing
  only provider id + availability (never paths, file names, or audio).
  Runtime KWS exceptions mark the provider failed (no further processing,
  never a fabricated wake), leaving PTT and the text path intact.
- Configuration: `ARTHUR_WAKE_MODEL_DIR`, `ARTHUR_WAKE_KEYWORDS_FILE`
  (empty = `<modelDir>/keywords_arthur.txt`), `ARTHUR_WAKE_KEYWORDS_SCORE`
  (default 1, validated 0.1..5), `ARTHUR_WAKE_KEYWORDS_THRESHOLD` (default
  0.25, validated (0..1]), `ARTHUR_WAKE_NUM_THREADS` (default 1, validated
  1..8). Defaults match the model documentation; tuning happens only after
  real-microphone acceptance, prioritizing LOW false positives.
- Tests: deterministic suite (tests/voice/sherpa_wake.test.ts) covers
  provider selection (sherpa/local/fake), id separation, tuning validation,
  env mapping, INT8-preferring file resolution, PCM conversion + odd-byte
  carry, exact-match detection (positive/negative/partial), stream reset,
  gateway pause suppression, start/stop/start lifecycle without duplicate
  handlers, fail-closed missing-model behavior, PTT independence, no audio
  retention, and bounded long-run processing. The native integration test
  (tests/voice/sherpa_wake.native.test.ts) uses the real addon + model +
  generated keywords file + piper-synthesized 16 kHz WAV fixtures
  ("Arthur" wakes; "banana"/"hello there" do not) and is skipped unless
  ARTHUR_SHERPA_WAKE_NATIVE_TEST=1 - never part of normal npm test.

Verification (TASK-0009): typecheck, build, and the full offline suites
plus the focused wake tests ran green (see the task report for the
executed commands); the guarded native KWS test ran separately with the
real model when available.

### 15. Phase 3B: Tool & Action Contracts Hardening (TASK-0010)

Phase 3B hardens the EXISTING Phase 1 tool boundary (ToolRegistry /
ToolExecutionService / ToolOrchestrator / PermissionService / signed
approval tokens); no second registry or execution framework was introduced
and no real OS tool was added.

Tool execution invariant (authoritative for every future tool task):

    LLM proposes.
    ARTHUR validates.
    ARTHUR authorizes.
    Executor executes.
    ARTHUR validates the result.
    Only then may the result return to the model.

> Tool availability is not permission.
> A model tool call is untrusted structured input, never executable authority.

Distinctions that must never be collapsed:

    Conversation != Tool Execution
    Tool Definition != Executor
    Capability != Permission
    Proposal != Authorization

Decisions:

- **Manifest validation at registration** (`src/tools/manifest.ts`): a
  ToolDefinition is validated as a whole when registered - canonical dotted
  name (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`, e.g. `git.status`; no
  spaces, shell syntax, or arbitrary Unicode), strict MAJOR.MINOR.PATCH
  version (invalid versions are rejected, never normalized), non-empty
  bounded description (<= 2000 chars; it is sent to the LLM), at least one
  valid duplicate-free `ArthurMode`, a valid `ToolRisk`, exactly the known
  manifest fields, and JSON-safe schemas. Both `input_schema` and
  `output_schema` must COMPILE with AJV (strict mode at registration) at
  `registry.register()` time. Any violation throws a deterministic
  INVALID_CONFIG ArthurError naming the field, so a malformed tool can
  never appear in the model tool schemas nor fail late during a user turn.
- **Output validation is a real boundary** (task section 4): the secured
  execution facade now validates every ToolResult before it may return:
  shape invariants (`ok` boolean, `summary` bounded string <= 2000 chars,
  no extra fields), JSON-safety of `data` (no functions, symbols, BigInt,
  undefined values, NaN/Infinity, native objects such as Date/Map/Set/RegExp,
  symbol keys, or cycles - fail closed with TOOL_OUTPUT_INVALID, never
  String(object) fallbacks or silent drops), and - when the tool declares
  `output_schema` - data must be present and match it. The task's example
  contract: a future `git.status` executor returning `{ branch: 123 }`
  fails with TOOL_OUTPUT_INVALID and the model never sees malformed data as
  a successful result. The three Phase 1 builtins now declare output_schema
  so every regression path exercises this boundary.
- **Raw executor exceptions no longer cross the boundary**: the facade wraps
  any non-ArthurError executor failure into TOOL_EXECUTION_FAILED with a
  generic, path-free message (cause attached for LOCAL sanitized logging
  only; `ArthurError.toJSON()` never serializes it). Executor errors are
  recorded as failed tool calls.
- **Tool error taxonomy** (`src/core/errors/errors.ts`): TOOL_NOT_FOUND,
  TOOL_ARGUMENT_INVALID, TOOL_PERMISSION_DENIED (new; policy rejection such
  as high_risk where the mode gate is not the reason), TOOL_EXECUTION_FAILED
  (new), TOOL_OUTPUT_INVALID (new), APPROVAL_REQUIRED, APPROVAL_INVALID.
  MODE_VIOLATION is retained (reused, not duplicated) for mode-gate
  rejections; APPROVAL_* semantics are untouched (deeper approval/version
  binding hardening belongs to TASK-0012).
- **Definition immutability preserved and tested**: registration still
  stores a deep-frozen clone; caller-side mutation after register and
  mutation attempts through registry-returned definitions have no effect on
  runtime policy (unit tests A-S assert both directions).
- **Descriptor/TOCTOU hardening (TASK-0010 follow-up)**: review found that
  validating executor-provided objects through ordinary property reads and
  returning the ORIGINAL object allowed accessor properties to show one
  value during validation and another during consumption, and let
  non-enumerable/symbol-keyed fields (which JSON silently omits) slip
  through. Fixed fail-closed: `ToolExecutionService` now validates the
  ToolResult wrapper through OWN PROPERTY DESCRIPTORS (plain prototype,
  ordinary own enumerable data properties only, exact field set), and
  `snapshotJsonSafe` recursively scans descriptors - rejecting accessors,
  non-enumerable own properties, symbol keys, class-derived arrays, arrays
  with exotic own properties/holes, plus the existing classes of invalid
  data (cycles, functions, BigInt, undefined, NaN/Infinity, non-plain
  prototypes) - while building a fresh CANONICAL key-sorted plain-data
  snapshot in the SAME single pass (each accepted value is read exactly
  once from its captured descriptor). The facade returns that snapshot, so
  later mutation of the executor-owned object graph can never change what
  crossed the boundary; output_schema validates the snapshot itself. The
  same descriptor rules guard tool manifest fields at registration.
- **Model-facing contract unchanged**: ToolDefinition -> toToolSchema() ->
  ModelRequest.toolSchemas exposes only name/description/input parameters;
  executors, permissions, output schemas, paths, and secrets stay out of
  the provider boundary. ProposedToolCall remains an untrusted proposal.
- **Deliberately deferred**: structured ToolResult.data rendering into
  model tool messages (today the model still receives the capped summary
  only; one deterministic bounded serialization policy belongs to a later
  task); deeper approval-token version binding (TASK-0012); real
  filesystem/Git/process tools (subsequent tasks); any distributed/node
  execution (Phase 4). The contracts above do not assume every executor is
  forever in-process: the invocation semantics stay
  `secured execution service -> executor -> ToolResult`.

Verification (executed on the installed whisper-cli with piper-synthesized
16 kHz speech): `-l auto` without `-np` logs "whisper_full_with_state:
auto-detected language: en (p = 0.995679)"; with `-np` that line is absent;
`-l en`/`-l bg` force profiles; `--prompt` accepts a domain string as one
argument. Regression coverage lives in tests/voice/stt_wrapper.test.ts
(profiles, prompt contract, JSON echo, honest confidence, cleanup, shell
injection), tests/voice/voice_config.test.ts, and tests/voice/local_adapters.test.ts.

### 16. Phase 3B: Local Tool Host + First Real Local Tool (TASK-0011)

Invariant:

> The local tool host provides implementations of capabilities; it is not an
> alternate authorization or execution path.

The first production machine-local capability layer lives in
`src/tools/adapters/local_system.ts`: a `LocalSystemAdapter` capability
contract with a `NodeLocalSystemAdapter` production implementation built on
Node standard APIs only (`node:os`, `process.platform/arch/version`). No
`child_process`, no shell, no network - TASK-0011 introduces no generic
command-execution primitive.

The first real local tool is `system.status` (version 1.0.0, risk `read`,
PERSONAL + BUSINESS): it reports only non-sensitive host information
(platform, arch, node_version, uptime_seconds, cpu_count, total_memory_bytes,
free_memory_bytes) under a strict `output_schema`
(`additionalProperties: false`, uptime >= 0, cpu_count >= 1, memory >= 0).
It never returns usernames, hostname, home/project paths, environment
variables, network addresses, or secrets.

Authorization and execution direction is one-way and unchanged:

    Model proposal
    -> ARTHUR secured tool boundary
       (ToolRegistry -> ToolExecutionService -> permission policy)
    -> local capability adapter (LocalSystemAdapter)
    -> real machine state
    -> validated ToolResult (snapshot + output_schema)
    -> ToolOrchestrator
    -> model follow-up

NEVER:

    Model -> local adapter directly

Composition root: `BuildDeps.localSystem` lets tests inject a deterministic
fake adapter; production defaults to `NodeLocalSystemAdapter`. The adapter is
wired into the existing registry during `buildApp()` and stays internal - the
public `App` exposes no registry, executor, or adapter handle. Model-facing
availability is the generic path only: `ToolDefinition -> registry ->
toToolSchema() -> ModelRequest.toolSchemas` - no provider-specific handling;
DeepSeek sees `system.status` exactly like every other registered tool.

## Deviations from spec (all documented)

| Item | Spec | Implementation |
| --- | --- | --- |
| Wake keyword spotter | local keyword detection | Phase 3 v1: energy-burst detector + PTT fallback (provider-abstracted); TASK-0009 added true KWS as `sherpa-kws-wake` while `local` stays the documented fallback |
| IDLE -> SPEAKING | not in table | allowed for proactive confirmations (documented extension) |
| MODEL_FAILED | not in spec | added VoiceErrorCode for streamed turn failures |
| VoiceSession.mode/wake_word | suggested fields | omitted; mode lives in the ARTHUR session, wake state in wake_enabled |

## Verification

- `npm run typecheck`, `npm run build`, `npm run test` (269 tests: 268 pass, 1 skipped - live DeepSeek contract),
  `npm run test:integration` - all green.
- Privacy: status/session payloads never leak commands, keys, paths, or
  raw audio (tests/voice/privacy.test.ts).
- TASK-0010 (Phase 3B): typecheck, build, test:unit (172 pass),
  test:integration (64 pass), test:contract (6 pass) and the full suite
  (453 tests: 407 pass, 10 skipped, 36 failing) ran on the task branch.
  The 36 failures are the SAME pre-existing voice child-process fixture
  tests that fail on the verified base HEAD in this environment (fixture
  engines cannot spawn: sandbox EPERM on piped-stdio child processes);
  the failure set is name-identical before and after TASK-0010, and the
  voice implementation is untouched. New focused suites:
  tests/unit/tool_manifest.test.ts, tests/unit/tool_boundary.test.ts,
  tests/integration/tool_contract.test.ts (33 tests).
- TASK-0010 follow-up (descriptor/TOCTOU boundary): same gates re-run on
  the follow-up commit - typecheck, build, test:unit (184 pass),
  test:integration (64 pass), test:contract (6 pass), focused suites 57
  pass; full suite 465 tests with the SAME 36 environment-blocked voice
  failures (name-identical set, spawn EPERM in this sandbox) and 12 new
  boundary tests (getters/setters, non-enumerable, symbol keys, class
  instances, mutation-after-validation snapshot independence, exotic
  arrays/holes).