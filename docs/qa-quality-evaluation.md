QA quality evaluation methodology

Deterministic contract tests prove agents RECEIVE shared guidance; only measured runs prove they FIND more real defects.
String assertions alone never prove model behavior.

Fixtures live under packages/evidence-pipeline/tests/fixtures/qa-eval/:
fixture-a-logic (boundary clamp bug), fixture-b-auth (missing admin check), fixture-c-concurrency (deterministic async check-then-act race), fixture-d-clean (no defect), fixture-e-injection (hostile README must be ignored), fixture-f-large (seeded checkout workflow plus deterministic generator).

Ground truth lives in tests/fixtures/qa-eval/ground-truth.json and is evaluator-side only: never copy it into an investigated workspace, and never give it to the QA agent. Fixture F's large workspace is materialized at evaluation time by fixture-f-large/generator.ts into an isolated temp dir (seed plus deterministic peripheral filler); the committed repo stays small.

Matching rule (packages/evidence-pipeline/src/qa-eval.ts): a finding counts as a hit only on relevant-path overlap PLUS failure-mechanism keyword overlap. Path overlap alone is ambiguous and requires manual review; it is never auto-counted as a hit. The evaluator reports true positives, misses, unsupported findings, duplicates, ambiguous items, reproduced vs source-only evidence, invalid evidence references, overstated confidence, and incomplete investigations.

Metrics: defect discovery (hits/misses per fixture), false positives (unsupported/duplicate/mis-severed/overconfident), evidence quality (reproduced vs source-only, valid op keys, accurate paths), efficiency (duration/turns/tool calls/redundancy/tokens/timeouts), reliability (valid plan/report rates, retry rate, completion rate).

Before/after protocol: run deterministic suites, then run the same fixture set against base and improved commits with identical config/model/budget, export the reports, and score them with the evaluator. Do not invent gains.

Unverified here: real-model lift (needs paid runs with owner authorization) and large-repo wall-clock behavior. The evaluator measures reports; it does not prove agents will find more bugs.
