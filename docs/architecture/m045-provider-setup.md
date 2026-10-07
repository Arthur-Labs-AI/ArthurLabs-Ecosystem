# M04.5 — Provider Setup & Secure Credentials

Status: implemented and acceptance-tested on the Android emulator; **uncommitted**. Schema stays **v7**. Marginalia visual language,
Recall ranking, Graph, Lineage and Project semantics are untouched.

Goal: Arthur is installable on a fresh phone and configurable entirely from the app. No adb provisioning, `.env`, or hand-written
credential file.

Evidence levels used below:

* **Verified on device**: observed on the Android emulator (Pixel_10, x86_64, API 37) with the real app and the real OpenAI API.
* **Code/test-proven**: enforced by a unit, architecture or UI test; not separately observed on a device.
* **Limitation**: not verified, or verified only in part.

## Current TTS status

**There is no text-to-speech runtime in the app.** A search of `apps/arthur` (React, Rust, Kotlin) finds none: no synthesis client, no
audio playback, no voice or model setting. TTS exists only in the separate Node runtime (`src/voice/tts/*`,
`src/runtime/local-models/runtime/managed_tts.ts`), which cannot run inside the Android app. So there is **no TTS capability, no Settings
panel and no "Test voice" action**; no fake TTS UI was exposed. `Capability` is `llm | stt | embeddings`, and a registry test asserts that
`tts` is not a capability name. Proposed follow-up: a native `tts` capability on the same OpenAI credential (speech endpoint, a
`MediaPlayer`/`AudioTrack` bridge, one voice setting) with a one-sentence "Test voice".

## Model

```
Provider credential (one per provider ACCOUNT)      Capability (what Arthur needs)         Binding
  openai ──────────────────────────────────────────  llm        gpt-4.1-mini, gpt-5-mini    llm        → openai
                                                      stt        gpt-4o-transcribe           stt        → openai
                                                      embeddings text-embedding-3-small      embeddings → openai
```

* `providers/registry.rs`: `ProviderId` (only `openai` today), `Capability`, `models(provider, capability)`. Defaults are the existing
  constants, so no model default changed. Wire names are asserted equal to the contract names (see "Bug found by acceptance").
* `providers/ai_config.rs`: `<app data>/ai/config.json` = `{version, setupCompleted, bindings}`. No secret, no consent. Missing or damaged
  means "Setup not done, default bindings".
* `providers/ai.rs` (`AiService`): `snapshot`, `set_credential`, `has_credential`, `delete_credential`, `complete_setup`, `test`, and
  `credential_for(capability)`.
* `BoundCredential` is the `CredentialSource` each provider client receives. It resolves capability → provider → secret **on every
  request**, so removing or replacing a key applies to the next call. The distiller, relation proposer/verifier and answer model share the
  `llm` source; the transcriber has `stt`; the embedder has `embeddings`.
* Pointing `llm` at another provider later means a new `ProviderId`, its endpoint and models, and a binding. The credential store, the
  commands, the contract shape and the Settings UI (a row per capability, a block per provider account) do not change. This is a design
  property; only OpenAI exists, so it has not been exercised with a second provider.

## Security architecture

