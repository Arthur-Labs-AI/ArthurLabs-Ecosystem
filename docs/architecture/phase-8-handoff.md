# Phase 8 — Handoff (Desktop UI & Live Run Canvas)

> Status: **RUNTIME ARCHITECTURE IN PROGRESS** — the Windows-Electron-hosted provider
> execution model is being replaced by a WSL2 runtime (this document's older sections
> below describe the retired architecture: `Simulation only`, `Paid gates DEFERRED`.
> Do not treat those as current.)

## Baseline and head

- Phase 8 baseline: `333f71fab7f7343ef0730ba77e5ec68e7855e46a` (exact-head CI `35389953791`, success).
- Phase 7 status: DETERMINISTICALLY CLOSED.
- Implementation commits: `aa225b6` (desktop run workspace + secure typed Electron IPC),
  `f92539d` (structural screen snapshots + overflow design QA).
- Frozen-core diff vs baseline: **empty** for `packages/` and `apps/cli`
  (`git diff 333f71f HEAD --stat -- packages apps/cli` returns nothing). Only `apps/desktop/`
  (64 files), the three `phase-8-*.md` docs, and `pnpm-lock.yaml` (desktop + harness deps) changed.

## What was delivered

- `apps/desktop` (`@qa/desktop`): Electron 36 main (privileged Sentry host) + React 18 + Vite 5
  renderer + `@xyflow/react` 12 canvas; Turbo `build`/`test`/`lint`/`typecheck` wired.
- Secure typed bridge: `window.sentry` only, Zod-validated channels (incl. `runs:ingest`),
  `nodeIntegration = false`, `contextIsolation = true`, `sandbox = true`, payload-only subscriptions.
- Run Workspace (`/runs/:runId`) and Retest Workspace (`/retests/:retestRunId`): deterministic
  FULL / TARGETED / RETEST graphs, live AgentNodes from observable telemetry (no chain-of-thought,
  no fake percentages/ETAs), agent timeline + operation detail + raw-event drawer, merger v2 /
  verifier v3 / issues inspectors, terminal-gated Merge / Verify / Ingest / Export / Open Project.
- Projects, Runs (history cards + filters), Issues (filters/detail/history/retest action), History
  (runs + retests + issues), Environment (real harness + sandbox probes, statuses only), Settings,
  Dashboard, Ctrl+K command palette, canvas F/+/-/Esc shortcuts, CopyId on all internal IDs.
- Simulation only: FakeHarnessAdapter, deterministic fixtures, `pnpm --filter @qa/desktop seed`
  (FULL + TARGETED + merge + verify + issues + PARTIAL + revision B + retest). No paid provider calls.
- Tests: 34 unit/service/smoke + 13 component/snapshot (47 total), all passing via the in-process
  runner in this sandbox; canonical `vitest run` pending CI (esbuild spawn is EPERM-blocked locally).

## Gate evidence (local, this sandbox)

- `pnpm format:check` — PASS.
- `pnpm lint` (18 tasks) — PASS.
- `pnpm typecheck` (34 tasks) — PASS.
- `pnpm build` — 17/18 PASS; `@qa/desktop#build:renderer` (`vite build`) fails locally on esbuild
  `spawn EPERM` (sandbox denies child-process spawn; same EPERM breaks `vitest`,
  `repository:check`'s git call, and untouched packages' tests). Requires CI confirmation.
- `pnpm test` — blocked locally by the same esbuild-spawn EPERM (also affects frozen packages).
  Desktop suite verified green through the in-process runner instead.
- `pnpm repository:check` — cannot invoke git in this sandbox; requires CI confirmation.

## Exact-head CI (observed)

- Final SHA: `01a40c36f7238ab9a2f6b786952185216c0d6ed6`
- GitHub Actions run: `35428675302` (workflow `ci`, `main`, push, created 2026-09-19T07:12:10Z)
- Status / conclusion: **completed / success** (required: completed / success) — all steps green:
  install, systemd lingering, sandbox probe, `repository:check`, `format:check`, `lint`, `typecheck`,
  test fallback path, `build` (incl. `@qa/desktop#build` with `vite build`).
- Prior head `32e653e` was likewise green (`35428303414`, completed / success); the delta to the
  final head is docs-only (this handoff's CI section).
- Sandbox caveat: probe reported `available=false` (exit 226); CI therefore ran
  `turbo run test --filter='!@qa/run-engine'` plus run-engine tests excluding
  `tests/verification-trust.test.ts`, exactly as the workflow prescribes for restricted runners.

## Deferred gates (unchanged, do not block Phase 8)

- Paid production acceptance: FULL 3/3 — DEFERRED (provider budgets unavailable).
- Paid production acceptance: TARGETED 3/3 — DEFERRED.
- Paid production acceptance: update → RETEST — DEFERRED.

## Phase 9 readiness

Working desktop app, stable shell, stable typed preload API, stable local Sentry integration, stable
Run Workspace, stable settings/environment views. Phase 9 takes installation, first-launch, provider
setup, secure credentials, WSL readiness, distribution, and updates without redesigning the UI core.
