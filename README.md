# A.R.T.H.U.R. — Hybrid Personal & Business AI Runtime

A.R.T.H.U.R. is a provider-neutral conversational runtime with isolated
Personal/Business memory, a secured tool-execution pipeline, cloud/local voice,
and a CLI + HTTP API over the same core services.

The current development line has moved well beyond the original Phase 1 README.
The important runtime shape today is:

```text
Voice / Text input
        |
        v
ConversationService
        |
        +--> ModelRouter --> DeepSeek (cloud today)
        |
        +--> ToolRegistry --> validation --> authorization/approval
        |                     --> ToolExecutionCoordinator --> adapters
        |
        +--> isolated Personal / Business memory

Voice input:
mic --> STT router --> final transcript --> conversation

Voice output:
final ARTHUR text --> TTS router --> speakers
```

Current hybrid voice backends:

- **Cloud STT:** OpenAI (`gpt-4o-transcribe` by default)
- **Cloud TTS:** OpenAI (`gpt-4o-mini-tts` by default)
- **Local STT:** NVIDIA Parakeet TDT 0.6B v3 on validated Windows/CUDA systems
- **Local TTS:** OmniVoice BG on validated Windows/CUDA systems
- **Lightweight local TTS:** BgTTS 38M v2 on Windows/Linux x64
- **Reasoning:** DeepSeek cloud today; local/LAN reasoning belongs to HR-03

> `arthur setup` currently configures **managed local voice models only**.
> DeepSeek/OpenAI credentials still need to be configured separately as shown
> below. Provider onboarding will be folded into setup later.

---

## Current status

Implemented foundations include:

- provider-neutral model / STT / TTS contracts and routers
- DeepSeek model provider with streaming and tool-call normalization
- OpenAI cloud STT and TTS providers
- managed local model catalog, hardware detection, recommendation, installation,
  validation, selection and persisted state
- persistent managed Python runtimes for local voice models
- isolated Personal / Business SQLite memory stores
- bounded multi-tool conversation loop
- explicit approval binding and durable tool execution lifecycle
- local system/filesystem/application/browser capability host
- read-only Git tool pack
- voice state machine, PTT, wake/VAD seams, streaming speech, barge-in and
  cloud/local fallback rules

A full Windows cloud voice turn has been live-accepted through:

```text
microphone -> OpenAI STT -> DeepSeek -> OpenAI TTS -> ffplay -> speakers
```

Local Parakeet and local TTS installation/runtime paths have also been
real-device validated on the supported platforms listed below.

---

# Fresh setup

## 1. Prerequisites

### Required everywhere

- **Git**
- **Node.js >= 22.5**
- **npm**

ARTHUR uses Node's built-in `node:sqlite`.

### Recommended Python

For the managed local voice stack, use **Python 3.12** when possible.

The Windows CUDA Parakeet and OmniVoice runtimes are validated on Python 3.12
and require Python `>=3.10,<3.14`.

On Windows, if the Microsoft Python launcher is installed:

```powershell
py -0p
$Python = py -3.12 -c "import sys; print(sys.executable)"
& $Python --version
```

Expected shape:

```text
Python 3.12.x
```

### Windows voice I/O

For microphone capture and speaker playback, install an FFmpeg build that
contains both `ffmpeg` and `ffplay`, then put them on `PATH`.

Verify:

```powershell
ffmpeg -version
ffplay -version
```

---

## 2. Clone and build

Current development branch:

```powershell
git clone https://github.com/Kaloyan3D/A.R.T.H.U.R.git
cd A.R.T.H.U.R
git switch feature/phase3-tool-runtime

npm ci
npm run build
npm link
```

`npm link` exposes the global `arthur` command for development. It is optional;
you can always use `npm run cli -- ...` instead.

Verify:

```powershell
arthur --help
arthur config path
arthur setup          # currently local models; unified FRS setup coming
arthur config show
arthur models detect
```

`arthur config path` prints the canonical machine config file
(`<app-data>/config.env`); it is CWD-independent and creates no databases.
`arthur config show` prints the effective configuration with secret values
never shown (`configured` / `not configured` only). The upcoming FRS-02/03/04
tasks populate machine config (provider credentials, voice/audio policies,
wake/PTT settings); today `setup` configures managed local voice models only.

For TypeScript validation during development:

```powershell
npm run typecheck
```

---

# Cloud configuration

