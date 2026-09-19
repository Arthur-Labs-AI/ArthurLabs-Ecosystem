# Phase 8 — Desktop UI Architecture

Status: final fix pass (Phase 8 hardening). Baseline 333f71fab7f7343ef0730ba77e5ec68e7855e46a.

Final fix pass delivered: secure persistent provider credentials (safeStorage-encrypted
store under userData, no plaintext, secrets never to renderer, one-time legacy migration);
simulation vs production registries (FakeHarness default, CLI-identical provider registrations
wired, explicit user action required, paid gates DEFERRED); async live Retest start (RetestRun id
returned before workflow settles, immediate navigation to /retests/:id); typed nested
DesktopRunSnapshot/DesktopRetestSnapshot DTOs; assessment `result` contract end-to-end;
evidence-driven agent stages with Reporting (agent.message/usage.updated) and honest
queued/starting mapping; pipeline honesty (merger/verifier/issues reflect artifact existence,
honest zero-issue ingest via ingestRan); AgentNode detail (stage, operation, 3 recent
activities, tokens, ticking elapsed); backend issue-state projection (projectIssueState in
main, frozen states only); awaited startup recovery with fatal surfacing; TanStack v5
query.state.data polling with full Retest terminal set; typed active-runs subscription kind;
project/revision/snapshot lineage headers; path-chip TargetSpec UX; deliberate run-action
feedback; deterministic Reset layout; full vitest inclusion (unit/component/service/smoke)
plus a true Electron smoke (main → preload → renderer).

Attempt 5 added: structural snapshot tests for all §177 screens (FULL/TARGETED/RETEST workspaces, agent inspector, merger/verifier/issues honesty assertions) and a design-QA overflow pass (wrap-anywhere text, ellipsis utilities, small-screen single-column workspace, horizontal table scroll). Attempt 3 added: a Ctrl+K command palette (navigation, per-project Full/Targeted QA entry, environment; no shell commands), canvas F/+/- keyboard shortcuts alongside the Fit/Reset controls, retest entries in the History timeline, and palette unit tests. Attempt 2 closed the attempt-1 gaps: run actions (Merge / Ingest Issues / Export JSON+Log / Open Project, terminal-gated per backend state), agent timeline with per-operation detail + raw-event drawer, full merger/verifier/issues inspectors (usable/unavailable agents, cluster agreement without confidence conflation, reproduced/partial/not-repro/inconclusive breakdown, severity breakdown), retest spec panel + assessment rationale/evidence/limitations, honest environment doctors (real harness + sandbox probes, statuses only), run-history cards with filters, project update + conflict UX + readiness, CopyId buttons on all internal IDs, edge inspector, telemetry counts (operations/files/commands/tests), and a seed covering FULL + TARGETED + merge + verify + issues + PARTIAL + revision B + retest.

## Stack

- Electron 36 (main, privileged Sentry host), React 18 + TypeScript + Vite 5 (renderer).
- `@xyflow/react` 12 for the execution canvas; TanStack Query 5 for server state; Zustand 5 available for local UI state; lucide icons.
- Monorepo: `apps/desktop` participates in pnpm workspace + Turbo (`build`, `test`, `lint`, `typecheck`).

## Security boundary

- Renderer: `nodeIntegration = false`, `contextIsolation = true`, `sandbox = true`.
- Preload (`src/preload/preload.ts`) exposes ONLY `window.sentry` (+ `dialogs.pickDirectory`). No `ipcRenderer`, `fs`, `child_process`, `shell`, `BrowserWindow`, or raw event objects cross the bridge.
- Every channel is named, Zod-validated in main (`src/main/ipc.ts`), and returns `{ ok, result } | { ok: false, error }` envelopes. Subscriptions deliver payloads only.
- Renderer never touches SQLite or the filesystem directly; directory picking goes through a native dialog whose path lands in main, and exports use validated application methods.
- Secrets: renderer receives readiness statuses only (real `configured`/`binaryAvailable`/`runtimeVerified`/`readiness` from doctorMuse/doctorDeepSeek/doctorGlm; never keys/tokens).

