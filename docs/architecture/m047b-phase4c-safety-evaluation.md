# M04.7B Phase 4C — Independent verifier integration and safety evaluation

Status: implemented, verified offline, **uncommitted and unstaged**. Nothing is activated. No paid or live request was made. Schema v8 is unchanged.

## 1. Verifier choice

| | Z.ai GLM (chosen) | DeepSeek (rejected) |
|---|---|---|
| Model used | `glm-5.3` | `deepseek-flash` / `deepseek-v4-pro` |
| Family vs. synthesizer (`gpt-6-luna`) | different (`glm` vs `openai`), enforced by `ensure_independent` | different |
| Data handling (official docs, read 2026-10) | International service, processed in Singapore; the DPA says customer input is processed in real time and not saved. It does **not** explicitly prohibit training. | Consumer policy: stored in the PRC, used for training unless the user opts out |
| Output control | `response_format: json_object` only (no JSON-schema); reasoning is always on (`reasoning_effort` low/high/max) | similar |
| Bulgarian | **undocumented** (accuracy unmeasured) | undocumented |

The choice rests on documented data handling, not on measured quality: none has been measured (§6). "Different family" is architectural separation; it is not proof of statistically independent errors. Prices ($1.40/$4.40 per million tokens) are the listed ones and may change.

## 2. What was built

- `providers/registry.rs`: `ProviderId::Zai` — a native-only credential slot (own keystore slot, no models, no TTS, invisible to every UI command, same pattern as `TypeSafe`). Nothing in shipped code constructs it yet.
- `synthesis/zai.rs`: `ZaiRevisionVerifier`, implementing `RevisionVerifier`.
  - Request: fixed system prompt; user message is a JSON document of the existing idea, the quoted sources, the new note and the proposal. It carries **no** object ids, revision ids, capture ids or project ids, so the verifier cannot name a target. Everything in it is declared data.
  - Answer contract (strict, enforced locally because the provider cannot enforce a schema): exactly `{"verdict": "pass"|"veto", "checks": {12 booleans}}`. The checks are: unsupported new fact, unsupported date/quantity/entity, dropped fact, negation/qualifier change, wrong correction behaviour, scope expansion, evidence misattribution, contradiction, ambiguous reference guessed, certainty increase, unfaithful to previous, unfaithful to new claim.
  - Fail-closed → `Unavailable(InvalidResponse)`: unparseable or non-JSON text, prose around JSON, a missing/extra key, a non-boolean, `pass` with a problem flagged, `veto` with none, `uncertain` or any other verdict word, wrong or missing model id (exact id or dated snapshot only), `finish_reason` other than `stop` (e.g. token budget spent on reasoning), empty or oversized content. Bad answers are never retried into good ones; only transport failures (timeout, 429, 5xx) are retried, at most twice.
  - Veto-only: the output type is `Verdict::{Pass, Veto(reasons), Unavailable(reason)}`. There is no way to say "revise this", to edit the draft, or to promote anything.
  - Bounds: 14 000-character input, 6 000-token output, 2 concurrent requests, per-request timeout, **cancel that abandons an in-flight request**, usage/cost accounting with fixed-code failure counters. `Debug` output is redacted; prompts, answers and keys are never logged.
- `synthesis/mod.rs`: two new typed reasons (`VetoReason::AmbiguousReference`, `UnavailableReason::InvalidResponse`).
- Pipeline: **no change was needed in `SynthesisStage` or `EvolutionPipeline`.** The Phase 4B stage already ran the verifier after deterministic validation, re-read both provider authorizations and the consent state after every wait and at commit, and made the CAS transaction the only writer. Phase 4C plugs the real adapter into that boundary and proves the properties with the real adapter (below).

## 3. Authorization and privacy protections

- `Purpose::Verification` is authorized separately from `Purpose::Synthesis`, per provider, default OFF, bound to a disclosure version (`zai::DISCLOSURE_VERSION`, `zai-verification-2026-10-v1`; a change voids earlier grants), revocable, never migrated from any other consent (TypeSafe/OpenAI consent does not authorize Z.ai).
- Verifier disclosure (must be shown, verbatim in substance, before a person can grant it in Phase 5): *the existing idea text, the new note's text and the proposed revision are sent to Z.ai's international service (Singapore) to be checked; Z.ai states it does not store the content; it does not contractually promise not to train on it; the check can be switched off at any time and ideas then wait for your review.*
- Without authorization, a key, or with the verifier unavailable, the stage does not even ask the synthesizer, so no text leaves the device for a draft that could never be verified (tested with the real adapter: zero requests reach the fixture).
- No request is made while a SQLite transaction is open (the stage runs before the single immediate transaction; tested: another writer completes while the verifier hangs).
- **There is no user-facing switch.** Granting authorization, entering the key and enabling evolution are Phase 5 work.

## 4. Offline tests (all pass)

