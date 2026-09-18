# Phase 7 — Stable Core / Private Beta

## Purpose

Phase 7 makes Sentry a stable technical private-beta product: FULL, TARGETED,
and RETEST are first-class QA workflows over immutable ProjectRevisions and
ProjectSnapshots; issues carry durable cross-revision lineage with
append-only history; fix-state decisions require fresh canonical evidence;
cancellation, crash recovery, revision history, storage hygiene, and
machine-readable CLI contracts are stable. The frozen Muse, DeepSeek, GLM,
Merger v2, and Verifier v3 foundations remain intact.

Phase 8 builds the Desktop UI. Phase 9 builds installation, setup, packaging,
onboarding, and distribution. Neither is implemented here.

## QA modes (closure: canonical)

QARun execution modes are `full | targeted`, persisted explicitly on every
QARun — never inferred from flags or instructions. FULL is unchanged:
Muse, DeepSeek, and GLM independently perform the same complete QA against
the frozen ProjectSnapshot. TARGETED is FULL-strength QA focused on a
narrower scope: all selected agents receive the same snapshot, context,
TargetSpec, instructions, and policy, with no peer visibility.

RETEST is a first-class cross-revision _workflow_ (`RetestRun` + a child
FULL/TARGETED QARun on revision B), not a QARun mode. Production never
creates `QARun mode=retest`; the `retest` branch in `QARunSchema` is a
LEGACY decoder for historical rows only. User workflows: FULL, TARGETED,
RETEST.

## TargetSpec

TARGETED runs persist one immutable `TargetSpec` row (per run) before agents
start: project-relative `includePaths` (normalized, inside the snapshot;
absolute paths, `..`, backslashes, and duplicates rejected), optional
`issueIds`, and optional `userInstructions`. Paths are validated against the
frozen snapshot manifest — unknown paths fail the run instead of widening
the scope. A deterministic `targetSpecDigest` (paths, issues, instructions,
agents, snapshot, policy) anchors run identity and audit. Scope defines the
QA objective, not a workspace prison: agents may inspect dependencies
outside the target, but findings should relate to the target or a necessary
dependency/consequence.

## Issue lineage

`Issue` is the stable product-level defect identity across time — distinct
from `Finding` (one AgentRun) and `FindingCluster` (one MergeResult).
`IssueOccurrence` connects an Issue to one revision/run/merge/cluster (plus
an optional verification run). History is append-oriented: `Issue` +
`IssueEvent[]` + `IssueOccurrence[]` + `RetestAssessment[]` are never
overwritten; `currentState` (`open`, `still_reproducible`, `partially_fixed`,
`fixed`, `inconclusive`) is derived from the event log. New issues start
`open`; explicit retest links are authoritative; reopening
(`fixed` → `still_reproducible`) records regressions. No fuzzy cross-run
merging and no LLM issue deduper: a later FULL run that resembles an
existing issue creates a new Issue rather than silently merging history.
Issue ingest from a merge result is idempotent via `issueIngestKey`
(one merge+cluster pair maps to exactly one occurrence).

## Retest domain

Historical cluster/occurrence → `RetestSpec` (source snapshot A, target
snapshot B; A ≠ B enforced) → `RetestRun` (status lifecycle: created →
agents_running → merging → assessing → completed/partial/failed/cancelled/
interrupted; the target snapshot is optional until the freeze, then
required and distinct) → deterministic `RetestAssessment` (issue,
revisions, occurrences, new evidence, result, rationale, limitations).
`VerificationRun` keeps its Phase 6 meaning (verify against the issue's
own historical snapshot) and is never reinterpreted as cross-revision
testing; retest reuses verifier trust primitives (recipe, sandbox, strict
identity, sig3) where technically appropriate.

`retestIssue` orchestration (closure v2): resolve the latest explicit
occurrence → create `RetestRun` (`created`) → resolve historical target
paths deterministically (exact → nearest ancestor → explicit focused
full-snapshot fallback `RETEST_HISTORICAL_TARGETS_ABSENT`; absence never
means fixed) → child FULL/TARGETED run on B through the standard
coordinator path (working copy must be at the target revision) → freeze B
→ persist the immutable `RetestSpec` v2 + `inputDigest` → merge →
`verifyMerge` on the target merge → `compareRetestSteps` →
`classifyRetest` → assessment (target IDs always revision-B; absent
targets stay absent, never source-substituted) + target occurrence (best
same-key cluster overlap) + `occurrence_recorded` / `retest_assessed`
events. Every normal path terminalizes the same RetestRun
(`failed`/`cancelled` carry a bounded `failure` record; pre-freeze failures
have no target snapshot); only a hard crash leaves it nonterminal, and
lease-based `recoverRetests` then interrupts it. Cross-project revisions
are rejected (`ISSUE_CONFLICT`). Cooperative `requestRetestCancellation` /
`acknowledgeRetestCancellation` cascade to the child target run; legacy
`cancelRetestRun` delegates to the same path for single-process callers.

Retest audit chain: `IssueOccurrence A → RetestRun → Snapshot B →
RetestSpec v2 → child FULL/TARGETED QARun → MergeResult B →
VerificationRun B → cross-revision deterministic comparison →
RetestAssessment → IssueEvent`.

Different-failure rule (conservative): the same target still failing for a
materially different reason is `inconclusive` (never fully `fixed`);
`fixed` requires positive healthy target evidence.

