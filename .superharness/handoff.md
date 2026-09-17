# Handoff — CI verifier sandbox probe (2026-09-17)

Status: local fix and regression tests pass; changes are uncommitted and GitHub Actions is UNVERIFIED until review and a new run on the final SHA.

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
