# ADR-0012: Muse Code SDK adapter boundary

Status: accepted

## Context

Phase 3 needs one real autonomous QA worker without coupling orchestration,
domain records, or the public CLI contract to a vendor SDK. The model output is
untrusted, Muse may emit private reasoning, and a coding agent can mutate files
or start processes. Production execution must therefore remain isolated,
structured, cancellable, and auditable.

## Decision

`@qa/harness-protocol` owns `HarnessAdapterRegistry`. A registration maps one
stable `AgentStackId` to an `AgentStackDefinition`, preflight, adapter factory,
and resolved runtime identity. `RunCoordinator` consumes only that registry and
the vendor-neutral `HarnessAdapter` event protocol. Fake and real runs use the
same snapshot, workspace, event validation, persistence, timeout, recovery,
cleanup, status, and export code.

`@qa/harness-muse` is the sole package allowed to import `@muse-code/sdk`, pinned
exactly at `0.1.1`. The production adapter starts `muse serve` with executable
plus argv (`shell: false`), opens one session in the isolated Sentry workspace,
selects the exact configured model, and runs two turns: plan, then execution.
Sentry never passes `--yolo` or `--disable-sandbox`. Non-interactive
`approvalMode: allowAll` selects an approval policy; it does not disable Muse's
sandbox. Muse's default fail-closed sandbox startup remains the enforcement
boundary.

This boundary follows the official [Muse Code SDK repository](https://github.com/meta-models/muse-code-sdk),
[contained execution guidance](https://github.com/meta-models/meta-model-cookbook/blob/main/04_muse_code/04_contained_execution/README.md),
and [staged approvals guidance](https://github.com/meta-models/meta-model-cookbook/blob/main/04_muse_code/03_staged_approvals/README.md).

The two model responses must be complete JSON documents matching
`SentryInvestigationPlanV1` and `SentryAgentResultV1`. No regex or prose scraping
is accepted. The plan is converted to a Sentry-owned record and persisted before
the execution turn begins. Temporary evidence keys are only correlations;
Sentry creates every plan, hypothesis, evidence, finding, operation, and event
ID. Paths must be relative, exist, resolve inside the isolated workspace even
through symlinks, and match strict schemas. Code references record a SHA-256
content hash and bounded excerpt. Line ranges must fall inside the referenced
file, and command evidence must match an observed Muse command and exit code.

Muse tool item IDs map to Sentry operation IDs. Reasoning items are discarded.
Subagent/workflow/reminder-child items fail the run. Provider stderr and errors
are bounded and redacted before persistence. Token fields are recorded only
when the SDK reports them; no monetary estimate is created.

## Consequences

Muse can be replaced without changing orchestration or stored domain semantics.
Older JSON records remain readable because `executionKind` and expanded runtime
identity fields are additive. A real run contains exactly one Muse AgentRun;
merger and verifier stages are absent. Windows shutdown is limited by the SDK's
documented child-process guarantee, so cleanup waits for bounded `client.close()`
but cannot claim process-tree termination on Windows.

The exact model is intentionally not defaulted. `SENTRY_MUSE_MODEL` must name a
model accepted by the installed host; otherwise execution fails before a run is
created. The binary resolves from an explicit adapter option, then
`SENTRY_MUSE_BINARY`, then `muse` on `PATH`.

The production timeout defaults to 30 minutes and is configurable per run. It
is an operational hang guard, not a project quota. Adapter shutdown completes
before the disposable workspace is removed.