## 3. Configure DeepSeek + OpenAI

The safest fresh setup is to create a **minimal** `.env` instead of copying old
legacy voice settings you may already have from an earlier checkout.

Create `D:\A.R.T.H.U.R\.env` (or `.env` in your checkout) with:

```dotenv
ARTHUR_MODEL_PROVIDER=deepseek
ARTHUR_MODEL_NAME=deepseek-chat
DEEPSEEK_API_KEY=YOUR_DEEPSEEK_KEY
DEEPSEEK_BASE_URL=https://api.deepseek.com

OPENAI_API_KEY=YOUR_OPENAI_KEY

ARTHUR_STT_POLICY=cloud_preferred
ARTHUR_TTS_POLICY=cloud_preferred
ARTHUR_CLOUD_STT_MODEL=gpt-4o-transcribe
ARTHUR_CLOUD_TTS_MODEL=gpt-4o-mini-tts
ARTHUR_CLOUD_TTS_VOICE=alloy
```

Never commit `.env`; it is git-ignored.

The two credentials are intentionally separate:

- `DEEPSEEK_API_KEY` is used for reasoning/model calls.
- `OPENAI_API_KEY` is used only by the OpenAI voice providers.

ARTHUR does not send raw microphone audio to DeepSeek. In cloud STT mode the
audio is sent to OpenAI STT, then only the final transcript enters the
conversation/model path. In cloud TTS mode the canonical final ARTHUR text is
sent to OpenAI TTS for speech rendering.

### Configuration precedence

```text
process env
  >
repo `.env` developer override
  >
machine config (<app-data>/config.env)
  >
code defaults
```

The canonical machine config is `<app-data>/config.env` (see
`arthur config path`): `%LOCALAPPDATA%\ARTHUR\config.env` on Windows,
`$XDG_DATA_HOME/arthur/config.env` or `~/.local/share/arthur/config.env` on
Linux, `~/Library/Application Support/ARTHUR/config.env` on macOS. It holds
only explicit machine/user choices - unset entries fall back to code-owned
defaults, so future default changes apply unless explicitly overridden.

Repo `.env` remains a supported **developer override** (loaded from the
current working directory), but it is no longer the production configuration
identity: `arthur` launched from the repo root, home, or any temp directory
observes the same machine config. Ambient process environment always wins
over both files, and programmatic/test `loadSettings()` overrides win over
everything. Existing `.env` installations keep working unchanged; FRS-02 may
later offer explicit migration/onboarding into machine config.

---

# Managed local voice models

## 4. Inspect hardware and recommendations

```powershell
arthur models detect
arthur models list
arthur models recommend --profile quality
arthur models status
```

The managed catalog currently contains:

| Model ID | Kind | Validated target | Notes |
| --- | --- | --- | --- |
| `parakeet-tdt-0.6b-v3` | STT | Windows x64 + CUDA | high quality, >=8 GB RAM, >=4 GB VRAM |
| `omnivoice-bg` | TTS | Windows x64 + CUDA | high quality Bulgarian, >=16 GB RAM, gated Hugging Face repo |
| `bgtts-38m-v2` | TTS | Windows x64 / Linux x64 CPU | lightweight Bulgarian + English, experimental |

The model IDs above are **ARTHUR catalog IDs**. For managed models, do not use
Hugging Face repo names as selection IDs. For example use:

```text
parakeet-tdt-0.6b-v3
```

not:

```text
nvidia/parakeet-tdt-0.6b-v3
```

unless a lower-level provider setting explicitly asks for an upstream repo ID.

---

## 5. Run the local model setup wizard

### Windows / NVIDIA

Use the explicit Python 3.12 interpreter:

```powershell
$Python = py -3.12 -c "import sys; print(sys.executable)"
arthur setup --python $Python
```

The wizard:

1. detects OS/CPU/RAM/GPU/accelerators
2. checks Python/runtime compatibility
3. ranks compatible STT/TTS models
4. shows the concrete installation plan
5. asks for approval before mutation
6. creates managed Python runtimes
7. installs/downloads model artifacts
8. runs real smoke validation
9. promotes validated installs and persists selection

On a validated NVIDIA Windows desktop, the quality recommendation is normally:

```text
STT  parakeet-tdt-0.6b-v3
TTS  omnivoice-bg
```

### OmniVoice Hugging Face access

