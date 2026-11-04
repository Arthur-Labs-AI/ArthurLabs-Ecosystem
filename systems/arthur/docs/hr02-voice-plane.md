# HR-02 — Hybrid Voice Plane

Phase 2 of the ARTHUR Hybrid Runtime Foundation. HR-01 contracts frozen
(RoutingDecision shape, RuntimeMode locality semantics, provider-neutral
Stt/Tts/ModelProvider interfaces); this phase adds real cloud/local STT+TTS
providers and deterministic routing. No local LLM inference (HR-03).

## Architecture before

```text
VoiceController -> SttRouter{local} -> local engine|fake     (local)
VoiceController -> TtsRouter{local} -> local engine|fake     (local)
ConversationLoopRunner -> ModelRouter -> DeepSeek|fake        (cloud|local)
```

Single-provider routers, `configured_default` everywhere, no fallback.

## Architecture after

```text
ONLINE: mic -> openai-stt (cloud) -> final transcript -> ConversationLoopRunner
        -> DeepSeek (ModelRouter, unchanged) -> canonical text -> openai-tts (cloud)
LOCAL:  mic -> parakeet-stt (local) -> final transcript -> ConversationLoopRunner
        -> DeepSeek (still networked in HR-02) -> canonical text -> local TTS
```

- `SttRouter{cloud, local, policy}`: cloud_preferred (default) streams live
  to cloud while retaining a bounded copy (UtteranceTee, ~120 s, memory-only);
  on cloud failure the SAME complete utterance replays to local. local_only
  streams straight to local; cloud is never called.
- `TtsRouter{cloud, local, policy}`: cloud_preferred renders via OpenAI;
  pre-playback cloud failure re-synthesizes the SAME canonical text locally
  exactly once; post-playback failure never restarts (no stitching).
- Reasoning untouched: OpenAI voice providers receive audio/text only — never
  tools, approvals, memory, or conversation ownership.

## Configuration

```env
ARTHUR_STT_POLICY=cloud_preferred   # cloud_preferred | local_only
ARTHUR_TTS_POLICY=cloud_preferred   # cloud_preferred | local_only
ARTHUR_CLOUD_STT_MODEL=gpt-4o-transcribe
ARTHUR_CLOUD_TTS_MODEL=gpt-4o-mini-tts
ARTHUR_CLOUD_TTS_VOICE=alloy
ARTHUR_LOCAL_STT_PROVIDER=          # parakeet = Parakeet worker; empty = legacy engine
ARTHUR_LOCAL_STT_MODEL=nvidia/parakeet-tdt-0.6b-v3
OPENAI_API_KEY=                     # cloud voice only; absent => local, startup OK
```

Invalid policy enums fail closed (INVALID_CONFIG). `local_only` needs no key.

## Parakeet setup (opt-in dev machine)

```powershell
powershell -ExecutionPolicy Bypass -File tools\voice\setup_parakeet.ps1
```

Installs NeMo ASR + downloads `nvidia/parakeet-tdt-0.6b-v3`. Tests never do this.
Worker protocol: persistent process + JSONL (`{id,audio_b64,sample_rate_hz}` ->
`{id,ok,text[,language]}`), 16 kHz mono s16le, bounded lines, request-id
correlation, no shell, no secrets on CLI.

## Live acceptance

Cloud voice (needs mic/speaker + keys):

1. `Arthur, отвори Visual Studio Code.`
2. `Arthur, отвори Visual Studio Code и провери current branch-а на ARTHUR repository-то.`
3. Expect logs: STT openai-stt/cloud/cloud_preferred, Model deepseek/cloud/
   configured_default, TTS openai-tts/cloud/cloud_preferred.

Local voice:

```env
ARTHUR_STT_POLICY=local_only
ARTHUR_TTS_POLICY=local_only
ARTHUR_LOCAL_STT_PROVIDER=parakeet
```

Speak (1); expect Parakeet -> transcript -> DeepSeek (networked in HR-02) ->
local TTS. Full offline reasoning arrives in HR-03.

Cloud failure: revoke/blank the key mid-session (or block the endpoint);
complete utterance must re-transcribe via Parakeet into ONE final transcript
and ONE DeepSeek turn; TTS pre-playback failure must speak once locally.

Opt-in provider tests (paid/live, never automatic):

```powershell
ARTHUR_LIVE_OPENAI_STT=1  # + OPENAI_API_KEY
ARTHUR_LIVE_OPENAI_TTS=1  # + OPENAI_API_KEY
ARTHUR_LIVE_PARAKEET=1    # after setup_parakeet.ps1
ARTHUR_LIVE_STT_FALLBACK=1
```

See `tests/voice/hr02_live.optin.test.ts` (all skip without gates).

## Latency baselines (manual, SC-09 later)

Record: capture_end -> final transcript (+provider, fallback y/n),
model start -> final canonical text, TTS request -> first playable audio
(+provider). No optimization in HR-02.
