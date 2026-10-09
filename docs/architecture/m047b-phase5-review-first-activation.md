# M04.7B Phase 5 — Persistent proposals, Marginalia review and review-first activation

Status: implemented and verified; **uncommitted**. Automatic Thought Evolution is now a real, usable feature that is **OFF by default** and **review-first**: Arthur may *suggest* a new version of an idea, the suggestion is stored, and only a person's explicit approval can change the idea. There is no automatic-apply mode anywhere in the product.

Models (unchanged, no new provider): identity = TypeSafe JEV 1.13; synthesis = GPT-6 Luna; verification = GPT-6 Luna as `SameFamilyReview` (a self-check, never independent); deterministic safety = IdentityResolver + draft validation + compare-and-set; authority = the person.

## Release status (read this first)

- **M04.7B is implemented in review-first mode only.** Automatic revision application is **unavailable**: no setting, command, code path or test-only switch in shipped code applies a model-written text without a person's explicit approval.
- **Real-provider end-to-end acceptance is still outstanding.** TypeSafe and OpenAI were exercised only through offline fakes and localhost fixtures; no live or paid request was made for Thought Evolution itself in Phases 4C or 5 (one unintended Ask Arthur request is disclosed in section 9). Quality of identity decisions, drafts and checks on real data is **unmeasured**.
- **Same-family verification does not establish independent correctness.** GPT-6 Luna checking GPT-6 Luna is a self-check that can share the writer's blind spots. It can only gate what is shown to a person; the person is the only authority.
- **Untested:** a signed/release Android build, minification effects, and any physical device. Only a debug build on an x86_64 emulator with a 16 KB-page image was run (section 9).
- **Provenance of an approved revision has a documented limitation** (section 2a).
- **A public-release privacy review is a separate, outstanding task** (data sent to TypeSafe and OpenAI, retention, disclosure wording, legal review). The in-app disclosures are accurate to what Arthur does, not a legal or privacy sign-off.
- The feature is **not** declared generally production-ready. It is OFF by default and intended for the owner's controlled use.

## 1. Architecture summary (integration points found)

| Need | Existing piece reused | What Phase 5 added |
|---|---|---|
| Keep the captured claim when nothing is applied | v8 `pending_claims` + `accept/separate/defer/reopen` | hooked variants (a step before the claim is closed, same transaction) |
| Apply with a stale-write guard | `revise_if_current_in` (CAS) | called only from the review path |
| Draft text that survives restart | — (the draft was lost) | **schema v9 `revision_proposals`** |
| Same-family pass must not apply | `SynthesisStage` mode (Phase 4C) | `run_outcome` returns the draft for storage; `run` still refuses |
| Provider consent | `JevConsent`, `ProviderAuthorization` | `evolution_runtime` (status, enable gate, consents, TypeSafe key) |
| Production wiring | test-only injector | `DistillationService::with_evolution` now production, fed only by `evolution_runtime::build` (review-first) |
| UI | `ArthurClient`, Marginalia tokens, mobile page stack | Review screen/pages, settings section, history labels + Undo |

Schema requirement: v8 could not hold the draft, so one additive v9 table was required (authorized). Nothing else changed in the schema.

## 2. Schema v9 (additive)

`revision_proposals` (+2 indexes, 9 triggers). No existing table is rebuilt or altered; nothing is backfilled (a v8 pending claim has no draft to recover).

- A proposal is 1:1 with its pending claim (`UNIQUE pending_claim_id`), created `open` only for an `open` claim, naming one of the claim's candidates and a base revision that is **still that object's current revision** at creation (trigger).
- Stores: target object, base revision, change (`additive|correction|replacement`), kind/title, proposed text, optional withdrawn evidence, validated evidence references (JSON, ≤ 13), synthesis model, verifier model, `verification_mode`, `verification_status = passed`, policy version, state, `user_edited`, `final_body`, `result_revision_id`, timestamps. **No key, header or provider payload column exists.**
- Content columns are immutable; terminal states (`approved`, `rejected`, `separated`, `superseded`) are final; rows are never deleted.
- `approved` is accepted only together with the committed revision it produced: on that object, origin `system`, carrying this claim's span as evidence, with exactly the approved text (trigger). `separated` needs the object created from the claim.
- A trigger marks a still-reviewable proposal `superseded` when its claim is resolved by any other route, so a proposal can never outlive its claim as reviewable.
- Stale-ness (base ≠ current) is **derived on read**, never stored.

