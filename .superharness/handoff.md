# Handoff — Sentry beta candidate (2026-10-09)

Candidate: `codex/release-v0.1.0-beta.1`, baseline `9c57e3f`.
Implementation/validation complete; distribution BLOCKED pending owner review
and target acceptance. All three CI jobs PASS on df6fd49: push 37891235154,
PR 37891284512. Fresh real runtime deployment with 18/18 uncached builds,
activation, handshake and clean shutdown PASS. Final receipt-only PR checks
precede merge. Full WSL runtime suite 40/40 tasks
(1,036 passed/32 opt-in or platform skips), including six real sandbox trust
cases. Windows Desktop 235 passed/one skip; Windows runtime/CLI and available
run-engine suites pass. Build/lint/typecheck 60/60, hygiene/format pass. Both
launcher fixture suites pass. Actual isolated Windows Electron/WSL boot, bridge,
renderer and idle close passed with all leases released and no matching child.

Shutdown now refuses pending QA/retest, retries transient request-busy stop,
awaits Electron cleanup, and prevents setup/update mutation after failed stop.
No harness orchestration/prompt/report changes. CI named quarantines repaired
and removed. Source/tag beta installs, CachyOS docs and branch review policy
aligned. GitHub protection HTTP 403 on private plan; no server enforcement claim.

Next: inspect draft PR checks, review code, run candidate target acceptance
from docs/releases/v0.1.0-beta.1-validation.md. Only then annotate the immutable
tag and prepare/review a draft pre-release using that report's exact commands.
No installer/tested binary bundle exists. Owner's earlier 3/3 success on both
hosts remains owner-reported. No paid provider acceptance was rerun here.

The original main checkout contains pre-existing DeepSeek/schema/docs changes;
these were excluded and left untouched. Git identity read and preserved.
`shux contract` was unavailable; status/ledger/handoff maintained directly.

## Prior handoff — Electron ZIP extraction on Node 26 (2026-10-06)

Task status: implemented and locally verified; CachyOS acceptance unverified.
This handoff accompanies the Electron extraction fix commit on `main`
(baseline `242b170`). The user authorized commit and push to `origin/main`
on 2026-10-06. The pre-existing untracked `PROJECT_GUIDE.md` was left untouched.

The locked chain was Electron 36.2.1 → extract-zip 2.0.1 → yauzl 2.10.0.
Node 26.1 reproduced a CommonJS extraction exiting 0 with neither promise
handler called. The compressed fixture failed its completion assertion;
the stored fixture passed. This matches upstream Electron #51619 and
extract-zip #154, caused by fd-slicer's obsolete stream destruction behavior.
The fix is a scoped root pnpm override `extract-zip@2.0.1>yauzl: 3.4.0`,
plus the generated lockfile. Electron remains 36.2.1.

Verification:

- New desktop unit regression: two-entry ZIP with a 256 KiB first entry,
  stored and deflated variants; checks explicit promise completion and both
  extracted contents, not just exit status. Node 26.1: RED before override,
  GREEN after (2/2). Test runs in the existing desktop Vitest suite.
- Actual unchanged Electron installer in an isolated temporary fixture,
  Node 26.1 on Windows, targeting linux-x64: checksum-verified ZIP downloaded,
  path.txt=`electron`, version=`36.2.1`, 74 files / 292,234,813 bytes,
  binary 196,980,512 bytes, locales and resources present. ZIP SHA256:
  `6ede19133495925c6fd39dcc161d255372a1cd0d2dc8c131929233584498be35`.
- Desktop suite: 37 files, 229 passed / 1 existing platform skip.
- Desktop lint/typecheck passed; launcher decision tests 20/20 passed.
- `pnpm build`: 20/20 passed (19 cached).
- Frozen lockfile install, repository hygiene, changed-file formatting,
  and `git diff --check` passed.

Next: pull the Electron fix from `origin/main` on the CachyOS checkout, run
`pnpm install --frozen-lockfile` at the root, then
`pnpm --filter @qa/desktop rebuild electron`. Verify path.txt, dist/version,
binary executable permission, and `pnpm --filter @qa/desktop exec electron
--version` returns v36.2.1. The existing cached ZIP can be reused. CachyOS
launch and GitHub CI were not executed here. WSL was unavailable on this host.
`shux contract` was attempted before work but the command was unavailable;
protocol records were updated directly without modifying controller-owned state.

Sources: https://github.com/electron/electron/issues/51619,
https://github.com/max-mapper/extract-zip/issues/154,
https://github.com/thejoshwolfe/yauzl/pull/170.

---

