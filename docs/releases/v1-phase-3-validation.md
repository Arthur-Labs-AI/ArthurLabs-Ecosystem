# Phase 3 Desktop usability validation

## Baseline and initial audit

Approved baseline: `9da3cbeb0cb3c5b1f95015c59f385e3b3f51c295`, owner-merged
Phase 2 PR #3. Merge CI [38040773408](https://github.com/Mert1026/Sentry/actions/runs/38040773408)
passed quality and both launcher jobs. Feature branch:
`codex/v1-desktop-improvements`, isolated `Sentry-v3`; dirty owner checkout preserved.
`shux contract` is unavailable; task status, ledger and handoff are maintained directly.

Audit before implementation covered App, AppShell, RunCanvas, AgentInspector,
RunSummaryPanel, AgentCanvasNode, telemetry, graph, live queries, bridge contract,
RunWorkspace, Runs, History, ProjectDetail, Providers, RuntimeSettings, main
bootstrap/service/update transport and their existing tests.

| Classification                         | Observation and priority                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CONFIRMED BUG (controlled regressions) | P0: update hints replace cached snapshots without ordering; an older hint can replace terminal data.                                                                                                                           |
| CONFIRMED BUG (controlled regressions) | P0: RunWorkspace and RetestWorkspace discard visible cached data on a failed refresh.                                                                                                                                          |
| CONFIRMED BUG (controlled regressions) | P0: progress marks every stage complete on overall completion and infers skipped earlier stages; usage/message after evidence invents Reporting.                                                                               |
| VERIFIED UX PROBLEM                    | P0/P1: overview counts only created AgentRuns, omits selected waiting agents, and calls missing workers waiting even after terminal failure. Agent empty reports say “yet” after terminalization.                              |
| VERIFIED UX PROBLEM                    | P1: failure detail is shown only for failed workers; timeout/interruption/cancellation omit existing structured errors and retained-result context.                                                                            |
| ALREADY IMPLEMENTED CORRECTLY          | Agent-specific filtering by AgentRun ID; stable selection on refresh; configurable 1/2/3-agent fan-out; persisted model/status/usage; full structured finding details with missing-field labels.                               |
| ALREADY IMPLEMENTED CORRECTLY          | Explicit paid-start confirmation/readiness; canonical JSON/log Save As; cancellation is silent; success follows awaited write; reveal restricted to saved paths; project/run/history/legacy routes and export schema retained. |
| OPTIONAL POLISH                        | Keyboard panel resizing, compact layouts and history filters. Existing canvas keyboard controls and resizable/collapsible panels reused.                                                                                       |
| OUT OF SCOPE                           | Dead-process automatic reconnection requires main lifecycle wiring; no public reconnect command exists. Provider retry, runtime redesign, new export formats, migration, installation and release work excluded.               |

Direct evidence jump controls and richer provenance inspection are a VERIFIED UX PROBLEM (P1), deferred from this bounded PR.

## Bounded implementation plan

Reproduce before fixing. Treat notifications as invalidation hints and read canonical
snapshots; reconcile read queries on observed offline-to-online runtime status.
Reuse TanStack Query and the existing IPC subscription, with cleanup and terminal
poll stopping. Keep cached results readable and distinguish communication failure
from durable QA outcome. Show selected-agent counts and honest missing/partial
reports. Project only observed stages, never infer successful testing from a
completed worker. No IPC, runtime, provider or persistence redesign.

Planned files: live-query hook, runtime-status hook/shell, RunWorkspace and
RetestWorkspace presentation, summary, inspector, telemetry and graph/node
placeholder presentation; focused component/hook/projector regressions.
Further independent UX work stays documented as follow-up; this PR does not
claim full Phase 3 acceptance or authorize Phase 4.

## Confirmed regressions and implementation

The baseline Windows Desktop suite passed **260 tests / 2 platform skips**.
The initial three new regression files then produced **23 failures / 6 passes**:
old notification replacement, duplicate discarded initial read, missing reconnect
reconciliation, cached run disappearance, selected-agent omission, terminal empty
reports and inferred stages. Passing guards included export success/cancellation/
failure and subscription cleanup. New tests were added before production edits.

Implemented in the renderer only:

- `use-live-run.ts`: unordered run/retest updates invalidate their exact cache
  keys and trigger canonical reads; payloads never replace cache data. Remove
  the discarded duplicate initial read. Nonterminal polling works in background,
  pauses when runtime status is unavailable, and stops after terminalization.
- `use-runtime-status.ts`: shared five-second background status query using the
  existing IPC call. Run/retest hooks reconcile once after observed unavailable
  to connected transitions. AppShell invalidates read-only project/history/
  readiness caches; inactive caches become stale and reread when reopened.
  No start/retry execution method is called by these effects.