Migration tests: fresh → v9; populated v8 → v9 (every authoritative row, decision, pending claim and the search index byte-identical, nothing invented, v8 behaviour intact, repeat opens change nothing); failing v9 step rolls back completely for three blockers (table, index, last trigger); interrupted upgrade leaves v8 intact and the next open completes it; an older binary refuses v9 untouched. **On a real device**: a v7 database from the emulator (6 captures, 3 ideas) was upgraded in place to v9 with every row preserved and `integrity_check = ok`.

Origin constraint worth knowing: `thought_revisions.origin` has a CHECK without a "user-approved" value and evidence may only attach to `system` revisions; widening either would rebuild a table, which was not authorized. So an approved suggestion is stored as a `system` revision and **the approval record is what states that a person approved it and whether the words are theirs** (`list_object_approvals`); the history UI uses it.

### 2a. Provenance of an approved revision (checked against every reader)

The schema allows evidence only on `system` revisions and has no user-approved origin; widening that needs a table rebuild, which v9 forbids. So an approved suggestion is a `system` revision, and the **approval record** (`revision_proposals`: `state = approved`, `result_revision_id`, `user_edited`, `final_body`) is the source of truth for "a person approved this, and these are/aren't their words". Every reader of origin was inspected:

| Reader | Treatment |
|---|---|
| Thought Lineage store / contracts | Unchanged: origin stays `system`. Nothing downstream may treat `system` alone as "AI-authored and unreviewed". |
| History UI (desktop rail, detail, Ideas list, mobile history and idea page) | Uses the approval record: "Suggested by Arthur · approved by you", "… your wording, approved by you", a rail tag, and a source note that says who wrote the words. It never shows "This text is your edit" for an AI draft, and never calls a person's wording AI-authored. A `system` revision with no approval record reads "Arthur wrote this text on its own". |
| Recall (Ask Arthur) | Reads an **effective origin**: `approved_suggestion` / `approved_edited` for approved revisions, `system` only for earlier fully automatic ones. All of them count as "edited since capture", so the original capture words are never offered as support for the new wording. The Ask prompt is untouched. |
| Graph notifications | An approval emits one `revised` event, and only after the commit; whether the meaning moved enough to matter is Automatic Connections' existing decision. Revisions carry no relation ownership: relations keep their own `user`/`model` origin and are never created, rewritten or re-owned by a revision. |
| Evidence/provenance readers | Approved revisions carry the claim's exact span as active evidence and keep the earlier assertion as historical (tested), so the support story stays truthful. |

Remaining limitation: a consumer that reads `thought_revisions.origin` directly, without joining the approval record, sees `system`. The approval record is the contract; the readers above were updated, and a test pins the Recall labels.

### 2b. Revocation semantics (what is and is not guaranteed)

Authorizations and consent live in app-private **files** (flipped in memory only after the file is written); proposals live in **SQLite**. There is no transaction spanning the two, so atomic cross-storage revocation is **not** claimed and cannot be. What is guaranteed:

1. **Fail closed at rest:** a missing, damaged, foreign or older-disclosure record means "not allowed"; revoking writes the file first, and if that fails nothing changes.
2. **No new provider request starts** once the in-memory flag shows the revocation. The flag is read before each request, between JEV runs, after each await, and again inside the commit transaction before a proposal is written.
3. **An in-flight request cannot be recalled** (it was already sent), but its result is discarded if the revocation is visible when it returns or at the commit check.
4. **The commit check is not atomic with COMMIT.** A revocation landing in the few microseconds after the in-transaction check and before the commit can still store one proposal. That proposal is local, review-only data (nothing is ever applied by the pipeline) and can be dismissed. This window is accepted and documented rather than hidden.
5. Revoking never deletes data a provider already received, and never deletes existing proposals; reviewing them needs no provider and no authorization.
6. The app is a single process; the files are read at startup, and the in-memory flag is authoritative while it runs. A second process editing the files would not be noticed until restart.

