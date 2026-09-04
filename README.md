# ARTHUR — Core Foundation (Phases 1–3)

ARTHUR is a small, testable conversational core: it accepts a text request,
creates a conversation turn, calls a model through a provider-agnostic
**Model Gateway**, and returns a structured response. Phase 1 implements the
foundation only — clean boundaries over feature count — as specified by
`ARTHUR_Phase_1_Core_DeepSeek_Implementation_Spec_v1.0`.

## What Phase 1 does

- Text chat through **DeepSeek V4 Flash** behind a provider-agnostic
  `ModelGateway` (DeepSeek is replaceable behind an interface).
- A deterministic **FakeProvider** for offline tests and demos.
- Persistent sessions (SQLite) with an explicit **Personal / Business** mode.
- A tool system with JSON-schema validation and an approval skeleton.
- An approval-required **Harness stub** that cannot execute without bound,
  explicit approval.
- An **HTTP API** and a **CLI** that use the same core services.
- Structured logging, tracing, usage capture, and secret redaction.
- A **local voice layer** (Phase 3): wake word, VAD, local STT, streaming
  TTS playback, barge-in, push-to-talk fallback, approval-by-voice, a
  deterministic voice state machine, HTTP control endpoints, and a
  dependency-free realtime WebSocket channel - all behind
  provider-agnostic engine boundaries.

## Repository layout

```
apps/
  api/                  HTTP entry point
  cli/                  local terminal client
src/
  core/
    conversation/       service, models, context_builder, validation
    modes/              ArthurMode
    errors/             typed error model
  models/               gateway, contracts, providers/{deepseek,fake}
  tools/                registry, contracts, orchestrator, permissions,
                        adapters/harness_stub, builtin
  sessions/             SQLite store + migrations
  observability/        logging, tracing, usage, metrics
  config/               settings, validation
  voice/                contracts, state machine, controller, audio,
                        wake/vad/stt/tts providers + gateways, realtime WS
  security/             redaction
tests/
  unit/ integration/ contract/
docs/architecture/      phase1/2/3-decisions.md
```

## Requirements

- Node.js **>= 22.5** (uses the built-in `node:sqlite`).

## Setup

```bash
npm install
cp .env.example .env   # optional; edit values
```

With no `.env`, ARTHUR runs against the offline `FakeProvider`. To use DeepSeek,
set `ARTHUR_MODEL_PROVIDER=deepseek` and provide `DEEPSEEK_API_KEY`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARTHUR_ENV` | `development` | Runtime environment |
| `ARTHUR_DB_PATH` | `./data/arthur.db` | SQLite database path |
| `ARTHUR_MODEL_PROVIDER` | `fake` | `deepseek` \| `fake` |
| `ARTHUR_MODEL_NAME` | *(empty)* | Model identifier (e.g. `deepseek-chat`) |
| `DEEPSEEK_API_KEY` | *(empty)* | DeepSeek secret |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek API base |
| `ARTHUR_MODEL_TIMEOUT_SECONDS` | `60` | Connect/read timeout |
| `ARTHUR_HISTORY_MAX_TURNS` | `20` | Prior turns in context |
| `ARTHUR_REASONING_PROFILE` | `normal` | `fast` \| `normal` \| `deep` |
| `ARTHUR_MODEL_RETRY_MAX_ATTEMPTS` | `3` | Retry budget (transient only) |
| `ARTHUR_APPROVAL_TTL_SECONDS` | `300` | Approval expiry |
| `ARTHUR_LOG_LEVEL` | `info` | Log level |
| `ARTHUR_BIND_HOST` | `127.0.0.1` | API bind host (localhost only) |
| `ARTHUR_BIND_PORT` | `8080` | API bind port |
| `ARTHUR_MEMORY_PERSONAL_DB_PATH` | `./data/memory-personal.db` | Personal memory store (SQLite) |
| `ARTHUR_MEMORY_BUSINESS_DB_PATH` | `./data/memory-business.db` | Business memory store (SQLite, physically separate) |
| `ARTHUR_EMBEDDING_PROVIDER` | `local_multilingual` | `local_multilingual` \| `fake` |
| `ARTHUR_EMBEDDING_MODEL` | `arthur-ngram-v1` | Local embedding model id |
| `ARTHUR_EMBEDDING_DIMENSIONS` | `384` | Embedding dimensions (16–2048) |
| `ARTHUR_MEMORY_MAX_RETRIEVAL_CANDIDATES` | `40` | Vector/FTS candidates before fusion |
| `ARTHUR_MEMORY_MAX_RERANKED_RESULTS` | `12` | Memories injected per turn |
| `ARTHUR_MEMORY_MAX_CONTEXT_TOKENS` | `1200` | Memory context token budget |
| `ARTHUR_MEMORY_MAX_SINGLE_CHUNK_TOKENS` | `300` | Max tokens per snippet |
| `ARTHUR_MEMORY_VECTOR_MIN_SIMILARITY` | `0.5` | Minimum cosine for vector candidates |
| `ARTHUR_MEMORY_EXTRACTION_ENABLED` | `false` | Opt-in post-turn extraction |
| `ARTHUR_MEMORY_EXTRACTION_CONFIDENCE_THRESHOLD` | `0.6` | Extraction confidence gate |
| `ARTHUR_MEMORY_EXTRACTION_IMPORTANCE_THRESHOLD` | `0.2` | Extraction importance gate |
| `ARTHUR_MEMORY_TEMPORARY_TTL_SECONDS` | `86400` | TEMPORARY memory TTL |

Configuration is validated at startup; invalid configuration fails with an
actionable message.

## Run

```bash
npm run build

