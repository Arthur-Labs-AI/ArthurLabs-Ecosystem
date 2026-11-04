# M04.7B Phase 4C — Same-family verifier integration and safety evaluation (cost-first)

Status: **supersedes** the first Phase 4C design (an independent Z.ai GLM verifier, committed locally as `0b8dd96`). The user rejected GLM-5.3 because its cost was unjustified; this revision removes it and verifies with GPT-6 Luna. The change is a working-tree revision on top of `0b8dd96`: nothing here is staged or committed. Nothing is activated. No paid or live request was made. Schema v8 is unchanged.

## 1. Decision and what it means

The verifier is **GPT-6 Luna** (`gpt-6-luna`, reasoning effort `none`) through the existing OpenAI chat boundary and the existing OpenAI credential. The synthesizer is also GPT-6 Luna. **This is NOT independent verification.** It is a same-family self-check (`VerificationMode::SameFamilyReview`): it can catch some mechanical or obvious semantic slips, but it shares the synthesizer's blind spots, so a pass is weak evidence. Nothing in code, tests, documentation or results calls it independent.

Consequences enforced in code:

- `SynthesisStage::new` (mode `Independent`) still refuses any verifier of the synthesizer's family. The guard was not weakened or bypassed.
- `SynthesisStage::new_same_family_review` (mode `SameFamilyReview`) accepts only a verifier whose family really equals the synthesizer's, and records its mode (`stage.mode()`). Neither constructor can mislabel the other's pairing.
- **A same-family `Pass` never applies a revision.** The stage returns `review_required` (a new allow-listed audit name; no schema change), the claim stays a pending claim for a person, and the existing idea and its evidence are untouched. A `Veto` gives `verifier_veto`; an unusable answer gives `verifier_unavailable`.
- The abstraction is preserved: any other `RevisionVerifier` of another family can replace Luna later through `SynthesisStage::new` without changing the pipeline.

## 2. What was built (this revision)

Removed relative to `0b8dd96`: `synthesis/zai.rs`, `ProviderId::Zai` (registry restored to its pre-Phase-4C form), all Z.ai tests, authorization names, disclosures, prices and environment variables. An architecture test now fails if the provider, its endpoint or its name reappears in shipped code or `Cargo.toml`.

- `synthesis/verdict.rs` (provider-neutral): the 12 checks (unsupported new fact; unsupported date/quantity/entity; dropped fact; negation/qualifier change; wrong correction behaviour; scope expansion; evidence misattribution; contradiction; guessed ambiguous reference; certainty increase; unfaithful to previous; unfaithful to new claim), the fixed instructions (all text is declared data), the data-only message (previous text, proposed text, sources, new note; **no object, revision, capture or project ids**), the strict JSON schema and the strict local parser (complete, self-consistent `{"verdict","checks"}` only; `pass` with a flagged problem or `veto` with none is rejected).
- `synthesis/openai_verifier.rs`: `OpenAiRevisionVerifier`. Strict `json_schema` output, effort `none`, no sampling parameter, `max_completion_tokens` 1 500, 14 000 characters of input, two attempts for transport failures only (never to get a different answer), two concurrent requests, per-request timeout, and a cancel that abandons a request already in flight. The answering model must be `gpt-6-luna` (exact or dated snapshot); anything else, `finish_reason` other than `stop`, an empty or oversized answer or a non-conforming verdict is `Unavailable(InvalidResponse)`. Identity: provider `openai`, family `gpt`.
- Authorization: `Purpose::Verification` for provider `openai` is separate from `Purpose::Synthesis`, default OFF, bound to a disclosure version, revocable; the shared key does not imply either. The stage checks both before any request, after every wait and again at commit.
- Verification disclosure (for Phase 5): *the existing idea text, the new note and the proposed revision are sent to OpenAI to be checked by the same model family that wrote the proposal; this is a self-check, not an independent review, and a passing check only means the proposal is shown to you for approval.*
- No new provider, key, dependency or schema. No request is made inside a SQLite transaction.

