# apps/arthur

The single A.R.T.H.U.R. product application: Tauri v2 + React + TypeScript + Vite.
One shared UI for desktop and Android; platform qualification is tracked separately.

**Status:** local text capture, Android voice capture, validated Thought Distillation,
projects, Cognitive Graph relations, immutable Thought Lineage, recall and
review-first evolution, persisted in app-local SQLite. M05 sync is a dormant
qualification candidate: production stays schema v9 with closed trust/LAN
activation. EMG integration is not implemented. See the
[current product overview](../../README.md) and
[M05 readiness gates](../../docs/architecture/m05-activation-readiness.md).

```text
src/                  React UI (platform-independent)
  app/                providers, navigation, shell (rail + global Capture), App, design tokens (app/styles)
  assets/fonts/       bundled Onest and JetBrains Mono, Latin + Cyrillic (OFL licences alongside)
  client/             ArthurClient interface + desktop / mobile / preview implementations
  components/         shared presentational pieces (icons, kind glyphs, margin, source quote, relation art, time wording)
  features/           one folder per product area (capture/, home/, ideas/, knowledge/, graph/, lineage/, settings/)
  hooks/              shared hooks (useArthurClient)
src-tauri/            Rust native layer
  src/commands/       Tauri commands exposed to the UI
  src/platform/       OS detection
  src/storage/        SQLite capture store (the only code that touches SQLite)
  src/audio/          voice capture service, recorder boundary, Android bridge
  src/providers/      shared cloud plumbing: credential source, HTTP client, strict-JSON chat completion
  src/stt/            cloud speech-to-text client
  src/distillation/   Thought Distillation: prompt, evidence resolver, provider client, service
  src/lineage/        Thought Lineage: the deterministic revision diff and the lineage error type
  src/graph/          Cognitive Graph construction: candidate selection, prompt, validator, provider client, service
  capabilities/       Tauri permission sets
```

Shared data shapes live in [`packages/contracts`](../../packages/contracts) and
are imported as `@arthur/contracts`.

## Desktop UI ("Thoughtspace")

The UI is moving from the earlier "Marginalia" language to **Thoughtspace** (approved prototypes in
[`docs/design/thoughtspace`](../../docs/design/thoughtspace); status and deviations in its `implementation-notes.md`).
Tokens live in `src/app/styles/tokens.css`; dark is the default and `data-theme="light"` on `<html>` switches to light.
The older Marginalia notes remain in [`docs/design/implementation-notes.md`](../../docs/design/implementation-notes.md).

