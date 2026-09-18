# Phase 7 Closure — Stable Core / Private Beta (Sentry 0.7)

Status: ACTIVE (closure implementation; paid live gates UNVERIFIED — see §H).
Prior `docs/architecture/phase-7.md` sections describing cosmetic
cancellation, QARun mode=retest production use, source-fallback target
lineage, and different-failure-as-fixed are HISTORICAL / SUPERSEDED by this
document. The rest of `phase-7.md` remains current.

## A. Cancellation (real, cooperative, persisted)

- `run_control_requests` / `retest_control_requests` (migration v6):
  `(run, cancel)` idempotent, durable, restart-safe, machine-readable
  (`requestedAt`, `requestingRuntimeId`, `acknowledgedAt`, `completedAt`).
- `qa run cancel` persists the request and returns `cancellation_requested`
  while a healthy owner is live — never fakes `cancelled` (§8).
- The owning `RunCoordinator` observes via a 500ms watcher per worker and
  calls `adapter.cancel(agentRunId)` on OWNED adapters only; owned child
  processes/sessions stop per harness ownership; workspaces are removed;
  the project lock releases only after genuine terminalization (§49).
- Terminal writes reconcile against durable state: a durably `cancelled`
  AgentRun is never overwritten by stale local `completed` (§12).
- Stale-owner pending requests complete honestly on recovery; the run
  itself interrupts (never fake-cancelled) (§16).
- CLI shape is additive (`status`, `ownerAcknowledged`); `CLI_CONTRACT_VERSION = 1`.

## B. Retest lifecycle

- Top-level guard: every normal path after `RetestRun` creation terminalizes
  the SAME row; `failed`/`cancelled` carry a bounded redacted `failure`
  record (`code`, `message`, `retryable`).
- Pre-freeze failures (`created`/`agents_running` → `failed`) require NO
  `targetSnapshotId`; `merging`/`assessing`/`completed`/`partial` always
  require it; `failed`/`cancelled`/`interrupted` require it only when target
  work had frozen B.

## C. Historical target resolution

- Exact path → nearest existing ancestor directory → deduplicated;
  total absence → explicit focused full-snapshot fallback with
  `RETEST_HISTORICAL_TARGETS_ABSENT`. Absence never equals fixed.
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

## F. RetestSpec v2 + digest (migration v6)

- `retest_specs(retest_run_id PK, project_id, payload)`; trigger-enforced
  immutability; persisted once B freezes; `RETEST_VERSION = 2` (v1 history
  readable, never reinterpreted). Digest covers issue, source occurrence,
  source/target snapshots + revisions, source merge/cluster, agents, resolved
  targets, retest + recipe versions (sha256, canonical ordering).

## G. Classification (conservative)

- Same target failing differently → `inconclusive` (never fully `fixed`).
  `fixed` requires positive healthy target evidence.

## H. Validation status (honest)

- Deterministic: 12/12 direct smoke checks PASS (spec v2, pre-freeze
  failure shape, legacy v1 decode, honest assessment lineage, legacy QARun
  decode + canonical reject, ancestor/fallback resolution,
  different-failure inconclusive, additive CLI shapes).
- Typecheck: schemas, persistence, domain, run-engine, CLI green (via
  workspace `tsc`; turbo/pnpm scripts unusable — `turbo` binary missing on
  PATH in this environment).
- Vitest suites: UNVERIFIED in this environment (missing
  `@rollup/rollup-win32-x64-msvc` optional dep breaks startup). New suites
  `packages/run-engine/tests/closure.test.ts`,
  `packages/run-engine/tests/retest-closure.test.ts`, and
  `packages/persistence/tests/migration-v6.test.ts` are written for CI.
- Paid FULL / TARGETED / RETEST live gates: UNVERIFIED (provider spend
  deferred per task brief — will happen in the near future). No live IDs to
  report; no credentials touched.
- Exact-head CI for the final SHA: NOT YET RUN (requires push).

## Next

Phase 8 — Desktop UI. Phase 9 — Installation, Setup & Distribution.
No Phase 8/9 implementation in this task.
