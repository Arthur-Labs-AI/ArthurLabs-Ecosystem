# Branching and release review

## Policy transition (2026-10-12: integrated via owner-merged PR #9)

Before this change Sentry used one integration trunk: feature and fix
branches were based on `origin/main` and merged into `main` (PRs #2–#8 did
so legitimately under that policy; history is not rewritten).

`dev` was created from approved `origin/main`
`4fd2be9fa3b17370841dbb1d2f0422a2150c62d8` (creation record kept in
`docs/development/dev-branch-transition.md`). PR #9 integrated the
transition into `dev` (owner-merged 2026-10-12 as `6e5ec22`): `main` remains
the frozen pre-v1 transition baseline at `4fd2be9` — not an accepted stable
v1 release — while `dev` carries ongoing development. From the `dev`
creation commit forward, the workflow below applies: new task branches start
from approved `origin/dev` and target `dev`.

## Branch responsibilities

| Ref                                      | Purpose                                       | Rule                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main`                                   | Stable release integration                    | Owner-approved release-ready changes only. Normal feature, corrective, and experimental security work never targets `main`. Stable builds originate from an explicitly approved `main` commit identified by an immutable annotated version tag. A push to `main` never automatically publishes a release. |
| `dev`                                    | Development integration                       | Integration branch for ongoing work. Feature/fix branches merge here after review, applicable CI, regression testing, honest unavailable-gate documentation, and owner approval. Phase 5 targets `dev`.                                                                                                   |
| `feature/*`, `codex/*`, `fix/*`          | Short-lived task branches                     | Base on the latest approved `origin/dev`. PRs target `dev`. No direct commits to `dev` except its initial creation.                                                                                                                                                                                       |
| `release/*` (e.g. `release/v1.0.0-rc.1`) | Release stabilization                         | Created from an approved `dev` commit. After feature freeze: release blockers, testing corrections, and documentation only. The RC undergoes exact-SHA CI and supported-host acceptance; the owner explicitly approves promotion to `main`.                                                               |
| `hotfix/*`                               | Critical repair of a published stable release | Start from the affected immutable release tag or approved stable baseline. The owner reviews and promotes the hotfix to `main`, creating a new version/tag when authorized.                                                                                                                               |
| `v<version>`                             | Annotated immutable release                   | Approved validated commit only; never move or overwrite an existing tag.                                                                                                                                                                                                                                  |

Historical `codex/release-*` and `codex/hotfix-*` refs remain valid history;
do not rename or delete them for this policy.

## Promotion and propagation rules

- `dev` → `release/*`: branch from an approved `dev` commit for stabilization.
- `release/*` → `main`: owner-approved promotion only (merge of the exact validated candidate), followed by a version tag.
- `hotfix/*` → `main`: owner-reviewed promotion for the affected release.
- `hotfix/*` → `dev`: integrate the correction back into `dev` afterward so the fix is not lost; verify future development still includes it.
- Never silently rebase or force-update shared branches (`main`, `dev`, `release/*`). Use reviewed merges or cherry-picks.

## Release-fix flow (normative)

1. Fix in the release branch (`release/*` or `hotfix/*`).
2. Validate the exact candidate (CI on the exact SHA plus applicable acceptance).
3. Owner-approved promotion to `main` (merge of the validated candidate; new tag when authorized).
4. Propagate the approved fix back into `dev` (merge or cherry-pick, reviewed).
5. Verify that future development still includes the fix (test on `dev`).

## Review, CI, and merge requirements

- Every change to `dev` and `main` arrives via a pull request from a task branch. No direct pushes.
- PRs require: code review, passing applicable CI on the exact candidate commit, regression testing, honest documentation of unavailable acceptance gates (e.g. native CachyOS, clean Windows VM, paid-provider runs), and owner approval.
- Required CI jobs: `quality`, `launcher (windows, no WSL)`, `launcher (linux, no CachyOS)`. Push CI runs on `main` and `dev`; PR CI runs on PRs into `dev`, into `main`, and on release/hotfix PRs.
- Only the owner merges (owner-only merges). Agents prepare PRs and stop; agents must not merge, enable auto-merge, or tag.
- CI alone does not enforce manual owner approval: while server-side branch protection is unavailable (see below), PR-only integration and owner review are procedural requirements, not server-enforced controls.

## Tags and artifact provenance

- Stable release builds originate from an explicitly approved `main` commit identified by an immutable annotated version tag (e.g. `v0.1.0-beta.1`, `v1.0.0-rc.1`, `v1.0.0`).
- Never create or move a tag without explicit owner authorization and candidate validation.
- A PR into `dev` passing CI (including any distribution-build step) does not produce an official stable release. Only explicitly approved release-candidate and stable-promotion procedures yield official release artifacts.
- Private artifact access controls are preserved; unsigned review artifacts from exact candidate SHAs are for review only (see `docs/setup/distribution.md` for packaged-archive rules).

## Unavailable acceptance gates

Phase5.1 rechecked both main/dev protection endpoints on 2026-10-13: HTTP403,
requiring GitHub Pro or a public repository. No server-enforced protection is
claimed. PR-only changes, exact-source applicable CI, honest unavailable gates,
explicit owner approval and owner-only merges remain procedural requirements.
The [Phase5.1 branch audit](../releases/v1-post-merge-acceptance-c78faa7.md#f-branch-hygiene)
identifies three fully merged remote task branches eligible for cleanup; remote
deletion still requires explicit owner approval and a fresh reachability check.

The [Phase5.3 audit](../releases/v1-phase-5-3-final-host-acceptance.md#branch-cleanup-recommendation)
rechecks all five historical task branches through owner-merged PR19 against
dev5c68491: zero unique commits, no active worktree or workflow-name dependency.
No branches were deleted; remote cleanup still needs explicit owner approval.

- Ubuntu GitHub Actions or Ubuntu WSL testing does not establish native CachyOS acceptance. A prepared WSL host is not a clean Windows install.
- When a required host gate cannot run, record `ENVIRONMENT UNAVAILABLE` (native CachyOS, clean Windows VM) or `OWNER ACCEPTANCE REQUIRED` (paid-provider runs) in the PR/validation report instead of implying coverage.

## No automatic publication

Phase6.0 explicitly authorizes an isolated `release-prep/v1.0.0-rc.1` review
branch from approved dev and safe version-specific preparation. It is not an
official `release/*` cut or a new update channel. Current owner functional
acceptance and pending policy/RC decisions are in the
[RC checklist](../releases/V1_RC_READINESS_CHECKLIST.md). Six historical merged
branches were rechecked against devc103509; none were deleted.

- No workflow publishes a release, creates a tag, or force-pushes a branch pointer automatically. Push CI validates only.
- GitHub's default branch is unchanged by this transition (still `main`). Changing the default branch affects new PRs, new clones, and automation; it is a separate owner decision — see `docs/development/dev-branch-transition.md` for the recommendation.

## Starting checklist (every task branch)

Before starting: fetch origin, inspect `git status`, `git branch --show-current`, `HEAD`, existing PRs, and tags. Base the branch on the latest approved `origin/dev` (or the release tag for hotfixes). Use an isolated worktree when the owner's checkout is dirty. Never reset, overwrite, or automatically stash owner changes. Push only the task branch, open a PR to `dev` (or to `main` for owner-approved promotions), and stop for owner review.