### 2c. Review-first is enforced by construction

(a) `evolution_runtime::build` is the only production builder and uses only `new_same_family_review`; (b) `apply` refuses `Plan::Revise` when review-first; (c) the stage never turns a same-family pass into an applicable draft; (d) the only command that can apply anything is `review_revision_proposal`, reached only from explicit buttons, and it re-reads the object and refuses a stale base; (e) a structural test (`no_shipped_path_can_turn_a_suggestion_into_a_revision_except_a_deliberate_review`) scans shipped sources for every caller of the review step, of `CasOrigin::System` and of pending-claim acceptance, and fails on any new one; (f) the review store touches no authorization, credential or HTTP code, so reviewing works offline and with the feature OFF; (g) the switch can only be turned on when every consent and key exists, and turning it OFF stops new provider work while keeping existing proposals reviewable; (h) schema v9 is additive and its migration is tested against populated v7/v8 data.

## 3. Durable proposal lifecycle

```
capture -> distillation -> JEV identity -> resolver -> Luna synthesis -> deterministic validation -> Luna same-family check
        -> ONE transaction: pending claim (open) + proposal (open) + identity decision      [never a revision]
review:  approve / edit+approve -> CAS revision + claim evidence + claim accepted + proposal approved   (one transaction)
         reject                 -> proposal rejected; the claim stays open and visible
         keep separate          -> new object from the claim's exact span + claim separated + proposal separated
         defer / reopen         -> claim and proposal move together
```
Not-stored cases (the claim is always kept): ambiguous identity, radical reframing, invalid draft, verifier veto, verifier unavailable, provider failure, stale target at commit, permission withdrawn, **review queue full** (the claim becomes its own idea, marked `review_quota`; nothing is dropped). No draft is ever invented where none exists. Nothing expires into deletion; "due" is only reported.

## 4. Approval and CAS protections

Each review operation runs in one immediate transaction; SQLite serializes concurrent callers, and repeating an operation is idempotent (`applied=false`).

1. Reload the target; check it exists, the project is not archived, and the claim and object are in the same project.
2. Compare the object's **actual current revision** with what the person read (`reviewedRevisionId`) and, for one-click approval, with the draft's base. Mismatch → `stale` with the current revision id; nothing is written; one-click approval is blocked and a person must re-review against the current text.
3. Edit-and-approve requires naming the revision read, validates the text, records `userEdited` and `finalBody`, keeps the AI draft as written, and keeps withdrawn evidence only if it is still active.
4. The CAS writer creates the revision; the claim's exact span is attached as evidence; the claim and proposal are closed with proof (triggers). Any failure rolls everything back (tested with an injected failure on the last write).
5. Graph integration is notified by the command **only after** the transaction committed (a failure returns no revision to notify).
6. Rejecting never deletes the capture or the claim; "dismiss the draft" (`reject`) and "keep as its own idea" (`keep_separate`) are different operations.

## 5. Production review-first safeguards

- `evolution_runtime::build` is the only place that builds the pipeline; it uses `SynthesisStage::new_same_family_review` (the independent, auto-applying form is never built in shipped code; an architecture test enforces both).
- `EvolutionPipeline::review_first()` is true for it, and `apply` additionally refuses any `Plan::Revise` in that mode, as a second independent guard.
- The hand-written drafter is replaced by one that always declines.
- It runs only when the switch is ON **and** TypeSafe consent, the TypeSafe key, the OpenAI key, the synthesis authorization and the verification authorization all hold; these are re-read before each request, after each wait, and inside the commit transaction. Revoking any of them mid-operation stores nothing.
- Per-capture and daily request budgets, input/output bounds and timeouts are unchanged.
- With the switch OFF, distillation takes its old path (tested: no classify/synthesize/check/decision).
- `distillCapture` keeps its contract (the new ideas); proposals are read through new client methods.
- A suggestion already made stays reviewable when the feature is turned off or offline; reading and reviewing are local.