| Property | Mechanism | Evidence |
|---|---|---|
| At rest, Android | `SecretsPlugin.kt`: AES-256-GCM, fresh IV per write, key generated inside the Android Keystore (`AndroidKeyStore`, non-extractable). Only IV + ciphertext (Base64) is stored, in app-private SharedPreferences `arthur_secrets`. | Verified on device: while configured, the only trace is `secret.openai` = 192 ciphertext bytes (a 165-character key), with no key-shaped ASCII inside. |
| Platform selection | `select_store(platform, keystore, dir)` is the only place a store is chosen. Android gets the Keystore store, or `UnavailableSecretStore` (set/delete fail, nothing is read or written) if the bridge is missing. Android has no path to `FileSecretStore`. | Code/test-proven: `android_never_falls_back_to_a_file_and_other_platforms_use_the_file_store`; architecture guard asserts `lib.rs` names no file store and that `select_store`'s Android arm cannot reach one. |
| At rest, desktop/dev/test | `FileSecretStore`: owner-only (0600) file in the app data directory. Desktop is a development target; a platform keychain would fit behind the same `SecretStore` trait. | Code/test-proven (0600 test). Not part of the Android acceptance. |
| Not readable from React | The contract has `setCredential` (write-only), `hasCredential`, `deleteCredential`, `testProvider`, `getAiConfig`, `completeSetup`. No operation returns a key and no payload has a field that could hold one. The Keystore plugin's commands are not Tauri commands, so the webview cannot call `readSecret`; only Rust's `AndroidKeystoreStore.get` can, for the request being sent. | Verified on device: invoking `read_secret`, `get_raw_api_key`, `plugin:arthur-secrets\|readSecret` and `…\|read_secret` from the webview all failed ("not found" / "Plugin not found"); `get_ai_config` contained no key. Code/test-proven: IPC test, contract architecture guard. |
| Not displayed | `OpenAI key •••••••• configured` is a constant chosen from a boolean. The input is `type=password`, `autocomplete=off`, cleared after every submit. Error text is chosen in the IPC layer from the error **code**, so nothing a provider or the native layer says is shown. | Code/test-proven (UI and IPC tests). |
| Not in logs | `ApiKey` has a redacting `Debug`; the Kotlin plugin never logs; the architecture test forbids logging in provider modules. | Code/test-proven; verified on device (see audit). |
| Not in SQLite, backups, APK | The store and `config.json` are outside the database. `allowBackup=false` plus explicit `dataExtractionRules` (Android 12+) and `fullBackupContent` (≤ 11) excluding every domain. Nothing is embedded in the APK. | Code/config-proven; SQLite and APK searched on device (see audit). A backup/restore round trip was not performed. |

### Bug found by acceptance

The native layer first serialised the provider as `openAi` (serde camelCase) while the contract says `openai`. The UI rejected the
native configuration and silently opened the app without Setup. Unit tests with hand-written payloads had not caught it. Fixed with an
explicit `#[serde(rename = "openai")]` and a test that every provider and capability serialises to exactly the contract name.

### Legacy credential migration

On Android, if `credentials/openai_api_key` exists (an adb-provisioned or pre-M04.5 install), `AiService::new` imports it into the
Keystore store, then overwrites and deletes the file, but only after the store confirms it holds the key (a failed import keeps the file;
an existing Keystore credential is never overwritten). An installation that already had a credential is marked "Setup completed". On
desktop the store reads that same file, so nothing moves.

**Limitation: legacy credential migration is unit-tested only. It was not acceptance-tested because fresh-install validation cleared the
previous app data.** (An accidental `pm clear` on the emulator removed the old developer-provisioned credential before the migration could
be exercised; no evidence for it was recreated.)

## Provider test

`GET {api_base}/models/{model}` for every model the capability uses, with the stored key. It authenticates the key and shows whether the
account can see the model; it requests no completion, recording or embedding, so it spends no tokens or audio and STT is tested without
recording speech. Outcomes: `connected` (2xx), `invalidCredential` (401), `unavailable` (403/404/429), `unreachable` (network, timeout,
5xx), `notConfigured` (no credential; no request is made).

* Verified on device: `connected` for `llm`, `stt` and `embeddings` with the real key; `invalidCredential` with a deliberately invalid test
  key against the real API; `unreachable` with wifi and data disabled.
* Limitation: a restricted key without model-read permission would be reported `unavailable`, not `invalidCredential`.

## First-run Setup

Shown before anything else when `setupCompleted` is false. Welcome → Connect AI → Configure speech (only where the device records) → Test →
Done. Every step can be skipped; "Set up later" is on the first page. Finishing or skipping stores only `setupCompleted`; it never touches
the Semantic Recall consent. The Done page states what works and what does not.