**Persistent revision proposals are NOT implemented.** A `review_required` outcome currently only keeps the claim as a pending claim with that reason; the verified draft itself is not stored, so nothing can yet be approved from it. The proposal store, the review/approve/reject workflow, consent UX and an approval path through the CAS writer belong to Phase 5.

## 3. Estimated additional cost

About 1 200 input tokens and 100 output tokens per check at the listed Luna prices ($0.10 / $0.50 per million) is roughly **$0.0002 per verified draft** (plus at most one retry on transport failure). That is an estimate from token arithmetic, not a measurement. The bounded real-model evaluation (at most 60 requests) would cost on the order of $0.01.

## 5. Evaluation design

Corpus (`synthesis/eval/corpus/`, pinned by SHA-256 in `CHECKSUMS`; a test fails if any file changes): dev = 31 revision cases (10 safe / 21 unsafe) + 10 identity cases; **holdout** = 25 revision cases (8 / 17) + 10 identity cases. Languages: English, Bulgarian, mixed, Unicode/emoji. Unsafe classes cover every category in the brief. Dev and holdout share no scenario (tested).

Layers, reported separately:

- **Identity gate**: the real resolver over *scripted* classifier signals. It measures the policy gate, not any classifier.
- **A — deterministic validator**: real code, no model.
- **B — mock transport**: the real adapter against a localhost fixture. *Oracle* (answers from the label; cannot be wrong), *always-pass*, *garbage*, *outage*. These show plumbing and failure behaviour. **They say nothing about model quality.**
- **C — real model (Luna, same-family)**: an `#[ignore]`d test that also requires `ARTHUR_LUNA_VERIFY_EVAL=yes`, checked before any credential is read, with `ARTHUR_OPENAI_API_KEY`. The 60-request cap is a maximum, not permission to run. It prints only counts. **Not run.**

**The labels are not ground truth.** The cases, their labels and the scripted signals were written by the implementer (an AI assistant) in this milestone; they were not adjudicated by a person and have no independent source. Metrics against them show only how the code agrees with its own author. The holdout was run by the same code as dev; nothing (heuristic, prompt, threshold, corpus) was changed after the first run, and one safe holdout draft that the validator stops (`h04-s`, mixed language, tentative wording) was deliberately left as a reported false veto.

Reproduce: `cargo test --lib synthesis::eval`; `ARTHUR_EVAL_WRITE=docs/architecture cargo test --lib synthesis::eval::tests::the_evaluation` rewrites `m047b-phase4c-evaluation-output.md` (every table, with numerators/denominators and Wilson intervals) and `m047b-phase4c-review-packet.md` (every case, with empty columns for an independent reviewer).

## 6. Results (against the implementer's own labels)

Small n; intervals are wide. See `m047b-phase4c-evaluation-output.md` for every row.

| | Dev | Holdout |
|---|---|---|
| Identity gate: false-revision (should not revise, did) | 0/6 | 0/6 |
| Identity gate: recall | 3/4 | 3/4 |
| Identity gate: incorrect target | 0/3 | 0/3 |
| Identity gate: UNCERTAIN rate | 6/10 | 6/10 |
| **A. Validator alone: unsafe drafts accepted** | **10/21 (48%, CI 28–68)** | **7/17 (41%, CI 22–64)** |
| A: unsupported-assertion acceptance | 2/7 | 3/6 |
| A: omission acceptance | 0/3 | 0/2 |
| A: incorrect-correction acceptance | **3/3** | **2/2** |
| A: scope expansion / certainty increase / ambiguous reference accepted | 2/2 · 1/1 · 1/1 | 1/3 · 0/1 · 1/1 |
| A: safe drafts wrongly stopped | 0/10 | 1/8 |
| B oracle: unsafe accepted / safe rejected | 0/21 · 0/10 | 0/17 · 1/8 (the validator one) |
| B always-pass: unsafe accepted | 10/21 | 7/17 |
| B garbage / outage: unsafe accepted | 0/21 | 0/17 |
| B garbage / outage: safe rejected (fail closed) | 10/10 | 8/8 |
| C real model | not run | not run |

