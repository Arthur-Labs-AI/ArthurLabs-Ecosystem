# Task status — Sentry v1 Phase 2

2026-10-10: IMPLEMENTED AND LOCALLY VERIFIED; draft PR #3 awaiting final-head
CI and owner review on `codex/v1-runtime-reliability`, isolated `Sentry-v2`
from owner-integrated Phase 1 `d29949b`. Baseline CI 37904000595 PASS
(hosted sandbox trust unavailable). Code commits `942892b` and `6187014` fix
reproduced run/retest identity association, startup cancellation and DeepSeek
turn failures; real subprocess crash/reconnect retains durable output.
WSL full suite: 1,085 passed / 16 skips, 40 tasks, real trust 8/8 PASS.
Windows runtime: 69 passed / 1 skip; Desktop: 260 passed / 2 skips. Required
local checks and shutdown-safety PASS on the applicable hosts. Exact-code CI
37924202481 on 6187014 PASS, all three jobs (hosted trust unavailable).
Final documentation-head CI and review receipts are in
`docs/releases/v1-phase-2-validation.md` and PR #3. Native CachyOS, interactive
and paid-provider candidate acceptance remain UNVERIFIED. No merge/tag/release.
Original dirty checkout and Git identity preserved. `shux contract` unavailable
on PATH; protocol records maintained directly. Phase 3 waits for owner integration.

## Previous task status — Sentry beta preparation

2026-10-09: candidate implemented and locally verified on
`codex/release-v0.1.0-beta.1`, baseline `9c57e3f`.

Candidate code CI: PASS on df6fd49 (push 37891235154, PR 37891284512), all three
jobs. Fresh real runtime deployment: 18/18 uncached builds, activation,
handshake and clean shutdown PASS. Final receipt-only PR checks precede merge.

Validation/owner acceptance: COMPLETE WITH DOCUMENTED LIMITATIONS. On
2026-10-09 the owner confirmed 3/3 on both machines and authorized release.
Prepare the annotated beta tag and draft pre-release after merge CI passes.
Manual candidate cancellation/maintenance scenarios remain independently
unverified and are disclosed in the release notes. GitHub tag/release receipts
are the source of truth for publication status; no installer is produced.
See [validation](../docs/releases/v0.1.0-beta.1-validation.md).
Original dirty main checkout and user-owned Git identity are preserved. `shux contract` unavailable;
protocol records maintained directly in this isolated worktree.
