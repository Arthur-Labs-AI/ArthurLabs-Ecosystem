# Independent agent depth — implementation receipt

Implemented on `codex/independent-agent-depth`, based on dev `f47f527`.

The three isolated copies/sessions remain independent. Production runs now use a
coordinator-owned preparation receipt, a versioned deadline policy, one
same-session challenge pass, exact planned-check coverage validation and separate
UI proof/coverage labels. No new service, SQLite migration, peer reviewer or
automatic paid retry was introduced. Preparation supports explicitly pinned pnpm
projects with a configured offline cache; missing preparation capabilities remain
visible limitations. See [operation and configuration](../development/independent-qa.md).

Source selection excludes incremental compiler caches for new imports without
changing frozen v2 hash rules. Old caches are removed only in disposable copies.
Failed installs recreate only their private copy. Cancellation before model launch
is covered, and adapter disposal/diagnostics failures no longer skip cleanup.

## Verification results

| Gate                                                   | Result     | Executed evidence                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting                                             | PASS       | `pnpm format:check`                                                                                                                                                                                                                |
| Lint                                                   | PASS       | `pnpm lint`, 20 tasks                                                                                                                                                                                                              |
| Types                                                  | PASS       | `pnpm typecheck`, 37 tasks                                                                                                                                                                                                         |
| Runtime/Electron application build                     | PASS       | `pnpm build`, 20 tasks                                                                                                                                                                                                             |
| Repository hygiene                                     | PASS       | `pnpm repository:check`                                                                                                                                                                                                            |
| Non-engine package suites                              | PASS       | `pnpm exec turbo run test --filter=!@qa/run-engine`, 39 tasks including build dependencies; existing opt-in/platform skips remain                                                                                                  |
| Engine suites on Windows without Linux-only trust file | PASS       | `pnpm --filter @qa/run-engine exec vitest run --exclude tests/verification-trust.test.ts --maxWorkers=2 --minWorkers=1`, 87 tests at that point                                                                                    |
| Final preparation/cancel/reset/dispose tests           | PASS       | Focused `workspace-preparation.test.ts` and `closure.test.ts`, 16 tests after the additional cancellation regression                                                                                                               |
| Three adapter phase paths                              | PASS       | Three tests per adapter: legacy, depth enabled, insufficient challenge budget; nine total                                                                                                                                          |
| Depth plan/report contract                             | PASS       | `tests/depth.test.ts`, four tests including unreportable long/duplicate plan names                                                                                                                                                 |
| Existing verifier isolation/trust                      | PASS       | Real Ubuntu WSL checkout, offline-installed dependencies, native build, `verification-trust.test.ts`: eight tests                                                                                                                  |
| New preparation isolation smoke                        | PASS       | Real Ubuntu WSL `test:preparation-sandbox`: two private prepared projects, independently writable workspace dependencies, blocked postinstall, denied peer/original reads and host loopback networking, owned process cancellation |
| Paid same-snapshot model comparison                    | UNVERIFIED | No new provider/model run was started; improved finding precision cannot be claimed from orchestration tests                                                                                                                       |
| Published package install/upgrade smoke                | UNVERIFIED | No release was built/published/installed in this task; the application build above is not that gate                                                                                                                                |

## Failures reproduced and corrected

- Before the added phase, the enabled OpenCode fixture produced three turns
  instead of four. All three adapters now pass the enabled/disabled/budget cases.
- A source-selection regression exposed imported tsbuildinfo. The fix was moved
  to source selection rather than changing v2 hashing, and an actual old revision
  integrity test remains passing.
- Real preparation under Linux HOME initially failed sandbox preflight. The
  existing inaccessible HOME mount masked child binds on WSL. Private tmpfs HOME
  with explicit binds fixes it while real HOME, peers and host networking remain
  inaccessible. The real verifier trust suite and new smoke both pass afterward.
- The final contract review found a 2000-character plan-name / 500-character report
  mismatch. New depth plans are checked before investigation, using the existing
  bounded planning correction; legacy plan schemas are unchanged.
- A malicious local pnpmfile fixture exposed hook discovery during a project-local
  version probe. The probe now runs in the private empty preparation HOME; the
  install keeps explicit hook denial. The real smoke guards both hook and
  lifecycle-script suppression.

## Branch cleanup

Deleted locally and from origin only after `merge-base --is-ancestor` confirmed
their tips were reachable from dev:

- `chore/app-cleanup-and-polish`: `75f5f58`
- `fix/glm-sandbox-result-detection`: `22b58b0`
- `feature/native-linux-support`: `6793a9c`

The owner explicitly revised the request to retain main/dev plus the new working
branch. Local and origin dev were both `f47f527` when verified; no unique commits
were discarded. Temporary Linux verification checkouts were removed after testing.
`shux contract` was unavailable, so task/ledger/handoff receipts were updated directly.

## Follow-up hardening (second pass, same branch)

Prompted by run_01M5Z8X98 (DeepSeek timeout before reporting, generic coverage passes, unprovisioned dependencies). No new services, retries, or model calls.

- Checkpoint report before optional validation; bounded challenge (2 min cap, last 5 min reserved, >=30 s to start); unchanged review skips the second serialization via `{"reportNeedsUpdate":false}` (invalid/prose review requires it).
- `groundCoverage` downgrades `passed` checks without complete executable proof (source-only, partial, piped/masked commands); `coverage` + `operationKeys` added as optional V2 check fields (strict shape otherwise unchanged; no migration).
- Timeout diagnostic names the fired deadline (configured run deadline vs absolute cap).
- Offline pnpm cache auto-discovery from known locations (`dataRoot/cache/pnpm`, XDG store) with `SENTRY_QA_CACHE_SEED` override; only needed package bytes are copied per workspace (multi-GB store mounted read-only, never copied).
- New/expanded regression tests: review-unchanged/review-failure/refinement-failure in all three harness suites, deadline-message test, store discovery test, zod-bytes smoke variant (`SENTRY_SANDBOX_SMOKE_STORE`).

Verification (this session): `git diff --check` clean; prettier check clean on all touched files; full typecheck (37 tasks), lint (20), build (20) pass; evidence-pipeline 73, opencode 125, deepseek 62, claude 102, schemas 118, run-engine 91 (excl. trust file), desktop qa-quality 2 — all pass; real-WSL preparation smoke passes with and without supplied store (zod bytes land as independent copies); verification-trust not re-run here (Windows node_modules lack the Linux rollup native binding; previously passed on real Ubuntu WSL and its code path is unchanged by this session).