`synthesis/tests_4c.rs` (13 tests) and the existing 45 `synthesis/tests.rs` tests cover: feature OFF (no classify/synthesize/verify/send); missing verifier; PASS → one revision with exact provenance; VETO (all 12 reasons) → claim held, idea untouched; every malformed/inconsistent/wrong-model/truncated/empty/oversized answer; no retry of bad answers, bounded retry of transport failures, no retry on 400/401/402/404; timeout; mid-flight cancel (a 30 s timeout is abandoned in under 5 s); verification authorization revoked while the synthesizer works, and at commit; stale revision after verification (a user edit or another automatic revision wins, the draft is not applied); duplicate processing (one revision); wrong project (never reaches synthesizer or verifier); correction provenance (old evidence becomes history, never current support); transaction rollback with clean retry; Graph event only after commit and no Graph work with Automatic Connections off; Bulgarian, mixed and emoji provenance; hostile instructions inside a capture or quote stay data; the key is never in a request body, log or `Debug`.

## 5. Evaluation design

Corpus (`synthesis/eval/corpus/`, pinned by SHA-256 in `CHECKSUMS`; a test fails if any file changes): dev = 31 revision cases (10 safe / 21 unsafe) + 10 identity cases; **holdout** = 25 revision cases (8 / 17) + 10 identity cases. Languages: English, Bulgarian, mixed, Unicode/emoji. Unsafe classes cover every category in the brief. Dev and holdout share no scenario (tested).

Layers, reported separately:

- **Identity gate**: the real resolver over *scripted* classifier signals. It measures the policy gate, not any classifier.
- **A — deterministic validator**: real code, no model.
- **B — mock transport**: the real adapter against a localhost fixture. *Oracle* (answers from the label; cannot be wrong), *always-pass*, *garbage*, *outage*. These show plumbing and failure behaviour. **They say nothing about model quality.**
- **C — real model**: an `#[ignore]`d, doubly gated test (`ARTHUR_ZAI_EVAL=yes` + `ARTHUR_ZAI_API_KEY`), hard-capped at 60 requests (≈ $0.4 at listed prices), prints only counts. **Not run.**

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

Labels from one author and one AI; tiny corpus; scripted identity signals; no human adjudication; no real-model result; Bulgarian accuracy of GLM undocumented; Z.ai's non-training status not contractually explicit; classes such as evidence misattribution are barely represented (1 case) and absent from the holdout; the verifier sees only the text, so it cannot detect an error in the *choice* of target (that remains the resolver's job); a verifier with correlated blind spots to the synthesizer is possible despite separate families.

## 8. Release recommendation: **RESTRICTED — do not activate**

- **GO: not supported.** There is no real-model measurement, no independent labels, and no UI for consent.
- **NO-GO is not warranted for the code**: fail-closed behaviour, authorization, rollback and race protections are verified offline.
- **RESTRICTED** means: the code may be merged dark. Any later activation must be *review-first* (a verified draft is shown to a person as a suggestion; nothing is applied automatically) until all of the following exist: (a) a human-adjudicated corpus (use the review packet) with at least ~100 unsafe and ~100 safe items including ≥ 30 Bulgarian; (b) a real-model run of layer C within a stated budget showing verifier false-PASS upper confidence bound acceptable for each unsafe class (especially incorrect corrections, scope and certainty); (c) a decision that Z.ai's data terms are acceptable for the disclosure text above, or a different verifier; (d) Phase 5 consent UX and revocation; (e) Android 16 KB APK compatibility verified (open item).

## 8a. Release decision (final): RESTRICTED — review-first only

- The real GLM verifier has **not been evaluated**; its accuracy is unmeasured. Human adjudication is incomplete (the review packet is unfilled).
- The deterministic validator alone accepted 7/17 unsafe holdout drafts (10/21 on dev); this is why automatic activation is premature.
- Scripted identity signals are not real JEV quality measurements.
- Safe mechanical behaviour (fail-closed, rollback, races, authorization) does not establish semantic correctness.
- The 16 KB Android APK release check is still outstanding; the native test run does not cover it.
- Phase 5 may add user-controlled approval of proposed revisions. Automatic revisions are **not** production-ready, and the pipeline is unreachable in production (the injector is test-only).
- The paid evaluation test needs `--ignored` **and** `ARTHUR_ZAI_EVAL=yes`, checked before any credential is read; the 60-request cap is a maximum, not permission. The evaluator writes reports only to an explicit directory (never the corpus), and a test pins the corpus by SHA-256.

## 9. Verification

Full `cargo test` 819 passed, 0 failed, 21 ignored (the ignored tests are the gated live-provider and paid tests, including the new `real_model_verifier_evaluation`; none were run); `cargo check` clean apart from pre-existing warnings; architecture tests (including the new `zai.rs`: no storage/graph/commands/tauri/jev imports; shipped code still never references the synthesis stage) pass; `git diff --check` clean. Android: see the report in the session; native test success is **not** evidence of 16 KB APK compatibility.