Reading: (1) the fail-closed behaviour is solid — no unusable verifier answer ever produced an acceptance, in any case. (2) The deterministic validator alone lets through roughly 40–50 % of the unsafe drafts, concentrated in exactly the semantic classes it cannot see (incorrect corrections, scope, certainty, ambiguity, misattribution). So **safety against these classes rests entirely on the verifier**, as the always-pass row shows, and the verifier's real accuracy is unmeasured. (3) The oracle row proves the plumbing, not the model. (4) Per-language rows exist, but the Bulgarian, mixed and emoji strata hold 1–5 cases each; the intervals are too wide to conclude anything about language parity. (5) Cost and latency of the real verifier are not measured; the cost model is token-count × listed price (≈ $0.006 per check estimated, unverified). (6) The identity gate has only been exercised with scripted signals, so these rates are properties of the policy, not of GPT-6 Luna as classifier (that was measured in M04.7A/JEV work).

## 7. Limitations

Labels from one author and one AI; tiny corpus; scripted identity signals; no human adjudication; no real-model result; Luna's accuracy as a verifier (and in Bulgarian) unmeasured; the verifier is the same family as the synthesizer, so its errors are likely correlated with the draft's; classes such as evidence misattribution are barely represented (1 case) and absent from the holdout; the verifier sees only the text, so it cannot detect an error in the *choice* of target (that remains the resolver's job); a verifier with correlated blind spots to the synthesizer is the premise of this design, not a risk to be explained away.

## 8. Release recommendation: **RESTRICTED — do not activate**

- **GO: not supported.** There is no real-model measurement, no independent labels, no independent verifier and no consent UI.
- **NO-GO is not warranted for the code**: fail-closed behaviour, authorization, rollback and race protections are verified offline.
- **RESTRICTED — review first.** The code may be merged dark. Even when Luna returns PASS, the draft is **not** applied: it requires explicit user approval, which Phase 5 implements (persistent proposal, review, consent, revocation). Automatic Thought Evolution stays OFF and unreachable until then. Automatic application may be reconsidered only with (a) a human-adjudicated corpus (use the review packet) with at least ~100 unsafe and ~100 safe items including ≥ 30 Bulgarian; (b) a real-model run of layer C within a stated budget; (c) an independent verifier of another family (the abstraction supports one); (d) Phase 5 consent UX; (e) Android 16 KB APK compatibility verified (open item).

## 8a. Release decision (final): RESTRICTED — review-first only

- GPT-6 Luna as a same-family verifier has **not been evaluated**; its accuracy is unmeasured, and a same-family pass is not independent confirmation. Human adjudication is incomplete (the review packet is unfilled).
- The deterministic validator alone accepted 7/17 unsafe holdout drafts (10/21 on dev); this is why automatic activation is premature.
- Scripted identity signals are not real JEV quality measurements.
- Safe mechanical behaviour (fail-closed, rollback, races, authorization) does not establish semantic correctness.
- The 16 KB Android APK release check is still outstanding; the native test run does not cover it.
- Phase 5 may add user-controlled approval of proposed revisions. Automatic revisions are **not** production-ready, and the pipeline is unreachable in production (the injector is test-only).
- The paid evaluation test needs `--ignored` **and** `ARTHUR_LUNA_VERIFY_EVAL=yes`, checked before any credential is read; the 60-request cap is a maximum, not permission. The evaluator writes reports only to an explicit directory (never the corpus), and a test pins the corpus by SHA-256.

## 9. Verification

Full `cargo test` 822 passed, 0 failed, 21 ignored (the ignored tests are the gated live-provider and paid tests, including `real_model_verifier_evaluation`; none were run); `cargo check` clean apart from existing warnings. Architecture tests assert: the synthesis modules import no storage, graph, command, UI or JEV code; shipped code never constructs the stage or verifier; the provider removed in this revision appears nowhere; a same-family pass is wired to `review_required`. Android: see the session report; native test success is **not** evidence of 16 KB APK compatibility.
