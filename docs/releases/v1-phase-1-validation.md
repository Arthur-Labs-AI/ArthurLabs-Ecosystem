# v1 Phase 1 validation — 2026-10-09

Scope: `codex/v1-phase-1-cleanup`, based on approved `origin/main`
`0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38`, also the target of annotated tag
`v0.1.0-beta.1`. Original owner checkout: `main` at
`9c57e3f78164c45c35316ae7bf2fe45fa4b0f132`, dirty with separate DeepSeek,
schema and protocol-document work plus untracked `PROJECT_GUIDE.md`. Those files
were preserved in place; this task uses `C:\Users\merte\Documents\GitHub\Sentry-v1`.
Package versions and released tags are unchanged.

## Baseline and review policy

Baseline CI [37893841778](https://github.com/Mert1026/Sentry/actions/runs/37893841778)
passed `quality`, `launcher (windows, no WSL)` and `launcher (linux, no CachyOS)`
on `0e5c10c`. Hosted systemd sandbox mounts were unavailable, so that baseline
CI used the documented lane excluding only `verification-trust.test.ts`.
No security proof is inferred from that skipped lane.

Authenticated admin queries to main protection and rulesets returned HTTP 403
requiring a plan upgrade or public visibility. Neither was changed. Required
PRs, owner approval, successful checks, blocked force pushes and branch deletion
remain procedural under the [manual gate](../development/branching.md).
The existing CI configuration validates every PR branch and is unchanged.

## Executed validation

Windows: Node `24.13.1`, pnpm `9.12.3`. Linux: Ubuntu WSL2, Node `22.23.2`,
pnpm `9.12.3`, native Linux validation clone with the same changed source.

| Gate                                                     | Result                  | Evidence and scope                                                                                                                                                                             |
| -------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen dependency install                                | PASS                    | `pnpm install --frozen-lockfile`, Windows and WSL; lockfile unchanged                                                                                                                          |
| Repository hygiene                                       | PASS                    | `pnpm repository:check`, Windows and WSL                                                                                                                                                       |
| Formatting                                               | PASS                    | `pnpm format:check`, Windows and WSL                                                                                                                                                           |
| Lint                                                     | PASS                    | `pnpm lint`, 20/20 tasks on each host; WSL uncached                                                                                                                                            |
| Types and prerequisite builds                            | PASS                    | `pnpm typecheck`, 37/37 tasks on each host; WSL uncached                                                                                                                                       |
| Full automated suite                                     | PASS                    | `pnpm test`, WSL, 40/40 tasks; 1,067 passed, 16 existing opt-in/platform skips                                                                                                                 |
| Build                                                    | PASS                    | `pnpm build`, 20/20 tasks on Windows and WSL; WSL final command reused builds executed by typecheck/tests                                                                                      |
| Desktop regressions                                      | PASS                    | `pnpm --filter @qa/desktop exec vitest run`, Windows, 260 passed/1 platform skip; WSL same counts                                                                                              |
| Runtime regressions                                      | PASS                    | `pnpm --filter @qa/runtime exec vitest run`, Windows, 62 passed/1 platform skip; WSL 63 passed                                                                                                 |
| Run-engine regressions                                   | PASS                    | WSL full suite, 75 passed, all 14 files including Full/Targeted, parallel, cancellation/recovery, export, issue/retest and trust suites                                                        |
| Real sandbox trust                                       | PASS                    | WSL `verification-trust.test.ts`, 8/8 cases including real replay, containment, secrets and descendant cleanup                                                                                 |
| New graph and inspector regressions                      | PASS                    | Seven failures reproduced before the two-file renderer fix; all 30 focused tests pass after it; baseline focused suites 21/21 passed                                                           |
| Windows launcher                                         | PASS                    | CI-equivalent PowerShell syntax; `node --test scripts/launcher/tests/launcher-logic.test.mjs` 20/20; launcher smoke, behavior, IO stress and shutdown safety scripts                           |
| Windows control/DeepSeek resolution                      | PASS                    | Full Desktop suite includes control/stdio/quit tests; DeepSeek `dsh-bin-selection.test.ts` and `dsh-sdk-resolution.test.ts` 7/7                                                                |
| Windows entrypoints                                      | PASS                    | `sentry.ps1 help`, `version`, `status`; status is diagnostic, not a new installation acceptance                                                                                                |
| Linux launcher                                           | PASS                    | All shell syntax and all 19 fixture scripts listed by `launcher-linux` in CI, plus `test-dsh-switch.sh` and `test-sandbox-prereqs.sh`; Node logic tests and help/version/Ubuntu native refusal |
| Diff and credential review                               | PASS                    | Complete source/test/docs diff reviewed; explicit scoped staging only; no credentials, databases, logs, generated builds or owner changes included                                             |
| Native CachyOS acceptance                                | ENVIRONMENT UNAVAILABLE | No native CachyOS host in this execution environment                                                                                                                                           |
| Paid three-agent acceptance                              | SKIPPED                 | No paid-provider runs in Phase 1; owner previously confirmed 3/3 on Windows/WSL and CachyOS, not reverified here                                                                               |
| Interactive Desktop / fresh install / upgrade acceptance | SKIPPED                 | Automated renderer/RPC/lifecycle fixtures ran; no new interactive acceptance or installer distribution is claimed                                                                              |
| `shux contract`                                          | ENVIRONMENT UNAVAILABLE | Attempted before work; command absent from PATH; task status, ledger and handoff maintained directly in this worktree                                                                          |

Current candidate GitHub CI is recorded by the PR checks after push/creation;
baseline CI above must not be mistaken for candidate verification. This report
records local validation before PR creation, not publication readiness.
Existing non-fatal warnings: SQLite experimental API, React SSR layout-effect
warnings in structural component tests and Vite's >500 KiB bundle warning.

## Every changed file and compatibility impact

| File                                                            | Reason                                                                                                                            | Compatibility impact                                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `.github/pull_request_template.md`                              | Request file/architecture impacts, exact CI scope, manual acceptance and owner review                                             | Documentation only                                                                           |
| `docs/development/branching.md`                                 | Adopt requested branch prefixes, immutable tags and precise manual enforcement alternative                                        | Historical refs retained; existing CI preserved                                              |
| `apps/desktop/src/renderer/lib/run-graph.ts`                    | Use recorded selection/AgentRuns instead of inventing three agents for empty historical inputs; remove unused locals              | Current selected-agent topology unchanged; historical identities and payload inputs retained |
| `apps/desktop/src/renderer/components/PipelineInspectors.tsx`   | Remove retired command instructions; label saved compatibility details; explain independent edges                                 | Retained merger/verifier outcomes and source attribution still render                        |
| `apps/desktop/tests/unit/run-graph.test.ts`                     | Cover all seven nonempty selections in Full/Targeted, empty/older records and evidence attribution                                | Adds regression coverage; prior topology/retest assertions retained                          |
| `apps/desktop/tests/unit/desktop-command-router.test.ts`        | Prove retired channels are rejected for both Renderer and CLI                                                                     | Existing IPC contract stays unchanged                                                        |
| `apps/desktop/tests/components/pipeline-compatibility.test.tsx` | Guard retained inspector data and removal of stale instructions                                                                   | Test only                                                                                    |
| `apps/runtime/tests/pipeline-compatibility.test.ts`             | Real persistence/reopen fixture for Full/Targeted findings, evidence, merge/verification and issue lineage; retired RPC rejection | Test only; no production adapter/provider/sandbox claim from its mocked preflight            |
| `docs/architecture/v1-phase-1-assessment.md`                    | Record source trace and bounded plan before implementation                                                                        | Documents why legacy services must remain                                                    |
| `docs/architecture/v1-pipeline.md`                              | Establish ownership, boundaries, lifecycle, evidence, recovery and historical contract                                            | No schema, migration, contract version or writer change                                      |
| `docs/releases/V1_ROADMAP.md`                                   | Describe all seven milestones with gates/dependencies/risks/branches                                                              | Later phases remain unimplemented                                                            |
| `docs/releases/v1-phase-1-validation.md`                        | Record this evidence and limitations for owner review                                                                             | Documentation only                                                                           |
| `.superharness/handoff.md`                                      | Record Phase 1 outcome and next owner action while retaining prior history                                                        | Protocol record only                                                                         |
| `.superharness/ledger.md`                                       | Append task evidence without editing previous entries                                                                             | Protocol record only                                                                         |

## Manual acceptance and remaining risks

Before merge, owner review should confirm the changed inspector wording and
recorded-agent canvas on supported desktops. On Windows/WSL and native CachyOS,
open an existing run (including old simulation/Muse data), inspect per-agent
findings/evidence, export JSON/logs, and inspect an existing issue/retest lineage.
Run selected-agent Full/Targeted QA with funded providers, cancel active work,
and reconnect/restart to confirm retained history and settled child processes.
These paid/interactive checks were not performed in this task.

Risk is concentrated in renderer presentation: empty historical graph inputs
now show no agent placeholders, while valid configured runs still show exactly
their selected agents. There is no data migration. Historical issue/retest
services deliberately retain their merge/verification dependencies. The private
plan cannot enforce owner-review policy. The separate uncommitted DeepSeek
provider-error patch is excluded and needs its own reviewed branch.

Phase 2 should address reproduced timeout/error/cancellation/partial-result and
crash-recovery defects with regressions and target acceptance. No later-phase
implementation, tag, version bump, release publication or automatic merge is
authorized by this milestone.