## Main owns Sentry

- `bootstrapDesktop()` opens `SentryDatabase`, `SentryRepository`, starts `RuntimeInstanceLease`, runs `coordinator.recover()` BEFORE presenting live state, then constructs `DesktopApplicationService`.
- `DesktopApplicationService` (`src/main/services/`) is a thin adapter: projects → ProjectManager/repository, runs → RunCoordinator, merge → `mergeRun`, verify → `verifyMerge`, issues → repository/ingest, retests → retest-service functions, doctors → stack metadata + project doctor. Zero duplicated business logic.
- No core semantic changes: Merger v2, Verifier v3, Retest v2, AgentStacks, CLI v1, migration v6 untouched.

## Routing

- HashRouter: `/` Dashboard, `/projects`, `/projects/:projectId`, `/runs`, `/runs/:runId` (Run Workspace), `/issues`, `/issues/:issueId`, `/retests/:retestRunId` (Retest Workspace), `/history`, `/environment`, `/settings`.
- Deep links carry full IDs; IDs render truncated with copy affordance via the inspector.

## View models

- Read-only projections in `src/renderer/lib/`: `AgentNodeView`, run/retest graph nodes/edges, timeline items. Backend truth (QARun, AgentRun, HarnessEvent, RunActivity, Finding, Evidence, MergeResult, VerificationRun, Issue, RetestRun/Spec/Assessment) is authoritative; the UI never infers `fixed`, verification outcomes, clusters, or issue state.
- `DesktopOperationId` (`dop_*`) exists only in main memory while `run()` settles; it is never persisted.

## Live update model

- `DesktopLiveUpdates`: main polls watched runs every 500 ms, idle sweep every 5 s (active-run strip + auto-watch). Snapshots are normalized `runSnapshot`/`retestSnapshot` payloads pushed over `sentry:run-update`.
- Renderer also polls via React Query (750 ms default, stops at terminal states) and refetches on window focus. Backend truth always wins; cancellation shows `cancellation_requested` until the coordinator terminalizes.
- Canvas updates are memoized (`React.useMemo` on graph + nodes/edges); only changed view models re-render.

## Canvas topology

- Deterministic `buildRunGraph(view)` (pure, tested): Project → Revision → Snapshot → [TargetSpec] → 3 parallel AgentNodes → Merger v2 → Verifier v3 → Issues. Retest adds source-Revision-A → RetestSpec v2 → … → Assessment lineage.
- Layout: fixed top→bottom with horizontal agent fan-out (x = 40 + i*260), merger re-centers branches. Node positions are presentational; topology is Sentry-owned and never user-editable.
- Edge states: pending / active (animated) / completed / blocked / failed, derived from persisted statuses.

## Agent telemetry projection

- See `docs/architecture/phase-8-agent-telemetry.md` for the full event→stage→label→icon map.

## Testing

- `tests/unit`: projector, graph, IPC-security, desktop-service (FakeHarness E2E: cancel states, TARGETED spec, merge→verify→ingest→history).
- `tests/components`: AgentNode/Merger/Verifier/Issues rendering incl. zero-findings honesty, no-Thinking/no-% assertions.
- `tests/smoke`: add → simulate FULL → workspace → merge → issue → retest flow with temp data root.
- No paid provider calls anywhere in tests (FakeHarnessAdapter only).

## Limitations (acceptable per spec)

- No installer/auto-update (Phase 9); dev commands only.
- Verifier sandbox probe surfaces honest unavailable states; no native Windows replay.
- No light theme, no mobile, no source editor/autofix, no adaptive investigation, no arbitrary run comparison.
- `vite build` / `vitest` require an environment where esbuild may spawn workers (blocked in this sandbox; CI runs them).
