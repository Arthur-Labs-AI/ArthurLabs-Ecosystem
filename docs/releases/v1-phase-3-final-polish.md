# Phase 3 final polish — runtime and activity truthfulness

Date: 2026-10-12. Branch: `fix/v1-desktop-status-truth`, isolated worktree
`Sentry-polish`. Product/test/visual commit:
`810264aade25ec9ad6f28b2c5997eec4a0ce6e4a`.

## Verified baseline and boundaries

PR #4 merged into `main` at `c07c76d972ce0f0c3bf353d57a00fad99a026262`.
Fetched origin/main and inspected the actual post-merge
[CI run 38213233386](https://github.com/Mert1026/Sentry/actions/runs/38213233386):
PASS quality, Windows launcher and generic Linux launcher. Hosted real sandbox
trust was explicitly unavailable; that job used the existing documented fallback.
Read branching policy and Phase 3 validation/limitations before implementation.

The owner's primary checkout remains on its original dirty `main` at `9c57e3f`;
its DeepSeek/schema/protocol edits and PROJECT_GUIDE.md were preserved. No main
commit/push, history rewrite, tag, version change, release or Phase 4. `shux
contract` is unavailable on PATH; task status, ledger and handoff maintained directly.

## Findings and exact reproduction

1. **Confirmed:** defer the initial `runtime.status()` promise with no cached
   status, then render AppShell. Previously the badge was Runtime offline and
   the cached-results warning appeared before any connectivity response.
   Runtime Settings and Environment had the same premature presentation.
2. **Confirmed:** project an `agent.message` event with recorded text/time into
   Activity. The row was categorized Reporting, although the stage projector
   correctly required an explicit reporting status.
3. **Confirmed:** project a completed AgentRun with sparse history. Intermediate
   milestones correctly remained internally `not_started`, but inspector text,
   canvas titles and accessible names exposed that as confirmed non-execution.
4. **Existing correct behavior retained:** a failed refresh already overrides
   cached connected data; background refresh, observed reconnect invalidation
   and cached reports also had passing guards. This correction preserves them.

Windows baseline: `pnpm build`, then `pnpm --filter @qa/desktop test`:
**299 PASS / 2 platform SKIPPED**. Add the two new regression files before
product edits and run:

```powershell
pnpm --filter @qa/desktop exec vitest run tests/components/runtime-presentation.test.tsx tests/components/stage-presentation.test.tsx
```

Initial fifteen cases: **6 FAIL / 9 PASS**. After detecting the same issue in
runtime detail views, add their two regressions before changing those pages:
runtime presentation file **2 FAIL / 8 PASS**. An initial cached-report test
fixture selected an invalid node ID; corrected to the real graph ID before
recording these RED results. No assertions or test deadlines were relaxed.

## Correction and compatibility

- `lib/use-runtime-status.ts`: small pure `runtimeConnectionState` helper gives
  errors and explicit disconnected responses precedence, otherwise returns
  connected from confirmed data or checking when no response exists. Polling,
  query key, RPC, retries and query ownership are unchanged.
- `components/AppShell.tsx`: Checking runtime… uses a neutral/informational
  badge and polite accessible announcement. Only confirmed unavailability
  shows the offline warning. A pending background refresh retains confirmed
  connectivity; an actual error overrides cached true. Reconnect effects are
  unchanged and never start execution.
- `pages/RuntimeSettings.tsx`, `pages/Environment.tsx`: reuse the same state
  helper for the existing runtime badges. Pending discovery no longer triggers
  the Environment offline alert. An environment-data failure alone no longer
  asserts disconnected runtime; missing runtime details are labeled unrecorded.
- `lib/agent-telemetry.ts`: generic output category is Message. Shared exhaustive
  display mapping presents AgentRun milestone `not_started` as Not observed,
  with Observed, Active, Completed, Warning, Failed and Cancelled labels.
  The projector, StageState union and persisted/domain states are unchanged.
- `components/AgentInspector.tsx`: uses display labels, with a distinct observed
  glyph; decorative glyphs are hidden from accessibility APIs. Message receives
  a neutral icon and retains existing text, timestamp and detail inspection.
- `components/nodes/AgentCanvasNode.tsx`, `styles.css`: matching readable canvas
  tooltip/accessibility labels and muted observed markers distinct from successful
  completion. Selected agents without AgentRuns still display Waiting or Not
  started using the unchanged graph's parent/worker truth.
- New `tests/components/runtime-presentation.test.tsx` (10 cases) and
  `stage-presentation.test.tsx` (7 cases). Existing `run-workspace.test.tsx` SSR
  expectation changes from initial Offline to Checking runtime, as required by
  the specification; adds an explicit no-premature-offline assertion.

Message remains visible under All and excluded from Files/Commands/Tests/
Findings/Warnings, with detail/timestamp preserved. Explicit reporting remains
active; sparse completion proves only completion; observed events remain visible.
Existing independent agent attribution and all previous Phase 3 reconnect/retained
report regressions pass. No harness, coordinator, runtime, persistence, snapshot,
sandbox, export schema, public IPC/RPC, legacy Retest or dependency edits. The
three independent agents are unchanged; no active Merger/Verifier or paid retry.

## Before/after rendered evidence

Actual Windows Electron 36.2.1, built renderer, real sandboxed preload/IPC bridge,
1440x1000 logical window. Controlled deferred status and sparse report fixtures;
no provider credentials, private projects or paid executions. Before captures
use the baseline build; after captures use the corrected build. Inspected all six:

| Scenario                     | Before                                                                    | After                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Pending initial connectivity | [Premature offline warning](assets/v1-phase-3-polish-before-checking.png) | [Checking without warning](assets/v1-phase-3-polish-after-checking.png) |
| Sparse completed history     | [Raw not_started](assets/v1-phase-3-polish-before-stages.png)             | [Not observed / Completed](assets/v1-phase-3-polish-after-stages.png)   |
| Generic message activity     | [Reporting category](assets/v1-phase-3-polish-before-activity.png)        | [Message category](assets/v1-phase-3-polish-after-activity.png)         |

These are fixture rendering checks, not live-provider or native CachyOS acceptance.
Existing Current operation wording on terminal workers remains a separate activity
copy follow-up; no lifecycle or operation-projection expansion in this correction.

## Executed validation

Windows Node 24.13.1 / pnpm 9.12.3. Ubuntu 26.04 WSL Node 22.23.2 / pnpm 9.12.3,
native Linux validation clone `/var/tmp/sentry-polish-validation.8KOLtE`.

| Gate                                      | Windows                                          | Ubuntu WSL                                                   |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`          | PASS                                             | PASS                                                         |
| `pnpm repository:check`                   | PASS                                             | PASS                                                         |
| `pnpm format:check`                       | PASS                                             | PASS                                                         |
| `pnpm lint`                               | PASS, 20 tasks                                   | PASS, 20 tasks                                               |
| `pnpm typecheck`                          | PASS, 37 tasks                                   | PASS, 37 tasks                                               |
| `pnpm test` full repository               | Full Windows gate not run; platform suites below | PASS on unchanged rerun, 40 tasks, 1,149 passed / 16 skipped |
| `pnpm --filter @qa/desktop test`          | PASS, 316 / 2 platform skips                     | PASS in full gate, 317 / 1 platform skip                     |
| `pnpm build`                              | PASS, 20 tasks                                   | PASS, 20 tasks                                               |
| Real sandbox trust                        | Linux-only                                       | PASS, 8/8 in uncached engine rerun                           |
| Windows Electron smoke with WSL host      | PASS                                             | Native Linux Electron: UNVERIFIED                            |
| Six rendered fixture captures             | PASS                                             | Native CachyOS visuals: ENVIRONMENT UNAVAILABLE              |
| Launcher decision logic / shutdown safety | PASS                                             | Generic Linux launcher CI tracked below                      |

Desktop suite includes AppShell/status hook, canonical live snapshots/reconnect,
agent telemetry/stages, Inspector, canvas nodes, graph, rendered components,
offline cached reports, preload/IPC and historical compatibility tests.

First full WSL attempt: FAIL in unchanged OpenCode cancellation fixture
`cancels only the owned session`, Vitest 5-second timeout. The fixture waits a
fixed 50 ms before cancelling, rather than awaiting listener readiness; concurrent
load can expose that timing assumption. Unchanged rerun PASS all 40 tasks (34
cached), OpenCode 115 passed / 8 opt-in skips and engine 86 including real trust
8/8 uncached. This timing-flake risk is recorded separately; harness changes are
expressly outside this PR. No assertions/deadlines or CI configuration changed.

Validation setup attempts also recorded: first WSL formatting check copied a test
while it was being edited; reran after formatting and final source synchronization.
First Electron handshake attempt preceded creation of the Linux runtime build
(MODULE_NOT_FOUND); after the build existed, smoke PASS with actual Linux Node,
handshake, BrowserWindow, isolated preload, no renderer Node and navigation.
The smoke test's expected unregistered application IPC diagnostics remain; fixture
checks exercise registered renderer IPC separately. Neither proves funded QA.

Logs: Windows TEMP `sentry-polish-*`, Linux `/var/tmp/sentry-polish-*`.
Review of the full production/test diff found no introduced correctness, security,
data-loss or lifecycle blocker. Runtime data remains canonical; new helpers only
derive presentation and neither write storage nor initiate provider work.

## Git and CI receipts

[Draft PR #5](https://github.com/Mert1026/Sentry/pull/5) targets main; code commit
`810264aade25ec9ad6f28b2c5997eec4a0ce6e4a`. Exact-code
[CI run 38215099581](https://github.com/Mert1026/Sentry/actions/runs/38215099581)
completed **PASS** in quality, Windows launcher and generic Linux launcher.
GitGuardian also PASS. Hosted trust remained unavailable (mount exit 226), so
its existing fallback excluded the real trust file; local WSL proof is separate.
The documentation receipt follows that code commit. Final documentation-head SHA
and its exact-head CI are recorded in the PR before owner review, so results are
never attributed to a different tested commit. Effective user-owned Git identity
was read before commit and author/committer verified unchanged.

## Remaining limitations / next phase

Phase 3 is not closed. Native CachyOS, native Linux Electron and funded OpenCode/
DeepSeek/GLM Full/Targeted acceptance remain UNVERIFIED. Compact navigation,
keyboard resizing and complete tab accessibility remain deferred. Finding-to-
evidence jumps/provenance UI, automatic dead-runtime recovery and lost-start-response
recovery retain the previous reports' limitations. Hosted trust capability is
independent of local WSL proof. No automatic process restart or paid retry added.

Recommend owner review/integration of this correction, then decide which remaining
Phase 3 acceptance gates to close or explicitly schedule before Phase 4 planning.
No Phase 4 implementation is included or authorized by this report.