- AppShell, RuntimeSettings and Environment distinguish query errors from stale
  cached connected status. Shell active-run count is labeled last known offline;
  an unavailable query is not presented as “No active runs”.
- RunWorkspace and RetestWorkspace keep cached canonical data visible on refresh
  failure, label it as last recorded state and direct users to runtime settings.
  The communication error does not change persisted QA status. Initial loads
  without cached data still show loading/error states.
- RunSummaryPanel and graph/node placeholders include recorded selected stacks
  before workers exist. Overview shows selected/running/completed/unsuccessful
  counts and each agent's status. Missing workers on terminal runs are “Not
  started”, not waiting. Historical selection still falls back to recorded
  AgentRuns. Agent names/statuses occupy separate lines after rendered review
  exposed crowding in the first implementation.
- Agent telemetry adds renderer-only `observed` milestones. Completion proves
  only the completed worker; it does not prove unrecorded planning, tests,
  evidence or reporting. Explicit reporting status is required; token usage
  and generic messages do not invent it. “Commands / Tests” replaces the
  overstrong “Runtime Validation” label for generic tool activity. Durable
  cancelled/interrupted status outranks a stale completion event. Unknown usage
  displays a dash rather than a fabricated zero.
- AgentInspector differentiates completed zero findings from an incomplete
  analysis with no reported findings. Partial findings remain visible with
  failure/cancellation/timeout/interruption context. Existing structured failure
  details are available for every status, and cancellation does not invent a
  human cause. Run-level partial/failed/cancelled notices identify unsuccessful
  agents, retain results and suggest deliberate next actions without diagnosis
  guessed from generic provider failures.

Existing agent selection and full finding detail components are reused. AgentRun
IDs filter findings/evidence/events; changing agents resets inspector-local
filters while snapshot refresh preserves the selected agent. IPC, runtime,
harnesses, database, export schemas, historical issue/retest semantics, versions
and dependencies are unchanged. There is no new paid execution or auto retry.

Some old tests explicitly asserted inferred progress. Those expectations changed
because this brief prohibits claiming unobserved stages: tests now pin only
observed milestones, terminal completion and absent future stages. The graph
selection matrix now explicitly uses an active parent before workers materialize;
four separate tests guard terminal missing-worker presentation. No security or
provider assertions were relaxed.

## Regression coverage

**39 additional tests**: 9 live snapshot cases, 20 workspace/report cases,
6 observed-stage cases and 4 terminal graph cases. They cover old hints, late
outstanding reads, reconnect without notifications, completion/output missed
offline, repeated reconnects, listener cleanup, run switching, terminal poll
stop, no automatic start, cached run/retest preservation, connected-status query
errors, 1/2/3 selections, independent agent switching, export outcomes and all
terminal report states. Tests use explicit promises/events and observable query
states, with fake timers for background polling and terminal poll stopping.

Existing telemetry, graph, finding details/missing data, IPC/preload, Desktop
service, native runtime process/recovery, exports, settings and smoke tests run
as part of the complete Desktop suite. Retained findings/evidence objects and
their IDs are not transformed or reattributed by presentation code.

## Reconnection limits

Verified: a renderer observing runtime status change from unavailable to connected
rereads canonical snapshots and refreshes read caches. Terminal state and retained
findings/evidence reconcile without a notification; no provider call restarts.
The real Electron fixture also performed offline to online reconciliation with
the actual preload/IPC bridge and no online snapshot notification.

This does **not** make a dead runtime process reconnect automatically. Existing
bootstrap exposes an internal reconnect method but the main lifecycle does not
wire it to automatic recovery. Closing/reopening Desktop remains the supported
operational path when the connection cannot return. A separate lifecycle PR
needs bounded recovery ownership and process tests. An RPC timeout still does
not prove execution failed; inspect history before deliberately starting again.

## Rendered review

Real Windows Electron 36.2.1, built renderer, actual sandboxed preload and IPC
envelopes; deterministic fixture handlers replace backend data for these images.
No private project, credentials or paid provider content is included. This is
rendered fixture verification, not live-provider acceptance.

- [Loading](assets/v1-phase-3-loading.png)
- [Three independent agents](assets/v1-phase-3-active.png)
- [Finding detail](assets/v1-phase-3-finding.png)
- [Cached results offline](assets/v1-phase-3-offline.png)
- [Partial result and timeout](assets/v1-phase-3-partial.png)
- [Completed zero-findings report](assets/v1-phase-3-empty.png)
- [Smaller desktop layout](assets/v1-phase-3-compact.png)

