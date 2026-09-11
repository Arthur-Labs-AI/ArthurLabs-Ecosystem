# Handoff — Phase 3 Muse execution foundation

Status: local implementation and required gates pass; push and GitHub Actions verification pending.

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

Next: commit and push Phase 3 to `main`, wait for GitHub Actions `status=completed` and `conclusion=success`, then record the CI result without starting Phase 4.
