# Cognitive Runtime v1 — final state and handoff

Status: **feature freeze.** This document records what v1 contains, what is verified, and what is not. It claims nothing
beyond the tests and acceptance runs listed. Branch `feature/cognitive-runtime-v1`. Not merged into `dev` or `main`.

## 1. Implemented capabilities (M01–M04)

| Milestone | Capability |
|---|---|
| M01 | Local-first capture store (SQLite), Capture → Inbox, Tauri desktop shell and Android shell sharing one React UI through the `ArthurClient` abstraction. |
| M02 | Distillation of captures into KnowledgeObjects with evidence spans; consent-gated provider use. |
| M03 | Revisions (edit, branch, merge, restore-as-new-revision), lineage and deterministic diffs; Projects (schema v6). |
| M04A–D | Recall: retrieval core (schema v7), evidence contract, grounded "Ask Arthur" with citations, consent and UI. |
| M04.5 / M04.6 | Provider setup; voice output (TTS). |
| M04.7A | Automatic Graph Integration: opt-in, default OFF, relations stored with `origin=model`, user relations never altered. Seven relation types. |
| M04.7B | Thought Evolution: identity classification, grounded revision synthesis, review-first proposals (schema v9), Review UI, Undo. |
| v1 close | Automatic Connections diagnostics and event-path regression tests (section 9). |

## 2. Schema

Schema **v9** (`SCHEMA_VERSION = 9`). v8 added identity/pending claims; v9 added the additive `revision_proposals` table
(1:1 with a pending claim, immutable content columns, terminal states final, no key/header/payload column). Migrations are
forward-only; a v7 device database was migrated to v9 intact on the Android emulator.

## 3. Model roles (no provider other than these)

- **Identity classification:** TypeSafe JEV (1.13).
- **Distillation, revision synthesis, verification, Graph Stage B:** GPT-6 Luna (OpenAI).
- Verification of a draft is **same-family review** (Luna checking Luna): a self-check that gates what a person sees. It is never
  described or treated as independent correctness.
- Graph Stage A is the proposal pass of the Graph service; Stage B is run twice with opposite presentation and must agree.

## 4. Review-first safety model

No code path applies a model-written text without a person's explicit approval; there is no automatic-apply mode. An approved
suggestion becomes a `system` revision with an approval record in `revision_proposals`; edits are recorded `user_edited`.
Writes are compare-and-set against the base revision; stale proposals cannot be approved. Undo creates a new revision; history
is never rewritten. Thought Evolution and Automatic Connections are OFF by default; enabling needs the relevant consents and key.

## 5. Lifecycle

Capture (verbatim, immutable) → Distillation (KnowledgeObject + evidence spans) → optional identity check (Thought Evolution →
pending claim → proposal → person approves/edits/rejects/keeps separate) → Revisions → Graph (manual relations always; automatic
`ChangedKnowledge` → integration worker → Stage A → Stage B → policy → guarded write) → Recall (retrieval over effective
revisions with evidence and origins `approved_suggestion` / `approved_edited`).

## 6. Platforms

Desktop (Tauri) and Android (Tauri mobile, debug build). Android was exercised on a Pixel_10 emulator with a 16 KB-page image:
v7→v9 migration, review/approve, back key, offline behaviour, credentials; ELF alignment 0x4000 and zipalign -P 16 for x86_64 and
arm64.

## 7. Test and acceptance results (recorded at closure)

Rust 887 passed / 22 ignored (live and bench tests, offline by default); frontend 559 passed (41 files); repository architecture
tests 88 passed; `cargo check` with 6 pre-existing warnings; frontend typecheck clean; `git diff --check` clean. Default tests make
no network requests. APK acceptance is the debug-build emulator run above.

## 8. Known limitations and unverified behaviour

- **Real-provider end-to-end acceptance is outstanding** for Thought Evolution (TypeSafe + OpenAI used only through offline fakes
  and localhost fixtures). Quality on real data is unmeasured.
- **Same-family verification** is not independent verification.
- **Graph semantic detection is limited.** Stage A is deliberately conservative; benchmark precision was not proven to the 0.90
  gate across runs; recall is low for `supersedes`, `extends`, contradictions and Bulgarian text; results vary between runs.
- **Automatic Connections zero-edge report is NOT resolved.** On the owner's desktop four new ideas produced no automatic relation.
  The ledger showed every idea reached `done` with the switch enabled, and 12 offline event-path tests show events reach the worker,
  candidates reach inference and an accepted relation is persisted. What Stage A/B actually returned for those ideas was unobservable
  and has not been measured. Diagnostics were added so it can be; no threshold, model or semantics was changed. Thought Evolution
  routing similar notes to proposals also reduces new object pairs.
- Untested: signed/release Android build, minification, physical device.
- A public-release privacy/legal review (data sent to TypeSafe and OpenAI, retention, wording) is outstanding.
- Provenance limitation of approved revisions: see `m047b-phase5-review-first-activation.md` section 2a.

## 9. Automatic Connections diagnostics (v1 close)

Privacy-safe counters and run records (`graph/diagnostics.rs`: counts, ids, codes — never capture text, bodies, keys, headers or
model output), command `get_graph_integration_diagnostics`, a Settings panel, and specific "Find connections" messages replacing the
single "No new connections found." sentence. Codes: NO_CANDIDATES, ALL_REJECTED, PROVIDER_FAILED, PERSISTENCE_FAILED,
SUCCESS_NO_NEW_EDGES, plus overall WORKER_NOT_STARTED / EVENT_NOT_DELIVERED / DISABLED / NO_EVENTS_YET. See
`m047a-automatic-connections-diagnosis.md`.

## 10. Privacy and consent boundaries

Everything is local unless a provider is used. Capture text leaves the device only to the configured provider after consent: kinds
`typesafe`, `synthesis`, `verification` (Thought Evolution); other provider features (Distillation, Ask, Automatic Connections) are likewise opt-in and gated by the configured key. Keys live in the
platform secret store, never in the database or logs. Diagnostics hold no content. UI code contains no provider/model literals.

## 11. Deferred to Cognitive Runtime v2

JEV Semantic Screening for Graph (not in v1); improving Graph recall; real-provider acceptance runs; independent (cross-family)
verification; release Android build and physical-device testing; privacy review.

## 12. Stable interfaces for M05 Home Node Sync

Candidates M05 may depend on: the schema-v9 tables and forward-only migrations; the immutable-revision model (revisions are
append-only, current pointer + compare-and-set); `ArthurClient` and `packages/contracts` types; relation `origin` values
(`user` / `model`) and the seven relation types; proposal states; ledger/switch files are app-private and **not** a sync contract.
Sync must not bypass the review-first rules or CAS guards.