## 6. Consent and credentials

Three separate, default-OFF, revocable permissions, each tied to the disclosure version shown: identity (TypeSafe), synthesis (OpenAI), verification (OpenAI, same-family). Granting must name the disclosure version (`disclosure_outdated` otherwise); the disclosure text is served by the native layer (a test pins it to its version). The verification disclosure states plainly that it is the same model family, a self-check, not an independent review. The TypeSafe key has its own native slot (Android Keystore on Android), is write-only (set/delete only; status carries booleans), and is never in a file, log, status or UI state. The OpenAI key is the existing AI & Voice key. Turning anything off stops new requests at once and the UI says it does not delete what a provider may already hold. The switch cannot be turned on while anything is missing (`not_ready`).

## 7. Marginalia UI

Desktop: **Review** in the rail with a count; list + detail. Phone: a pushed **Review** page and item pages (system Back closes them in order), reached from a quiet line on Home and from Settings. Each item shows the idea now, the suggested version labelled as written by Arthur (model id from the native record), a word-level "what changed" (strike-through and underline, not colour alone), why it was held, the new note's exact words, what already supports the idea, how it was checked with an explicit **self-check** warning, and Approve / Edit & approve / Reject / Keep as separate idea / Decide later. A stale suggestion shows a warning and cannot be approved as it is. Waiting notes without a draft say so and offer Keep as separate idea / Decide later. A capture whose notes were held reads "N notes are waiting for your review" instead of "Nothing to structure". Settings has a "Thought Evolution" section. History labels revisions truthfully ("Suggested by Arthur · approved by you", "… your wording …") and offers **Undo to Rn**, which adds a new `merge` revision with both the current and the chosen earlier revision as parents (compare-and-set; nothing deleted). Provider and model names in the UI come from native data; no UI file hard-codes one (the repository boundary test enforces it).

## 8. Tests

Rust 870 passed / 0 failed / 22 ignored (paid/live/seed helpers; none run): proposal store (18), migrations (v9: 5), end-to-end pipeline (13), runtime (7), plus the existing suites. Frontend 552 passed. Repository architecture tests 88 passed. Specifically covered: feature OFF regression; consent setup/revocation and disclosure versions; credential write-only handling; capture → persisted proposal; restart recovery; approve; edit-and-approve; reject; keep separate; defer/reopen; stale revision; user edit before approval; concurrent approvals (8 threads → exactly one write); approve racing reject; repeated actions; provenance and historical evidence after approval and after a correction; Graph event only from a commit; invalid/unavailable provider; offline classifier; pending quota; project boundaries; rollback; desktop, mobile and preview clients; Android native behaviour (below).

Repository architecture tests: seven were already failing before this phase (rules still written for schema v7 and for the Phase 2/3 modules). They were updated to the current design with explicit, narrow exceptions (`distillation/evolution.rs` composes storage inside a lent transaction; `evolution_runtime.rs` is the credential-source composition root; test files may mention integration), not loosened generally.

## 9. Android acceptance (real APK, emulator)

**What was and was not verified.** *Verified by running:* the x86_64 debug APK on the Pixel_10 emulator. *Verified by inspection only:* the arm64-v8a library (built, ELF `LOAD` alignment and `zipalign` checked; **never launched**). *Not verified:* any physical device, and any signed/minified release build.

Build: `npm run tauri android build -- --debug --target x86_64 --target aarch64 --apk` (debug, universal). Device: the Pixel_10 emulator on the **16 KB page-size** system image (`getconf PAGE_SIZE` = 16384, Android 17, x86_64). No physical device was available; **that is reported separately and not claimed.** A native Rust test run is not APK acceptance and is reported on its own.

