# QA depth follow-up

## Scope and architecture

Fix false coverage passes, short stable report check aliases, durable report
checkpoint, then deploy and verify the active runtime. No paid model run.
Using architecture-review for the added event contract:

1. Source of truth: the existing SQLite harness event journal owns checkpoints;
   canonical evidence/findings remain the normal final output.
2. Ownership: adapters build validated facts, the coordinator persists them.
3. Dependencies: schemas define the event, protocol validates ownership, engine
   consumes it. No dependency reversal or new service.
4. Boundary: one typed report.checkpoint event carries bounded canonical facts;
   no live client, raw model report or credentials cross the boundary.
5. Failure: optional review failure falls back normally; disconnect/crash recovery
   materializes checkpoint facts only when no final facts were already submitted.
   Interrupted workers stay interrupted; this never fabricates completion.
6. Lifecycle: checkpoint before review; final facts supersede it; journal retained
   with run history. Existing cleanup still owns private workspaces.
7. Tests: fake adapter disconnect, stale-owner recovery, protocol ownership,
   coverage negatives and all three adapter identity paths.
8. Compatibility: additive event variant, no DB migration. Old runs keep decoding;
   old binaries cannot read the new event variant, so deploy desktop/runtime
   together and do not claim old-binary rollback compatibility for new runs.
9. Observability: journal checkpoint event and warning on recovery; partial outcome
   with original failure rather than completed.
10. Security: existing evidence conversion before checkpoint, strict nested run
    ownership validation, no additional host or network capability.

## New run evidence

Owner export run_01M5ZNPA0HBVTQE9E42YHESM58 uses the old workflow: all three prep
receipts limited, challenge before reporting, old 90min diagnostic on a 30min
deadline. OpenCode completed in 3:44 with two findings; DeepSeek spent about18min
planning and timed out during investigation; GLM failed report serialization and
then exact-check-name validation. No checkpoint was emitted by this old runtime.
The new bounded review cannot guarantee output when initial investigation/report
itself fails. Stable IDs address the observed long-name serialization failure.

## Implementation and verification

- Ambiguous compound/multiline shell commands and absolute-path inspections are
  downgraded instead of inheriting the last shell process's successful exit.
  Permanent negative coverage fixtures failed before the fix and pass afterward.
- Host-issued short IDs resolve to exact frozen names, with no fuzzy matching;
  IDs avoid collisions with original names. All three adapter phase fixtures
  exercise aliases and one durable checkpoint per depth-enabled run. Alias
  normalization also applies to the legacy path; its regression failed before
  the normalization fix and passes afterward.
- Checkpoint facts use the existing event journal. Live disconnect and stale-owner
  recovery retain them without fabricated completion or duplication. Injected
  restoration write failure initially leaked the workspace; the new finally
  boundary now guarantees cleanup and that regression passes.
- Full non-engine suites: PASS, 39 Turbo tasks, existing platform/live skips.
- Final build/typecheck/lint: PASS, 60 Turbo tasks (combined command).
- Final three adapter phase suites: PASS, 18 tests.
- Format, diff whitespace and repository hygiene: PASS.
- New paid provider runs and an accuracy comparison: UNVERIFIED, not started.

Local command logs: ignored `.tmp-sentry-test-fixtures/fix-*`,
`checkpoint-*` and `alias-legacy-red.log`. Deployment receipts follow separately.
