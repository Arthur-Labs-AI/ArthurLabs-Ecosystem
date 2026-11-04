# ADR 0015: Remove merge, verification, issue and retest

## Status

Accepted.

## Context

Full and Targeted QA already ended at independent per-agent results. The
`@qa/merger` and `@qa/verifier` packages, the merge/verification/issue/retest
services in `@qa/run-engine`, and the Desktop and CLI surfaces for them were
retained only for historical data and for retests. Retests re-ran QA and then
invoked merge and verification internally to compute an assessment. That code
was not reachable from the active product flow and carried the lowest test
coverage of the security-sensitive code.

## Decision

- Delete `@qa/merger`, `@qa/verifier`, the merge, verification, issue and
  retest services, their RPCs (`issues.*`, `retests.*`), the CLI commands
  (`run merge`, `issue *`, `retest *`, `verify *`), and the Desktop Issues and
  Retest pages.
- Keep the systemd sandbox that workspace preparation needs. It moved to
  `@qa/run-engine` (`sandbox.ts`); no verification semantics remain.
- Remove the related schemas, IDs, enums, domain transitions and repository
  methods, including `QARun.lineage`, `configuration.verificationLevel`,
  `TargetSpec.issueIds` and the `retest` QARun mode.
- Add persistence migration 7. It drops the merge, cluster, verification,
  issue and retest tables, deletes legacy runs whose mode is not `full` or
  `targeted`, maps runs stuck in `clustering`/`verifying` to `partial`, strips
  removed fields from stored run and target-spec payloads, and removes
  merger/verifier activities.

## Consequences

- Issue and retest history, and merge or verification results, are not
  readable after upgrade. Full and Targeted runs, findings, evidence, usage
  and exports remain. Previously written export files are not rewritten.
- Orphan cleanup no longer recognises old verifier workspace or staging
  directories; leftover `verifier-workspaces` directories under a project can
  be deleted by hand.
- The CLI contract drops the removed commands. Run results are unchanged.
- The change is not reversible without restoring the removed code and data
  from a backup; rolling back the code after migration 7 would leave the
  database without the old tables.