# Previous handoff — Phase 7 DETERMINISTICALLY CLOSED (2026-09-18)

Phase 7 — DETERMINISTICALLY CLOSED

Final SHA: `e63a8d92a591ab2d81c00026895506d21bf42542`
Exact-head CI: run `35389490104` (status completed, conclusion success) —
repository:check, format:check, lint, typecheck, degraded-lane tests
(sandbox trust unverified on the hosted runner, exit 226), build all green.
Previous exact-head CIs: `35387679322` (success) on `5d6e961`, `35387225215`
on `ae3af24`, `35350824372`/`35351420106` on `9b60bb5`/`733ebc6`.

Core contracts frozen (QARun full|targeted, RetestRun+RetestSpec v2,
control requests, issues/occurrences/events, merge/verification lineage).

Deferred (provider budgets unavailable — not failed, not passed):

- paid FULL 3/3
- paid TARGETED 3/3
- paid update→RETEST

Reason: provider budgets unavailable (explicit user decision; see
docs/architecture/deferred-gates.md).

Next: Phase 8 — Desktop UI (UNLOCKED).

---

# Previous handoff — DeepSeek tool-result lifecycle (2026-09-18)

Status: local fix verified, uncommitted on `main`; fresh paid DeepSeek validation and exact-head CI are UNVERIFIED.

Baseline: `39afa814a1a930636d94b45d833ffd621e24915e`. The reported run `run_01M2SEPZ6TF06EDEQ8S4VSG5MM` persisted 94 `tool.started` events but only 90 matching `tool.completed` events. Each of the four unmatched `bash` starts was immediately followed by `DEEPSEEK_SANDBOX_MENTION`: the adapter emitted that warning and returned before processing the same `tool/result`. Its terminal event then correctly failed protocol validation. The adapter now preserves the warning and also processes the result, without fabricating an exit code or changing the validator.

Regression: new fake-session test failed before the fix with `Terminal event cannot leave tool operations open`, then passed after the fix; the DeepSeek package passed 32/32 and the full repository `pnpm test` passed 34/34 Turbo tasks. Repository hygiene, format, lint (17/17), typecheck (33/33), and build (17/17) passed locally. No paid agent run was started. The user was advised to rotate the credential exposed in chat; do not copy it into any file or report.

Next: review/commit/push the patch under the main-branch review rule, confirm exact-head CI, then run a new DeepSeek smoke with a rotated key. Do not reuse the exposed credential. The old failed run is historical and is not rewritten.

---

# Historical handoff — Phase 7 Stable Core / Private Beta, IN PROGRESS (2026-09-17)

## Phase 6 CLOSED (recorded at Phase 7 start)

Phase 6 closed at final SHA `b425d2496dbcbebb308e50c34c0f74fed48a130b` with
GitHub Actions run `35209431594` (status completed, conclusion success).
The stale conditional-closure header below is superseded; its detail is
retained for history.

## Phase 7 status (final: 3f5d279 pushed; exact-head CI green)

Final SHA `3f5d279db5728327a292702e1b357929fc53d505`, CI run
`35246872308` (status completed, conclusion success, updated
2026-09-17T16:33:07Z). Working tree clean. Paid-agent live runs remain
the single UNVERIFIED gate (no provider models/keys on this machine);
everything else on the §128 checklist is evidenced below.

## Phase 7 status (commit bb192b3 pushed; CI in progress) [SUPERSEDED]

