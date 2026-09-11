# Phase 2.2 — Headless Sentry and machine-to-machine CLI

Status: **IMPLEMENTED LOCALLY; GITHUB CI VERIFICATION PENDING**

Baseline: `8338870451921e5066c267499bfca56116cb3a16`

Phase 2.2 makes the local `qa` CLI a versioned automation boundary for scripts,
CI, autonomous coding harnesses, and a future UI/backend process. It does not add
a real AI provider, UI, server, authentication, automatic source fixes, or
monetary cost tracking.

## Machine contract v1

Every supported command accepts `--json`. Machine stdout contains exactly one
JSON document:

```json
{
  "schemaVersion": 1,
  "command": "project.list",
  "ok": true,
  "data": { "projects": [] }
}
```

Failures use the same envelope with `ok: false` and a typed, bounded, sanitized
`error` containing `code`, `message`, `retryable`, and optional scalar `details`.
No raw SQLite, filesystem, Zod, stack trace, environment secret, or provider
credential is part of normal machine stdout. Stderr is reserved for warnings and
diagnostics. Normal machine mode is a single final document; it is not NDJSON and
does not report progress.

Each command result has a dedicated strict Zod schema in
`packages/schemas/src/cli.schema.ts`. Contract v1 keeps command identifiers,
required envelope/result fields, error meanings, stdout/stderr rules, and exit
semantics stable. Compatible optional fields and new commands may be added;
breaking changes require a new `schemaVersion`.

Stable v1 error codes are `INVALID_ARGUMENT`, `PROJECT_NOT_FOUND`,
`RUN_NOT_FOUND`, `RUN_NOT_COMPLETE`, `PROJECT_LOCKED`, `ACTIVE_RUN_EXISTS`,
`PROJECT_COPY_DRIFT`, `PROJECT_SOURCE_NOT_FOUND`, `PROJECT_SOURCE_UNREADABLE`,
`PROJECT_PATH_OVERLAP`, `PROJECT_COPY_FAILED`, `PROJECT_UPDATE_FAILED`,
`PROJECT_DELETE_FAILED`, `INSUFFICIENT_STORAGE`, `SQLITE_BUSY`,
`RUNTIME_LEASE_CONFLICT`, `RUNTIME_LEASE_LOST`, `HARNESS_PROTOCOL_VIOLATION`,
`RUN_EXECUTION_FAILED`, and `INTERNAL_ERROR`. Retryability is explicit in every
error response rather than inferred from its message.

## Supported commands

```text
qa capabilities --json
qa project add <path> --json
qa project list --json
qa project show <project-id> --json
qa project update <project-id> [path] --json
qa project delete <project-id> --yes --json
qa run simulate <project-id> [options] --json
qa run list <project-id> --json
qa run show <run-id> --json
qa run status <run-id> --json
qa run export <run-id> --format log|json --json
```

`run simulate` is explicitly fake/development-only. `capabilities` truthfully
reports that real agent execution, retest execution, and cancellation are false.

## Exit codes

| Code | Meaning                                                  |
| ---: | -------------------------------------------------------- |
|    0 | Command completed successfully                           |
|    1 | Internal or unexpected Sentry failure                    |
|    2 | Invalid command or arguments                             |
|    3 | Requested project, run, or source was not found          |
|    4 | Busy, locked, drifted, or retryable local-state conflict |
|    5 | QA completed successfully and findings require attention |
|    6 | QA execution failed                                      |
|    7 | QA completed partially with usable output                |
|    8 | QA was cancelled                                         |

Finding defects is a successful QA execution and is therefore distinct from exit 6. Read/inspection commands return exit 0 when their retrieval succeeds,
regardless of the persisted run's outcome.

## Read and mutation boundaries

`project list/show` and `run list/show/status` use a read runtime: no mutation
lease, recovery, status transition, project unlock, or workspace access. A
separate process may inspect an active run without interfering with its healthy
owner.

`project add/update/delete`, `run simulate`, and `run export` use a mutation
runtime with the Phase 2.1 lease, abandoned-only recovery, and guaranteed release.
Export is a mutation because it may create a durable artifact.
Exporting a nonterminal run returns retryable `RUN_NOT_COMPLETE` instead of
caching an incomplete artifact as the run's durable export.

Project list reads only current project/copy summaries. Run status reads one
QARun, grouped AgentRun status counts, AgentRun usage DTOs, and a finding count.
It does not materialize events, evidence, activities, or an export. Missing token
metrics remain absent; known metrics are summed, and `totalTokens` appears only
when both input and output aggregates are known. Run show returns richer persisted
records and counts. Run export remains the complete durable history surface.

## External harness and future execution

An external coding harness can import/update a managed copy, invoke Sentry,
inspect structured results, decide what to fix in the original project itself,
and repeat. Sentry never applies those fixes.

Future real execution will fit the same application boundary as `run start`,
`run status`, and `run cancel`. Both blocking `--wait` and start-then-poll models
are planned. Phase 2.2 deliberately does not create a detached-process shim or
route production commands through the fake adapter.

## Phase 2.1 final cleanup

Incremental harness validation now keeps a set of all operation IDs seen during
an AgentRun, preventing reuse after completion while retaining no full event
history. Unsafe and broken workspace links use SHA-256 names in a workspace-owned
metadata namespace outside the copied project tree. Their original path, textual
target, classification, and reason remain deterministic and path-safe without
colliding with legitimate sibling files.

## Deferred scope

- real Muse, DeepSeek, GLM, or other HarnessAdapter execution;
- production `run start`, async ownership, `--wait`, and polling orchestration;
- run cancellation;
- real targeted and retest orchestration;
- UI, HTTP/REST/GraphQL/WebSocket/MCP servers;
- automatic source fixes, authentication, SaaS, billing, and monetary AI costs.

The recommended next phase is **Phase 3 — Real AgentStack Execution Foundation**.
