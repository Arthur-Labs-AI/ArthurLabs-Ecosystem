QA quality evaluation methodology

Deterministic contract tests prove agents RECEIVE shared guidance; only measured runs prove they FIND more real defects.
String assertions alone never prove model behavior.

Fixtures live under packages/evidence-pipeline/tests/fixtures/qa-eval/:
fixture-a-logic (boundary clamp bug), fixture-b-auth (missing admin check), fixture-c-concurrency (deterministic async race on the last seat), fixture-d-clean (no defect), fixture-e-injection (hostile README must be ignored), fixture-f-large (seeded checkout workflow plus deterministic generator).

Ground truth lives in tests/fixtures/qa-eval/ground-truth.json (version 2) and is evaluator-side only: never copy it into an investigated workspace, and never give it to the QA agent. Fixture F's large workspace is materialized at evaluation time by fixture-f-large/generator.ts into an isolated temp dir (seed plus deterministic peripheral filler); the committed repo stays small. Agent-visible sources carry no answer key: no planted-defect labels, no ground-truth IDs, no evaluator metadata (verified by the leakage test).

Matching rule (packages/evidence-pipeline/src/qa-eval.ts): a finding counts as a hit only on canonical path equality (fixture-root-aware; repo-relative, workspace-relative, and Windows paths all canonicalize) AND at least `minMarkers` distinct behavior markers including every `requiredMarkers` group (generic component-name groups alone never satisfy the core defect requirement) matched in non-denial sentences AND at least one cited evidence item that exists in the report. A single generic keyword never suffices; path overlap alone, negated claims, wrong-path mechanism descriptions, evidence-free assertions, and assertions backed only by missing or invalid evidence keys abstain as ambiguous; anything else is unsupported. The evaluator reports true positives, misses, unsupported findings, duplicates, ambiguous items, reproduced vs source-only evidence, invalid evidence references, overstated confidence, and incomplete investigations.

Trust boundary: the evaluator sees the parsed report only. A `reproduced_*` strength is a self-reported claim unless the report already passed Sentry's frozen-ledger validation (`trustedProvenance: true` yields `sentry-validated`, otherwise `self-reported`). `confirmed` confidence requires Sentry-validated reproduction evidence; source inspection alone supports `strong` at most, and self-reported reproduction is flagged as not independently confirmed. `trustedProvenance` is a caller-supplied assertion for trusted evaluation integrations only; raw reports must never enable it for themselves.

Metrics: defect discovery (hits/misses per fixture), false positives (unsupported/duplicate/mis-severed/overconfident), evidence quality (reproduced vs source-only, valid op keys, accurate paths), efficiency (duration/turns/tool calls/redundancy/tokens/timeouts), reliability (valid plan/report rates, retry rate, completion rate).

Before/after protocol: run deterministic suites, then run the same fixture set against base and improved commits with identical config/model/budget, export the reports, and score them with the evaluator. Do not invent gains.

Unverified here: real-model lift (needs paid runs with owner authorization) and large-repo wall-clock behavior. The evaluator measures reports; it does not prove agents will find more bugs.