`preslaff/omnivoice-bg` may require Hugging Face access. ARTHUR never stores or
copies your Hugging Face token. Authenticate externally if needed:

```powershell
hf auth login
```

or:

```powershell
huggingface-cli login
```

Then rerun setup.

### Non-interactive setup

```powershell
arthur setup --yes --python $Python
```

JSON mode is also non-interactive and requires `--yes`:

```powershell
arthur setup --yes --python $Python --json
```

### Explicit model selection

```powershell
arthur setup --python $Python `
  --stt-model parakeet-tdt-0.6b-v3 `
  --tts-model omnivoice-bg
```

---

## 6. Verify local model state

```powershell
arthur models status
arthur models list
arthur models validate
```

A healthy selected model should report:

```text
installed: true
configured: true
ready: true
current validation: passed
runnable: true
```

Re-running setup is intended to be idempotent. READY models are skipped instead
of being downloaded again.

Individual lifecycle commands are available when needed:

```powershell
arthur models install <model-id> --python $Python
arthur models select <model-id>
arthur models validate [model-id]
arthur models remove <model-id> --yes
arthur models status --json
arthur models list --json
```

---

# Persistent data locations

Unless overridden with `ARTHUR_DATA_DIR`, ARTHUR uses a stable per-user data
root that does not depend on the repo/current directory.

| Platform | Default data root |
| --- | --- |
| Windows | `%LOCALAPPDATA%\ARTHUR` |
| Linux | `$XDG_DATA_HOME/arthur` or `~/.local/share/arthur` |
| macOS | `~/Library/Application Support/ARTHUR` |

Managed model paths live under:

```text
<ARTHUR data root>/runtime/local-models
<ARTHUR data root>/runtime/models.json
```

Default SQLite files also derive from the same stable app-data root:

```text
arthur.db
memory-personal.db
memory-business.db
```

For isolated testing:

```powershell
$env:ARTHUR_DATA_DIR = "$env:TEMP\arthur-test"
arthur models status
```

---

# Windows microphone + speaker setup

Managed STT/TTS models do not open Windows audio devices themselves. The voice
controller uses configurable capture/playback process boundaries.

## 7. Find the microphone

```powershell
ffmpeg -list_devices true -f dshow -i dummy
```

Look for an `(audio)` entry such as:

```text
"Microphone (High Definition Audio Device)" (audio)
```

Test it independently:

```powershell
$Mic = 'Microphone (High Definition Audio Device)'

ffmpeg -hide_banner -loglevel error `
  -f dshow `
  -i "audio=$Mic" `
  -t 3 `
  -ac 1 `
  -ar 16000 `
  -y "$env:TEMP\arthur-mic-test.wav"

ffplay -hide_banner -loglevel error -nodisp -autoexit `
  "$env:TEMP\arthur-mic-test.wav"
```

Replace the microphone name with the exact device name on your system.

---

## 8. Configure capture + playback

For a first full voice test, PTT is simpler than wake-word configuration:

```dotenv
ARTHUR_VOICE_ENABLED=true
ARTHUR_WAKE_ENABLED=false

ARTHUR_AUDIO_CAPTURE_COMMAND="ffmpeg -hide_banner -loglevel error -f dshow -i audio=\"Microphone (High Definition Audio Device)\" -ac 1 -ar 16000 -f s16le pipe:1"
ARTHUR_AUDIO_PLAYBACK_COMMAND="ffplay -hide_banner -loglevel error -nodisp -autoexit -f s16le -ar 16000 -ch_layout mono -i -"
```

Important for current FFplay builds: use `-ch_layout mono` for raw PCM input.
Do **not** use the old playback example with `-ac 1`; FFplay 8.x may reject it
with `Option not found`.

The internal voice format is mono 16 kHz signed 16-bit little-endian PCM.

You can verify the playback contract directly:

```powershell
ffmpeg -hide_banner -loglevel error `
  -f lavfi -i "sine=frequency=660:duration=2" `
  -ac 1 -ar 16000 `
  -f s16le -y "$env:TEMP\arthur-tone.pcm"

cmd /c 'type "%TEMP%\arthur-tone.pcm" | ffplay -hide_banner -loglevel error -nodisp -autoexit -f s16le -ar 16000 -ch_layout mono -i -'
```

---

# Voice routing modes

## Cloud-preferred voice