Inspected hierarchy, status visibility, text wrapping, scrollable inspector and
overview, missing-field labels and existing design language at 1440x1000 and
1100x760 logical window sizes. Fixed crowded agent-name rows. Smaller windows
retain the existing vertically stacked/scrolling panels; seeing the inspector
requires scrolling. More compact navigation and keyboard panel resizing remain
follow-up work. Owner review of visuals on both target hosts remains required.

Real `pnpm --filter @qa/desktop smoke:electron` also passed with an isolated WSL
runtime entry: Linux handshake, non-Electron runtime Node, BrowserWindow load,
preload bridge, no renderer Node access and project navigation. The existing
smoke script does not register application IPC handlers for its test window,
so its expected “No handler registered” diagnostics are not a complete
production application flow claim. Fixture visual smoke covers renderer IPC
behavior separately; funded Full/Targeted acceptance remains unverified.

## Executed validation

Windows Node **24.13.1**, pnpm **9.12.3**. Ubuntu WSL Node **22.23.2**, pnpm
**9.12.3**, native Linux validation clone `/var/tmp/sentry-v3-validation.Kb94Ng`.
Logs reside outside tracked files in Windows TEMP (`sentry-phase3-*`) and
Linux `/var/tmp/sentry-phase3-*`.

| Gate                            | Windows                                                     | Ubuntu WSL                                                          |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| Frozen install                  | PASS                                                        | PASS                                                                |
| Repository hygiene / formatting | PASS                                                        | PASS                                                                |
| Lint                            | PASS, 20 tasks                                              | PASS, 20 tasks                                                      |
| Typecheck                       | PASS, 37 tasks                                              | PASS, 37 tasks                                                      |
| Build                           | PASS, 20 tasks                                              | PASS, 20 tasks                                                      |
| Desktop suite                   | PASS, 299 tests / 2 platform skips                          | PASS, 300 tests / 1 platform skip                                   |
| Full `pnpm test`                | UNVERIFIED as a full Windows gate; platform suites executed | PASS on rerun, 40 tasks / 1,132 tests / 16 opt-in or platform skips |
| Real sandbox trust              | Linux-only                                                  | PASS, all 8 real verification-trust cases                           |
| Electron smoke                  | PASS, actual Windows Electron / WSL handshake               | UNVERIFIED native Linux Electron                                    |
| Rendered fixture IPC smoke      | PASS, actual Windows Electron                               | UNVERIFIED native CachyOS visuals                                   |

First Linux full-suite attempt: 38/40 tasks successful, existing
`parallel-execution > isolates one timeout without cancelling peers` exceeded
Vitest's unchanged five-second test deadline under concurrent load. The rerun
passed all 40 tasks (38 cached), including all 86 engine tests and real trust
8/8. The final renderer/test snapshot passed all 40 tasks again (39 cached), with 1,132 passed / 16 skipped. No test assertion or deadline was changed. This remains a timing-flake
risk to watch in exact-head CI, not a waived gate.

Initial validation tooling mistakes were repaired: Linux transport copy lacked
Git metadata for hygiene; replaced with a clone plus the scoped patch. Four
unformatted files were formatted. Visual harness text checks switched from
CSS-transformed innerText to DOM textContent. These were not product defects.

Windows launcher decision logic, production-behavior fixtures and shutdown-safety regression also PASS. Linux fixture checks and both exact-head CI launcher jobs are tracked with the PR.

Final local and exact-head CI receipts are recorded with the PR before owner
review. Hosted sandbox capability and native CachyOS must be reported separately;
generic Linux launcher fixtures do not prove CachyOS acceptance.

## Remaining Phase 3 work and owner review

- P1: finding-to-evidence drill-down currently exposes linked IDs/type/strength
  in full finding detail and the Evidence tab; direct jump controls and richer
  provenance inspection are deferred. No provenance is removed or invented.
- P0 follow-up: dead-process automatic reconnect remains separate, as above.
  Existing lost-start-response/idempotency gap from Phase 2 remains documented.
- P1/P2: broader history/query loading/error presentation, provider setup copy,
  compact stacked-panel navigation, keyboard resizing and complete keyboard
  tab semantics warrant a separate focused accessibility/UI review.
- Native CachyOS, funded OpenCode/DeepSeek/GLM Full/Targeted runs, interactive
  cancellation/recovery/export acceptance and owner visual approval are
  **UNVERIFIED in this task**. Previous beta acceptance is historical only.

This is a bounded P0/P1 improvement PR, not complete Phase 3 closure. Review the
new observed-stage semantics, last-known offline labeling and query read volume.
No actionable correctness, data-loss, security or lifecycle defect was found in
the scoped self-review; external/runtime recovery gaps above remain. Phase 4
Installation & Distribution is recommended only after owner review/integration
and deciding how to close or explicitly schedule these remaining Phase 3 gates.
