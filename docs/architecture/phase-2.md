# Phase 2 — Local Runtime Foundation

Status: **IMPLEMENTED**

Baseline: `b1acf6ca6b564d88ce65b4e18646a74081974f7f`

## Implemented

Phase 2 turns the Phase 1/1.1 contracts into an executable local lifecycle:

- configurable, OS-specific `SentryDataRoot` with `SENTRY_DATA_ROOT` override;
- migrated SQLite metadata store using Node's built-in `node:sqlite`, foreign keys,
  WAL, explicit repository methods, and Zod parsing on every read/write boundary;
- complete managed-folder import and recoverable staged update with no implicit
  `.git`, dependency, build-output, hidden-file, asset, or binary exclusions;
- `lstat` traversal, symlink preservation, unsupported-entry failure, streamed file
  copy/hash, bounded copy concurrency, cancellation, progress, and storage preflight;
- immutable revisions, conservative factual project context, and a progressive
  NDJSON context-material index;
- deterministic run-start snapshots whose complete manifest is a streamed
  `manifest.ndjson` artifact rather than an inline array;
- reflink-first, stream-copy-fallback agent workspaces, never mutable hardlinks;
- independent FakeHarnessAdapter workers with incremental event/result persistence,
  activity projection, timeout and transport-loss isolation, cleanup, and unlocking;
- startup recovery for interrupted runs/workers, locked copies, and staged updates;
- persisted-data `.log` and streamed-section `.json` exports;
- project and simulated-run CLI commands plus Phase 2 `qa doctor` checks.

## Data layout

```text
SentryDataRoot/
├── sentry.db
└── projects/<ProjectId>/
    ├── working-copy/
    ├── staging/
    ├── revisions/
    ├── context/<ContextId>.materials.ndjson
    └── runs/<QARunId>/
        ├── snapshot/manifest.ndjson
        ├── events/
        ├── activities/
        ├── artifacts/
        ├── exports/run.log|run.json
        └── agents/<AgentRunId>/workspace/
```

Event/activity directories are reserved for filesystem artifacts; their bounded
metadata and event records are canonical in SQLite. Agent workspaces are removed
after terminal runs unless `SENTRY_KEEP_WORKSPACES=1` is set.

## Persistence and migrations

Migration `0001_initial` creates separate tables for Project,
ManagedProjectCopy, ProjectRevision, ProjectSnapshot, ProjectContextSnapshot,
QARun, AgentRun, AgentInvestigationPlan, EmergentHypothesis, Finding, Evidence,
RunActivity, Artifact, RunExportManifest, and HarnessEvent. Domain IDs are primary
keys. Relationship columns carry foreign keys and query indexes. JSON payloads
remain the versioned Zod DTOs, parsed on both save and load; corrupted rows fail
with entity-specific `PERSISTED_DATA_INVALID` rather than coercion.

Each HarnessEvent is inserted in its own transaction with a monotonically
increasing per-AgentRun sequence. If the process stops after event 412, events
1–412 remain committed. WAL improves local reader/writer behavior; foreign keys
encode ownership and cascade run history only through explicit project deletion.

## Copy and update failure boundaries

Import copies into revision-named staging, hashes the finished copy, promotes it,
then persists the initial Project/Revision/ManagedProjectCopy transaction and
builds context. Any failure removes the incomplete Sentry project and never edits
the source.

Update marks the copy `updating`, builds and validates a new staging copy, stores
the new non-current revision/context, renames the healthy working copy to a
backup, promotes staging, and only then commits the new `currentRevisionId`.
Failures restore the backup and current metadata. Directory replacement is called
recoverable transactional update—not universally atomic—because Windows and
other filesystems have interruption boundaries between renames. Startup recovery
discards staging and restores a missing working copy from backup.

## Large-project behavior and deterministic hashes

Files are copied and hashed through streams. The worker set is capped (default
eight); it never contains the whole project. Directory names are byte-sorted per
directory for deterministic traversal. Manifest lines use canonical property
order and aggregate SHA-256 over their exact UTF-8 NDJSON representation:

- file hash: SHA-256 of file bytes;
- symlink hash: SHA-256 of the link target normalized to `/` separators;
- directory hash: SHA-256 of `directory\0<relativePath>`;
- project content hash: SHA-256 of the ordered complete manifest lines.

Timestamps are excluded. Add, remove, rename, byte change, type change, and
symlink-target change therefore alter identity. Snapshot DTOs contain only counts,
total bytes, and the manifest ArtifactId. Artifact writes stream through a
same-directory temporary file while calculating SHA-256 and size, then rename to
the final Sentry-managed path.

## Context and isolation

Context collection indexes every ordinary file, including unknown technologies.
It reads bounded prefixes only from useful text/configuration material and reports
facts with provenance: README purpose, extension-backed languages, known manifest
package managers, and explicitly declared React/Vue/Angular/Vitest/Jest
dependencies. It leaves architecture, business rules, and critical flows absent
when evidence is insufficient.

Every AgentRun receives one private request and one private writable workspace.
The factory asks for copy-on-write/reflink and falls back to streamed physical
copies. It never creates mutable hardlinks. Tests modify one workspace and prove
the managed baseline, peer workspace, and original source remain unchanged.

## Fake run and recovery

`qa run simulate` locks the copy, checks revision drift, streams a snapshot,
loads factual context, persists the QARun/AgentRuns, builds workspaces, and runs
selected fake adapters independently through `Promise.allSettled`. Each event is
validated and stored before its plan, hypothesis, finding, evidence, usage, and
activity projections are updated. Deterministic merger and verification stages
are explicitly no-op/simulated.

Scenarios are `success`, `partial`, `all-fail`, `transport-loss`, and `timeout`.
A missing terminal HarnessEvent is never manufactured: the coordinator records
`WORKER_DISCONNECTED`. Timeout calls adapter cancellation and records a structured
`RUN_TIMEOUT`. Overall `partial` depends on persisted usable finding/evidence
output, even when no worker completes. Startup changes nonterminal agents to
`APP_INTERRUPTED`, derives the run outcome from durable output, and safely unlocks.

## CLI

```text
qa doctor
qa project add <path>
qa project list
qa project show <project-id>
qa project update <project-id> [path]
qa project delete <project-id> --yes
qa run simulate <project-id> [--agents ...] [--scenario ...] [--instructions ...]
qa run list <project-id>
qa run show <run-id>
qa run export <run-id> --format log|json
```

Project deletion removes only Sentry-managed data and requires `--yes`; it never
deletes the selected source folder. Run deletion is deferred.

## Contracted for later

- Muse Code, DeepSeek Harness, Claude Code, or any real model/provider call;
- AI merger/deduplication, real clean-state verification, or fix execution;
- arbitrary baseline build/test command execution;
- Electron/React/workflow-canvas UI, REST, or MCP servers;
- authentication, RBAC, multitenancy, billing, monetary cost, quotas, or expiry.

**Sentry Phase 2 is complete. The local project lifecycle, persistence, snapshot,
workspace, observability, recovery and simulated end-to-end runtime are ready for
real Agent Stack integration.**