# HTTP API
npm start

# CLI
npm run cli -- chat --mode personal
npm run cli -- status
npm run cli -- session <id>
npm run cli -- approve <approval-id>
npm run cli -- reject <approval-id>
npm run cli -- memory remember --session <id> --type semantic "fact to remember"
npm run cli -- memory search --session <id> "query"
npm run cli -- memory list --session <id>
npm run cli -- memory forget --session <id> <memory-id>
npm run cli -- memory status --session <id>
npm run cli -- documents add --session <id> --file notes.md --title "Notes"
npm run cli -- documents list --session <id>
```

Example API interaction:

```bash
curl http://127.0.0.1:8080/v1/turns \
  -H "content-type: application/json" \
  -d '{"mode":"personal","message":"hello","client_request_id":"1"}'

# Phase 2 memory endpoints (domain is resolved server-side from the session)
curl http://127.0.0.1:8080/v1/memory/remember \
  -H "content-type: application/json" \
  -d '{"session_id":"<id>","client_request_id":"2","text":"remember this","type":"semantic"}'
curl http://127.0.0.1:8080/v1/memory/search \
  -H "content-type: application/json" \
  -d '{"session_id":"<id>","query":"remember"}'
curl "http://127.0.0.1:8080/v1/memory?session_id=<id>"
curl -X DELETE "http://127.0.0.1:8080/v1/memory/<memory-id>?session_id=<id>"
curl http://127.0.0.1:8080/v1/documents \
  -H "content-type: application/json" \
  -d '{"session_id":"<id>","client_request_id":"3","title":"Notes","source_type":"text","content":"..."}'
```

## Voice (Phase 3)

Voice is **disabled by default** (`ARTHUR_VOICE_ENABLED=false`). Enable it in
`.env`, then control it over HTTP:

```bash
curl http://127.0.0.1:8080/v1/voice/status
curl -X POST http://127.0.0.1:8080/v1/voice/enable \
  -H "content-type: application/json" -d '{"session_id":"<id>"}'
