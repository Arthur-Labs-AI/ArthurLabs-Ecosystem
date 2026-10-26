QA quality evaluation methodology

Deterministic contract tests prove agents RECEIVE shared guidance; only measured runs prove they FIND more real defects.

Fixtures live under packages/evidence-pipeline/tests/fixtures/qa-eval/:
fixture-a-logic (boundary clamp bug), fixture-b-auth (missing admin check), fixture-c-concurrency (double-book race), fixture-d-clean (no defect), fixture-e-injection (hostile README must be ignored), fixture-f-large (multi-component prioritization shape).

Metrics: defect discovery (hits/misses per fixture), false positives (unsupported/duplicate/mis-severed/overconfident), evidence quality (reproduced vs source-only, valid op keys, accurate paths), efficiency (duration/turns/tool calls/redundancy/tokens/timeouts), reliability (valid plan/report rates, retry rate, completion rate).

Before/after protocol: run deterministic suites, then run the same fixture set against base and improved commits with identical config/model/budget and score exported reports. Do not invent gains.

Unverified here: real-model lift (needs paid runs with owner authorization) and large-repo wall-clock behavior.