Screens: **Home** (composer, today's captures grouped by capture, a connected-thinking preview, recently evolving),
**Ideas** (list + inspector), **Connections** (the map), **Evolution** (revision rail), **Settings**. Capture is a global
action (Ctrl/⌘ N), not a screen.

**Auto-organize.** After a Capture is persisted (typed or voice), the UI starts distilling it. The order and guarantees:

1. `createCapture` / `finishVoiceCapture` persist the raw Capture first. Nothing else has happened yet.
2. Only after that resolves does `AutoOrganize` ask `useKnowledge().distill(captureId)`. It is a subscriber that cannot fail or
   delay a capture (its errors are swallowed in `useCaptures`).
3. Requests are served one at a time, in order. Home shows "Arthur is organizing…" (or "Waiting to organize…").
4. A failure becomes that capture's retryable job ("Couldn't organize this capture. Your words are saved."). The Capture is
   untouched. The UI never builds a knowledge object: it only shows what `listKnowledgeObjects` returns, so a failed or
   untrustworthy run leaves no partial objects (the native distillation is all-or-nothing).
5. Captures that already existed when the app opened are **not** organized automatically. They show "Not organized yet" with
   an Organize button.

Colour means a relation or a state, never a category: idea kinds are shapes, relation kinds are line geometry
(`RELATION_GEOMETRY`), the single accent marks current / focus / selection. Do not add colour per kind.

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
touches it: `CaptureComposer` -> `ArthurClient` -> Tauri command -> `src-tauri/src/storage`.

## Voice capture (Android)

`CaptureComposer` -> `ArthurClient.startVoiceCapture / finishVoiceCapture` -> mobile client ->
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

`AutoOrganize` / `useKnowledge` -> `ArthurClient.distillCapture / listKnowledgeObjects` -> Tauri commands ->
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

**Provider.** OpenAI `gpt-6-luna` (reasoning effort `none`, no sampling parameter; an approved migration from `gpt-4.1-mini`, see
`docs/architecture/gpt6-luna-migration.md`) through chat completions with strict JSON-schema output. The prompt (`distillation/prompt.rs`) says: use only the capture, never invent,
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

`ConnectionsScreen` -> `ArthurClient.createRelation / listRelations / getObjectRelations / getObjectNeighbors /
inferRelations` -> Tauri commands -> `storage::relation_store` (manual) or
`graph::GraphService` -> cloud LLM (propose, then verify) -> deterministic validation -> `record_relations` (one transaction).

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

**Inference (M02.1: two stages, no storage change).** The model never writes to the graph.

```text
bounded candidate objects (<= 40: the ones you ask about, then the most recent)
  -> Stage A   model proposes relation candidates (<= 20)                       [request 1]
  -> validate  ids, kinds, no self edge, no duplicate, inside the candidate set
  -> drop      candidates that are already durable edges (no verification, no write)
  -> Stage B   model verifies kind + direction of every survivor, twice:         [requests 2, 3]
               one batch per vote, the pair listed in opposite orders
  -> gates     deterministic rules over each vote, then agreement between the votes
  -> validate  the same structural checks again, on the verified set
  -> store     one transaction (`record_relations`)
```

Stage A (`graph/prompt.rs`) is told to prefer a short list of strong candidates; Stage B (`graph/verify_prompt.rs`)
re-judges each one from the two objects' own text. Both prompts render their kind definitions from one table
(`graph/semantics.rs`), so they cannot disagree. The model sees only knowledge objects (id, kind, title, body), never raw
captures; the verifier additionally never sees Stage A's reasoning or the direction Stage A chose.

**Why the verifier is built this way (measured, not assumed).** With real calls on a controlled dataset:
a verifier shown Stage A's `source -> target` was *anchored* by it and confirmed a backwards dependency; asking it to
*pick* a direction (`first|second`) showed a position bias; a single sample sometimes flipped a correct direction.
So the verifier is shown each pair in a neutral order, rates the two claims `first KIND second` and
`second KIND first` separately (`strong|weak|none`), and native code (`verify::orient`) derives the direction from the
ratings. The batch is verified twice with the pair listed in opposite orders, and an edge is kept only if both votes
reach the same kind and direction. Whether a result counts as accepted, reversed or reclassified is computed by comparing
with Stage A, not taken from a label the model writes. Direction is never inferred from id order; lexical order is used
only by storage canonicalization of symmetric kinds.

**Gates** (all must hold for a verdict to become an edge; otherwise it is a semantic rejection):

1. confidence is `high`. `medium` and `low` are rejected. Confidence is a decision for the run, never stored.
2. `explicitLink`: the objects' own words state or clearly imply the link. A shared project, topic, product or
   vocabulary, mere recency, or the model's outside knowledge is not enough.
3. the chosen orientation is rated `strong`.
4. for a directional kind (`extends`, `depends_on`, `derived_from`, `supersedes`) the opposite orientation is not
   also `strong`. If both are, the direction is ambiguous and the edge is rejected; if neither is, there is no
   defensible direction. A reversal happens only when the opposite direction is clearly the supported one.
5. `supersedes` additionally requires the replacement not to be older than what it replaces (recency alone never
   proves replacement, but replacement by an older object is rejected outright).
6. the decision label must agree with the kind it names, otherwise that verdict is dropped.
7. both votes must agree on kind and direction; a vote that keeps and a vote that rejects count as disagreement.

**Relation-specific rules** (the shared table, used by both prompts):

| kind | use only when | do not use when |
|---|---|---|
| `related_to` | the text states or clearly implies a specific link that would help recall, and no stronger kind applies | they only share a project, topic, theme or vocabulary; never a fallback |
| `extends` | A clearly enriches a more general B | both merely discuss similar things, or B is the richer one |
| `depends_on` | A could not work, be true or be carried out without B, and B does not equally need A | B merely helps, or each needs the other; a note that X must come before Y is about X, and Y depends on X |
| `contradicts` | accepting one means rejecting the other | they simply differ or cover different parts of a subject |
| `derived_from` | A is a real conceptual consequence of B | they share a topic, or came from related captures |
| `duplicates` | meaning and intent are near-equivalent | one adds detail or scope (that is `extends`) |
| `supersedes` | the text shows A replaces, updates or reverses B | A is merely newer or on the same subject |

**Two kinds of "no".** *Malformed* output from either stage (bad JSON, an out-of-vocabulary value, a missing,
duplicate or out-of-range verdict, an unknown kind, more proposals than the cap) and any provider failure reject the
whole run: nothing is written and the error is retryable. A candidate that the verifier *legitimately declines*
(reject, medium/low confidence, no explicit link, unclear or disputed direction, disagreeing votes, a self-contradicting
label) is not an error: it is dropped and only the verified remainder is persisted. Zero relations is a valid result,
and an edge that already exists is skipped, so repeating inference never duplicates anything.

**Cost bound.** Candidates <= 40; Stage A relations <= 20; verified relations <= 20 (each judged by two votes in two
batched requests); provider requests per run **<= 3** (1 proposal + 2 votes), however many objects there are. Nothing loops
over the provider (an architecture test pins the call sites). With nothing proposed, or every candidate already stored,
the verifier is not called (1 request). Fixed prompt text is ~1.3k tokens per request plus ~100 tokens per object or
candidate; a run took about 10 s end to end.

**Models** (`providers/chat.rs`, `graph/openai.rs`). Stage A: `gpt-4.1-mini`, strict JSON schema, `temperature: 0`.
Stage B: `gpt-6-luna` with `reasoning_effort: none` (an approved migration from `gpt-5-mini` at effort `low`; Luna on Stage B has NOT been
re-measured, and the table below is the historical record of the earlier models). No tools,
the same app-private credential. Measured on the same two controlled datasets (A: the M02 acceptance objects plus weak
same-project pairs; B: relations stated explicitly in the objects' text; "wanted" = a correct edge persisted):

| verifier (rating-based design) | runs per dataset | forbidden edges persisted | wanted edges found |
|---|---|---|---|
| `gpt-4.1-mini` | 8 | 0 | 3 / 32 |
| `gpt-4.1` | 8 | 0 | 7 / 32 |
| `gpt-5` (effort low) | 6 | 0 | 9 / 24 |
| `gpt-5-mini` (effort low) | 6 | 0 | 13 / 24 |

Every configuration was safe; they differ in how many correct edges survive the two-vote agreement. Earlier verifier
designs, before the ratings/neutral-order redesign above, did persist a reversed dependency (1 in 10 runs).
Occasionally Stage A copies an id wrongly, which rejects that run as malformed (about 1 in 20 Stage A calls).

HISTORICAL: the configuration shipped when this was measured (`gpt-4.1-mini` proposer, `gpt-5-mini` verifier) over 20 further runs (10 per dataset): 0 forbidden
edges, 0 technical failures, exactly 3 requests per run, 16 / 40 wanted edges.

**UI.** Plain SVG, deterministic circular layout (no graph library, no physics). Each kind has its own colour and
line style, directional kinds have an arrowhead, and each edge is labelled with its kind. Selecting a node shows
kind, title, body and source; selecting an edge shows type, direction and origin. The same relations are also
listed as text and can be selected from the list. There is a manual relation form and an Infer relations button.

To try the model against the real prompt without a device:

```bash
ARTHUR_LIVE_KEY_FILE=/path/to/key ARTHUR_LIVE_RUNS=10 cargo test live_inference -- --ignored --nocapture
```

The harness runs both controlled datasets, prints what each stage proposed and judged in the same run, fails on any forbidden
edge, and accepts `ARTHUR_LIVE_PROPOSER_MODEL` / `ARTHUR_LIVE_VERIFIER_MODEL` to compare models.

## Thought Lineage

`EvolutionScreen` -> `ArthurClient.getObjectLineage / updateKnowledgeObject / createRevisionFrom / mergeRevisions /
diffRevisions / ...` -> Tauri commands -> `storage::lineage_store` (the only code that writes revisions) and
`lineage::diff` (the deterministic diff).

**Three separate systems.** Capture provenance answers *where did this come from* (`KnowledgeObject -> exact Capture span`,
`object_sources`). The Cognitive Graph answers *how is this related to other knowledge* (`KnowledgeObject -> KnowledgeObject`,
`relations`). Thought Lineage answers *how did this one thought evolve* (`KnowledgeObject -> its own revision DAG`).
Revisions are never encoded as graph edges, a revision never references a relation, and graph `supersedes` (one OBJECT
replaces another object) is unrelated to a revision's parent (this object's own earlier state).

**Identity.** An object keeps one stable id for ever; editing never creates a new object. A `ThoughtRevision` is an
immutable snapshot `{ id, objectId, kind, title, body, createdAt, origin, provenance?, parentRevisionIds }`. Ids and
timestamps are generated by the native store (UUIDv4 and RFC 3339), never supplied by the caller. Origins: `initial`,
`user_edit`, `distillation` (interpreted from a NEW capture), `merge`, `system`.

**Authority.** `thought_revisions` is the history; `knowledge_objects.current_revision_id` says which revision the object
currently is. The object's `kind/title/body` columns remain as a **projection** of that revision (so every earlier read
path keeps working unchanged). They cannot drift: a trigger refuses any write that would make them differ from the
current revision (or point at a revision of another object, or at nothing); every mutation writes the revision, its
parent links and the object in ONE transaction; and every read re-verifies the equality and fails as corrupt otherwise.

