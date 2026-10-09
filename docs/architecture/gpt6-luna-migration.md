# Model migration: GPT-6 Luna for distillation, revision synthesis and Automatic Connections Stage B

Status: implemented, verified offline, signed off for commit. This is an APPROVED default-model migration, not an evaluation of Luna. No live request has been made.

## 1. Roles
| Role | Before | Now | Reasoning effort | Output cap (`max_completion_tokens`) |
|---|---|---|---|---|
| Thought Distillation (`distillation/openai.rs`) | `gpt-4.1-mini`, `temperature: 0` | `gpt-6-luna` | `none` | 4,096 |
| Grounded revision synthesis (`synthesis/openai.rs`, Phase 4B) | `gpt-4.1-mini`, `temperature: 0` | `gpt-6-luna` | `low` | 8,192 (reasoning counts toward it) |
| Automatic Connections Stage B (`graph/openai.rs`, M04.7A) | `gpt-5-mini`, effort `low` | `gpt-6-luna` | `none` | 4,096 |

NOT changed (not in the approved scope): Automatic Connections Stage A and Ask Arthur answers stay on `gpt-4.1-mini` at `temperature: 0`; speech-to-text, text-to-speech and embeddings are untouched; the TypeSafe JEV classifier is untouched. `providers::chat::DEFAULT_MODEL` therefore remains `gpt-4.1-mini` because Stage A and Ask Arthur still use it; each migrated role names `chat::LUNA_MODEL` explicitly. `gpt-5-mini` is no longer referenced by any production role. M04.7A's three-stage design, request limits, admission policy, project boundaries, user-owned relations and default-OFF behaviour are unchanged: only the Stage B model and its effort changed.