Completion semantics: `setupCompleted` means Setup was seen, not that anything is configured. Removing a credential later does **not**
reopen Setup (verified on device); Settings → AI & Voice is where it is configured again.

## Degraded operation

| Missing | Still works | Unavailable, and how it is shown |
|---|---|---|
| `llm` credential | Typed and voice Capture (raw); lexical Recall of already-organized ideas | Auto-organize is not attempted (captures stay "Not organized yet"); Home says "Organizing and Ask Arthur are off until you connect AI"; the Ask page says Ask Arthur can't write answers until AI is connected; native Ask returns `retrieval_only` with `llmNotConfigured` |
| `stt` credential | Typed Capture | Speak is hidden and Home says so; the Capture tab opens typing |
| `embeddings` credential | Lexical Recall | The semantic channel reports `unavailable/notConfigured` (M04B behaviour) |
| Semantic Recall OFF (default) | Lexical Recall | none |

Settings shows `OpenAI connected · Semantic Recall Off` as two separate facts. A credential never turns consent on; the consent file and
its model-key binding are untouched.

## Fresh-install acceptance

Android emulator, final APK (universal debug, x86_64), real OpenAI API.

**Verified on device**

* Complete uninstall, then confirmation that no app data or credential state remained, then a fresh install. Setup appeared with no adb
  provisioning and no `.env`.
* Degraded operation before any credential: typed Capture saved ("Not organized yet", organizing never attempted), Speak hidden with a
  notice, the Ask page explained the missing AI connection, no crash.
* The OpenAI credential was entered entirely through the Arthur UI. All three provider probes reached `connected`.
* Semantic Recall stayed **OFF** after the credential was saved and was enabled only by the explicit Settings switch. Ask with it OFF made
  0 embedding requests and uploaded 0 texts.
* STT: the real `gpt-4o-transcribe` path ran three times; each result was persisted as a Voice Capture.
* Distillation: real typed Captures produced 3 knowledge objects (a note, an idea, a task) through the production Distillation model.
* Ask Arthur: real `gpt-4.1-mini` synthesis, outcome `answered`, 1 request, no retry, citing the Task it was grounded on.
* Semantic Recall ON: 3 vectors indexed, 0 pending.
* The credential survived force-stop and relaunch with no re-entry (all probes `connected`; consent persisted).
* Removing it through Settings deleted the Keystore entry. Setup did not reopen; Speak was hidden; Ask returned `retrieval_only` with
  synthesis `unavailable/llmNotConfigured` and semantic `unavailable/notConfigured`; a typed Capture still saved and stayed "Not organized
  yet".
* Local knowledge survived removal: 3 objects, 6 captures (the sixth typed after removal), 3 vectors; consent unchanged.

**Limitations (not upgraded to stronger claims)**

1. **STT quality.** The real `gpt-4o-transcribe` call and Voice persistence were verified, but emulator-fed audio transcribed as gibberish
   (`kenapaweka`, `agrárgazdaság`, `Tartufo.`). The audio was sample WAVs routed through a virtual host microphone. This proves transport
   and runtime integration, **not** transcription quality. Real-phone microphone quality is still to be accepted.
2. **Voice Distillation.** Real voice Captures reached STT. Two completed organization with zero objects; the third was still "organizing"
   when last observed and its outcome was not seen. Typed Captures, not voice ones, are what produced objects through the production
   Distillation model.
3. **Semantic paraphrase.** With Semantic Recall ON, the query "does getting rest help me remember things better" returned the intended
   object ("Sleep and memory consolidation") as the top result with `semantic: ok`, 1 embedding request and 1 uploaded text. The same
   query was **not** run with Semantic Recall OFF, so semantic retrieval is verified operationally, but the query's dependency on the
   semantic channel is not proven by an A/B comparison.
