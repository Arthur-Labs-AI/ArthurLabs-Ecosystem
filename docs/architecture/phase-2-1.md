# Phase 2.1 — Runtime Integrity Hardening

Status: **IMPLEMENTED LOCALLY; GITHUB CI VERIFICATION PENDING**

Baseline: `52c8bd7dff2d2a12978f13dabfe24237f6880556`

Phase 2.1 hardens the Phase 2 local runtime without introducing a real AI adapter,
UI, authentication, monetary cost tracking, or automatic source changes.

## Runtime ownership and recovery

Every mutation-capable process creates a durable `RuntimeInstance` in SQLite. The
record contains an opaque instance ID, process/host diagnostics, start time,
heartbeat, and optional release time. Heartbeats run every five seconds and a
lease is stale after twenty seconds by default. A clean shutdown marks the lease
released. A heartbeat write failure is retained as a typed error and prevents
later mutation through that lease.

QARuns, managed-copy run locks, and project lifecycle operations persist their
owning runtime ID. Recovery acts only when that owner is released, absent, or past
the stale threshold. A second process may read the database without registering a
lease or running recovery. A fresh owner is never interrupted by another process.
Legacy Phase 2 rows without an owner are recovery-eligible for compatibility.

Two processes acquire a project run lock through `BEGIN IMMEDIATE` plus an
in-transaction `ready` check. Exactly one can change the copy to
`locked_for_run`; the loser receives `ACTIVE_RUN_EXISTS` (or a typed busy error)
and cannot overwrite the owner.

## Project lifecycle journals

Updates and deletes use durable `RuntimeOperation` journal rows to bridge short
SQLite transactions and filesystem rename boundaries. Update builds and hashes a
staging tree and prepares context material without publishing revision/context
metadata. It then backs up the healthy working copy, promotes staging, and commits
the new Project, Revision, context artifact, context snapshot, current copy, and
journal stage in one database transaction. Pre-commit failure removes prepared
metadata artifacts and restores the old copy; abandoned recovery does the same.
Post-commit recovery treats the new revision as canonical and only cleans residue.

Delete first marks the managed copy `deleting`, renames its project root to a
tombstone, deletes canonical SQLite project history transactionally, then removes
the tombstone. Recovery restores the tombstone when the database project still
exists, or finishes deletion when the database commit already happened. The
original source path is never a deletion target.

## Symlink and junction isolation

Snapshot traversal uses `lstat` and records each link's textual target and
classification: `internal`, `external`, or `broken`. Classification resolves the
canonical project root and target, including `..`, absolute targets, nested links,
Windows case folding, directory symlinks, and junctions exposed through Node's
link APIs. Traversal never follows the link, so cycles remain finite and identity
is deterministic.

Managed baseline import preserves links. Agent workspaces use the stricter
`inert-unsafe` policy: safe internal links are recreated against the
workspace-local target; external and broken links become inert
`*.sentry-link.json` descriptions containing relative path, target, and reason.
They are never writable paths to the original source or an external target.
Windows directory links use a workspace-local junction target when required by
the platform; external or unclassifiable reparse targets are not activated.

## Protocol ingestion and live observability

Each AgentRun owns one incremental validator. It retains only started/terminal
flags and currently open tool operation IDs, rather than the full event history.
It rejects a wrong QARun or AgentRun, duplicate/unmatched tool lifecycle, tool-name
mismatch, missing or duplicate start/terminal events, open tools at terminal, and
events after terminal. SQLite classifies duplicate event IDs as `EVENT_CONFLICT`.

After validation, one short SQLite transaction persists the HarnessEvent and its
Finding, Evidence, Plan, Hypothesis, AgentRun, and RunActivity projections. If a
later event fails, earlier committed events remain available and only that agent
fails with `HARNESS_PROTOCOL_VIOLATION`; peer workers continue. Fake lifecycle
events persist real `planning`, `running`, and terminal AgentRun states.

Abandoned-run recovery marks nonterminal AgentRuns `APP_INTERRUPTED`, derives the
final QARun outcome from durable usable output, and finalizes every `waiting` or
`running` RunActivity—including root, agent, and tool nodes—with a timestamp and
unexpected-stop explanation. It does not invent terminal HarnessEvents.

## Large-run exports

SQLite repository iterator APIs feed both exporters row by row. Log export no
longer materializes all HarnessEvents. JSON sections for agent runs, plans,
hypotheses, activities, events, findings, evidence, and artifacts are emitted one
record at a time while preserving a valid deterministic document shape.

## Migration strategy

`packages/persistence/src/migrations.ts` is the single migration SQL source of
truth. Migration 0002 adds runtime leases, operation journals, owner columns,
indexes, uniqueness, and cross-run ownership triggers. It is forward-only and
upgrades a representative healthy 0001 database in place without data loss.
Application DTO schemas keep new QARun ownership optional so version-1 payloads
remain readable; newly active runtime records always write ownership.

The exact Phase 2.1 completion statement is intentionally withheld until the
repository's GitHub Actions run has been observed passing.
