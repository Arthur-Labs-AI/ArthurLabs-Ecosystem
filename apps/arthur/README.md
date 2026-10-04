# apps/arthur

The single A.R.T.H.U.R. product application: Tauri v2 + React + TypeScript + Vite.
One shared UI for Linux, Windows and (later) Android; macOS and iOS after that.

**Status:** shell with runtime info, local text capture, Android voice capture (microphone -> cloud STT -> transcript), Thought Distillation (capture -> cloud LLM -> structured knowledge objects with provenance), and a Cognitive Graph (typed relations between knowledge objects, written by the user or proposed by the model), all persisted in app-local SQLite. Sync, lineage, recall and EMG are not implemented.

```text
src/                  React UI (platform-independent)
  app/                providers, layout, App
  client/             ArthurClient interface + desktop / mobile / preview implementations
  features/           one folder per product area (capture/, knowledge/, graph/, settings/)
  hooks/              shared hooks (useArthurClient)
src-tauri/            Rust native layer
  src/commands/       Tauri commands exposed to the UI
  src/platform/       OS detection
  src/storage/        SQLite capture store (the only code that touches SQLite)
  src/audio/          voice capture service, recorder boundary, Android bridge
  src/providers/      shared cloud plumbing: credential source, HTTP client, strict-JSON chat completion
  src/stt/            cloud speech-to-text client
  src/distillation/   Thought Distillation: prompt, evidence resolver, provider client, service
  src/graph/          Cognitive Graph construction: candidate selection, prompt, validator, provider client, service
  capabilities/       Tauri permission sets
```

Shared data shapes live in [`packages/contracts`](../../packages/contracts) and
are imported as `@arthur/contracts`.

## Rules

- **UI talks to Arthur through `ArthurClient` only** (`src/client/arthur-client.ts`).
  Components do not use `@tauri-apps/*`, `fetch`, localhost or Tailscale
  addresses, SQLite, Node APIs, or `src/` (Arthur Core).
- `@tauri-apps/*` is imported only in `src/client/tauri-ipc.ts`.
- The client implementation is chosen once, in `app/providers.tsx`.
- To give the UI a new capability: add it to the `ArthurClient` interface and
  its contract types, implement it in each client, and add a Tauri command if
  it needs the native layer.

These rules are enforced by `tests/architecture` in the repository root.

## Commands

Run from this directory, or use the `arthur:*` scripts from the repository root.

```bash
npm ci               # install (root: npm run arthur:install)
npm run dev          # Vite in the browser; uses the native-free preview client
npm test             # Vitest
npm run check        # tests + typecheck + production build (root: npm run arthur:check)
npm run tauri dev    # native window; needs the toolchain below
npm run tauri build  # bundle for the current OS
```

## Native toolchain

