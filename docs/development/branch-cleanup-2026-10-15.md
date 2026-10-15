# Branch cleanup receipt — October 15, 2026

Owner-authorized repository maintenance for `Mert1026/Sentry`. Branch operations
are complete. This additive documentation commit records the operations and
updates naming policy; release preparation is retained, not published.

## A. Starting state

- Remote main: `4fd2be9fa3b17370841dbb1d2f0422a2150c62d8`.
- Remote dev: `c6d4769bf3179d49bb3718074d6c083f52332626`.
- Active Phase 6.3 preparation: `fca2d0b04120d9fd6195ba42f342a8685ca02386` (one ahead of dev, zero behind).
- Open PRs: **0**, rechecked before deletion.
- Default branch: `main`; no Windows release or native feature branch existed.
- GitHub branch metadata reported `protected: false` for all 14 refs. Detailed
  protection/ruleset endpoints returned HTTP 403 (private repository plan); no
  settings changed. Main/dev and published tags were explicitly preserved.
- Primary local checkout remained on its pre-existing main commit
  `9c57e3f78164c45c35316ae7bf2fe45fa4b0f132` with its owner changes untouched.

### Full initial remote inventory

| Branch                                   | Full SHA                                   |
| ---------------------------------------- | ------------------------------------------ |
| `codex/sentry-local-fixes`               | `982048d29977842c83e5d1acd84da7c9f28b93d1` |
| `codex/v1-phase-6-3-windows-freeze`      | `fca2d0b04120d9fd6195ba42f342a8685ca02386` |
| `dev`                                    | `c6d4769bf3179d49bb3718074d6c083f52332626` |
| `fix/v1-g10-recovery-acceptance`         | `9170f06c3f6adf039ac2f677b0be2071960750a6` |
| `fix/v1-post-merge-acceptance`           | `255af881c6f32a87bf0aeca094172dc1a06fe1b6` |
| `fix/v1-pre-rc-acceptance-preparation`   | `42c484874e74e9544bdd1c035e5bfd02b0e27237` |
| `fix/v1-provider-credential-persistence` | `8ab68f9010e0a6bdc1c78aa0d4699cf96c2dc8ec` |
| `fix/v1-windows-bootstrap-mode`          | `be7708e131ee28309c11e2ac3bf24a16609f436d` |
| `main`                                   | `4fd2be9fa3b17370841dbb1d2f0422a2150c62d8` |
| `release-prep/v1-rc1-cut-verification`   | `7dd7e06babaf17c6e06ee8f674f05c7c12dcbd44` |
| `release-prep/v1-windows-only-scope`     | `16b47d83da58fc8091df94131be64891a0b467a0` |
| `release-prep/v1.0.0-rc.1`               | `ef6ce35cf0eac9c3bdb0fafc8693f78b125ddfad` |
| `test/v1-final-host-acceptance`          | `9f690bc9a130615e252dbc0b79f0a7500ece9b5b` |
| `test/v1-owner-acceptance-evidence`      | `de4f40b8e2f1c36d53685a4168694aff210b05f4` |

### Active local worktrees

| Path                                                                     | Branch / state                        | Starting HEAD                              |
| ------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------ |
| `C:/Users/merte/Documents/GitHub/Sentry`                                 | `main`                                | `9c57e3f78164c45c35316ae7bf2fe45fa4b0f132` |
| `C:/Users/merte/.codex/artifacts/sentry-ci-fix-20261015/checkout`        | `codex/v1-phase-6-3-windows-freeze`   | `fca2d0b04120d9fd6195ba42f342a8685ca02386` |
| `C:/Users/merte/.codex/worktrees/sentry-beta-release/Sentry`             | `codex/release-v0.1.0-beta.1`         | `07cbecc09f25783fda9a41a0d19267efa9a05868` |
| `C:/Users/merte/.codex/worktrees/v1-credential-status-diagnostic/Sentry` | `fix/v1-credential-status-diagnostic` | `516bc35f938659543384dde30e57f2619ca51243` |
| `C:/Users/merte/.codex/worktrees/v1-phase-4-release-hardening/Sentry`    | `fix/v1-phase-4-release-hardening`    | `979521b6146411e44d1cfe613413871d1c3db522` |
| `C:/Users/merte/.codex/worktrees/v1-phase4-beta-acceptance/Sentry`       | `detached`                            | `0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38` |
| `C:/Users/merte/.codex/worktrees/v1-release-packaging/Sentry`            | `codex/v1-release-packaging`          | `b9e1f0b5b8f53ac6a8e066ead613c5a4f993c3a9` |