## 2. API compatibility: documented versus tested
Sources: [GPT-6 Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna), [Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [upgrading guide](https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p6-sol.md).

**Documented capabilities (relied on).** Per the maintainer's sign-off citing the model page and the Chat Completions reference: Luna supports Chat Completions and Structured Outputs; `reasoning_effort` accepts `none` and `low`; `max_completion_tokens` includes reasoning tokens; reasoning-token usage appears under `completion_tokens_details.reasoning_tokens`. Independently read during this work: the model page (API id `gpt-6-luna`; Chat Completions and Responses supported; effort values `none`, `low`, `medium` default, `high`, `xhigh`, `max`; 1.05M context, 128k max output; $0.10 per million input and $0.50 per million output; function calling on Chat Completions only at effort `none`, which Arthur does not use) and the upgrading guide. The Chat Completions reference page could not be retrieved by the tool used for the review (HTTP 404), so its statements are recorded from the sign-off, not re-read.

**Not stated in the pages that could be read, and handled defensively.** Which sampling parameters are rejected at which effort (a third-party summary says to omit `temperature`, `top_p` and logprob options for any effort other than `none`); the `finish_reason` on budget exhaustion. Hence: a reasoning request carries NO sampling parameter at any effort including `none`, so determinism no longer rests on `temperature: 0` (safety never did: it rests on strict schemas, verbatim-evidence resolution, deterministic validation, the verifier and compare-and-set); the output budget is `max_completion_tokens` and `max_tokens` is never sent to Luna; reasoning tokens are read from `completion_tokens_details.reasoning_tokens` when present and are treated as part of the billed `completion_tokens`; the strict `json_schema` response format and the endpoint are unchanged.

**Behaviour that was NOT tested against the live API before the smoke run in section 6 (now checked there, except item 6):**
1. `reasoning_effort: "none"` and `"low"` together with the strict `json_schema` `response_format` on Chat Completions are accepted for all three roles.
2. A request with `max_completion_tokens` and with no `temperature` is accepted, and the budget is respected.
3. The answering `model` is `gpt-6-luna` or a dated snapshot of it (the strict match would otherwise fail closed on a differently formatted id).
4. `usage` carries `completion_tokens_details.reasoning_tokens` and `prompt_tokens`, so accounting is populated.
5. Budget exhaustion surfaces as `finish_reason: "length"` (handled as a typed failure) and a refusal as `message.refusal` (handled).
6. Real-model quality: distillation spans and wording, Stage B recall of wanted edges and its safety, synthesis faithfulness. None of this was benchmarked.
Any of 1 to 4 failing produces a typed error and no write; there is no fallback to another model.

## 3. Behaviour
* The answering model must be exactly the requested id, or that id plus a date snapshot (`gpt-6-luna-20260922`). `gpt-6-luna-pro`, `gpt-6-lunar`, an older model, an empty id and a missing `model` field are all rejected: distillation as `llm_invalid_output` (nothing saved), Stage B as an invalid output, synthesis as `ModelMismatch`. There is no fallback to `gpt-4.1-mini` or `gpt-5-mini`.
* Refusals, `finish_reason: length` (token budget exhausted, which with reasoning can leave the answer empty) and unreadable output are typed failures; nothing is retried because an answer was unwanted.
* Timeouts: distillation 60 s (unchanged), Stage B 60 s (was 120 s for `gpt-5-mini` at effort `low`, now no reasoning), synthesis as configured by its caller.
* Accounting (synthesis, the only role with usage accounting): prompt tokens x $0.10/M + completion tokens (reasoning included) x $0.50/M, with reasoning tokens also reported separately; cached-input discounts are ignored, so the estimate is an upper bound. The previous constants ($0.40/$1.60) are gone.
* The LLM model list shown in AI & Voice is now `gpt-4.1-mini` and `gpt-6-luna` (`registry::models`, and the preview client's static copy): the models Arthur actually uses.

## 4. What was not re-measured
The historical Stage B measurements in `apps/arthur/README.md` (and the live acceptance results in the M04 notes) describe the earlier models and are left as the record of those runs. Luna on distillation quality, on Stage B recall of wanted edges and on synthesis has NOT been benchmarked here (the instruction was a migration, not a comparison). Stage B's safety rests on its deterministic admission policy and two-vote agreement, which are unchanged; its measured "forbidden edges persisted: 0" property was observed on the previous model.

## 5. Tests
Chat request builder (effort and budget present, every sampling parameter absent, non-reasoning models unchanged); `model_matches` strictness; distillation (shipped model, parameters, snapshot accepted, mismatch/missing model/budget cut-off/refusal rejected); Stage B (shipped model and effort, parameters per model family, mismatch and missing model rejected, cut-off rejected, Stage A unchanged); synthesis (request shape, reasoning-token accounting, previous-model and longer-id mismatches, budget cut-off); registry model list; Phase 4B pipeline tests unchanged and passing. Default-OFF behaviour is covered by the existing Automatic Thought Evolution and Automatic Connections tests, which still pass.

## 6. Live API smoke verification (2026-10-09)
Authorized scope: exactly three real, paid requests (one per migrated role) with SYNTHETIC text only, maximum $0.05. They exercised the real request builders and the real strict parsers: distillation through `OpenAiDistiller`, synthesis through `OpenAiRevisionSynthesizer` (one attempt, no retry), Stage B through `OpenAiRelationVerifier` directly (one request, not the three-request graph pipeline). No database, no Graph, no personal data, no TypeSafe.

| | Distillation | Revision synthesis | Stage B |
|---|---|---|---|
| Result | PASS | PASS | PASS |
| HTTP status | 200 | 200 | 200 |
| Requested / returned model | `gpt-6-luna` / `gpt-6-luna` | `gpt-6-luna` / `gpt-6-luna` | `gpt-6-luna` / `gpt-6-luna` |
| Reasoning effort | `none` | `low` | `none` |
| Finish reason | `stop` | `stop` | `stop` |
| Tokens input / output / of which reasoning | 446 / 58 / 0 | 580 / 110 / 31 | 2,805 / 80 / 0 |
| Estimated cost | $0.000074 | $0.000113 | $0.000321 |

Total estimated spend: **$0.000508**. Strict responses parsed by the production parsers; distillation evidence resolved to exact spans; synthesis cited only server-issued source ids and passed the deterministic validation; Stage B returned one valid `depends_on` verdict over the two ids sent.

**API compatibility: CONFIRMED** for all three roles: `reasoning_effort` `none` and `low` with the strict `json_schema` response format on Chat Completions; `max_completion_tokens` with no sampling parameter; the returned model id `gpt-6-luna`; `finish_reason: stop` without truncation; reasoning-token usage under `completion_tokens_details.reasoning_tokens` (31 for the `low` request, 0 for `none`). Not exercised live (covered offline only): budget exhaustion (`finish_reason: length`), refusals, wrong-model answers, error statuses.

**Real-world quality and reliability: NOT ESTABLISHED.** Three single calls on tiny synthetic inputs prove the wire contract, not accuracy or consistency. In particular the synthesis sample produced "Arthur is a mobile application. Arthur will also support desktop." (it kept mobile and added desktop but concatenated instead of merging into one sentence), which the deterministic checks accepted: a reminder that those checks do not judge fluency or meaning. Distillation quality across real captures (Bulgarian and mixed text included), Automatic Connections Stage B recall and false-edge behaviour, and revision faithfulness all REQUIRE the Phase 4C evaluation; nothing here should be read as evidence for them.

**Safeguards of the smoke tests.** They are `#[ignore]` and additionally gated by `ARTHUR_LUNA_LIVE_SMOKE=yes` (exact value, checked before the key is read; tested in the default suite without a network). The credential comes from `ARTHUR_OPENAI_API_KEY` in the environment, is held in memory only, is never printed, and the tests write nothing to disk (asserted by a test). Output is fixed facts: status, models, effort, finish reason, token counts, cost, check flags and, for the synthetic synthesis, the revised sentence. Test-only transport diagnostics (`providers::chat::last_call`, which records the last call's status, model, finish reason, token counts and, on a rejected request, the provider's error message and parameter name; never prompts, answers or keys) exist only under `#[cfg(test)]` and cannot be compiled into the app: a production build (`cargo build`) succeeds without them, and the module has no production caller. The only production-visible additions are the `finish_reason` field of `chat::Completion` (a string the adapters ignore) and, in the test build only, `OpenAiRevisionSynthesizer::single_attempt`.

Command (one paid request each; synthetic only, rotated or app-configured key):
`ARTHUR_LUNA_LIVE_SMOKE=yes ARTHUR_OPENAI_API_KEY=<key> cargo test --offline --lib live_luna_smoke::<distillation|synthesis|stage_b> -- --ignored --nocapture --test-threads=1`