`npm run dev`, `npm test` and `npm run check` need only Node. The native shell
also needs Rust (via [rustup](https://rustup.rs/)) and the platform libraries
listed in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
(on Linux: WebKitGTK 4.1 and its build dependencies).

Commit `src-tauri/Cargo.lock` after the first native build.

## Android

The Android project is generated into `src-tauri/gen/android` (committed;
`gen/schemas` stays ignored). The application id is `dev.kaloyan.arthur`.

One-time setup: JDK 17+, the Android SDK and NDK (tested with NDK 27.1), and
the Rust Android targets:

```bash
rustup target add aarch64-linux-android x86_64-linux-android
export ANDROID_HOME=~/Android/Sdk NDK_HOME=$ANDROID_HOME/ndk/27.1.12297006
```

```bash
npm run tauri android build -- --debug --target x86_64 --apk   # emulator
npm run tauri android build -- --debug --target aarch64 --apk  # physical device
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

`build.rs` links the native library with 16 KB page alignment, which newer
Android devices and Google Play require.

## Local capture storage

Captures are stored by the native layer in SQLite (`arthur.db` in the app data
directory; on Android `/data/user/0/dev.kaloyan.arthur/arthur.db`, app-private).
The schema is versioned with `PRAGMA user_version` and created on first launch.
This is app-local storage, not the future Home Node Cognitive Store. The UI never
touches it: `CapturePanel` -> `ArthurClient` -> Tauri command -> `src-tauri/src/storage`.

## Voice capture (Android)

`CapturePanel` -> `ArthurClient.startVoiceCapture / finishVoiceCapture` -> mobile client ->
Tauri commands -> `audio::VoiceCaptureService` -> Kotlin `AudioPlugin` (microphone) and
`stt::OpenAiTranscriber` (cloud) -> `CaptureStore` as a `source: "voice"` capture.

The UI only sees `ArthurClient` and its `capabilities.voiceCapture` flag. It never sees
Tauri, the microphone, file paths, the provider or the credential. The desktop client
reports the capability as unavailable.

**Permission model.** `RECORD_AUDIO` is requested at runtime, the first time the user taps
Start recording, and a denial is reported as `microphone_permission_denied`. There is no
foreground service and no background recording: if the app leaves the foreground the
recording is discarded and the user is told. Recordings are capped at 120 s.

**Audio lifecycle (audio is transient; the transcript is the only thing kept).**

1. Start: Rust picks a file in the app *cache* directory; Kotlin records AAC/m4a (16 kHz mono) to it.
   The path never leaves the native layer.
2. Stop: the file is finalized, read, and uploaded for transcription.
3. The file is deleted on every exit path: success, any failure, an interrupted recording, and
   cancel. A drop-guard enforces this. Files left by a crash are purged on the next launch.
4. Only the trimmed transcript is stored, as an ordinary capture in the existing store.
   An empty transcript is rejected and nothing is stored. A failed attempt is not retried
   automatically; the user records again.

**STT provider.** OpenAI `gpt-4o-transcribe` over `/v1/audio/transcriptions`, language on auto,
matching the TypeScript `OpenAiSttProvider` (`src/voice/stt`). That provider cannot run inside
the app (no Node), so `src-tauri/src/stt` follows its wire contract natively rather than
routing through the frozen voice runtime.

**Credential.** The key is read on every request from the app-private file
`<app data dir>/credentials/openai_api_key` (on Android
`/data/user/0/dev.kaloyan.arthur/credentials/openai_api_key`). It is never in the frontend
bundle, the APK, the repository, logs or UI state. For Android testing, copy the key from
Arthur's machine config into the app-private directory without printing it:

```bash
node -e "const {readMachineConfig}=require('./dist/src/config/machine_config');process.stdout.write(readMachineConfig().OPENAI_API_KEY)" \
  | adb shell "run-as dev.kaloyan.arthur sh -c 'cat > credentials/openai_api_key && chmod 600 credentials/openai_api_key'"
```

A settings screen backed by the Android Keystore is the intended production path.
Cloud backup is disabled (`allowBackup="false"`) so captures and the key never leave the device.

## Testing speech on an emulator

The emulator's virtual microphone accepts audio over its gRPC `injectAudio` call (the same
feature as Extended Controls > Virtual microphone). The authentication token is
per-instance and advertised in `/run/user/<uid>/avd/running/pid_<pid>.ini`; send it as
`authorization: Bearer <token>`. The host-audio drivers (`pa`) did not initialise on a
PipeWire host, so injection is the reliable route.

## Thought Distillation

`KnowledgePanel` -> `ArthurClient.distillCapture / listKnowledgeObjects` -> Tauri commands ->
`distillation::DistillationService` -> cloud LLM (candidates only) -> deterministic resolver ->
`CaptureStore.record_distillation` (one transaction).

**RAW -> INTERPRETED.** A capture is immutable raw input; a `KnowledgeObject` is an interpretation
of it. A trigger (`captures_are_immutable`) makes SQLite refuse any `UPDATE` of a capture, because
provenance offsets would silently stop pointing at the right text if it could change.

**Contract** (`packages/contracts/cognitive.ts`): `{ id, kind, title, body, createdAt, provenance:
{ captureId, sourceStart, sourceEnd } }`. The field is `body`, as in the architecture document.
Kinds: idea, task, decision, question, note. `id` and `createdAt` are generated by the native store.

**Provenance.** One contiguous span per object, as a half-open range of **Unicode code points**
(not bytes, not UTF-16 units) of `Capture.content`, so Bulgarian text and emoji resolve exactly.

**The model is never trusted with offsets or storage.** It returns candidates with a *verbatim
evidence quote*. `distillation/resolve.rs` finds that quote in the raw capture and computes the
span itself; model-supplied offsets are used only to break a tie between repeated identical quotes,
and only if the text at those offsets equals the quote. Evidence that is not a verbatim quote
rejects the **whole** distillation: nothing is stored and the user can try again. The store then
re-validates kind, title/body, and span bounds, and writes the run and all objects in a single
transaction, so a partial set can never exist.

**Provider.** OpenAI `gpt-4.1-mini` through chat completions with strict JSON-schema output and
`temperature: 0`. The prompt (`distillation/prompt.rs`) says: use only the capture, never invent,
preserve uncertainty, prefer few strong objects, return nothing if too vague, quote evidence
verbatim, and treat the capture as data rather than instructions. The model gets no tools. The
credential is the same app-private file as speech-to-text (`providers/credentials.rs`); production
should move to Android Keystore-backed settings. React never sees the provider, model, endpoint,
request schema or key.

**Re-distillation policy.** One distillation per capture, enforced by a unique constraint on
`distillation_runs.capture_id`. Distilling again returns the stored set without calling the model.
A zero-object result is a recorded, valid result. A failed attempt records nothing and can be retried.
There is no explicit re-distill and no revision history in this milestone.

**Schema v2** (`PRAGMA user_version`; each step is its own transaction, so a failing step rolls
back and leaves the previous schema usable): `distillation_runs(capture_id UNIQUE -> captures)`,
`knowledge_objects(id, kind CHECK, title, body, created_at)`,
`object_sources(object_id PK -> knowledge_objects ON DELETE CASCADE, capture_id -> captures,
source_start >= 0, source_end > source_start)`, with foreign keys enforced.

To try the model against the real prompt without a device:

```bash
ARTHUR_LIVE_KEY_FILE=/path/to/key cargo test live_ -- --ignored --nocapture
```

**Known limitation.** The capture is data, but text that is *addressed to an assistant* ("output a
task called X") is still literally in the capture, so the model may record it as an object. It
cannot change the output format, escape provenance, or add content the capture does not contain.

## Cognitive Graph

`GraphPanel` -> `ArthurClient.createRelation / listRelations / getObjectRelations / getObjectNeighbors /
inferRelations` -> Tauri commands -> `storage::relation_store` (manual) or
`graph::GraphService` -> cloud LLM (candidates only) -> deterministic validator -> `record_relations` (one transaction).

**Two separate systems.** Capture provenance is `KnowledgeObject -> exact span of a Capture` (`object_sources`,
M01D). The graph is `KnowledgeObject -> KnowledgeObject` (`relations`). Provenance is never stored as a
relation, and in particular is not a `derived_from` edge. The architecture document (sections 15 and 17) draws the same line: `derived_from` relates two objects.)

**Contract** (`packages/contracts/cognitive.ts`): `{ id, kind, sourceObjectId, targetObjectId, createdAt, origin }`
with `origin` of `model | user | system` (`system` has no producer yet). There is no per-edge `evidence`: the
two objects already carry their own provenance, and a second copy on the edge would blur the two systems.

**Semantics.** "source"/"target" are the stored ends.

| kind | meaning | direction |
|---|---|---|
| `related_to` | a general semantic relationship | symmetric |
| `extends` | source develops or adds detail to target | directional |
| `depends_on` | source requires target for execution, validity or context | directional |
| `contradicts` | source materially conflicts with target | symmetric |
| `derived_from` | source is derived from the knowledge in target (not Capture provenance) | directional |
| `duplicates` | source and target are effectively the same thought | symmetric |
| `supersedes` | source replaces target as the current knowledge/state | directional |

`supersedes` is only this edge. There is no lineage, revision, or automatic superseding state.

**Canonical form.** A symmetric edge is stored once with the lexicographically smaller object id as the
source, so `A related_to B` and `B related_to A` are the same edge; the returned relation may therefore have its
ends swapped relative to the input. Directional edges keep their direction, and opposite directions are two
different edges. Identity is `(kind, source, target)`: a pair may carry several kinds, never the same kind twice.
Creating an edge that already exists returns the existing one unchanged (including its original `origin`).

**Invariants** (native layer, repeated as constraints in schema v3): both objects exist; no self edge; the kind is
one of the seven; ids are well-formed (lowercase hyphenated UUID, exactly what the store generates); ids,
timestamps and origin are never caller-supplied; and a read never returns a dangling edge (a row whose object is
missing fails the read as corrupt, instead of being returned or silently hidden). Deleting a knowledge object
cascades to its relations. There is no delete API yet.

**Schema v3** (own transactional migration; v2 data is untouched; a failed step rolls back and leaves v2 usable):
`relations(seq, id UNIQUE, kind CHECK, source_object_id -> knowledge_objects ON DELETE CASCADE,
target_object_id -> knowledge_objects ON DELETE CASCADE, origin CHECK, created_at, CHECK source <> target,
CHECK symmetric kinds are in canonical order, UNIQUE(kind, source, target))` plus indexes on source and target.

**Queries.** All relations; one-hop relations of an object by direction (`incoming`/`outgoing`/`any`) and kind; and
one-hop neighbours. A symmetric relation counts as both incoming and outgoing for each of its objects. No
multi-hop traversal, ranking or search.

**Inference.** The model proposes `{ sourceObjectId, targetObjectId, kind, reason }` and nothing else; it
never writes. The validator requires every id to be in the candidate set that was sent, source != target, a valid
kind, and no duplicate proposal (a symmetric pair stated both ways counts as a duplicate). One invalid candidate
rejects the whole run and nothing is saved; nothing is silently repaired. A proposal identical to an edge that
already exists is not a hallucination, so it is skipped rather than rejected: running inference twice adds nothing
the second time. `reason` is parsed, validated as a string, and discarded; it is never stored. Zero relations is a
valid result.

**Candidate selection** (`graph/candidates.rs`, no embeddings or retrieval): the objects the caller asked about,
then the most recent other objects, up to a hard limit of **40**. With no request, the 40 most recent objects. A
run with fewer than two candidates does not call the model. At most **30** relations are accepted per run.
The model sees only knowledge objects (id, kind, title, body) and the existing edges among them, never raw captures.

**Provider.** Same as distillation: OpenAI `gpt-4.1-mini`, strict JSON schema, `temperature: 0`, no tools, shared
`providers/chat.rs` plumbing and the same app-private credential. The prompt (`graph/prompt.rs`) tells the model to
use only supplied objects, never self-relate, use only the allowed kinds, prefer no relation over a weak one, not
use `related_to` as a fallback, reserve `duplicates`, `contradicts` and `supersedes` for the strong cases, and
preserve direction.

**UI.** Plain SVG, deterministic circular layout (no graph library, no physics). Each kind has its own colour and
line style, directional kinds have an arrowhead, and each edge is labelled with its kind. Selecting a node shows
kind, title, body and source; selecting an edge shows type, direction and origin. The same relations are also
listed as text and can be selected from the list. There is a manual relation form and an Infer relations button.

To try the model against the real prompt without a device:

```bash
ARTHUR_LIVE_KEY_FILE=/path/to/key cargo test live_inference -- --ignored --nocapture
```