All seven existing worktrees and all 17 registrations were retained. Ten
registrations already referenced missing directories; no metadata was pruned.
Only the task-owned preparation worktree received a branch/upstream rename and
the subsequent documentation commit. Other worktrees were not switched or edited.

## B. Renamed branches

| Original branch                     | New branch                                 | Original SHA                               | SHA verified at rename                     | Verified                                                                                     |
| ----------------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `codex/v1-phase-6-3-windows-freeze` | `release-prep/v1-phase-6-3-windows-freeze` | `fca2d0b04120d9fd6195ba42f342a8685ca02386` | `fca2d0b04120d9fd6195ba42f342a8685ca02386` | PASS: identical commit and tree, fetched replacement, GitHub access, local checkout/upstream |

Verified tree: `30674e2f5a50ad4b4c19614f92ddfaea58608321`. The replacement remote existed and
was verified before the old remote name was deleted. The final preparation tip
is the additive documentation commit containing this receipt, with the original
commit retained as its parent; its full SHA is recorded in the final owner report
and private `final-verification.json`. No history was rewritten.

## C. Deleted branches

| Deleted branch                           | Last full SHA                              | Associated merged PR                              | Ahead of dev | Verification                                                                              |
| ---------------------------------------- | ------------------------------------------ | ------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `codex/sentry-local-fixes`               | `982048d29977842c83e5d1acd84da7c9f28b93d1` | [#25](https://github.com/Mert1026/Sentry/pull/25) | 0            | PASS: tip and merge reachable from dev; no active worktree, dependency or protection flag |
| `fix/v1-g10-recovery-acceptance`         | `9170f06c3f6adf039ac2f677b0be2071960750a6` | [#19](https://github.com/Mert1026/Sentry/pull/19) | 0            | PASS: tip and merge reachable from dev; no active worktree, dependency or protection flag |
| `fix/v1-post-merge-acceptance`           | `255af881c6f32a87bf0aeca094172dc1a06fe1b6` | [#18](https://github.com/Mert1026/Sentry/pull/18) | 0            | PASS: tip and merge reachable from dev; no active worktree, dependency or protection flag |
| `fix/v1-pre-rc-acceptance-preparation`   | `42c484874e74e9544bdd1c035e5bfd02b0e27237` | [#14](https://github.com/Mert1026/Sentry/pull/14) | 0            | PASS: tip and merge reachable from dev; no active worktree, dependency or protection flag |
| `fix/v1-provider-credential-persistence` | `8ab68f9010e0a6bdc1c78aa0d4699cf96c2dc8ec` | [#17](https://github.com/Mert1026/Sentry/pull/17) | 0            | PASS: tip and merge reachable from dev; no active worktree, dependency or protection flag |
| `fix/v1-windows-bootstrap-mode`          | `be7708e131ee28309c11e2ac3bf24a16609f436d` | [#24](https://github.com/Mert1026/Sentry/pull/24) | 0            | PASS: tip and merge reachable from dev; no active worktree, dependency or protection flag |
| `release-prep/v1-rc1-cut-verification`   | `7dd7e06babaf17c6e06ee8f674f05c7c12dcbd44` | [#22](https://github.com/Mert1026/Sentry/pull/22) | 0            | PASS: tip and merge reachable from dev; no active worktree, dependency or protection flag |
| `release-prep/v1-windows-only-scope`     | `16b47d83da58fc8091df94131be64891a0b467a0` | [#23](https://github.com/Mert1026/Sentry/pull/23) | 0            | PASS: tip and merge reachable from dev; no active worktree, dependency or protection flag |
| `release-prep/v1.0.0-rc.1`               | `ef6ce35cf0eac9c3bdb0fafc8693f78b125ddfad` | [#21](https://github.com/Mert1026/Sentry/pull/21) | 0            | PASS: tip and merge reachable from dev; no active worktree, dependency or protection flag |
| `test/v1-final-host-acceptance`          | `9f690bc9a130615e252dbc0b79f0a7500ece9b5b` | [#20](https://github.com/Mert1026/Sentry/pull/20) | 0            | PASS: tip and merge reachable from dev; no active worktree, dependency or protection flag |
| `test/v1-owner-acceptance-evidence`      | `de4f40b8e2f1c36d53685a4168694aff210b05f4` | [#16](https://github.com/Mert1026/Sentry/pull/16) | 0            | PASS: tip and merge reachable from dev; no active worktree, dependency or protection flag |

All 11 candidates were freshly checked against unchanged remote tips, merged PR
records, current ancestry/ahead counts, worktree paths, branch protection flags
and exact-name script/workflow references in main/dev/preparation. Live workflow
queries for in-progress, queued, waiting, requested and pending runs found no
candidate dependency. The old preparation remote name and these 11 refs were
removed by one ordinary atomic remote deletion. No force push was used.
Three candidates had only stale registrations for missing folders; their local
branches and registrations were retained. Historical PRs and commits remain.

## D. Retained branches

- `main`: unchanged default/stable integration reference.
- `dev`: unchanged reviewed development integration baseline.
- `release-prep/v1-phase-6-3-windows-freeze`: active unmerged Phase 6.3 preparation and naming/cleanup documentation.
- All other local branches were retained, including historical `codex/` refs
  owned by other worktrees and local counterparts of deleted remote branches.
  Internal Codex refs were untouched. Remote cleanup does not authorize local
  history or worktree cleanup. Full local inventory follows.

| Retained local branch                      | SHA immediately after remote cleanup       |
| ------------------------------------------ | ------------------------------------------ |
| `chore/v1-dev-branch-transition`           | `ee3ce646ff53182d499afb298de6de9ab0dcb847` |
| `codex/deepseek-shell-evidence`            | `be3431f64c00d84723b5c8957dc5d992a26ecce5` |
| `codex/project-removal`                    | `10062e6277510a42f21bec3ad8b0b38ba4908f8e` |
| `codex/release-v0.1.0-beta.1`              | `07cbecc09f25783fda9a41a0d19267efa9a05868` |
| `codex/sentry-local-fixes`                 | `0eab97310f0c3ad2be05623d839a49e5a9683774` |
| `codex/v1-desktop-improvements`            | `d6fe709d4f23d93a5c4d206ca29b1ffd884fa12a` |
| `codex/v1-phase-1-cleanup`                 | `e44528b3228245280bd1672e5ca6a17f03916417` |
| `codex/v1-release-packaging`               | `b9e1f0b5b8f53ac6a8e066ead613c5a4f993c3a9` |
| `codex/v1-runtime-reliability`             | `384961460023a5bf82fc09d83f1e91d1033f5dc7` |
| `codex/v1-security-testing`                | `a0b8d760cc5ea844176bd3dd120c9551260438fc` |
| `codex/windows-launcher-ci`                | `982048d29977842c83e5d1acd84da7c9f28b93d1` |
| `codex/wsl-space-reclamation`              | `d86a401091dd361a63f384ce5094e917ab15ca8f` |
| `dev`                                      | `c1d2d58a8ce4c12cb1199950f7611ad6360f8203` |
| `fix/v1-credential-status-diagnostic`      | `516bc35f938659543384dde30e57f2619ca51243` |
| `fix/v1-desktop-status-truth`              | `3dfb6319d11472ce995cf84cfce398d9c2eeb370` |
| `fix/v1-error-boundary-final-hardening`    | `100e14e8d6eb56dd1f03083fcb36241b5bafb1d3` |
| `fix/v1-error-redaction-hardening`         | `ee4c8ff7b8353dc1d06538a23fb5bf90ef78c00b` |
| `fix/v1-g10-recovery-acceptance`           | `9170f06c3f6adf039ac2f677b0be2071960750a6` |
| `fix/v1-phase-4-release-hardening`         | `979521b6146411e44d1cfe613413871d1c3db522` |
| `fix/v1-post-merge-acceptance`             | `255af881c6f32a87bf0aeca094172dc1a06fe1b6` |
| `fix/v1-pre-rc-acceptance-preparation`     | `42c484874e74e9544bdd1c035e5bfd02b0e27237` |
| `fix/v1-provider-credential-persistence`   | `8ab68f9010e0a6bdc1c78aa0d4699cf96c2dc8ec` |
| `fix/v1-update-divergence-preflight`       | `b73392531745b38b42f0292914d33dd603a1a30d` |
| `fix/v1-windows-bootstrap-mode`            | `90677b54c825536439f420da6cb1513147006edf` |
| `main`                                     | `9c57e3f78164c45c35316ae7bf2fe45fa4b0f132` |
| `phase/phase-1-foundation`                 | `e8dac98f1c3304f35559d81d9173ed7525a712d0` |
| `release-prep/v1-phase-6-3-windows-freeze` | `fca2d0b04120d9fd6195ba42f342a8685ca02386` |
| `release-prep/v1-rc1-cut-verification`     | `7dd7e06babaf17c6e06ee8f674f05c7c12dcbd44` |
| `release-prep/v1-windows-only-scope`       | `16b47d83da58fc8091df94131be64891a0b467a0` |
| `release-prep/v1.0.0-rc.1`                 | `ef6ce35cf0eac9c3bdb0fafc8693f78b125ddfad` |
| `test/v1-final-host-acceptance`            | `9f690bc9a130615e252dbc0b79f0a7500ece9b5b` |
| `test/v1-owner-acceptance-evidence`        | `9595345c25dab802c450fdaa3ef4d5bef0b0267e` |

## E. Final remote branch structure

Exactly three remote branches remain. At completion of ref operations, before
the additive documentation commit, their exact inventory was:

| Branch                                     | Full SHA after ref cleanup                 |
| ------------------------------------------ | ------------------------------------------ |
| `main`                                     | `4fd2be9fa3b17370841dbb1d2f0422a2150c62d8` |
| `dev`                                      | `c6d4769bf3179d49bb3718074d6c083f52332626` |
| `release-prep/v1-phase-6-3-windows-freeze` | `fca2d0b04120d9fd6195ba42f342a8685ca02386` |

The final documentation push advances only the preparation tip to the commit
containing this receipt. The final owner report/private verification records
its full SHA after push. No active remote `codex/` branch remains.
`release/v1.0.0-windows` and `feature/native-linux-support` were not created.

## F. Integrity verification

- Main/dev retain their full initial SHAs; default branch remains main.
- Original preparation commit/tree preserved at rename; later changes limited
  to naming policy, current branch reference, this receipt and task records.
- All deleted candidate tips and associated merge commits remain reachable
  through dev. No Git objects or historical commits were pruned.
- Published `v0.1.0-beta.1` tag object remains
  `e92e3be8d2de21ce5c22508c15de3c08f02cb77a`, peeled commit
  `0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38`.
- Primary HEAD, status and SHA256 hashes of owner dirty/untracked files were
  checked against preflight. Other worktree HEADs/branches/status and all
  registrations remain intact, except the authorized preparation rename.
- Release notes/checklist remain byte-identical; the Phase 6.3 handoff retains
  selected source, archive checksums, all prior gate results and failure evidence.
- No product source, schema, package version, protocol, model, dependency,
  workflow, historical PR or immutable receipt was changed.
- No release publication, paid QA run, filesystem deletion, Actions artifact/run
  deletion, distribution retry, self-merge or settings change occurred.
- Applicable verification: documentation formatting, repository hygiene,
  whitespace checks and final remote/history/local-state comparisons. No new
  product or supported-host acceptance is claimed by this maintenance task.
- Private audit: `C:/Users/merte/.codex/artifacts/sentry-branch-cleanup-20261015`.
  `shux contract` was unavailable; task status, ledger and handoff maintained directly.

## G. Outstanding release tasks

1. Windows distribution [38685627221](https://github.com/Mert1026/Sentry/actions/runs/38685627221)
   last failed only at artifact upload quota after successful build/archive
   verification. No retry was started; quota availability is not established.
2. Create `release/v1.0.0-windows` only through the separate approved release
   process after its required merged-source distribution gate succeeds.
3. Open the Phase 6.3 review PR from `release-prep/v1-phase-6-3-windows-freeze`
   into that release branch when available; no substitute PR to dev/main.
4. Owner review/merge, fresh actual-merge verification and separate authorization
   of exact source/assets precede any official RC tag/release/main promotion.

Branch cleanup completion does not establish release completion.