4. **Post-removal embedding diagnostics.** After the credential was removed, diagnostics reported `embeddingRequests: 1`. That counter
   should be read as an *attempted* embedding operation. The unit test `without_a_credential_it_fails_before_touching_the_network` proves
   execution fails before any network call when there is no credential, but no packet capture was taken on the device, so "no network
   traffic" is code/test-proven, not observed.
5. **Cold-start semantic query.** The first Ask after relaunch reported semantic `unavailable`; the next succeeded (`ok`). Recorded as an
   observed transient, likely the 1.5 s query-embedding timeout on a cold start. It is not a credential-persistence failure (the probes
   were `connected` immediately before). The cause was not isolated.
6. **Legacy credential migration** is unit-tested only (see above).
7. A backup/restore or device-transfer round trip was not performed; backup exclusion is configuration-proven only.
8. Only OpenAI exists, so multi-provider binding is a design property, not exercised.

## Credential leak audit

Method: Arthur never gives the key back, so the audit searched for **any key-shaped string** (`sk-` followed by 20 or more URL-safe
characters), not the exact secret. The same search was run while the credential was configured and again after removal. Earlier in the
session an exact-string search was also run for a deliberately fake test credential, with 0 hits in the same locations.

| Location | Configured | After removal |
|---|---|---|
| App-private files (66 files, tar of the app data directory) | 0 hits | 0 hits |
| SQLite (`arthur.db` full dump) | 0 | 0 |
| SharedPreferences and other settings/config files (`shared_prefs/*.xml`, `ai/config.json`, recall settings) | 0 | 0 |
| WebView storage (`app_webview`), `localStorage`, `sessionStorage` | 0 hits; `localStorage` and `sessionStorage` had no keys | 0 |
| `credentials/` directory | empty | empty |
| logcat (full buffer) | no Authorization-header lines and no `Bearer` hits; the only key-shaped matches were Android's own task-launch log lines, where the search pattern matched the tail of a hyphenated system word ("task-…") | 0 outside that noise |
| IPC response (`get_ai_config`) | no key; only `hasCredential` booleans | same |
| Keystore-backed material | `secret.openai`: 192 ciphertext bytes, no key-shaped ASCII inside | entry **gone** |
| APK contents (929 files) | 1 file matched: strings inside `libarthur_lib.so` (two short Unicode/regex table names), unrelated library strings, not a credential | n/a |
| Raw-secret probes from the webview | none succeeded (see the security table) | same |

Not covered: the Rust diagnostics payload of a real voice session beyond the configuration and Ask responses listed above; logs produced by
a debug build outside logcat; a device backup.

## Verification

Full-suite results after the last production change: Rust 459 passed; app tests 485 passed; architecture tests 76 passed
(`check:foundation`); typecheck clean; Vite production build OK; `cargo check` OK (one old unused-method warning in `recall/answer.rs`);
Android x86_64 debug build OK. After this documentation and test-fixture cleanup: the focused checks listed in the milestone report.

## Files

Rust: `providers/{registry,secrets,ai_config,ai,probe,android_keystore}.rs`, `providers/credentials.rs` (`FileCredentialSource` is now
test-only), `commands/ai.rs`, `lib.rs`.
Android: `SecretsPlugin.kt`, `res/xml/{data_extraction_rules,backup_rules}.xml`, manifest.
Contracts: `packages/contracts/ai.ts`.
UI: `features/setup/*` (context, KeyForm, SetupFlow, AiVoiceSettings, AiOffNotice, copy, css) and small gating edits in
`App.tsx`, `providers.tsx`, `AutoOrganize`, `CaptureComposer`, `HomeScreen`, `MobileHome`, `MobileAsk`, `AskScreen`, `mobile-nav`,
`SettingsScreen`, `MobileSettings` and `evidence-model.ts`.
Tests: Rust unit tests in the new modules, `client/ai-setup.test.ts`, `features/setup/setup.test.tsx`, and credential guards in
`tests/architecture/foundation_shell.test.ts`.