```dotenv
ARTHUR_STT_POLICY=cloud_preferred
ARTHUR_TTS_POLICY=cloud_preferred
```

Runtime shape:

```text
mic
 |
 v
OpenAI STT --failure-before-final--> local STT fallback
 |
 v
final transcript
 |
 v
DeepSeek
 |
 v
canonical response text
 |
 v
OpenAI TTS --failure-before-playback--> local TTS fallback
 |
 v
speakers
```

STT fallback reprocesses the same complete utterance; ARTHUR never stitches
partial transcripts from multiple providers. TTS only falls back before usable
playback begins; once speech has started, ARTHUR does not restart/stitch the
same response with another provider.

## Local-only voice

```dotenv
ARTHUR_STT_POLICY=local_only
ARTHUR_TTS_POLICY=local_only
```

This keeps STT/TTS on the local voice providers and never calls OpenAI voice.

**This is not yet a fully offline assistant.** In the current HR-02/HR-02.5
runtime, reasoning is still DeepSeek unless you explicitly configure the fake
provider. Local/LAN LLM routing is an HR-03 responsibility.

---

# Run ARTHUR

## Text chat

```powershell
arthur chat --mode personal
arthur chat --mode personal --verbose
arthur chat --mode business --verbose
```

One-shot:

```powershell
arthur ask --mode personal "Hello Arthur"
arthur ask --mode personal --verbose "Check the local system status."
```

The CLI and HTTP API use the same `ConversationService`; the CLI is not a
second or bypass runtime.

## Voice console

After the `.env` above is configured:

```powershell
arthur voice --mode personal --verbose
```

The developer voice console uses the production `VoiceTurnController` path.
For PTT:

1. press **Enter** to start push-to-talk
2. speak
3. press **Enter** again to stop/finalize

A successful cloud turn should look conceptually like:

```text
[state] listening (push_to_talk)
[ptt] START
[state] capturing
...
[ptt] STOP
[stt.final] <transcript>
[state] thinking
...
[state] speaking
[tts] started
...
[tts] ended
```

---

# Wake word

PTT works independently of wake-word support.

The production true wake-word path uses `sherpa-onnx` KWS. The legacy `local`
wake provider is only an energy-burst compatibility fallback and is **not** a
real keyword recognizer.

For sherpa setup on a development machine:

```powershell
pip install sherpa-onnx click sentencepiece pypinyin
powershell -ExecutionPolicy Bypass -File tools\voice\setup_sherpa_wake.ps1
```

Then configure:

```dotenv
ARTHUR_WAKE_ENABLED=true
ARTHUR_WAKE_WORD=arthur
ARTHUR_WAKE_PROVIDER=sherpa
ARTHUR_WAKE_MODEL_DIR=models/wake/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01
ARTHUR_WAKE_KEYWORDS_FILE=
ARTHUR_WAKE_KEYWORDS_SCORE=1
ARTHUR_WAKE_KEYWORDS_THRESHOLD=0.25
ARTHUR_WAKE_NUM_THREADS=1
```

Tune thresholds only against a real microphone and prioritize low false
positives over maximum detection rate.

---

# Linux notes

The canonical application-data root and managed model platform are Linux-aware.
Current proven Linux local-model support is intentionally narrower than Windows:

- `bgtts-38m-v2`: validated on Linux x64 CPU
- Parakeet: currently cataloged as Windows x64 CUDA only
- OmniVoice: currently cataloged as Windows x64 CUDA only

A Linux machine with no compatible STT may legitimately receive a TTS-only
setup. That is a supported partial-capability state; STT can continue to use
cloud/LAN until another validated local backend exists.

Typical start:

```bash
npm ci
npm run build
npm link
arthur models detect
arthur setup --python "$(command -v python3)"
arthur models status
```

---

# Developer CLI reference

```text
arthur chat --mode personal|business [--session <id>] [--verbose]
arthur ask --mode personal|business [--verbose] [--json] "<message>"
arthur voice --mode personal|business [--session <id>] [--verbose]

arthur tools [--mode personal|business] [--json]
arthur tools inspect <tool-name> [--json]
arthur status [--json]
arthur session <id> [--json]
arthur approve <approval-id>
arthur reject <approval-id>

arthur models detect [--json]
arthur models list [--json]
arthur models recommend [--profile quality|balanced|lightweight] [--kind stt|tts] [--json]
arthur models install <model-id> [--reinstall] [--python <exe>] [--json]
arthur models select <model-id> [--json]
arthur models status [--json]
arthur models validate [model-id] [--json]
arthur models remove <model-id> [--yes] [--json]
arthur setup [--yes] [--stt-model <id>] [--tts-model <id>] [--python <exe>] [--json]

arthur config path [--json]
arthur config show [--json]
```