The `classifyRetest` classifier is deterministic: `fixed` requires strong
active evidence the behavior no longer occurs; `still_reproducible` requires
strong fresh observation of the same identity; `partially_fixed` covers
mixed assertion outcomes; anything unobservable or indecisive is
`inconclusive`. Agent silence is never proof of a fix, and agent consensus
alone never decides — the verdict is grounded in fresh canonical evidence
plus cross-revision verification.

`compareRetestSteps` builds the classifier input from persisted replay
steps: it compares BEHAVIOR, not match direction, keyed by exact ID-free
replay intent (`command`+`cwdRelative` for command replays,
`testName`(+`command`) for test replays). Only `command_replay` and
`test_replay` steps carry signal — `source_integrity` content trivially
changes after any fix, so it is excluded. Source steps must strongly
confirm failure on A to form a baseline; a target step showing the same
failure signature is still-reproducible evidence, a healthy observation is
fixed evidence, a different failure signature is fixed-with-limitation (the
moved problem is recorded, §17). Missing, weak, or undecisive observations
degrade to `inconclusive`, never to `fixed`.

## Run and revision lineage

QARuns carry optional lineage: `parentRunId` (e.g. FULL → TARGETED
follow-up), `sourceIssueId`, `sourceOccurrenceId`, `sourceRevisionId`,
`targetRevisionId` — one field per semantic. `qa project revisions` exposes
the revision chain with content hashes, current markers, and the run IDs
that used each revision. Project updates never mutate history: revision A,
its snapshot, runs, merges, verifications, and occurrences stay durable.

## Cancellation and crash recovery

`qa run cancel` is real cooperative cancellation, never cosmetic state
painting. Any live runtime persists a durable `run_control_requests` row
(`cancellation_requested`, idempotent per run); the OWNING runtime observes
it via per-worker watchers (500ms poll, no busy loop) while provider
streams block, invokes `adapter.cancel()` on owned adapters/sessions only
(never foreign PIDs), reconciles durable state before every terminal write
(a durably `cancelled` row is never overwritten by stale local state),
then terminalizes honestly: nonterminal AgentRuns become `cancelled`,
completed runs keep `completed`, completed Findings/Evidence are preserved,
workspaces are cleaned, and only then the project lock releases. The CLI
distinguishes `cancellation_requested` / `cancelled` / `already_terminal`
(additive shape, contract v1). A request whose owner died completes
honestly on recovery while the run itself interrupts (never
fake-cancelled). Crash recovery (existing run/agent/verification sweeper
plus the retest nonterminal scan) leaves no permanent fake running states
and retains completed work.

## Storage hygiene and configuration

No automatic history pruning: revisions, runs, evidence, artifacts, issues,
verifications, and retests persist until explicit user deletion. Temporary
Sentry-owned workspaces are cleaned by the existing ownership-scoped
cleanup paths; no generic temp scanning. `qa doctor storage` reports
non-destructive sizes and counts; the conservative orphan scavenger only
removes exact-contract paths (`agent_workspace`, `verifier_workspace`,
`verifier_staging`) with no active DB/runtime ownership, a stale owner,
and age beyond `ORPHAN_MIN_AGE_MS` (24h). `qa doctor cleanup` dry-runs
unless `--apply`; every removal is audited (class, age, reason, operation
id, result). The canonical config model (`resolveSentryConfig`) centralizes
the data root, default agents, timeouts, sandbox backend, and hygiene
threshold in one place; `qa doctor config` dumps it redacted. `qa project
doctor` inspects readiness without mutation: managed-copy state, revision
and run/issue counts, marker-based ecosystem detection, PATH-probed
runtimes, and verifier preflight — unavailable means unavailable. Secrets
stay out of the database, doctor output, exports, and error envelopes
(bounded redaction).

## Exports

Run exports extend additively: `targetSpecs`, `issueOccurrences`,
`issues`, `issueEvents`, `retestRuns`, and `retestAssessments` sections
stream after the verification sections (metadata and records only — giant
artifacts are never inlined). Export staleness now also covers issue
ingest and retest assessments touching the run. The human log renders
issue lineage per the §81 shape: issue header, first-seen revision and
mode, then each retest crossing with its verdict.

## CLI machine contract

Contract version stays 1 (additive): new commands `run cancel`,
`project revisions`, `issue list/show/history/ingest`, `retest
start/show/cancel`, `run start --mode targeted --paths …`, `doctor
storage/cleanup/config`, and `project doctor` follow the
one-JSON-stdout / stderr-diagnostics / stable-exit-code convention.
`capabilities` truthfully advertises `runCancellation`,
`targetedExecution`, `issueLineage`, and `retestExecution`.
`ISSUE_NOT_FOUND` exits 3 (not-found); terminal-cancel refusals exit 4
(state conflict); `ISSUE_CONFLICT` and `PROJECT_COPY_DRIFT` are typed
machine errors. `doctor cleanup` is dry-run unless `--apply` is passed.

## Closure migration v6

Forward-only, transactional, idempotent: un_control_requests +
etest_control_requests (durable cooperative cancellation) and
etest_specs (immutable, trigger-enforced; old RetestRuns read as
legacy/absent, all new frozen-B Retests persist v2). Phase 6 and Phase 7-v1
databases migrate cleanly with history readable.

## Private-beta boundaries

Supported path: Windows host with WSL2 Ubuntu/systemd for verifier
runtime, or direct Linux. No native Windows runtime verifier. Browser and
external-service verification may stay `inconclusive`. Automatic cross-run
issue deduplication, adaptive investigation, installers, and the desktop UI
are explicitly out of scope (Phases 8/9 and later).
