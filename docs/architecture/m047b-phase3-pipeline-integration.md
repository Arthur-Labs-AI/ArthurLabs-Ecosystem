# M04.7B Phase 3: identity-aware distillation commit

Status: implemented and tested with an injected FAKE classifier and a test-only revision drafter. Not reachable from the app: production keeps the existing distillation path. No schema change (v8 from Phase 2), no live JEV/OpenAI identity call, no real revision synthesis, no UI.

## 1. Pipeline and transaction boundary
```text
Capture (durable before anything else)
  distiller proposes claims -> resolve_candidates (verbatim spans, whole-set validation)          [unchanged]
  ── no SQLite lock held from here ──────────────────────────────────────────────────────────────
  identity_snapshot(capture)   one short read: the capture's CURRENT project + that project's objects (current revisions)
  shortlist per claim          same project only, at most 4, by shared words (no padding)
  resolve_capture              pure IdentityResolver (Phase 1), injected classifier
  drafts for REVISE            injected RevisionDrafter; draft validated (kind, size, changes something, retraction target ACTIVE)
  ── one IMMEDIATE transaction ──────────────────────────────────────────────────────────────────
  begin_distillation_in        read capture, honour an earlier run (returns it, writes nothing), insert the run, clear the failure
  per claim, in reading order  NEW / unchecked / quota fallback -> object + source mapping + initial revision + decision
                               REVISE -> SAVEPOINT { revise_if_current_in, evidence, decision }
                               UNCERTAIN -> pending claim + uncertain decision
  commit
  ── after commit ────────────────────────────────────────────────────────────────────────────────
  change_events(outcome)       created for NEW, revised for REVISE, nothing for UNCERTAIN
```
Shared code, not duplicated: `record_distillation` now uses the same `begin_distillation_in` and `insert_object_in` as the identity path; the Phase 2 `*_in` storage functions and `revise_if_current_in` do the identity writes. One commit per capture. A write that fails for any reason other than an expected conflict aborts and rolls back the WHOLE capture; the capture itself was durable before distillation began, and the existing `organization_failures` bookkeeping and manual retry apply unchanged.

## 2. Dispositions
* **NEW (verified)**: a classifier ran and found no plausible referent -> object, `object_sources`, initial revision, decision `new` (model id recorded).
* **NEW (unchecked)**: identity was NOT established (disabled, invalid input, no eligible candidate, classifier failure/timeout, unknown model, malformed signals, candidates no longer valid, review queue full) -> the same object, but the decision is `unchecked` with a reason. Never `new`.
* **REVISE**: compare-and-set against the exact revision the decision was made for, origin `system`, no span of its own; the claim's real capture span is attached as evidence with the draft's role (`asserts`/`corrects`/`replaces`, optional named retraction); decision `revise` references the committed revision. Old revisions and their evidence are untouched.
* **UNCERTAIN**: a pending claim holding the full claim, its span, candidates and reasons; nothing existing changes; `due_at` is set (reporting only).
* **Conflicts at commit** (target edited, moved, archived, or another capture revised it first; draft refused): only that claim's savepoint is undone and it becomes UNCERTAIN with `stale_target` / `invalid_draft`. If its candidate left the project it becomes an unchecked object (`invalid_candidates`). A stale decision is never re-used and never converted to a revision.
* **Same-object conflicts within one capture**: Phase 1 downgrades every claim aimed at one object to UNCERTAIN (`conflicting_claims`); no draft is requested.
* **Quota**: at `max_unresolved_pending` (default 50 per project) a new UNCERTAIN claim is kept as an unchecked object (`review_quota`), never dropped, never presented as verified. **Expiry**: nothing resolves automatically; `due_pending_claims` only reports.

## 3. Feature OFF (the production state)
`DistillationService::new` has no pipeline. `with_evolution` exists only under `#[cfg(test)]`, and tests assert that `lib.rs`, `commands/distill.rs` and `commands/integration.rs` never mention the pipeline or its setting. Even an injected pipeline runs only while its own persisted setting (`EvolutionSettings`, `evolution` settings file, default OFF, damaged/missing = OFF, independent of Automatic Connections' file) is ON. OFF means: the unchanged `record_distillation` path, no classifier or drafter call, no decision, pending claim or evidence row, identical objects, sources and initial revisions (regression test compares the plain and injected-but-OFF results).

## 4. Client contract
`distill_capture` still returns `KnowledgeObject[]` = the objects NEW claims created, exactly as before. Revised objects and pending claims are NOT folded into that list. The richer result is the internal `DistillationOutcome { objects, revised, pending, fresh }` from `distill_detailed`; the review/read contract for pending claims and revisions is additive and belongs to Phase 5 together with the UI (until then nothing can enable the feature, so no client observes the difference). `ArthurClient` (Desktop, Mobile, Preview) is unchanged. Note for Phase 5: a client that only re-reads the `distillCapture` list will not see a revised object's new text until it re-lists objects.

## 5. Graph events
`change_events(store, &outcome)` builds `ChangedKnowledge::created` per NEW object and `::revised` per REVISE, in claim order, nothing for UNCERTAIN, and nothing `revised` when `fresh == false` (a repeated call). It needs a committed outcome, which a rolled-back attempt never produces. `commands::integration::notify` still drops everything unless Automatic Connections is ON; a test shows a revision event against a disabled `IntegrationService` makes no provider call and writes no relation. M04.7A is unchanged.

## 6. Concurrency and recovery (tested)
Classification holds no lock (a test edits the store from inside the classifier). Two captures racing for one object: one revision, the other a `stale_target` pending claim. A user edit or a project move during classification wins. Duplicate processing (sequential or concurrent) writes once and reports `fresh = false`. A failure at the last write rolls back object, revision, evidence, decisions and run; after reopening the database the retry commits the full result and clears the failure.

## 7. Provenance
The Phase 2 guarantees hold end to end: R2 is `system`, has no span of its own, and `evidence_support` lists the real spans of both captures as active; a correction that names the earlier assertion moves exactly that evidence to withdrawn; a later revision still shows the earlier one's evidence as its own history. The A/B ("mobile application" / "will also support desktop") case is a CONTROLLED FIXTURE with a test classifier. It does not authorize automatic revision of scope-broadening statements in production; the Phase 1 policy decides that, and the Inbox always asks.

## 8. Activation plan (Phase 4/5)
The feature may be switched on only when ALL of these exist: a real classifier adapter (async, outputs precomputed before the sync resolver runs; calibrated model id in `accepted_models`; consent and credential), a real revision drafter with deterministic validation and an independent veto-only verifier, an `ArthurClient` read contract for outcomes, the review UI for pending claims (accept / keep separate / decide later), the expiry sweep calling `separate_pending_claim(.., "expiry")`, a user-facing setting that also disables itself when a component is missing, benchmarks meeting the Phase 0 gates, and the Android 16 KB page-size release check. Until then `with_evolution` stays test-only.

## 9. Known limits
The shortlist is lexical and bounded (paraphrases without shared words get no candidate, which is the safe default NEW). The classifier trait is synchronous. `distillation_for(capture)` lists only objects sourced from that capture (NEW and fallback objects), not revisions or pending claims.

## 10. Open release item: Android 16 KB page size (UNRESOLVED)
Compatibility of the Android APK with 16 KB-page devices is NOT verified. The native test binaries (including this phase's, 306 tests) segfaulted on a 16 KB-page emulator image until linked with `-C link-arg=-Wl,-z,max-page-size=16384`. This phase changes no Android linker configuration; the release build must be checked and the flag (or an NDK default) applied before any Android release. See also `m047b-phase2-schema-v8.md` section 9.
