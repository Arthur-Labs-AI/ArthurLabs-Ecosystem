# Dev-branch transition record (Milestone A)

Date: 2026-10-12.

## Parent baseline

- Approved `origin/main`: `4fd2be9fa3b17370841dbb1d2f0422a2150c62d8` (merge of PR #8).
- Post-merge push CI (run 38287855117): `quality`, `launcher (windows, no WSL)`,
  `launcher (linux, no CachyOS)` — all passed (success).
- Immutable beta tag `v0.1.0-beta.1` → `0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38` (unmoved, unmodified).
- Pre-transition `origin/dev` did not exist (verified via `git ls-remote --heads origin`).

## Branch creation evidence

- `dev` was created with a direct ref push of the exact approved SHA, without
  touching the owner's working tree:
  `git push origin 4fd2be9fa3b17370841dbb1d2f0422a2150c62d8:refs/heads/dev`.
- Result: `refs/heads/dev` → `4fd2be9fa3b17370841dbb1d2f0422a2150c62d8`; `main` and
  `dev` point to the same commit. No empty commit, no history rewrite, no tag
  movement, no `main` reset.
- Owner checkout was left untouched: it stayed on its local `main` with its
  pre-existing uncommitted work intact. All transition work happened in the
  isolated worktree `../Sentry-work-chore-dev-transition` on branch
  `chore/v1-dev-branch-transition` (based on `origin/dev`).

## Exact transition procedure

1. Fetched all remote refs; inspected status, PRs, `origin/main` CI, tags, and
   confirmed `origin/dev` was absent.
2. Created `origin/dev` from the exact green `origin/main` SHA (above).
3. Branched `chore/v1-dev-branch-transition` from `origin/dev` in an isolated worktree.
4. Implemented the policy + updater + CI + test changes in that branch (PR targets `dev`).
5. Stopped for owner review without merging (this PR).

## New PR targets

- Development PRs target `dev` (feature/fix branches based on `origin/dev`).
- Phase 5 branch `codex/v1-security-testing` will target `dev` after this
  transition merges and `dev` CI is green.
- Only owner-approved promotions target `main` (release/hotfix candidates).

## New source updater behavior

- Branch `dev` tracks only `origin/dev`; branch `main` tracks only `origin/main`.
- Detached checkouts (pinned tags such as `v0.1.0-beta.1`, release candidates)
  refuse with zero Git mutations.
- `feature/*`, `fix/*`, `codex/*`, `release/*`, and `hotfix/*` checkouts refuse
  with actionable `git switch` guidance. Sentry never switches branches automatically.
- Existing clean `main` checkouts are not redirected to `dev`: they keep
  tracking `origin/main` until the user explicitly runs `git switch dev`.
- Pinned beta installs stay pinned; packaged archives refuse development
  tracking (unchanged, see `docs/setup/distribution.md`).
- Invariants preserved on both platforms: exact branch identification, matching
  remote ref, dirty-tree refusal, fetch-only-the-intended-branch, divergence
  refusal (fast-forward only, no reset/stash), graceful-stop refusal,
  previous-runtime retention on deploy/handshake failure, data/credential
  preservation, updated-launcher re-execution, and accurate channel reporting.

## Existing beta compatibility

- `docs/beta/updating.md` documents the beta-tag flow (unchanged) plus the two
  source channels (`dev` → `origin/dev`, `main` → `origin/main`).
- Historical validation reports that targeted `main` under the old policy were
  left as written; the policy change is dated, not backdated.

## Main/dev promotion rules

- Development merges into `dev` (review + CI + owner approval).
- Release stabilization on `release/*` from an approved `dev` commit.
- Owner-approved promotion of the exact candidate to `main`, then a version tag.
- Hotfixes start from the affected tag/baseline, promote to `main` by owner
  review, and propagate back into `dev`.

## CI trigger verification

- `.github/workflows/ci.yml` push triggers now cover `main`, `dev`, and the
  historical `codex/release-*` / `codex/hotfix-*` patterns; `pull_request`
  coverage is unchanged (PRs into `dev`, into `main`, release/hotfix PRs).
- Required jobs unchanged: `quality`, `launcher (windows, no WSL)`,
  `launcher (linux, no CachyOS)`.
- Observed PR-into-`dev` CI: PR #9's exact-head checks passed (`quality`,
  `launcher (windows, no WSL)`, `launcher (linux, no CachyOS)`, plus the
  `distribution` unsigned-candidate jobs and secret scanning).
- Observed post-merge push CI: the owner merged PR #9 on 2026-10-12
  (`6e5ec2252ba2881e775c9ee058d6523b7eca2142`); the resulting `dev` push
  workflow (run 38294840620) completed with all three required jobs green.
  Both PR and push triggers are therefore verified by observed workflows.
  No push trigger is claimed verified before its workflow is observed.

## Release artifact rules

- No workflow publishes releases, creates tags, or force-pushes branch pointers.
- `.github/workflows/distribution.yml` ("distribution (unsigned review
  candidates)") exists: on pull requests and manual dispatch it checks out
  the exact PR head SHA, runs install/build/`distribution:test`, builds the
  unsigned Windows/Linux candidates, and uploads them as short-retention
  private workflow artifacts for review. It never creates a GitHub Release
  and never publishes stable assets. An earlier revision of this document
  incorrectly stated the workflow was absent; that statement is corrected
  here (2026-10-13, Task A) without altering the branch-creation record
  above. A green CI/distribution check on a `dev` PR is not an official
  stable release; packaging rules live in `docs/setup/distribution.md`.

## Default-branch recommendation (separate owner decision)

- GitHub's default branch was left as `main` (no automatic change).
- Recommendation: keep `main` as default until the team routinely targets `dev`
  and release promotion is exercised at least once; then switch the default to
  `dev` in a separate owner-approved settings change so new PRs/clones land on
  the development stream. Request owner approval separately; do not bundle it
  with this code PR.

## Risks and recovery

- Risk: a user on `main` expecting development updates stays on the stable
  stream. Mitigation: documented channels; `sentry update` reports its channel
  explicitly; nothing auto-switches.
- Risk: pushing `dev` with a wrong SHA. Mitigation: the SHA was the observed
  `origin/main` value fetched immediately before the push; `git ls-remote` and
  `git rev-parse origin/dev` confirmed equality afterward.
- Risk: accidental `main` rewrite. None performed: `main` was never reset,
  rebased, or force-pushed; only a new `dev` ref was pushed.
- Recovery: if `origin/dev` ever needs repair, delete nothing silently — open a
  reviewed PR or, for a ref-level problem, have the owner recreate the pointer
  from the agreed SHA with `--force-with-lease` after capturing a recovery ref.
