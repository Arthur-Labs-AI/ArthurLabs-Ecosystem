# Dev-branch hardening validation (Task A)

Date: 2026-10-13. Branch: `fix/v1-update-divergence-preflight` (base: approved `origin/dev`, PR targets `dev`).

## Starting baseline

- Approved `origin/dev`: `6e5ec2252ba2881e775c9ee058d6523b7eca2142` (owner merge of PR #9).
- `origin/main`: `4fd2be9fa3b17370841dbb1d2f0422a2150c62d8` — unmoved throughout this task.
- Post-merge `dev` CI (run 38294840620): `quality`, `launcher (windows, no WSL)`,
  `launcher (linux, no CachyOS)` — all success (verified before implementation).
- Beta tag `v0.1.0-beta.1` untouched. No open PRs at start. Owner checkout left
  untouched (isolated worktree used throughout).
- `.github/workflows/distribution.yml` ("distribution (unsigned review
  candidates)") verified present on `origin/dev`: triggers on pull requests and
  manual dispatch, checks out the exact PR head SHA, builds unsigned
  Windows/Linux review candidates as short-retention private artifacts, never
  publishes a release.

## Finding A — reproduction (before fix)

- New regression tests were written first against unmodified production code,
  using disposable local Git remotes with Desktop stubbed as running:
  - Linux `test-update-channels.sh`: `UPDATECHANNELS-FAIL: diverged stopped
Desktop before refusing`.
  - Linux `test-update-safety.sh`: `UPDATESAFETY-FAIL: diverged stopped Desktop
before refusing`.
- Observed pre-fix order: fetch remote, detect HEAD mismatch, gracefully stop
  Sentry, attempt `git merge --ff-only`, discover divergence, refuse — leaving
  Sentry unnecessarily stopped. The merge itself failed safely; only the
  shutdown ordering was wrong (inherited behavior, not a corruption defect).

## Correction — fast-forward preflight before shutdown

- Linux `sentry_ff_eligibility(repo, ref)` in `scripts/launcher/linux/commands/update.sh`:
  wraps `git merge-base --is-ancestor HEAD <ref>` on the resolved allowlisted
  ref only (`origin/dev` / `origin/main`), printing one word and always
  returning 0: `eligible` (exit 0), `ahead` (ref is an ancestor of HEAD),
  `diverged` (exit 1 both ways), `preflight-failed` (any other git error —
  never mistaken for a clean divergence verdict).
- Windows `Test-SentryFastForwardEligible -RepoRoot -ChannelRef` in
  `scripts/launcher/commands2.ps1`: same semantics via `$LASTEXITCODE`.
- `cmd_update` / `Invoke-SentryUpdate` evaluate the preflight after fetch and
  the already-current early return, and BEFORE any Desktop state inspection:
  `ahead` and `diverged` refuse with manual-reconciliation guidance (no reset,
  no rebase, no destructive repair offered); other failures refuse as a
  preflight error. Refusals state that no shutdown was attempted and no merge
  was performed. The existing `git merge --ff-only` remains the authoritative
  final guard and is unchanged.
- Resulting order: channel, branch gate, dirty gate, fetch, ref validation,
  already-current return, preflight, divergence refusal, graceful maintenance,
  merge, updated-launcher handoff, install/build/deploy, handshake, rollback.

## Regression coverage (all use disposable repos; never the real checkout)

- `test-update-channels.sh` (23 checks, all pass): allowlist mapping, clean
  current on both channels, behind-each-channel fast-forward (asserted SHAs),
  diverged dev/main with Desktop running (no STOP marker, no merge line, HEAD
  and local commit intact), behind+running proceeds (stop then merge then
  advance), ahead (guidance, no stop, no merge, no rewrite), forced
  preflight-failed wiring, helper unit mapping (eligible/ahead/diverged/
  missing-ref/bad-ref via real ancestry), missing-branch origin, dirty main
  refuses before fetch, plus all pre-existing cases unchanged.
- `test-update-safety.sh`: new diverged-with-running case (no shutdown, no
  merge, HEAD intact); dirty/branch/rollback asserts unchanged and passing.
- `launcher-behavior.test.ps1`: helper unit asserts plus a 3c integration
  block with a faked running Desktop and a stop-call counter — diverged
  dev/main refuse with zero stop calls and zero merge calls, eligible
  behind-states stop exactly once then merge and advance, ahead refuses,
  forced preflight-failed refuses, missing-branch and dirty-main refuse
  before fetch. Full file result: BEHAVIOR-OK, zero `^FAIL ` lines.
- `test-desktop-safety.sh` / `shutdown-safety.test.ps1`: git mocks extended
  with a `merge-base --is-ancestor` success case (behind-state scenario), all
  prior assertions intact; both suites pass, including stop-failure-blocks
  coverage after an eligible preflight.

## Before/after evidence

- Before: diverged + running Desktop -> STOP attempted, merge attempted and
  failed, Desktop left stopped (test failures quoted above).
- After: diverged + running Desktop -> exit 1, `No Desktop shutdown was
attempted and no merge was performed`, HEAD and local commits byte-identical,
  Desktop left running (asserted via stop-call counters/markers on both
  platforms). Behind + running -> stop, merge, advance (ordering preserved).

## Documentation corrections (Finding B)

- `docs/development/branching.md`: transition section now states integration
  via owner-merged PR #9 (`6e5ec22`); `main` described as the frozen pre-v1
  baseline (not a stable v1 release); creation record (`4fd2be9`) preserved.
- `docs/development/dev-branch-transition.md`: CI section updated with the
  observed post-merge `dev` workflow (run 38294840620, all green); the false
  "no distribution.yml" statement replaced with an accurate description of
  the unsigned-candidate workflow plus a dated correction note. The original
  branch-creation SHA and procedure are unaltered.
- `docs/releases/V1_ROADMAP.md`: transition callout updated from pending to
  integrated. README required no change (no contradictory statements found).
- Branch protection is described as procedural/manual only; no
  server-enforced claim is made (plan capability unverified).

## Compatibility assessment

- Pinned beta tags: detached checkouts still refuse with zero mutations.
- Packaged archives: still refuse Git tracking (covered by existing
  non-git/archive refusal paths; distribution workflow semantics unchanged).
- `main` channel: clean-main current/advance behavior unchanged apart from the
  added preflight; existing `main` checkouts are not redirected.
- `dev` channel: same, plus the new divergence/ahead guidance.
- Staged deployment, handshake validation, previous-runtime rollback, and
  database/credential preservation are untouched (no production changes beyond
  the preflight gate).

## Standard gates (this worktree, Task A head)

- `pnpm install --frozen-lockfile`: PASS. `pnpm repository:check`: PASS.
  `pnpm format:check`: PASS. `pnpm lint`: PASS (20/20). `pnpm typecheck`:
  PASS (37/37). `pnpm build`: PASS (20/20). `pnpm distribution:test`: PASS.
- `pnpm test` (default concurrent suite, Windows host): FAIL — confined to the
  untouched `@qa/run-engine` package: 6 verification-trust failures, each
  `sandbox unavailable: systemd user tools unavailable` plus Windows EBUSY
  fixture cleanup (no systemd on Windows), and 1 timing-sensitive failure
  (`kills on event silence but lets steady output earn more time`). Focused
  rerun of `tests/run-engine.test.ts` + `tests/parallel-execution.test.ts`:
  21/21 PASS. No failure touches launcher, docs, or workflow code changed here
  (the diff contains no `packages/` or `apps/` edits). This matches the
  approved-baseline behavior for concurrent Windows runs.
- `launcher-behavior.test.ps1`: PASS (BEHAVIOR-OK, zero `^FAIL ` lines,
  including 40+ new preflight asserts). `test-update-channels.sh`: PASS
  (23/23). `test-update-safety.sh`: PASS. `test-desktop-safety.sh`: PASS.
  `shutdown-safety.test.ps1`: PASS. `launcher-smoke.ps1`: PASS.
  `launcher-logic.test.mjs`: PASS (20/20). `io-stress.test.ps1`: PASS.
- Linux shell matrix: all PASS except `test-desktop-startup.sh`, which fails
  on Windows git-bash with `setsid is unavailable` before any Electron
  attempt; both `open.sh` and that test are byte-identical to `origin/dev`,
  so the failure predates Task A. Ubuntu CI adjudicates.
- PowerShell parser check on all launcher scripts: PASS. `bash -n` on all
  Linux launcher scripts and tests: PASS.

## Remaining known limitations

- `test-desktop-startup.sh` fails on Windows git-bash hosts with
  "setsid is unavailable" before any Electron attempt (`open.sh` and the
  test are byte-identical to `origin/dev`, so this predates Task A). Ubuntu CI
  adjudicates; not claimed locally.
- Full concurrent `pnpm test` on Windows remains subject to the known
  timing-sensitive flakes in untouched packages; concurrent and serial outcomes
  are reported separately in the gate table.
- Paid-provider, clean-VM, and native CachyOS acceptance remain
  `OWNER ACCEPTANCE REQUIRED` / `ENVIRONMENT UNAVAILABLE` and are out of scope
  for this hardening task.

## Implementation commits

- `fix(launcher): preflight source update ancestry before shutdown` (production).
- `test(launcher): preserve active Desktop on diverged channel` (regressions).
- `docs(v1): finalize dev-branch transition record` (this document plus Finding B).
  Exact SHAs are listed in the PR description (this file is committed with them).
