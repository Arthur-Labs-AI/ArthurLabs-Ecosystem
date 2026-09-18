# Phase 7 Closure — Stable Core / Private Beta (Sentry 0.7)

Status: DETERMINISTICALLY CLOSED (implementation COMPLETE; paid live
acceptance DEFERRED — provider budgets unavailable; see §H).
Prior `docs/architecture/phase-7.md` sections describing cosmetic
cancellation, QARun mode=retest production use, source-fallback target
lineage, and different-failure-as-fixed are HISTORICAL / SUPERSEDED by this
document. The rest of `phase-7.md` remains current.

## A. Cancellation (real, cooperative, persisted)

- `run_control_requests` / `retest_control_requests` (migration v6):
  `(run, cancel)` idempotent, durable, restart-safe, machine-readable
  (`requestedAt`, `requestingRuntimeId`, `acknowledgedAt`, `completedAt`).
- Ownership is strict: `isLocalRunOwner` / `isLocalRetestOwner` compare
  `runtimeInstanceId === lease.instanceId`. Freshness (`isRunOwnerFresh`)
  is liveness only — never ownership.
- `qa run cancel` / `qa retest cancel` from a foreign CLI persist the
  request and return `cancellation_requested` — they never acknowledge or
  terminalize another runtime's live execution (foreign acknowledge refused).
- The owning `RunCoordinator` observes via a 500ms watcher per worker,
  marks `acknowledgedAt`, awaits `adapter.cancel()` on OWNED adapters only
  (never fire-and-forget, never foreign PIDs), settles workers, cleans
  workspaces, then terminalizes the parent as `cancelled` after
  `allSettled` (never via `aggregateAgentRunOutcome`). `completedAt` is set
  only after owned execution truly settles.
- Terminal writes reconcile against durable state: a durably `cancelled`
  AgentRun is never overwritten by stale local `completed` (and a timely
  `completed` before cancellation stands).
- Stale-owner pending requests complete honestly on recovery; the run
  itself interrupts (never fake-cancelled).
- CLI shape is additive (`status`, `ownerAcknowledged`); `CLI_CONTRACT_VERSION = 1`.

## B. Retest lifecycle

- Top-level guard: every normal path after `RetestRun` creation terminalizes
  the SAME row; `failed`/`cancelled` carry a bounded redacted `failure`
  record (`code`, `message`, `retryable`).
- Pre-freeze failures (`created`/`agents_running` → `failed`) require NO
  `targetSnapshotId` and NO RetestSpec; post-freeze failures retain both.
- Retest cancellation propagates owner-to-owner: retest request → child
  request-only → child owner settles → retest terminalizes. Foreign runtimes
  never mark the workflow cancelled while child execution is active.

## C. Historical target resolution

- Resolved against the Snapshot B manifest inside the frozen boundary
  (never the mutable tree): exact path → nearest existing ancestor →
  deduplicated; total absence → explicit focused full-snapshot fallback with
  `RETEST_HISTORICAL_TARGETS_ABSENT`. Absence never equals fixed.
- Frozen revision identity asserted (`PROJECT_COPY_DRIFT` on B≠C) before
  any agent starts; agents never run on C while claiming B.
- `historicalPaths`, `resolvedTargetPaths`, `resolutionStrategy`, and
  `limitations` persist in the immutable `RetestSpec` v2.

## D. Lineage honesty

- `targetMergeResultId` / `targetVerificationRunId` are OPTIONAL and
  revision-B-only; missing targets stay absent. Source IDs live only in
  source fields.

## E. Canonical architecture

- QARun modes: `full | targeted`. RETEST is the `RetestRun` cross-revision
  workflow with a child FULL/TARGETED QARun. `QARun mode=retest` is a LEGACY
  decoder only; `CanonicalQARunSchema` enforces production modes.
  Production creation APIs accept only `full | targeted`.

## F. RetestSpec v2 + digest (migration v6)

- `retest_specs(retest_run_id PK, project_id, payload)`; trigger-enforced
  immutability PLUS repository compare: identical re-save is idempotent,
  different payload → `RETEST_SPEC_CONFLICT` (never silent).
- Persisted by the `onSnapshotFrozen` hook after B freeze + revision assert
  - manifest resolution, BEFORE any agent adapter starts.
- `RETEST_VERSION = 2` (v1 history readable, never reinterpreted). Digest
  covers issue, source occurrence, source/target snapshots + revisions,
  source merge/cluster, agents, resolved targets, retest + recipe versions
  (sha256, canonical ordering).

## G. Classification (conservative)

- Same target failing differently → `inconclusive` (never fully `fixed`).
- `fixed` requires positive healthy target evidence: same historical target
  positively passing under compatible replay.

## H. Validation status (honest)

- Deterministic suites PASS: run-engine 67/67 local (closure 6, retest 4,
  retest-closure 9, targeted 9, + others), persistence 23/23, domain 84/84
  (incl. conservative different-failure), schemas 118/118.
- Gates: repository:check PASS, format PASS, lint 17/17 PASS, typecheck
  33/33 PASS, build 17/17 PASS (turbo; local run after frozen-lockfile
  repair — vitest/rollup native + turbo restored).
- Pre-existing Windows-local failures, identical on the clean baseline:
  verifier unit 2 (path containment fixtures) + run-engine
  verification-trust 6 (systemd sandbox unavailable on Windows). CI
  (ubuntu-latest + linger) is authoritative: baseline exact-head CI was
  green with these files; the degraded lane excludes only
  `verification-trust.test.ts` when the runner lacks mounts.
- Paid FULL 3/3 / TARGETED 3/3 / update→RETEST: DEFERRED — provider
  budgets unavailable. Not FAILED, not PASSED. No live IDs invented; no
  credentials touched. See `docs/architecture/deferred-gates.md`.
- Exact-head CI for the final SHA: REQUIRED before Phase 8 (see handoff).

## Next

Phase 8 — Desktop UI (unlocked after exact-head CI). Phase 9 —
Installation, Setup & Distribution. No Phase 8/9 implementation in this task.