curl -X POST http://127.0.0.1:8080/v1/voice/disable
curl http://127.0.0.1:8080/v1/voice/devices
curl -X POST http://127.0.0.1:8080/v1/voice/interrupt
curl -X POST http://127.0.0.1:8080/v1/voice/ptt/start
curl -X POST http://127.0.0.1:8080/v1/voice/ptt/stop
```

Realtime events/commands ride the WebSocket at `/v1/voice/realtime`
(no external dependencies; RFC 6455 handshake + masked frames implemented
in-repo). The same event stream is available via `app.voice.subscribe`.

Engine selection: `ARTHUR_WAKE_PROVIDER`/`ARTHUR_VAD_PROVIDER`/
`ARTHUR_STT_PROVIDER`/`ARTHUR_TTS_PROVIDER` = `local` (energy VAD,
command-based STT/TTS, energy-burst wake), `sherpa` (wake only: True Wake
Word v1, see below) or `fake` (deterministic offline stand-ins). Missing
engines never fail startup: the status endpoint reports availability and
never leaks commands, paths, keys, or raw audio. Raw audio is processed
locally and never sent to DeepSeek - only the transcript enters the
conversation (client_type=voice).

The local wake provider is a documented energy-burst detector (not a
keyword spotter); push-to-talk remains available as the fallback and the
wake path is provider-abstracted.

### True Wake Word v1 (sherpa-onnx KWS)

`ARTHUR_WAKE_PROVIDER=sherpa` enables the production wake word: a fully
local streaming keyword spotter (`sherpa-onnx-node`, pinned exact version)
running the small English GigaSpeech zipformer KWS model in-process on the
same PCM frames that already flow through the wake gateway. Detection is
strictly the literal keyword (case/whitespace/BPE-marker-insensitive exact
match) - random speech no longer wakes ARTHUR. After each detection the
KWS stream is reset; during TTS playback the gateway keeps suppressing wake
processing (echo protection); PTT stays fully independent of the KWS
lifecycle, and a missing model/package degrades to PTT-only (never a crash,
never a false wake).

`local-energy-wake` = compatibility/fallback energy detector - NOT true
keyword spotting. `sherpa-kws-wake` = production True Wake Word v1.

Windows setup (model binaries stay machine-local; `models/` is git-ignored):

1. Install the one-shot keyword converter tooling (runtime ARTHUR never
   needs Python): `pip install sherpa-onnx click sentencepiece pypinyin`
2. Download the model + generate the encoded keyword file (idempotent):
   `powershell -ExecutionPolicy Bypass -File tools\voice\setup_sherpa_wake.ps1`
   This fetches
   `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` (INT8 + FP32
   ONNX, ~18 MB) into `models/wake/`, writes `keywords_raw.txt`
   (`Arthur @Arthur`) and converts it with the model's `tokens.txt` +
   `bpe.model` via the official `sherpa-onnx-cli text2token` into
   `keywords_arthur.txt`. The raw word can NEVER be written into the
   keywords file directly - it must be BPE-encoded for the model.
3. Configure in `.env`:
   `ARTHUR_WAKE_PROVIDER=sherpa`,
   `ARTHUR_WAKE_MODEL_DIR=models/wake/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`,
   `ARTHUR_WAKE_KEYWORDS_FILE=` (empty = keywords_arthur.txt in the model dir),
   `ARTHUR_WAKE_KEYWORDS_SCORE=1`, `ARTHUR_WAKE_KEYWORDS_THRESHOLD=0.25`,
   `ARTHUR_WAKE_NUM_THREADS=1`.
4. Real-device acceptance (do not skip): say "banana" (no wake), "hello
   there" (no wake), "Arthur" (wake), "Arthur, what is Nexus?" (full
   turn), repeat "Arthur" at normal volume, and verify PTT. Tune
   `ARTHUR_WAKE_KEYWORDS_SCORE`/`_THRESHOLD` only against the real
   microphone - never against synthetic fixtures - prioritizing LOW false
   positives over 100% detection.

Native integration check (opt-in, never part of `npm test`): with the
model, keywords file and `tests/fixtures/wake/*.wav` fixtures present, run
`ARTHUR_SHERPA_WAKE_NATIVE_TEST=1 npm test` - the guarded tests feed the
real KWS "Arthur" (must wake), "banana" and "hello there" (must not wake).

### Voice - Windows setup (v1 reference)

The local engines are plain child processes with a strict stdin/stdout
contract (`child_process.spawn`, tokenized command lines, bounded buffers,
timeouts, and tree-kill cleanup - see `src/voice/process_util.ts`). Any
tool that matches the contract can be used directly; engines that do not
are bridged by the zero-dependency wrapper scripts in `tools/voice/`
(`stt_wrapper.cjs`, `tts_wrapper.cjs`).

**1. FFmpeg (capture + playback)**

- Install FFmpeg (https://www.gyan.dev/ffmpeg/builds/ - the "release"
  build includes ffplay) and add `bin` to your PATH.
- List your capture devices once:
  `ffmpeg -list_devices true -f dshow -i dummy`
- Capture - raw mono s16le at 16 kHz on stdout:
  `ARTHUR_AUDIO_CAPTURE_COMMAND="C:\ffmpeg\bin\ffmpeg.exe -f dshow -i audio=\"Microphone (Realtek(R) Audio)\" -ac 1 -ar 16000 -f s16le pipe:1"`
- Playback - read raw s16le from stdin until EOF:
  `ARTHUR_AUDIO_PLAYBACK_COMMAND="C:\ffmpeg\bin\ffplay.exe -nodisp -autoexit -f s16le -ar 16000 -ac 1 -"`

**2. whisper.cpp (STT)**

- Build or download `whisper-cli` and a model (https://github.com/ggml-org/whisper.cpp).
- Recommended primary desktop/server model: **ggml-large-v3-turbo.bin**
  (https://huggingface.co/ggml-org/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin).
  Model files are machine-local downloads - `models/` is git-ignored, never
  commit one. A quantized model may be used on lower-resource future nodes;
  any whisper.cpp-compatible `.bin` works via `ARTHUR_STT_MODEL_PATH`.
- Language profiles (STT Quality v2): `ARTHUR_STT_LANGUAGE=en | bg | auto`.
  Prefer an explicit profile whenever the expected language is known: Whisper
  auto-detection is unstable for short accented utterances (real-device A/B:
  short Bulgarian-accented English was transcribed partly as Japanese under
  `auto`; `en` was clearly better). `auto` remains the code-level default for
  unknown-language scenarios.
- Domain initial prompt: `ARTHUR_STT_INITIAL_PROMPT` (e.g. "ARTHUR, Nexus,
  AutoPulse, DeepSeek, GitHub, Engineering Mode") is passed to whisper-cli as
  one `--prompt` data argument - spawned without a shell, bounded to 2048
  characters (fail-closed), never logged, empty = disabled. Vocabulary lives
  in configuration, never hardcoded in source.
- Language/confidence observability: the wrapper JSON echoes an explicit
  profile; under `auto` it reports the language whisper.cpp auto-detected
  (parsed from its log line - which `-np` would suppress, so the wrapper no
  longer passes `-np`; undefined if the engine logs no detection). whisper-cli
  exposes no utterance-level transcript confidence in its text output, so
  `confidence` stays undefined instead of being fabricated (future hook:
  `--output-json-full` per-token probabilities; any primary/fallback retry
  policy belongs ABOVE the wrapper, which stays single-shot).
- The wrapper adapts whisper-cli's WAV-file workflow to ARTHUR's stdin PCM
  contract (temp WAV, deleted before exit; segment text extracted; one JSON
  line emitted):
  - `WHISPER_CLI="C:\whisper\build\bin\Release\whisper-cli.exe"`
  - `WHISPER_MODEL="C:\whisper\models\ggml-base.bin"`
  - `ARTHUR_STT_ENGINE_COMMAND="C:\Program Files\nodejs\node.exe \"D:\A.R.T.H.U.R\tools\voice\stt_wrapper.cjs\""`

**3. piper (TTS)**

- Download the piper 1.2.0 Windows zip and a voice, e.g.
  `en_US-lessac-medium` (https://github.com/rhasspy/piper/releases).
- The wrapper feeds text straight to `piper --output_raw` and resamples its
  native 22050 Hz output to ARTHUR's 16 kHz (streaming linear interpolation,
  no dependencies):
  - `PIPER_EXE="C:\piper\piper.exe"`
  - `PIPER_MODEL="C:\piper\voices\en_US-lessac-medium.onnx"`
  - `PIPER_VOICE_CONFIG="C:\piper\voices\en_US-lessac-medium.onnx.json"`
  - `ARTHUR_TTS_ENGINE_COMMAND="C:\Program Files\nodejs\node.exe \"D:\A.R.T.H.U.R\tools\voice\tts_wrapper.cjs\""`

**4. End-to-end `.env` (mic -> STT -> DeepSeek -> TTS -> speaker)**

```dotenv
DEEPSEEK_API_KEY=sk-...
ARTHUR_MODEL_PROVIDER=deepseek
ARTHUR_VOICE_ENABLED=true
ARTHUR_WAKE_ENABLED=true
ARTHUR_WAKE_WORD=arthur
# local = energy-burst fallback; sherpa = True Wake Word v1 (see above)
ARTHUR_WAKE_PROVIDER=local
ARTHUR_VAD_PROVIDER=local
ARTHUR_STT_PROVIDER=local
ARTHUR_TTS_PROVIDER=local
ARTHUR_STT_LANGUAGE=en
ARTHUR_STT_MODEL_PATH=C:\whisper\models\ggml-large-v3-turbo.bin
ARTHUR_STT_INITIAL_PROMPT=ARTHUR, Nexus, AutoPulse, DeepSeek, GitHub, Engineering Mode
ARTHUR_TTS_VOICE=en_US-lessac-medium
ARTHUR_AUDIO_INPUT_DEVICE=default
ARTHUR_AUDIO_OUTPUT_DEVICE=default
ARTHUR_AUDIO_CAPTURE_COMMAND="C:\ffmpeg\bin\ffmpeg.exe -f dshow -i audio=\"Microphone (Realtek(R) Audio)\" -ac 1 -ar 16000 -f s16le pipe:1"
ARTHUR_AUDIO_PLAYBACK_COMMAND="C:\ffmpeg\bin\ffplay.exe -nodisp -autoexit -f s16le -ar 16000 -ac 1 -"
ARTHUR_STT_ENGINE_COMMAND="C:\Program Files\nodejs\node.exe \"D:\A.R.T.H.U.R\tools\voice\stt_wrapper.cjs\""
ARTHUR_TTS_ENGINE_COMMAND="C:\Program Files\nodejs\node.exe \"D:\A.R.T.H.U.R\tools\voice\tts_wrapper.cjs\""
WHISPER_CLI=C:\whisper\build\bin\Release\whisper-cli.exe
WHISPER_MODEL=C:\whisper\models\ggml-large-v3-turbo.bin
PIPER_EXE=C:\piper\piper.exe
PIPER_MODEL=C:\piper\voices\en_US-lessac-medium.onnx
PIPER_VOICE_CONFIG=C:\piper\voices\en_US-lessac-medium.onnx.json
```

Start the app, then: `curl http://127.0.0.1:8080/v1/voice/status` should
report every component available. Say "arthur" (or use
`POST /v1/voice/ptt/start`), speak, and ARTHUR replies out loud. Replace
`audio="Microphone (Realtek(R) Audio)"` with the device name from the
`ffmpeg -list_devices` output, and adjust paths to your installs. Vosk or
sherpa-onnx engines that emit the documented JSON line can replace the
whisper wrapper; any `--output_raw`-style TTS can replace piper.
See `docs/architecture/phase3-decisions.md` for the full decision record.

## Test

```bash
npm test              # unit + integration (offline, deterministic)
npm run test:unit
npm run test:integration
npm run test:contract # live DeepSeek test; skipped unless DEEPSEEK_API_KEY is set
```

The normal test suite never depends on external API availability. The live
DeepSeek contract test runs only when `DEEPSEEK_API_KEY` is present.

## Architecture boundaries

- **LLM independence** — no core/business logic imports a DeepSeek SDK; all
  model calls go through `ModelGateway`.
- **Local orchestration** — conversation state, permissions scaffolding, tool
  routing scaffolding, logs, and configuration run locally.
- **Minimal remote payload** — the provider receives only the assembled turn
  context; secrets, environment, databases, and filesystem contents are never
  sent.
- **No silent tool execution** — model output cannot directly execute code,
  shell commands, or network calls; only registered executors run, after
  validation and permission checks.
- **Fail closed** — invalid provider output, invalid tool calls, missing
  permission, or malformed configuration return a controlled error.
- **Phase 2 memory isolation** — two physically separate SQLite stores
  (Personal/Business); the domain is derived only from the trusted server-side
  session record. Clients/models cannot select a domain, database, or
  namespace; any attempt fails closed (Phase 2 spec §5 North Star).
- **Local RAG, remote reasoning** — embeddings, storage, and retrieval
  (hybrid vector + FTS5 + reciprocal rank fusion + local reranker) run
  locally; DeepSeek receives only assembled, budgeted, untrusted-labeled
  memory snippets in a user-role block.
- **Untrusted memory data** — retrieved memory cannot change the system
  contract, mode contract, tool schemas, permissions, or approval rules;
  credential-like content is rejected before persistence, and documents are
  redacted with the Phase 1 sanitizer boundary.
- **Local voice, remote reasoning** — wake/VAD/STT/TTS and playback run
  locally; only the transcript reaches the model (client_type=voice); raw
  audio is never persisted, logged, or transmitted.
- **Fail-closed voice** — the deterministic state machine rejects illegal
  transitions; missing engines disable only their component (PTT fallback),
  never startup; voice errors map to stable HTTP status codes.

See `docs/architecture/phase1-decisions.md`, `phase2-decisions.md`, and
`phase3-decisions.md` for detailed decisions.

## Phase 1 non-goals

No wake word/voice, real Harness execution (stub only), autonomous agents, or
polished UI. *(RAG/embeddings/memory were Phase 1 non-goals — implemented in
Phase 2; the voice layer was a Phase 1 non-goal — implemented in Phase 3.)*