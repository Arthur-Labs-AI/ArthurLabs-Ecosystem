# Task status — Phase 3 bounded Desktop usability improvements (2026-10-10)

IMPLEMENTED AND LOCALLY VERIFIED; feature PR/exact-head CI and owner review pending.
Approved baseline 9da3cbeb0cb3c5b1f95015c59f385e3b3f51c295, owner-merged PR #3;
merge CI 38040773408 PASS. Isolated codex/v1-desktop-improvements / Sentry-v3.
Owner dirty main9c57e3f and separate DeepSeek/schema/protocol work preserved.
Initial Desktop baseline 260 PASS / 2 skips; new regressions 23 RED / 6 guards PASS.
Renderer-only fixes: canonical rereads for unordered hints and observed reconnect;
cached run/retest reports retained on refresh errors; truthful selected agents,
observed stages, unknown usage and terminal partial/empty reports. No auto execution.
39 added cases; Windows Desktop299 PASS / 2 platform skips, WSL Desktop300 / 1 skip.
Frozen install, hygiene, format, lint20, typecheck37 and build20 PASS on both hosts.
Full WSL pnpm test40 tasks, 1,132 PASS / 16 skips; real sandbox trust8/8 PASS.
First full run had an existing engine test5s timeout; unchanged rerun passed,
then final renderer snapshot passed again. No assertions/deadlines relaxed.
Real Windows Electron smoke PASS with WSL handshake; seven rendered fixture images
cover loading, agents, finding, offline, partial, empty and compact layout. These
are not funded-provider/native CachyOS acceptance. Launcher Windows fixture checks PASS.
See docs/releases/v1-phase-3-validation.md and roadmap for scoped review and limits.
Owner review required after exact-head CI (PR is source of truth for final SHA/jobs).
Phase 3 is not closed: evidence jumps/provenance UI, broader history/accessibility,
dead-process reconnect and fresh target/live-provider acceptance remain follow-up.
No Phase 4, main push/merge, tag, version bump, release or paid calls. Git identity
preserved. shux contract unavailable; protocol records maintained directly.

## Previous record

# Task status — Phase 2 final cancellation correction

2026-10-10: IMPLEMENTED AND LOCALLY VERIFIED; owner review pending on existing
codex/v1-runtime-reliability / draft PR #3, reviewed baseline 8ed311b.
Confirmed cancelled AgentRun/parent versus failed activity with clean stream
close; also confirmed late cancellation overwrote a completed worker.
Four regressions RED / four guards PASS before fix; all eight GREEN afterward.
Only production file: run-engine coordinator. Validator/projector contracts,
Phase 2 identity/startup/DeepSeek/recovery fixes and historical data preserved.
WSL full suite 1,093 passed / 16 skips, 40 tasks, real trust 8/8 PASS.
Windows focused engine 47 PASS, protocol 25 PASS, runtime 69 PASS / 1 skip;
Desktop 260 PASS / 2 skips; formatting PASS. Exact corrected-head CI status
source of truth is PR #3; successful CI precedes integration.
Frozen install/hygiene/lint/typecheck/build PASS on Windows and WSL.
Owner review is required after corrected-head CI; no Phase 3, merge/tag/release
or paid calls. Original dirty main and Git identity preserved. shux unavailable;
protocol records maintained directly. Final CI receipt belongs to PR #3.

## Previous task status — Phase 2 initial candidate

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
