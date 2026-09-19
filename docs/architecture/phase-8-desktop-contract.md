# Phase 8 — Desktop Bridge Contract

Preload API: `window.sentry` (plus `window.sentry.dialogs.pickDirectory`).
All payloads are JSON-serializable; main validates every call with Zod before touching Sentry.

## projects

- `list()` → project cards (id, name, state, currentRevisionId, sourcePath, updatedAt, runCount).
- `add(sourcePath)` → `ProjectManager.addProject` (native folder picker supplies the path).
- `get(projectId)` → full `ProjectRecord` (project, managedCopy, revision, context).
- `revisions(projectId)` → `ProjectRevision[]`.
- `update(projectId, sourcePath?)` → `updateProjectCopy`; locked projects return `ACTIVE_RUN_EXISTS`/`PROJECT_LOCKED` honestly.
- `doctor(projectId)` → readiness, revision/run/issue counts, detected ecosystem, warnings.

## runs

- `list(projectId)` → `QARun[]`.
- `get(runId)` → `RunSnapshot` (run, agentRuns, findings, evidence, activities, events, mergeResults, verificationRuns, occurrences, targetSpec?).
- `status(runId)` → `RunStatus` (agents by status, findings total, tokens).
- `startSimulation(projectId, { mode, includePaths?, scenario?, instructions? })` → `DesktopOperation { operationId, runId? }`. Simulation only (FakeHarness); production controls stay disabled without providers.
- `cancel(runId)` → `requestRunCancellation` result (`cancellation_requested` until terminal).
- `merge(runId)` → `mergeRun` result (Merger v2).
- `verify(mergeResultId)` → `verifyMerge` (Verifier v3).
- `ingest(mergeResultId)` → `ingestMergeIssues` (Issue ingest; idempotent per merge/cluster).
- `exportRun(runId, format)` → existing exporter manifest (`log`|`json`).

## issues

- `list(projectId)` → `Issue[]`; `get(issueId)` → `Issue`; `history(issueId)` → issue + occurrences + events + assessments + retests.

## retests

- `list(issueId)` → `RetestRun[]`; `start(issueId, { revisionId? })` → `DesktopOperation { operationId, retestRunId }` (simulation registry; backend stays production-semantic).
- `get(retestRunId)` → `RetestSnapshot` (retestRun, spec?, targetRun?, assessments). Spec/Snapshot-B/targetQaRunId survive cancellation.
- `cancel(retestRunId)` → request + owner-acknowledge cascade (child run gets request-only).

## doctors

- `environment()` → agent stack readiness (statuses only, never secrets), simulation label, data root.

## system

- `info()` → `{ dataRoot, versions: { desktop, merger: '2', verifier: '3', retest: '2' } }`.
- `activeRuns()` → nonterminal runs for the global strip.

## subscriptions

- `subscribe.onRunUpdate(cb)` → `cb({ kind, runId?, retestRunId?, operationId?, snapshot? })` for `run-created | run-snapshot | retest-created | retest-snapshot`. Payloads only — never Electron events.
- `sentry:watch-run` / `unwatch-run` / `watch-retest` orient the 500 ms poller; `sentry:active-runs` pushes the idle sweep.

## errors

Structured `{ code, message }` (bounded to 100/1000 chars): `PROJECT_NOT_FOUND`, `ACTIVE_RUN_EXISTS`, `INVALID_TARGET`, `RUN_NOT_TERMINAL`, `ISSUE_NOT_FOUND`, `RETEST_NOT_FOUND`, `IPC_UNKNOWN_CHANNEL`, `DESKTOP_ERROR`. Important errors render in-page; toasts are transient-only.
