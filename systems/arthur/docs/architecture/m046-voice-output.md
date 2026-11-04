# M04.6 — TTS / Voice Output

Status: implemented and acceptance-tested on the Android emulator; **uncommitted**. Schema stays **v7**. Output only: no voice chat, wake
word, automatic speech, audio library or TTS history.

Evidence levels: **Verified on device** (Android emulator Pixel_10 x86_64, real OpenAI API), **Code/test-proven**, **Limitation**.

## Model

`tts` is a fourth capability beside `llm`, `stt` and `embeddings`, bound to a provider like the others. It reuses the OpenAI provider
credential (no second key field). Model and voice are explicit in `ai/config.json` (`"tts": {"model","voice"}`, written out on every start,
validated against the provider's allowed lists, falling back to defaults):

| | Value |
|---|---|
| Endpoint | `POST https://api.openai.com/v1/audio/speech`, `response_format: mp3` |
| Default model | `gpt-4o-mini-tts` (allowed: also `tts-1`, `tts-1-hd`) |
| Default voice | `alloy` (allowed: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar) |
| Credential | `AiService::credential_for(Capability::Tts)`, resolved from the `SecretStore` on every request |

Another provider means a new `ProviderId`, its endpoint and its `tts_options`; the contract, commands and UI do not change (design
property; only OpenAI exists).

## Native architecture

* `tts/openai.rs`: the HTTP client. Bounded: request timeout 45 s, input ≤ 4096 chars, audio ≤ 8 MB read incrementally, response must be
  audio. Failures are classified (`NotConfigured`, `Auth`, `Network`, `Unsupported`, `Provider`, `Protocol`) and never carry a provider
  body.
* `tts/chunk.rs`: deterministic splitting at paragraph and sentence boundaries (Latin and Cyrillic alike, no transliteration). First chunk
  ≤ 280 chars (fast first audio), later chunks ≤ 900, the whole job ≤ 6000 chars; text beyond that is left out and reported as
  `truncated`.
* `tts/service.rs`: one session at a time. Chunk *n+1* is fetched while *n* plays; every step re-checks the session generation, so Stop (or
  a newer session) fetches no further chunk and writes no further file. Each chunk's audio is written to ONE transient file
  (`<app cache>/tts/<random uuid>.mp3`), played, and deleted on finish, failure, cancellation or drop; the directory is wiped on startup.
  The player is a shared device, so a session takes it only after the previous owner released it.
* `tts/android.rs` + `PlaybackPlugin.kt`: `MediaPlayer` (`USAGE_MEDIA`, `CONTENT_TYPE_SPEECH`), transient audio focus, only files inside the
  app cache. Losing focus or leaving the foreground stops playback; focus and the player are released the moment audio ends. The plugin
  commands are not Tauri commands (the webview cannot call them).
* Commands: `speak_text`, `test_voice`, `stop_speech`, `get_speech_status`. No command returns audio, text, an endpoint or a credential. The
  status holds counts, a coarse state, the outcome and timings only. Pause is intentionally not offered (stop and cancel are).
* Desktop builds have no player (`UnavailablePlayer`), and the desktop client reports `speechOutput: false`, so no Listen or TTS row is
  shown there.

## UI

* Settings → AI & Voice → **Text to speech**: provider, model, voice, status, a privacy line ("Listening sends the text of the answer you
  choose to OpenAI to be spoken…"), **Test** (token-free probe) and **Test voice** (one fixed short sentence). No credential field.
  Independent of Semantic Recall consent.
* Ask Arthur: a restrained **Listen** text action under an `answered` answer (desktop and mobile share it). Never auto-plays. It becomes
  Preparing…/Stop while active, stops when the answer goes away or the screen is left, and is absent when TTS has no credential or the
  device cannot play audio. A failure shows one fixed sentence under it and never changes the answer.

## Verified on device

* TTS used the existing OpenAI connection (no new key); all four probes `connected`.
* **Test voice** produced and completed audio output, which was recorded on the host (about 3.5 s of sound for the fixed sentence, peak
  about −35 dB). Nobody listened to it: pronunciation, loudness and real-speaker quality were not evaluated.
* Bulgarian, mixed Latin/Cyrillic with punctuation (`«»`, `—`, `3.5`, `?`), and a 1,490-character mixed text (3 chunks) all synthesized and
  finished; the provider received the text as written.
* A real Ask answer: **Listen** produced audio output through to completion (recorded on the host, not listened to) (about 3.6 s to first audio). **Stop** during playback halted the audio within the
  tap, left no player or focus holder, and Listen again worked.
* Backgrounding (Home) stopped playback, released focus, deleted the file and did not resume on return.
* Removing the credential through Settings: the Keystore entry was removed, TTS reported "Needs a key", the text answer already on screen
  was untouched, and Listen disappeared. `speak_text` without a credential fails as `notConfigured` before any request.
* Re-adding the key restored TTS.
* Force-stop during playback left one abandoned file; it was removed on relaunch. After relaunch there was no speech history (session 0).
* Audit of app data (70 files) after re-adding the key: no key-shaped string, no `Bearer`, no audio file by name or header, no spoken text
  outside the user's own knowledge, no speech/tts table, schema `user_version` 7; logcat has no key-shaped string, Authorization line or
  spoken text. The only key-shaped APK match is two static strings inside `libarthur_lib.so`, unrelated to credentials.

## Performance (emulator, real provider; first chunk)

| Stage | Observed |
|---|---|
| Request startup (until the provider call began) | 0–1 ms |
| Provider synthesis | 1.1–4.6 s (fixed sentence 1.1–3.5 s; a 280-character first chunk 2.9–4.6 s; a 900-character first chunk took about 7–8 s before the small first chunk was introduced) |
| Audio decode/preparation (write file + `MediaPlayer` prepare) | 17–486 ms (typically below 150 ms) |
| Time to first audio output | 1.2–4.7 s, dominated by synthesis |
| Cleanup (delete after play) | under 1 ms (reported as 0 ms) |

Nothing blocks the UI thread: synthesis, file I/O and playback run on the native async runtime and the UI polls a small status every 350 ms
only while speaking.

## Limitations (not upgraded)

1. **Audio quality.** The emulator produced and completed audio output, which was recorded on the host. Pronunciation, loudness and
   real-speaker quality were not evaluated; they remain for the ARM64 phone acceptance.
2. The emulator's audio path is not a real device audio stack; audio-focus loss from another app (a call, other media) was **not**
   exercised on device. It is covered by the service test with a player-reported cancellation and by the plugin's focus listener.
3. Pause/resume is not implemented.
4. Time to audible depends on the provider and varied by about 4× between runs.
5. The Ask answer used for the on-device Listen test was short; long-answer chunking was verified with `speak_text` on a 1,490-character text
   (3 chunks, Stop mid-way fetched no further chunk and left no file), not with a long Ask answer.
6. **Desktop playback is not implemented in M04.6.** The desktop shell has no player, reports `speechOutput: false`, and shows no Listen or
   TTS row; this is intentional.
7. The unsupported-voice path is refused up front by the native allow-list. The provider's own 400/404 response is code/test-proven
   (`Unsupported`), not observed on device.
8. The provider's real 401/network failures for TTS were exercised through the probe and through unit tests; a failed `speak_text` on device
   was observed only for the missing-credential case.

## Tests

Rust: `tts::chunk` (7), `tts::openai` (4), `tts::service` (14 with deterministic provider and player doubles: success, each failure,
cancellation, no further chunk after stop, temp-file cleanup, repeated playback, long text, English/Bulgarian, focus loss, startup
cleanup, no text in status), `providers` (TTS binding, config explicitness, voice/model validation). App: Listen and Settings behaviour
(`features/speech/speech.test.tsx`), IPC contract (`client/ai-setup.test.ts`). Architecture: the TTS guard in
`tests/architecture/foundation_shell.test.ts` (provider/SecretStore layer, no persistence, cache-only audio, no schema change).
