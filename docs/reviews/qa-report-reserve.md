# Run 01M60MR: enforce reporting reserve

The run reached the hard30min deadline with no initial report/checkpoint: OC
investigation buffered until exit; DS planning21s, investigation23min, then
reporting until timeout; GLM live investigation continued until termination.
Dependencies were ready. Compact prompts/DS streaming ran, but advisory time
management did not enforce a reporting reserve. No evidence establishes OOM.

## Architecture / scope

1. Source of truth: host deadline, observed operation registry and redacted tool
   events. No model-generated completion/exit status is trusted implicitly.
2. Ownership: stop only the current agent's owned process/client. Same private
   workspace and provider/model; reporter may see only that agent's observations.
3. Dependency direction: shared phase-deadline stream helper in evidence-pipeline;
   adapters own provider lifecycle and report conversion; coordinator unchanged.
4. Contract: reserve one third of remaining run time for first report/repair.
   Host-enforced investigation deadline, not another prompt request. On expiry
   close owned work, mark partial, start one report-only context from own receipts.
5. Failure: unconfirmed shutdown, auth, sandbox or explicit cancellation never
   starts a recovery conversation. Generic investigation errors remain failures.
   Report attempts stay bounded by existing MAX_REPORT_ATTEMPTS and hard deadline.
6. Lifecycle: old client settles before reporter starts; new reporter context has
   safety/mission + bounded redacted observed outputs + exact frozen ledger.
   No investigation retry, no peer sharing. Open operations close with unknown
   outcomes. Normal completed investigations retain their existing conversation.
7. Tests: controlled never-ending investigation/report, cancellation race,
   interrupted tool lifecycle, observed output retention/dedup, actual native
   vendor binaries against local stubs (zero credit).
8. Compatibility: no schema/DB change; legacy no-depth callers retain behavior.
   This deliberately relaxes same-conversation policy only for bounded report
   recovery. Same-copy/agent independence remains. SENTRY_QA_DEPTH=0 rollback.
9. Observability: explicit phase-expired/partial-analysis warnings and report
   recovery notice; never label a truncated investigation complete coverage.
10. Security: same sandbox/auth/report firewalls. No raw reasoning or secret
    transport data in recovery context. Bounded tool output is UNTRUSTED evidence.

Real SDK probe: SDK-minimal uses persistent JSONL, but restarting a client and
prompting its existing id throws `session already exists`; no usable wire resume
or cancel exists in pinned SDK. Do not silently claim interrupted conversation
continuity. Fresh report context is explicit, host-owned and tool-free by the
existing report firewall. Probe used local HTTP stub/dummy credential only.

## Verification receipt (2026-10-28)

Implemented on `fix/qa-stage-contracts`, based on bfd6b9c. Host reserves one
third of remaining investigation time for reporting. Two existing report
attempts receive separate deadlines with cleanup margin. Expired phases never
start provider work. Recovery contexts carry full schema, own bounded public
tool notes and frozen operation receipt; no private reasoning/peer state.
Unfinished coverage remains partial. Recovery skips optional challenge.
OpenCode and Claude shutdown failures now prevent report recovery.

| Gate                              | Result / evidence                                                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows full build/typecheck/lint | PASS: `pnpm exec turbo run build typecheck lint --concurrency=2`, 60 tasks (`reserve-final-static.log`)                                                  |
| Broad non-engine suite            | PASS: `pnpm exec turbo run test --filter=!@qa/run-engine --concurrency=1`, 39 tasks (`reserve-full-tests.log`)                                           |
| Windows run engine                | PASS: vitest excluding Linux verification-trust, one worker, 94 tests (`reserve-engine.log`)                                                             |
| Final shared pipeline             | PASS: 86 tests (`reserve-final-shared.log`)                                                                                                              |
| Final provider regressions        | PASS: DS11, OC13, GLM17 focused tests; deadline, cancellation, failed shutdown, exhausted repair and live output/dedup (`reserve-final-{ds,oc,glm}.log`) |
| Native WSL trust/preparation      | PASS: trust8 and 2 private prepared copies, lifecycle scripts blocked, cancellation stopped (`reserve-native-trust.log`)                                 |
| Native candidate build            | PASS: 18 tasks, stage-only, no activation (`reserve-stage.log`)                                                                                          |
| Actual vendor runtime recovery    | PASS: six local-stub cases, three providers x investigation/report timeout, valid checkpoints inside original 90s deadline (`reserve-native-*.log`)      |
| Funded model accuracy/depth       | UNVERIFIED: no paid provider run in this task                                                                                                            |

Local logs are under ignored `.tmp-sentry-test-fixtures/`. Reproducible native
proof: `node scripts/verification/qa-report-reserve.mjs PROVIDER PHASE`, with
PROVIDER deepseek/opencode/glm and PHASE investigation/report. It always uses
loopback stubs and dummy credentials; real vendor binaries and production
sandbox/adapter paths remain active. Installed versions: DS SDK/runtime
0.1.5-rc.2, OpenCode1.18.32, Claude Code2.1.270. Investigation recovery elapsed
61.5/70.9/64.3s respectively; reporting recovery45.1/65.1/49.8s. These prove
lifecycle/deadline/report persistence, not semantic quality from funded models.
The final expired-deadline guard and cancellation-after-session guard were
added after native proofs and covered by final focused tests and static gates.

Self-review: correctness/lifecycle blockers found (fresh report schema omitted
on repair; unchecked owned shutdown) were fixed and regression tested. No
remaining actionable data-loss/security findings identified in this diff.
No DB migration or provider sandbox bypass. Initial static failures (explicit
optional fields, test const style, CLI error enum) were corrected; final gates
above passed without removing assertions or weakening sandbox checks.

## Activation

Implementation `defd410` pushed on `fix/qa-stage-contracts`. Deployed native
`1.0.2-defd410` with deploy-wsl-runtime.ps1:18 tasks PASS, ENTRY_OK,
SENTRY_DEPLOY_EXIT:0. `current` resolves to that version; runtime.hello returns
ok:true, Linux/WSL, Node22.23.2. Desktop opened from this checkout after an
empty active-run query and stopped-desktop status. Main/dev not merged here.
Format, repository hygiene and diff whitespace checks PASS. Working tree clean
after this documentation receipt is committed. Funded semantic QA remains
UNVERIFIED; no guarantee that a model returns valid findings within two attempts.
