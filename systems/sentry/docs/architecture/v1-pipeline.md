# Sentry v1 architecture contract

This contract describes the current independent-agent v1 pipeline. Historical
Phase1 scope statements below record the original design baseline.
See the [source assessment](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/v1-phase-1-assessment.md) and
[release roadmap](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/V1_ROADMAP.md).

```text
Desktop / supported CLI broker
  → Linux runtime → managed project revision → immutable snapshot
                                            ├→ OpenCode → own report/evidence
                                            ├→ DeepSeek → own report/evidence
                                            └→ GLM via Claude Code → own report/evidence
  ← persisted run snapshots / update hints / JSON and log exports
```

Only selected agents execute. Full and Targeted QA share this topology.
Targeted QA freezes and validates a TargetSpec against the snapshot manifest;
agents retain full-strength investigation within that focus and its dependencies.
No agreement-based confidence or obligatory deduplication stage is added.

## Source of truth and ownership

The Linux runtime owns the canonical SQLite repository, project operations,
runtime lease, RunCoordinator and adapter registry. `ProjectManager` owns managed
copies and revisions; `SnapshotEngine` owns frozen manifests and retained bytes;
`WorkspaceFactory` creates a disposable private workspace for each AgentRun.
Adapters may mutate only their allowed workspace. Source imports, retained
revision material and sibling agent workspaces are not shared writable state.

The Desktop main process owns runtime launch/connection, host path translation,
safeStorage-backed provider settings, native export dialogs and update fan-out.
It owns no domain database or coordinator. The renderer reads persisted snapshots
and keeps only presentation state (selection, canvas positions, panel widths).
Credentials stay outside renderer payloads; runtime configuration is memory-only.

## Dependency direction and explicit boundaries

Shared IDs, schemas, domain rules and persistence support project/snapshot/
workspace packages and the run engine. Agent integrations implement the common
harness protocol. Runtime wires those components; Desktop reaches runtime
through typed stdio RPC, not direct database or adapter construction.

Renderer IPC and the supported external CLI share `desktop-command-router.ts`
validation; external commands have a narrower allowlist. Runtime dispatch is
separate and validates start options/IDs. NDJSON transports carry serializable
requests, responses and bounded update notifications, not live objects, arbitrary
shell commands or internal database handles. Keep the existing protocol and IPC
contracts backward compatible. Direct development CLI transport is not the
production automation contract.

## Adapter and evidence responsibilities

OpenCode, DeepSeek and GLM through Claude Code independently plan, investigate
and report through their current integrations. Harness adapters own provider
transport, sessions, tool restrictions, event translation, report validation,
usage and child-process disposal. Phase 1 does not refactor these harnesses.

The coordinator validates and persists harness events and derived activities,
findings and evidence. Each finding retains `agentRunId`, `sourceAgentStackId`
and evidence references. Evidence retains its originating AgentRun, operation
grounding and snapshot provenance. The evidence pipeline enforces existing
containment/trust checks; agent agreement cannot upgrade evidence strength.
Durable artifact bytes and repository records survive disposable workspace
cleanup. Keep deliberate workspace-retention diagnostics separate from ordinary
cleanup; they do not replace evidence persistence.

## Lifecycle and failure semantics

Preflight resolves only selected stacks. Project locking, revision integrity
and snapshot freeze precede execution. The initial QARun is persisted before
the frozen hook (required by retest foreign keys); TargetSpec is saved before
agents start. Selected agents run concurrently with independent outcomes.
Handled pre-execution errors terminalize the persisted row. Settled workers
produce completed, partial, failed or cancelled parent outcomes using the
existing aggregation rules. Production finalization produces reports/exports,
not merge/verify/ingest orchestration.

Unavailable credentials, local prerequisites and malformed output remain
structured failures; partial output and peer outcomes must not disappear.
A Desktop RPC timeout does not prove a run failed to start: the service
reconciles persisted active runs and reports `RUN_MAY_HAVE_STARTED` where needed.
No silent retry that risks duplicate paid runs is introduced.

## Cancellation, recovery and observability

Cancellation is a durable control request. The runtime owner acknowledges it,
signals owned adapters, waits for settlement/disposal and workspace cleanup,
then records completion. Pending retest cancellation propagates to the child
run; it does not start new adapters after a pre-execution cancellation request.
Shutdown refuses active QA/retests; reconnecting a transport must not invent
completion or create a second run.

Runtime leases/heartbeats establish ownership. Boot recovery interrupts work
whose owner is stale, preserves findings/evidence and releases abandoned locks.
Notifications refresh Desktop cached snapshots; polling/re-reading snapshots
reconciles dropped hints and reconnects. Persisted status, typed failure codes,
agent events, activities, usage and exports are the observable record.

## Removal of merge, verification, issue and retest

The merger and verifier packages, the merge/verification/issue/retest services,
their RPCs, CLI commands and Desktop pages were removed (see
[ADR 0015](../adr/0015-remove-merge-verification-issue-retest.md)). Full and
Targeted QA end at the independent agent fan-out and the report. Persistence
migration 7 drops the merge, cluster, verification, issue and retest tables and
discards legacy retest runs; ordinary Full/Targeted runs, findings, evidence
and exports are kept. The systemd sandbox that workspace preparation uses now
lives in `@qa/run-engine`.

## Test seams and security

Use fake RPC transports for Desktop routing, deterministic graph inputs for
rendering, explicit fake harnesses for historical fixtures, and temporary real
repositories for persistence/reopen tests. Fake harnesses remain barred from
production execution. Existing Full/Targeted, parallel, cancellation, recovery,
export, issue/retest and sandbox suites guard the boundaries. Real systemd
mount/replay tests require a capable Linux host; mock preflight tests do not
prove containment. Report unavailable security/provider/platform gates explicitly.

No new privilege boundary, secret transport, persistence writer, service,
database, broker or framework is introduced. Keep current credential isolation,
path validation, sandbox controls and security tests intact. Windows/WSL release acceptance remains separate from generic Linux CI. Native
Linux Desktop (CachyOS) acceptance is deferred to a future native release; shared
Linux runtime and sandbox tests remain required for Windows through WSL2.

## Retired product flows

Do not restore Merger → Verifier → Issue Ingestion orchestration, compulsory
clustering/deduplication, or confidence derived from agent agreement.
