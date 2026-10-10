# Sentry v1 Phase 2 reliability validation

## Baseline and scope

Phase 1 PR #2 was owner-integrated on 2026-10-09 at
`d29949b981216cdcdd8b6817c4df12893c05f616`. Baseline CI
[37904000595](https://github.com/Mert1026/Sentry/actions/runs/37904000595)
passed quality and both launcher jobs. Hosted sandbox mounts were unavailable;
the CI fallback explicitly leaves real sandbox trust unverified.

Work is isolated in `codex/v1-runtime-reliability` / `Sentry-v2`. Original
checkout `main` at `9c57e3f` contains owner changes and is not modified.
No paid calls, SDK upgrade, schema migration, version change or release action.

## Lifecycle audit and initial classification

Inspected runtime host/start/detection/shutdown, Desktop transport/bootstrap/
service/main/live updates/renderer queries, coordinator/error/retest service,
repository/lease, all three adapters and relevant tests/history (including
`2a843cd`, `03c80b4`, `848da67`). Classification before reproduction:

| Step                      | Owner / behavior                                                                      | Classification                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1. Preflight              | Selected registrations checked before run identity/lock                               | EXISTING SAFE BEHAVIOR; pre-row failure test                                                                   |
| 2. Request                | RPC validates input; pending workflow prevents shutdown                               | EXISTING SAFE BEHAVIOR; shutdown-safety tests                                                                  |
| 3. Identity               | Runtime polls project/issue lists after starting workflow                             | SUSPECTED BUG: another request's row may satisfy detection; fast row may enter baseline                        |
| 4. Lock                   | ProjectManager acquires managed-copy lock before snapshot                             | EXISTING SAFE BEHAVIOR; no concurrent project execution                                                        |
| 5. Snapshot               | Integrity and immutable snapshot precede persisted QARun                              | EXISTING SAFE BEHAVIOR; Full/Targeted tests                                                                    |
| 6. Start                  | Adapter creation/metadata/workspace await before watcher                              | SUSPECTED BUG: cancellation in startup may still enter provider stream                                         |
| 7. Concurrent workers     | Selected workers settle independently with allSettled                                 | EXISTING SAFE BEHAVIOR; barrier tests                                                                          |
| 8. Durable output         | Validated events, findings, evidence and activities transact                          | EXISTING SAFE BEHAVIOR; invalid protocol / partial output tests                                                |
| 9. Agent outcome          | Terminal rows reconciled; adapter disposed before workspace cleanup                   | EXISTING SAFE BEHAVIOR for tested adapters; throwing dispose remains SUSPECTED BUG requiring reproduction      |
| 10. Parent outcome        | Domain aggregation after settlement; production report/export only                    | EXISTING SAFE BEHAVIOR; success/partial/all-fail tests                                                         |
| 11. Cancellation/shutdown | Durable request, owned adapter cancel, fail-closed Desktop quit                       | EXISTING SAFE BEHAVIOR during active execution; startup hypothesis above                                       |
| 12. Recovery              | Lease freshness protects live owners; stale rows interrupted and locks released       | EXISTING SAFE BEHAVIOR; recovery/closure/retest tests                                                          |
| 13. Reconciliation        | RPC correlation/generations/timeouts; persisted snapshot polls and notification hints | EXISTING SAFE BEHAVIOR in covered reconnect paths; automatic reconnect/UI refresh wiring is FUTURE IMPROVEMENT |

Provider audit: OpenCode and GLM already map thrown typed errors, redact
diagnostics and dispose owned clients. Broad fallback authentication matching
and non-auth GLM error result classification need separate reproduction
(SUSPECTED BUG, not fixed speculatively). DeepSeek's pinned SDK returns idle
results carrying `turn/end` error reasons; adapter currently parses final text
without interpreting that outcome (SUSPECTED BUG pending regression).

The separate owner DeepSeek patch was read as a diff in the original checkout:
it handles error reasons, introduces `DEEPSEEK_PROVIDER_FAILED`, and adds five
tests. It has not been copied. This branch independently reproduced the
pinned SDK contract and implemented only behavior justified by those tests.

## Implementation plan and architecture review

First run baseline suites. Add controlled-promise regressions before production
edits. If reproduced, replace list inference with per-request persisted-row
callbacks in coordinator/retest and runtime; check durable cancellation before
entering an adapter stream; interpret structured DeepSeek error outcomes without
JSON correction retries. Reuse existing recovery/partial/history coverage and
extend missing assertions. Keep unrelated hypotheses as explicit follow-ups.

1. Source of truth: SQLite rows remain canonical; callbacks only signal a saved ID.
2. Ownership: coordinator/retest service write rows; runtime observes and rereads.
3. Dependencies: run-engine exposes optional callbacks without importing runtime.
4. Boundaries: internal ID callbacks only; no public RPC or IPC payload changes.
5. Failure: pre-row rejection propagates; no unpersisted ID or automatic model retry.
6. Lifecycle: runtime retains workflow promises after early response; shutdown
   remains busy until they settle. Cancellation waits for owned cleanup.
7. Test seams: real temporary repositories, fake agents/SDK and explicit gates;
   fake timer advancement only to exercise production polling deterministically.
8. Compatibility: optional additive callbacks; no data conversion, rollback is
   code revert; historical retest/merge/verification records remain supported.
9. Observability: created notifications follow canonical reread; durable agent
   failures retain safe structured diagnostics.
10. Security: no new input, privilege, secret transport or persistence boundary;
    retain existing sandbox and redaction controls.

## Reproduction, fixes and verification

The initial hypotheses above were classified before tests. The following
findings are now independently reproduced and fixed.

### Important: wrong startup identity and masked rejection — CONFIRMED BUG

Affected: `apps/runtime/src/runtime.ts`, creation observers in
`packages/run-engine/src/index.ts` and `retest-service.ts`.

`start-identity.test.ts` controls snapshot settlement and real project-lock
contention. Against baseline runtime `d29949b`, a request rejected by the
coordinator with `ACTIVE_RUN_EXISTS` instead returns the other request's run
ID. Concurrent real retests return one ID for two persisted RetestRuns. The
polling loop checks unrelated list changes before workflow settlement, so a
different request's row masks the actual outcome.

Separate boundary tests persist a row synchronously before the old detector's
baseline and hold workflow settlement: the start response remains missing.
This proves a host-seam flaw; current real coordinator/retest paths await
preflight/integrity before persistence, so synchronous creation is not claimed
as a reproduced current production scheduling path.

Fix: optional internal observers fire immediately after the request's own row
is saved. Runtime races that exact identity with workflow settlement, rereads
the row before notifying/responding, and retains the pending workflow for
shutdown ownership. No list inference, polling timer, public protocol change
or automatic retry. Tests refuse unpersisted IDs and assert real observers see
a canonical row before any agents/child run start.

RED: three initial boundary tests plus real run-lock contention and real
concurrent retests failed against baseline runtime. GREEN: seven identity tests
pass with the fix. Pre-row errors and busy shutdown remain covered unchanged.

### Important: execution after startup cancellation — CONFIRMED BUG

Affected: `packages/run-engine/src/index.ts` cancellation watcher/consumer.

A controlled adapter-creation promise lets cancellation persist after the
parent's pre-launch check but before the stream watcher starts. Baseline still
calls `adapter.run` once. The interval-only watcher observes cancellation too
late, potentially beginning a provider turn after effective cancellation.

Fix: run the existing owned-adapter check immediately at watcher registration
and await delivery before entering the stream. The regression holds cancel
delivery open: no stream starts, request acknowledges but does not complete,
parent stays active; after delivery/disposal settle, agent/parent cancel and
the project unlocks. Repeated requests remain idempotent. No new process-kill
mechanism. RED: stream call count 1. GREEN: 0 and one cancellation delivery.

### Important: DeepSeek errors parsed as output or success — CONFIRMED BUG

Affected: `packages/harness-deepseek/src/adapter.ts`, its error-code union and
the existing CLI error-code registry (additive only).

Pinned `@deepseek-ai/dsh-sdk-client` `0.1.5-rc.2` resolves `runText` at idle and
returns durable events plus final assistant text. Its installed implementation
does not throw for a `turn/end` provider error. The old adapter ignores this
reason. Seven tests reproduce invalid credentials, exhausted credit, rate
limits, unavailable provider, transport loss, timeout and invalid request/model
across planning/investigation/reporting. Failed reporting with plausible JSON
incorrectly completes; other failures become output correction retries/errors.

Fix: structured failure overrides final text. Authentication maps to
`DEEPSEEK_AUTH_FAILED`; others use `DEEPSEEK_PROVIDER_FAILED`, retaining bounded,
redacted phase/code/status/message. Known keys, Bearer values and the submitted
prompt are redacted. No raw outcome serialization, SDK upgrade, config change
or added paid retry. RED: all seven failed (including false `run.completed`).
GREEN: truthful failure, SDK calls only up to the failing turn, no correction
retry, secrets/prompt absent and owned client closed once.

The owner patch was separately reviewed, never copied. This branch's separate
fixture independently covers seven outcomes and prompt-echo redaction. The
original four-file patch remains untouched/uncommitted in the owner checkout.

### Test portability correction — CONFIRMED TEST BUG

With a built runtime on WSL, the existing Linux child handshake test asserted
`isWsl=false` despite correctly reported WSL identity. Its assertion now checks
the host's explicit WSL environment: native Linux CI still requires false,
WSL requires true. All platform/executable/RPC/stop/restart checks remain.
This corrects a test-host assumption; it is not native CachyOS acceptance.

## Regression matrix

| Scenario                                                     | Coverage                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 1/2/3 selected agents, success and attribution               | Added 1/2 selection cases; existing full/parallel/Targeted three-agent tests                              |
| One failure / timeout, retained peer output                  | Existing parallel, run-engine and Targeted partial cases                                                  |
| All fail, honest state and unlock                            | Existing all-fail case                                                                                    |
| Invalid/incomplete protocol with prior accepted output       | Existing disconnect/protocol/export cases                                                                 |
| Provider outcomes and secret isolation                       | Seven new DeepSeek cases; unchanged OpenCode/GLM suites                                                   |
| Startup / active / repeated / late cancellation              | Creation and cancel-settlement gates; existing closure and active-retest-cancel                           |
| Identity / lock contention / pre-row error / shutdown        | Seven identity cases, real observer assertions; unchanged runtime/shutdown tests                          |
| Crash / accepted cancel / stale lease / reconnect            | New actual child SIGKILL with explicitly seeded in-flight rows; no paid agents                            |
| Durable output, completed history, fresh start               | Crash fixture checks retained IDs, completed row unchanged, no replay, unlock and explicit fresh fake run |
| Timeouts, pending cleanup, stale-child events, notifications | Existing stdio client, Desktop service/live-update tests                                                  |
| Historical reopening, issues/retests, Full/Targeted          | Existing pipeline-compatibility and issue/retest/Targeted suites                                          |

The process test kills only its exact owned child. It uses seeded in-flight
rows and a real runtime lease, accepts cancellation through RPC, crashes that
subprocess, explicitly ages the lease rather than sleeping, then reconnects
through real stdio. It does not claim real provider-process crash acceptance.

## Original verification receipts (before final correction)

Implementation commits: `942892bee1a0ced4f2b6b815fc49a2a4c476c693`
(identity/cancellation/recovery tests), then
`618701465faec2e4232fd1ca35ee65f9c93d3eb5` (DeepSeek). These are the exact
production/test bytes validated in this original receipt. Commit `8ed311b`
added only this report, roadmap and protocol records. The final correction
and its separate receipts are recorded below. Draft
[PR #3](https://github.com/Mert1026/Sentry/pull/3) is the final-head CI receipt
and owner review surface; no merge is performed by this task.

Exact-code CI [37924202481](https://github.com/Mert1026/Sentry/actions/runs/37924202481)
on `618701465faec2e4232fd1ca35ee65f9c93d3eb5`: completed SUCCESS;
`quality`, `launcher (windows, no WSL)`, and `launcher (linux, no CachyOS)`
all PASS. Hosted mounts failed capability probing with exit 226, so the
existing fallback excluded only the real trust test file. This is not a
hosted trust PASS; the eight real proofs below ran separately on WSL.
Final documentation-head CI is tracked in PR #3 and must pass before review
completion/integration; these code-SHA receipts remain immutable evidence.

Windows: Node 24.13.1 / pnpm 9.12.3. Ubuntu WSL: Node 22.23.2 / pnpm 9.12.3,
validation clone on its native Linux filesystem, same source bytes as the
implementation commits (not a native CachyOS host).

| Gate / command                                | Windows                                                                  | Ubuntu WSL                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`              | PASS                                                                     | PASS                                                                           |
| `pnpm repository:check`                       | PASS                                                                     | PASS                                                                           |
| `pnpm format:check`                           | PASS                                                                     | PASS                                                                           |
| `pnpm lint`                                   | PASS, 20 tasks                                                           | PASS, 20 tasks                                                                 |
| `pnpm typecheck`                              | PASS, 37 tasks                                                           | PASS, 37 tasks                                                                 |
| `pnpm test`                                   | Full suite not run on Windows; platform-dependent trust tests run on WSL | PASS, 40 tasks; 1,085 passed / 16 opt-in or platform skips                     |
| `pnpm build`                                  | PASS, 20 tasks                                                           | PASS, 20 tasks                                                                 |
| Runtime full suite                            | PASS, 69 passed / 1 platform skip                                        | PASS, 70 passed                                                                |
| Desktop full suite                            | PASS, 260 passed / 2 Linux-only skips                                    | PASS, 261 passed / 1 platform skip                                             |
| Run-engine focused six suites                 | PASS, 44 passed                                                          | Full engine PASS, 78 passed                                                    |
| DeepSeek                                      | Adapter PASS, 29 passed                                                  | Full package PASS, 46 passed                                                   |
| Real sandbox trust                            | ENVIRONMENT UNAVAILABLE on Windows                                       | PASS, 8/8 with real sandbox replay                                             |
| Windows launcher `shutdown-safety.test.ps1`   | PASS, `SHUTDOWN-SAFETY-OK`                                               | Not applicable                                                                 |
| Exact-code Actions 37924202481                | PASS, launcher (no WSL)                                                  | PASS, quality and Linux launcher (hosted Ubuntu, no CachyOS; trust unverified) |
| Native CachyOS / interactive funded providers | ENVIRONMENT UNAVAILABLE / UNVERIFIED                                     | ENVIRONMENT UNAVAILABLE / UNVERIFIED                                           |

Baseline focused suites before implementation: runtime 62 passed / 1 platform
skip; DeepSeek 39 passed; parallel/closure/Targeted 22 passed. The full WSL
suite includes transport/client/service/recovery/cancellation, legacy history,
all three harnesses, Full/Targeted, CLI, and unchanged real trust tests.

One Windows runtime attempt under concurrent lint/type/build load hit the
existing 5s PATH-readiness timeout and EBUSY cleanup. Full rerun passed (67
passed/1 platform skip before the last two identity guards). No test timeout
or assertion was relaxed. Initial direct Desktop testing preceded its build
and failed from missing compiled preload; the required build is now included.
First Linux validation build failed from Windows incremental metadata copied
without dist outputs. Removing only validation-clone tsbuildinfo files and
rebuilding all 20 tasks passed.

Complete diff self-review found no actionable introduced correctness,
data-loss, security or lifecycle defect. New callbacks observe committed rows;
they do not become a second source of truth. No credentials, runtime logs,
temporary databases, generated outputs or owner patches are committed.

Changed production files: runtime host; run-engine coordinator and retest
service; DeepSeek adapter/error union; additive CLI error-code registry.
Regression files: new runtime `start-identity.test.ts`; existing run-engine
run/Targeted/retest tests; DeepSeek adapter tests; Desktop native-process test.
Other changes: this report, `V1_ROADMAP.md`, task status, ledger and handoff.

## Final cancellation review correction (2026-10-10)

Baseline: PR #3 remained OPEN/DRAFT, base `main`, exact reviewed and fetched
head `8ed311b10a8b5fb3e3d1dbfcee52126a14c014be`. No intervening contributor
commits. Reused the clean isolated Phase 2 worktree; original dirty checkout
and release tags remain untouched. Existing Phase 2 changes were reviewed.

**CONFIRMED BUG, important:** intentional owner cancellation could leave the
AgentRun and parent cancelled but the agent activity failed. Reproduction in
`packages/run-engine/tests/cancellation-stream.test.ts`:

1. An owned fake adapter yields `run.started`, then blocks on an explicit promise.
2. After persistence, request cancellation twice through the coordinator's
   durable request path. The owner watcher acknowledges and calls `cancel()` once.
3. Resolve the cancellation gate. The stream ends cleanly without a terminal.
4. Hold `dispose()` open: parent/request remain nonterminal/incomplete, workspace
   exists and project stays locked. Resolve disposal and await coordinator settlement.
5. Assert parent, AgentRun and agent activity all cancelled; no protocol-failure
   diagnostic, synthetic terminal, duplicate worker or second provider stream;
   control request complete, workspace removed, project ready.

Repeat with an accepted finding and evidence linked to an observed completed
tool operation. Compare complete persisted objects before and after cancellation,
including agent/stack attribution, evidence IDs and grounding operation provenance.

RED against `8ed311b`: both primary cases failed because the agent activity was
`failed` / `Agent failed protocol validation`. The AgentRun itself remained
cancelled with no failure: the normal path persisted cancellation before calling
`validator.finish()`, then `finish()` rejected the absent terminal. Catch created
a failed local worker candidate; reconciliation correctly retained the durable
cancelled row, but `finalizeAgent()` unconditionally wrote a failed activity.
Existing cancellation tests covered statuses/locks, not this activity disagreement.

Two related deterministic cases also failed: late cancellation overwrote an
already persisted completed worker as cancelled; and a real protocol error racing
a durable cancellation finalized cancelled activity as failed. Overall RED:
**4 failed / 4 passed**. The passing guards included uncancelled truncation and
genuine protocol errors during owner cancellation.

Minimal production change: `packages/run-engine/src/index.ts` only. Skip the
stream-close completeness check only when `consumeWithTimeout()` successfully
returns its owned cancellation outcome after shutdown delivery. Per-event
validation, exceptions and uncancelled `finish()` stay strict. Explicitly close
the existing active agent activity as cancelled through the unchanged projector;
do not fabricate harness events. Preserve all durable terminal worker statuses
when reconciling late cancellation. Remove the broad catch cancellation override;
use the reconciled status for activity finalization. If an actual exception races
a durably cancelled worker, preserve its terminal row/activity and record a
separate failed runtime diagnostic with the bounded error code, not raw text.

The validator and activity projector APIs, schema versions, public contracts,
three-agent/selected-agent execution, Full/Targeted, request-specific identity,
startup cancellation, DeepSeek structured outcomes, crash recovery and legacy
issue/retest behavior remain unchanged. No retries, paid calls or new processes.
Cleanup/disposal ordering is unchanged; explicit gates prove completion waits
for owned disposal and real workspace cleanup. Adapter shutdown errors remain
observable. Previously hypothesized throwing-dispose cleanup remains a separate
unfixed follow-up below.

GREEN: **8/8 new cases**, **47/47** across cancellation-stream, closure,
run-engine, parallel-execution, Targeted and active-retest-cancel suites on
Windows Node 24.13.1 / pnpm 9.12.3. Edge coverage includes cancellation before
`run.started`, duplicate requests, adapter-emitted valid cancellation, late
normal completion, uncancelled missing terminal, genuine protocol exceptions,
durable-cancel/error reconciliation and shutdown diagnostics. Existing startup
cancellation, terminal-request, cross-run rejection and validator guards are
retained. Full corrective checks are recorded below; the exact corrected-head
CI receipt belongs to PR #3 before owner review completion.

Corrective validation (same Node/pnpm versions as above):

| Gate                                                | Windows                                                   | Ubuntu WSL                                                                          |
| --------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                    | PASS                                                      | PASS                                                                                |
| `pnpm repository:check`                             | PASS                                                      | PASS                                                                                |
| `pnpm format:check`                                 | PASS; final documentation formatted and checked           | PASS; final documentation formatted and checked                                     |
| `pnpm lint`                                         | PASS, 20 tasks                                            | PASS, 20 tasks                                                                      |
| `pnpm typecheck`                                    | PASS, 37 tasks                                            | PASS, 37 tasks                                                                      |
| `pnpm build`                                        | PASS, 20 tasks                                            | PASS, 20 tasks                                                                      |
| `pnpm test`                                         | Focused/platform suites below; full Windows suite not run | PASS, 40 tasks (33 cached); 1,093 passed / 16 opt-in/platform skips                 |
| Cancellation/parallel/Targeted focused suites       | PASS, 47 tests                                            | Included in 86 passing engine tests                                                 |
| Harness protocol full suite                         | PASS, 25 tests                                            | PASS, 25 tests                                                                      |
| Runtime full suite, including seven identity cases  | PASS, 69 passed / 1 platform skip                         | PASS, 70 tests                                                                      |
| Desktop full suite, including cancellation/shutdown | PASS, 260 passed / 2 Linux-only skips                     | PASS, 261 passed / 1 platform skip; actual process crash/reconnect included         |
| Real sandbox trust                                  | ENVIRONMENT UNAVAILABLE                                   | PASS, 8/8, uncached affected engine task                                            |
| Corrected-head Actions                              | Exact corrected-head result recorded in PR #3             | Exact corrected-head result recorded in PR #3; hosted trust is capability-dependent |

Full WSL tests reran affected engine/runtime/Desktop/CLI tasks; unchanged tasks
used Turbo's normal cache. No trust-test quarantine or assertion relaxation.
Correction diff self-review found no additional introduced correctness,
data-loss, security or lifecycle defect. No logs, databases, credentials or
generated files are included. Final commit/Actions receipt is recorded in PR #3;
the frozen reviewed baseline and RED/GREEN counts above are explicit.

## Remaining problems and follow-ups

- SUSPECTED BUG, important: throwing adapter `dispose()` may bypass subsequent
  workspace cleanup. Reproduce actual adapter semantics before a separate
  cleanup PR; no fix or regression protection is claimed here.
- SUSPECTED BUG, important: broad OpenCode fallback auth matching and GLM
  non-auth error results need separate structured provider fixtures. This PR
  changes only independently reproduced DeepSeek outcomes.
- SUSPECTED BUG, important: lost start response after a run already terminalizes
  is absent from active-only Desktop timeout reconciliation. No automatic retry
  exists today; inspect history before a manual retry. An operation-receipt /
  idempotency contract requires separate review.
- FUTURE IMPROVEMENT: automatic Desktop reconnect and refresh fan-out wiring.
  Explicit transport reconnect, canonical polling and real restart recovery
  are tested here; no Phase 3 UI redesign is included.
- ENVIRONMENT UNAVAILABLE: native CachyOS and interactive supported-host runs.
  Generic Linux/WSL transport fixtures do not satisfy those acceptance gates.

## Remaining acceptance

Native CachyOS and interactive Windows/WSL acceptance require owner hosts.
Previously successful 3/3 runs are OWNER-REPORTED historical evidence only.
Manual acceptance must exercise Full/Targeted with funded providers, one provider
denied/credit exhausted, active and startup cancellation, refused busy shutdown,
unexpected runtime loss/restart, retained peer evidence and final snapshots.
No automatic paid rerun is permitted during recovery or ambiguous start failure.