**Schema v4** (own transactional migration; a failed step rolls back and leaves v3 usable):

- `thought_revisions(seq, id UNIQUE, object_id -> knowledge_objects ON DELETE CASCADE, kind CHECK, title, body, origin CHECK,
  created_at, capture_id -> captures, source_start, source_end)` with an all-or-none CHECK on the three source columns,
  an index on `(object_id, seq)`, and a UNIQUE partial index `one_initial_revision_per_object`.
- `revision_parents(child_revision_id, parent_revision_id)`: primary key on the pair (no duplicate edge), CHECK child <> parent,
  both ends cascade, an index on the parent.
- `knowledge_objects.current_revision_id -> thought_revisions(id)`.
- Triggers: revisions and parent edges are immutable (`UPDATE` aborts); a parent must belong to the same object, must be
  OLDER than its child (so a cycle is structurally impossible), and must not be a descendant of it (an explicit recursive
  check, as a second line of defence); and the projection guard above.

**Bootstrap.** Every existing object gets exactly one initial revision, derived deterministically in SQL with no random
source: its id is the object's id with the UUID version nibble set to `8` (`substr(id,1,14) || '8' || substr(id,16)`), a
valid UUID that is unique because the mapping is injective. Re-deriving gives the same ids, so two migrations of the same
data agree and re-running changes nothing. Content, timestamp and source span are copied from the object and
`object_sources`; nothing existing is modified except the new pointer. An unmigrated v3 database upgrades in place.

