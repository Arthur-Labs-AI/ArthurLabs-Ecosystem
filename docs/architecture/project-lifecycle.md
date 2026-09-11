# Project Lifecycle

## Product and storage boundary

Sentry accepts local project folders only. It does not import from GitHub or
another cloud source, and it never modifies the user's original folder. Sentry
uses a separately configured `SentryDataRoot`; it must not default to writing
managed data inside the source project.

Implemented Phase 2 layout:

```text
SentryDataRoot/
└── projects/<ProjectId>/
    ├── working-copy/                 # current clean managed copy
    ├── revisions/<ProjectRevisionId>/
    └── runs/<QARunId>/
        ├── snapshot/manifest.ndjson
        ├── activities/
        ├── artifacts/
        ├── exports/run.log|run.json
        └── agents/<AgentRunId>/workspace/
```

`resolveSentryDataRoot()` owns OS defaults and `SENTRY_DATA_ROOT` overrides.
Paths inside transport DTOs remain project-relative; runtime paths in harness
requests are opaque local execution paths.

## Import, revision, snapshot

```text
original local folder
        │ Import / Update Project Copy
        ▼
staging copy + validation
        │ successful recoverable replacement
        ▼
ManagedProjectCopy.currentRevisionId
        ▼
immutable ProjectRevision
        ▼
immutable run-start ProjectSnapshot
```

Every successful initial import or update creates a new `ProjectRevision`.
`ProjectSnapshot.projectRevisionId` records the exact revision from which a run
baseline was derived. Old runs and snapshots never move when the managed copy is
updated.

Update Project Copy copies into revision-named staging, validates content,
persists a non-current revision and context, preserves the old copy as a backup,
promotes staging, and then commits `currentRevisionId`. A failed update restores
the previous healthy working copy and history. Run start hashes the managed copy
and rejects unexpected baseline changes as `PROJECT_COPY_DRIFT`.

## Locking and isolation

`ManagedProjectCopy` transitions are:

```text
ready ──► updating ──► ready | error
  └────► locked_for_run ──► ready | error
  └────► deleting ──► ready | error
error ──► ready
```

`ready` and `locked_for_run` require `currentRevisionId`; only a locked copy has
`lockedByQARunId`. While locked, application code rejects update, replace, delete, and baseline
mutation operations. The user may continue editing the original external folder;
those edits cannot affect the active run.

Each selected agent receives a separate writable workspace derived from the
locked baseline. Agents may inspect, test, instrument, and change only their own
workspace. No agent sees another agent's workspace or outputs. Future clean-state
verification must start from the original run baseline, never an investigation
workspace.

## Large projects

There is no project-size, file-count, token, or inline-content cap in the domain
contract. `fileCount` and `totalBytes` accept non-negative JSON-safe integers.
Phase 2 copy, hash, manifest, and artifact implementations are streaming/chunked.
File-copy concurrency is bounded, manifests are NDJSON artifacts, and Snapshot
DTOs contain only counts/bytes plus the ArtifactId. Complete import is the default;
there are no implicit exclusions. Workspace copies prefer reflinks and fall back
to physical stream copies; mutable hardlinks are never used.

## History and deletion

Run activity is append-oriented and retained incrementally so pre-crash events,
evidence, and findings survive an agent interruption. History has no expiry,
scheduler, quota cleanup, or automatic retention window. Project deletion is an
explicit `--yes` operation and deletes only Sentry-managed data. Selected run
deletion remains deferred.

Phase 2.1 makes lock acquisition a `BEGIN IMMEDIATE` compare-and-set and records
the owning RuntimeInstance. Update and delete journals make rename/tombstone crash
boundaries recoverable, while read-only processes never invoke recovery. See
[Phase 2.1](./phase-2-1.md) for the precise lease and symlink policies.