Memory/documents commands remain available through the same CLI and API.

---

# HTTP API

Build and start:

```powershell
npm run build
npm start
```

Default bind:

```text
http://127.0.0.1:8080
```

Example turn:

```bash
curl http://127.0.0.1:8080/v1/turns \
  -H "content-type: application/json" \
  -d '{"mode":"personal","message":"hello","client_request_id":"1"}'
```

Voice control endpoints include:

```text
GET  /v1/voice/status
POST /v1/voice/enable
POST /v1/voice/disable
GET  /v1/voice/devices
POST /v1/voice/interrupt
POST /v1/voice/ptt/start
POST /v1/voice/ptt/stop
```

Realtime voice events/commands use `/v1/voice/realtime`.

---

# Testing

## Deterministic suites

```powershell
npm run typecheck
npm run build
npm run test:unit
npm run test:integration
npm test
```

The normal suite must not require internet access, cloud credentials or model
downloads.

## DeepSeek live contract

With `DEEPSEEK_API_KEY` configured:

```powershell
npm run build:test
node --env-file-if-exists=.env `
  --disable-warning=ExperimentalWarning `
  --experimental-test-isolation=none `
  --test "dist/tests/contract/deepseek.live.test.js"
```

## OpenAI live STT/TTS

```powershell
$env:ARTHUR_LIVE_OPENAI_STT = "1"
$env:ARTHUR_LIVE_OPENAI_TTS = "1"

npm run build:test
node --env-file-if-exists=.env `
  --disable-warning=ExperimentalWarning `
  --experimental-test-isolation=none `
  --test "dist/tests/voice/hr02_live.optin.test.js"
```

These are paid/live opt-in tests and are not part of the normal deterministic
suite.

---

# Security and runtime boundaries

- **Provider-neutral core:** DeepSeek/OpenAI details live behind adapters.
- **Personal/Business isolation:** separate physical memory stores; domain comes
  from trusted session state, not model/user-selected database names.
- **Tool authority stays local:** model output only proposes tool calls.
  Registry validation, mode/risk policy, approval binding and execution stay in
  ARTHUR.
- **No approval bypass:** approval-required tools cannot execute directly from
  a model response.
- **Secrets are not model data:** keys are configuration, never tool/model
  payload fields and never intentionally logged.
- **Voice privacy is mode-dependent:** local-only STT keeps raw audio local;
  cloud STT sends raw utterance audio to OpenAI. Raw audio is never sent to
  DeepSeek. Cloud TTS sends final speakable text to OpenAI.
- **Fail closed:** invalid configuration/provider responses/tool calls do not
  silently widen authority.
- **Stable app-data root:** persistent state does not depend on `cwd` unless the
  operator explicitly overrides it.

---

# Repository layout

```text
apps/
  api/                     HTTP entry point
  cli/                     CLI, model commands, setup wizard

src/
  core/conversation/       conversation + multi-tool loop
  models/                  provider-neutral model gateway/providers
  runtime/                 routing, hardware discovery, local model platform
  tools/                   registry, approvals, lifecycle, capability packs
  sessions/                SQLite session store
  memory/                  isolated Personal/Business memory + retrieval
  voice/                   audio, wake, VAD, STT/TTS, controller, realtime
  observability/           logs, metrics, usage, tracing
  security/                sanitization/redaction boundaries
  config/                  settings + validation

tools/voice/               managed local voice workers/smoke utilities

tests/
  unit/
  integration/
  contract/
  voice/

docs/
  architecture/
```

---

# Current limitations / next runtime work

- `arthur setup` installs/selects local voice models but does not yet onboard
  DeepSeek/OpenAI credentials.
- Fully offline/local reasoning is not implemented yet; HR-03 owns local/LAN
  intelligence and capability routing.
- Local model support is deliberately conservative: a model/platform is not
  marked supported until that path has been validated.
- Wake-word and audio-device setup remain machine-specific.

For architecture decision records, see `docs/architecture/` and the HR-02
hybrid voice documentation under `docs/`.