**DAG rules**, enforced in the native layer by one insertion path (`insert_revision`) before the first write: an initial
revision has no parent; an edit or a branch has exactly one; a merge has between 2 and 8 distinct ones; every parent exists,
belongs to the same object and is distinct; a revision is never its own parent; at most 1,000 revisions per object. A
cycle cannot be created: new revisions only ever point at older ones, `would_create_cycle` checks the descendants of the
child, and the database refuses a cycle or a backwards edge independently. Reads additionally verify the shape (one root,
parents earlier in the history, parent counts match the origin).

**Operations.**

- `updateKnowledgeObject(objectId, {kind?, title?, body?})`: a new revision whose parent is the current one, which becomes
  current. The old revision is untouched. A change that changes nothing is rejected.
- `createRevisionFrom({objectId, parentRevisionId, changes, makeCurrent?})`: a continuation of ANY revision of the object,
  including an old one (a branch). It does **not** become current unless `makeCurrent` is true, so a branch never silently
  replaces the object's state or erases another continuation. No branch names exist.
- `mergeRevisions({objectId, parentRevisionIds, result, makeCurrent?})`: one new revision with all the parents. The caller
  supplies the merged content; nothing is merged automatically. Not current unless asked.
- Reads: `getObjectLineage` (the whole DAG, oldest first, plus the current id), `listRevisions`, `getRevision`,
  `getRevisionParents`, `getRevisionChildren`. One hop; no cross-object traversal.
- Domain only (no command, no UI, no automatic matching): `revise_from_capture`: the user picks an existing object and a NEW
  capture span; the new revision carries that capture's provenance.

**Provenance across revisions.** The initial revision keeps the object's original source span. A user edit or a merge has **no**
provenance: edited text is never claimed to come from the capture, and the old span is never stretched over new text. Only a
revision created from a new capture carries that capture's span (validated against its text, in code points). The object-level
`provenance` (M01D, `View source`) remains the object's ORIGIN and is not rewritten; each revision's own provenance is on the
revision. Captures stay immutable.

**Deterministic diff.** `diffRevisions(old, new)` (two revisions of one object) returns `{ kind: {changed, from, to}, title,
body }` where title and body are `{ changed, segments: [{ op: equal|insert|delete, text }] }`. It is a word-level longest-common-subsequence
diff over tokens (a run of letters/digits, a run of white space, or one other code point), with a fixed tie-break, prefix/suffix
trimming and merged segments, so Bulgarian text and emoji diff correctly and the same input always gives the same output.
No model is involved. The TypeScript twin (`packages/contracts/lineage.ts`, used by the preview client) and the native
implementation (`lineage/diff.rs`) are both tested against one fixture file, `tests/fixtures/revision_diff_cases.json`.

**Graph coexistence.** Graph relations hang off the object id, not a revision. Editing, branching or merging never deletes,
rewrites or re-targets a relation, and nothing re-runs graph inference. A relation can therefore become semantically stale
after an object's text changes (for example an `extends` that no longer holds); reconciling that is future work.

**UI.** `EvolutionScreen`: pick an idea in the list; a left-to-right rail of its revisions in lanes (the line of thought, then
branches; right-angle rails run parent -> child; the current revision is filled and labelled "current"); the selected
revision's kind, title, body, origin, provenance (or an explicit "no capture source"), parents, and the diff against each parent
(a merge can be compared with each parent in turn); and Revise (a new current revision), Branch from the selected revision (not
current) and Merge (select two or more revisions on the rail). Captions under each revision are derived from the diff
(`+15 −0 words · title`); revisions carry no message, so none is invented.