Foundation + retest/ingest/hygiene/doctors/exports slices are implemented
and locally verified, committed as `bb192b3` ("Phase 7: targeted runs,
retest, and issue lineage") and pushed to `main`; CI run `35242396645`
on the exact HEAD completed with conclusion `success` (headSha
`bb192b30db842b009c7f429852065ca247a0bd5d`, updated 2026-09-17T15:50:15Z).
Working tree now carries only this handoff file (modified, uncommitted)
plus the recorded append-only ledger entry committed in `bb192b3`.

## Live proof completed 2026-09-17 (unpaid, fresh data root)

Small fixture project via built CLI: add → simulate 3/3 → merge
(3 clusters) → `issue ingest` (3 open issues, idempotent) → `issue
list/show` → `project revisions` (run linkage) → `project doctor`
(ready, sandboxAvailable true) → `doctor storage/config` (found real
pre-existing `/var/tmp/sentry-verify-*` orphans, correctly reported as
unreferenced) → `run export` (lineage sections: 3 issues/occurrences/
events) → restart re-read (history intact) → secret scan clean → no
stray agent processes. Paid-agent runs, large-repo smoke/soak, and the
friend-readiness test remain open (see below). Still
required before any completion statement: paid FULL/TARGETED/retest live
validation (§§99–101), large-repo smoke + soak (§§97–98, §103),
restart/cleanup/process/secret live proof (§125), friend-readiness test
(§§126–127), and exact-head CI success on the final SHA (§124).
Frozen AgentStacks, Merger v2, and Verifier v3 remain untouched (zero diff
`b425d24..bb192b3` in harness-muse/deepseek/claude-code, merger,
verifier); no Phase 8 UI and no Phase 9 installer work has started.

---

# Previous handoff — Phase 6 final closure, CONDITIONAL (2026-09-17)

Status: Phase 6.1.1 implementation reviewed. Production validation is CONDITIONAL: all non-paid gates pass, Merger v2 + Verifier v3 validated on the reference 3/3 run, one real correctness fix applied with regression test; the fresh paid FULL 3/3 run is PENDING (user deferred live runs to manual testing). Exact-head CI is UNVERIFIED for the new fix commit until review, push, and a new Actions run on the final SHA.

Baseline: `e91f0e05368ad0166ccda7289f0af975e82ce6a7` (clean tree at validation start; exact-head CI `35193512641` completed/success covers this SHA). Working tree now carries the §40 fix (2 files, uncommitted): `packages/run-engine/src/verification-service.ts` + `packages/run-engine/tests/verification-service.test.ts`.

Phase 6 closure validation (this session):

- Local gates on final tree (Ubuntu WSL): repository:check PASS, format:check PASS, lint 17/17 PASS, typecheck 33/33 PASS, test 34/34 Turbo tasks PASS (run-engine 35/35 incl. 8 trust proofs, verifier 18/18, schemas 106/106, CLI 16/16), build 17/17 PASS.
- Verifier doctor (Ubuntu WSL): sandboxBackend=systemd, sandboxAvailable=true, runtimeReplaySupported=true.
- Paid runs: Muse-only probe `run_01M2Q58QXH6B37G4NNSXNNXNNP` completed 1/1 (2 findings). FULL attempt `run_01M2Q5G6J95H3QAB30H7V5VTQ9` partial 2/3 — Muse + DeepSeek completed, GLM failed `GLM_INVALID_RESULT` (model cited nonexistent `vitest.config.ts`; trust pipeline correctly rejected, no Sentry regression; tree clean at baseline). User then deferred all further live runs to manual testing; the retry job was killed. Fresh FULL 3/3 remains PENDING.
- Reference 3/3 run `run_01M2MJ71E3VK8ZDTT20ABJ6R06` (9 findings, 22 evidence): merge reuses `merge_A6DM6D4MQ0PK1021CE0N7PG9VA` (mergerVersion=2, usableAgents=3, unavailable=[], 3 clusters: all_available_sources/multi_source/single_source; manual inspection found no false merge).
- Verifier v3 on that merge: `vrun_01M2Q6RJJWT7TC0M8BWW0B2TKA` completed 3 attempts, 3 inconclusive (retained material for the Sept-13 revision aged out; fail-closed refusal, honest). Repeat after fix: `vrun_01M2Q7FSDZNXR17ZQSW8JGNJ95` completed, same outcomes, all 21 steps terminal.
- Real bug fixed per §3/§40: drift-refusal path left recipe steps `queued` after completed attempts; now terminalize as completed/unsupported (outcome unchanged: inconclusive). Regression test RED→GREEN; targeted suites green; full gates green on final tree.
- Integrity: managed working-copy hashes identical pre/post live runs; QA workspaces cleaned; no stray agent processes; verifier workspaces + staging cleaned for completed attempts (93 `/var/tmp/sentry-verify-*` orphans predate this session, Sept 16, no DB rows — environmental litter, not validation fallout); secret scan of persisted verification output clean; sig3 mechanism confirmed (`sig3:` prefix, trust suite proves strong-identity replay).
- Export of the reference run is additive (mergeResults, findingClusters, verificationRuns incl. the new vrun, attempts, assertions).
- Frozen dirs zero diff vs baseline: harness-muse/deepseek/claude-code, merger. Versions preserved: MERGER_VERSION=2, NORMALIZER_VERSION=1, VERIFIER_VERSION=3, RECIPE=3, SIGNATURE=3.

Update 13:30Z — FRESH FULL 3/3 COMPLETE: user re-ran after the contract fix and `run_01M2Q9J43SH3XBPJHZ1MFG6X36` completed 3/3 (Muse 3 turns; DeepSeek 7079/23975 tokens 4 turns; GLM 39590/28089 tokens 4 turns — the `symbol` fix held on first attempt; 8 findings, 19 evidence; snapshot `snap_01M2Q9J45JTBW10DH6YRJDTMJ0`). Merge `merge_KDS6MZFP7VREMB9HN45MTCBHKF` (v2, usableAgents=3, unavailable=[], 2 clusters; manual inspection: cluster 1 all_available_sources bridges divide-bug + red-suite/toolchain findings via shared tests/math.test.ts locations, cluster 2 multi_source pure-divide — no false merge, merger untouched). Verifier `vrun_01M2QAS1V1HHR8YMS8W66BJX23` completed 2/2 inconclusive (v3/v3/v3, sandbox systemd available, fail-closed retention refusal; all 18 steps terminal — fix verified live). Export additive incl. the new vrun; working-copy hashes unchanged; workspaces/staging cleaned; no stray processes; secret scan 0 hits. Final gates on the fix tree: hygiene/format/lint 17/17/typecheck 33/33/test 34/34/build 17/17 ALL GREEN. Remaining: review + commit the 4-file fix set, push, record the new exact-head Actions run, then declare Phase 6 closed. Do NOT claim GitHub CI green for the fix SHA until that run completes. Do not start Phase 7 automatically.

---

# Previous handoff — CI verifier sandbox probe (2026-09-17)

Prior status (superseded by the conditional-closure section above): local fix and regression tests pass; changes are uncommitted and GitHub Actions is UNVERIFIED until review and a new run on the final SHA.

Baseline: `327804d395a4434a966febdc7d103e2721e97d7c` (`main` / `origin/main` at investigation start).

The reported Actions failure is `@qa/run-engine` verifier trust fixtures: sandbox preflight binds the data root under `/home/runner`, where `ProtectHome=yes` makes the work directory invisible (`226/NAMESPACE`). The real replay stages under `/var/tmp`. `verifyMerge` now preflights that same staging parent. A regression test first failed with the old data-root argument, then passed after the change. The temporary CI mount probe now reports the actual `systemd-run` exit status rather than the status of `tail`, and checks a `/var/tmp` bind with replay-equivalent sandbox properties.

Local WSL validation: run-engine 35/35, CLI 16/16, full `pnpm test` 34/34 Turbo tasks. Two multi-subprocess CLI tests needed measured test-only budgets on this `/mnt/c` checkout (64s and 42s in isolation); no production timeout was changed. Repository, format, lint, typecheck, and build gate results are recorded in the latest ledger entry. Do not claim GitHub CI green until the final reviewed SHA has a successful Actions run. No paid agent runs were made.

Next: review this diff, commit/push under the repository's main-branch review rule, inspect the new Actions `staged_exit` and `pnpm test` results, and investigate any remaining runner-specific sandbox restriction without weakening the trust tests or adding a host fallback.

---

# Historical handoff — Phase 3 Muse execution foundation

Status: Phase 3 complete. Implementation is pushed to `main`, local gates pass,
and GitHub Actions completed successfully.

Baseline: `a2f3f7a3b79cf40d246a9ed1390ed202622ba281`

Implemented:

- generic `HarnessAdapterRegistry` and one `RunCoordinator` for simulation and production;
- `@qa/harness-muse` with `@muse-code/sdk@0.1.1`, binary/model preflight, one-session two-stage planning/execution, streamed observable events, Sentry-owned IDs, evidence/path validation, redaction, and bounded shutdown;
- real `qa run start ... --agents muse --wait`, agent list/doctor, strict JSON results, runtime identity, real exports, and stable exit semantics;
- disposal-before-workspace-cleanup and original/managed-copy isolation regressions;
- Phase 3 ADR, architecture, setup, and README updates.

Verification:

- `pnpm repository:check`: pass
- `pnpm format:check`: pass
- `pnpm lint`: pass
- `pnpm typecheck`: pass
- `pnpm test`: 32 files passed, 1 live-smoke file skipped; 223 tests passed, 0 failed, 1 skipped
- `pnpm build`: pass
- built CLI: `qa 0.3.0`
- live Muse smoke: NOT RUN — `SENTRY_MUSE_MODEL` is unset and `muse` is not discoverable
- implementation commit: `97a53c8bfb925459413194634bb37f03e7cedb6a`
- GitHub Actions: run `34611636854`, `status=completed`, `conclusion=success`

Next: do not start Phase 4 automatically. A live Muse smoke remains available
only when a user explicitly provides a configured host/model/auth environment
and opts in with `SENTRY_LIVE_MUSE_TEST=1`.