| Check | Result |
|---|---|
| 16 KB alignment | ELF `LOAD` segments of `libarthur_lib.so` aligned `0x4000` for **x86_64 and arm64-v8a** (only x86_64 was run); `zipalign -c -P 16` verification successful (the `.so` files are stored uncompressed at 16 KB boundaries). The app launched and ran on the 16 KB emulator. Release (signed, minified) build not produced. |
| SQLite migration | The emulator already held a real **v7** database (6 captures, 3 ideas, 3 revisions). Installing the new APK over it migrated it in place to **v9**: every capture/idea/revision preserved, new tables empty, `integrity_check = ok`. |
| Capture storage / restart | Existing captures read back after upgrade and after every force-stop/relaunch. |
| Proposal persistence | Two suggestions (English with emoji, Bulgarian correction) were written into the device database by `write_the_android_acceptance_suggestions` (an ignored helper that uses the same store APIs the pipeline uses; no provider was called). They appeared after launch, survived restarts, and Cyrillic and emoji render correctly. |
| Review UI | Home line, list page, item page (idea now, suggested version, word-level changes, new note, support, same-family self-check warning, five decisions) checked on screen. |
| Native review | **Approve** (offline) applied the correction once: revision count 1→2, evidence row written, claim `accepted`, proposal `approved`, earlier text kept; after a restart the state was identical. **Reject** dismissed the suggestion and kept the note open ("no suggested text"); **Keep as separate idea** then created its own idea; final state: proposals `approved`+`rejected`, claims `accepted`+`separated`, `integrity_check = ok`. |
| Back key | system Back from an item → list → Home, app stays open. |
| Offline | Airplane mode (OS-level "Network is unreachable"): reading, approving, rejecting and keeping separate all worked, since review is local. |
| Native credentials | `set_typesafe_credential` through the real command: status shows `hasCredential` with no secret anywhere in the answer; **no credential file** was created in the app directory (Android Keystore slot); `set_evolution_enabled(true)` was refused (`not_ready`) while consents were missing; the key was deleted afterwards. Switch OFF on a fresh install (no settings file). |
| Android native tests | 710 passed, 0 failed, 13 ignored on the emulator (16 KB-aligned test binary), including the new proposal store, pipeline and runtime tests. |

| Recall provenance on device | On the final x86_64 APK, `ask` over the approved Bulgarian correction returned evidence whose current-revision origin was `approved_suggestion` (not `system`), proving the Recall change runs on Android SQLite. |

**Disclosure — one unintended live request.** That check was run after the emulator's network had been switched back on, and the emulator still held an OpenAI key from earlier testing, so the Ask Arthur call (`ask`) reached the real OpenAI account: one question about the synthetic seed data (a meeting day), a few hundred tokens, cost well under one cent. Only the evidence retrieved for that question (the synthetic meeting idea and its note) could have been sent, and the emulator holds only test data from development sessions, so no real personal content was involved to the best of my knowledge; no TypeSafe request was made, and no Thought Evolution request (synthesis, verification, identity) was made. It was not authorized and should not have happened; the emulator was put back in airplane mode straight away and the remaining checks were offline.

An on-device look at the Settings section found a real layout defect (a class collision with an existing `.evo` rule squeezed the section into a narrow column); it was fixed and re-verified on the rebuilt APK.

## 10. Limitations

- Review quality depends on a same-family self-check and uncalibrated JEV thresholds; nothing here is a measured accuracy claim. The Phase 4C real-model evaluation was not run. No Thought Evolution request (TypeSafe or synthesis/verification) was made; one unintended Ask Arthur request is disclosed in section 9.
- An approved suggestion is stored with `system` origin (see section 2); only the approval record says a person approved it.
- Waiting notes cannot be merged into an idea from the Review screen: without a suggested text there is nothing reviewed to apply; the person edits the idea themselves.
- Review state is per project (the active one); proposals of other projects are visible after switching.
- Physical-device testing and a signed release build were not performed; arm64 was only built and inspected.
