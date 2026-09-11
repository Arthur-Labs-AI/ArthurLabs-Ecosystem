# Handoff — Phase 3 Muse execution foundation

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
