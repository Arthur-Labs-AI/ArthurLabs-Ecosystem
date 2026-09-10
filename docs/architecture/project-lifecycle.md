# Project Lifecycle

## Product and storage boundary

Sentry accepts local project folders only. It does not import from GitHub or
another cloud source, and it never modifies the user's original folder. Sentry
uses a separately configured `SentryDataRoot`; it must not default to writing
managed data inside the source project.

Conceptual layout (not implemented in Phase 1.1):

```text
SentryDataRoot/
└── projects/<ProjectId>/
    ├── working-copy/                 # current clean managed copy
    ├── revisions/<ProjectRevisionId>/
    └── runs/<QARunId>/
        ├── activities/
        ├── artifacts/
        └── agents/<AgentRunId>/workspace/
```

The layout is a requirement, not a filesystem API. Paths inside transport DTOs
remain project-relative; runtime paths in harness requests are opaque local
execution paths.

## Import, revision, snapshot

```text
original local folder
        │ Import / Update Project Copy
        ▼
staging copy + validation
        │ successful atomic replacement
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

Update Project Copy must copy into staging, validate completion, create the new
revision, atomically make it current, and then regenerate project context. A
failed update must preserve the previous healthy working copy and history.
Drift detection between the external folder and managed copy is deferred.

## Locking and isolation

`ManagedProjectCopy` transitions are:

```text
ready ──► updating ──► ready | error
  └────► locked_for_run ──► ready | error
error ──► ready
```

`locked_for_run` requires `lockedByQARunId`; every other state forbids it. While
locked, future application code must reject update, replace, delete, and baseline
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
Phase 2 copy, hash, manifest, and artifact implementations must be streaming or
chunked: they must not load, hash, copy, or serialize a whole project in one
buffer. Complete import is the default; any future exclusion must be explicit and
must not silently omit QA-relevant files.

## History and deletion

Run activity is append-oriented and retained incrementally so pre-crash events,
evidence, and findings survive an agent interruption. History has no expiry,
scheduler, quota cleanup, or automatic retention window. Future deletion actions
(`Delete Run`, selected runs, project history, or Sentry project) must be explicit
user operations. Their filesystem/persistence implementation is deferred.
