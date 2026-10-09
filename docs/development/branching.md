# Branching and release review

Sentry uses one integration trunk with isolated change/release branches.
Immutable version tags identify distributions.

| Ref                              | Purpose                     | Rule                                                                                          |
| -------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| `main`                           | Stable integration          | Owner-reviewed PRs with passing CI; no direct feature commits or agent pushes                 |
| `codex/<feature-name>`           | Feature or milestone        | One bounded task from approved origin/main; PR to main                                        |
| `fix/<issue-name>`               | Targeted bug fix            | Reproduce and validate the fix; PR to main                                                    |
| `release/<version>`              | Release stabilization       | Freeze features; only release blockers, validation and notes                                  |
| `hotfix/<version>-<description>` | Released-version repair     | Start from affected release tag; targeted validation and owner review; integrate back to main |
| `v<version>`                     | Annotated immutable release | Approved validated commit only; never overwrite                                               |

The released baseline is `v0.1.0-beta.1`. v1 development starts with
`codex/v1-phase-1-cleanup`; package versions stay at the beta during this phase.
Examples of later bounded branches are `codex/v1-runtime-reliability` and
`release/v1.0.0-rc.1`. Existing `codex/release-*` and `codex/hotfix-*` branches
remain valid historical refs; do not rename or delete them for this policy.

Before starting, inspect branch, HEAD and status, fetch origin and tags, and
inspect existing PRs. Start from the latest owner-approved `origin/main`.
Use an isolated worktree when the owner's checkout is dirty. Never reset,
overwrite or automatically stash owner changes. Push only the task branch,
open a PR to main, and stop for owner review. Agents must not merge the PR.
Never rewrite shared history or force-push. Use a new version for any
post-publication distribution change; never move an existing tag.

Release tags are annotated and immutable, for example `v0.1.0-beta.1`,
`v1.0.0-rc.1` and `v1.0.0`. Only create a tag or publish artifacts after explicit
owner authorization and candidate validation. A cleanup PR authorizes neither.

## Gates

The existing `ci.yml` runs PRs on all branches, including every branch prefix
above. Push triggers cover `main` and the older `codex/release-*` and
`codex/hotfix-*` names. New `release/*` and `hotfix/*` candidates must open PRs
to receive CI; a branch push alone is not validation. The three jobs are
quality, Windows launcher, and generic Linux launcher. Mandatory failures
fail CI. Capability-dependent security proofs remain mandatory wherever
supported and explicitly unverified elsewhere.

Require owner review, passing checks on the exact candidate commit, and a
platform acceptance report before merge/tag/publication. Prepare a draft
pre-release with accurate notes; attach only tested real assets. This beta
ships source. Keep beta users on tags; development main is an explicit opt-in.

## Server enforcement limitation

On 2026-10-09, authenticated admin requests to
`GET /repos/Mert1026/Sentry/branches/main/protection` and
`GET /repos/Mert1026/Sentry/rulesets` both returned HTTP 403:
“Upgrade to GitHub Pro or make this repository public to enable this feature.”
This private repository's current plan does not provide these controls.
Policy/CI are not server-enforced approval. Visibility stays private.

With an eligible plan, protect main/release/hotfix branches with required PR
review, current CI, blocked force pushes/deletions, and administrator coverage
where appropriate. Required checks are `quality`, `launcher (windows, no WSL)`,
and `launcher (linux, no CachyOS)`; verify names in Actions before configuring.
Until then, owner review and PR-only integration are procedural requirements.

## Manual alternative while protection is unavailable

1. Keep every task on its own branch and open a PR targeting main. Keep it
   draft while required verification is incomplete; do not enable auto-merge.
2. Record the candidate HEAD SHA, the full diff, executed checks and unavailable
   platform/security gates in the PR. Check `gh pr checks <number>` and the
   Actions jobs above. A skipped real sandbox lane remains unverified.
3. The owner reviews the current diff and validation report, resolves requested
   changes, and explicitly approves that candidate. If the owner also authored
   the commits and GitHub disallows self-approval, record the owner's explicit
   approval in the PR conversation. Agent sign-off is not owner approval.
4. After any new commit, rerun CI and obtain owner acceptance of the updated
   candidate. Only the owner performs the merge after the required checks pass
   and disclosed manual acceptance requirements are satisfied.
5. Never force-push, delete main/release refs, or overwrite published tags.
   Agents stop after PR creation. Tagging and publication are separate owner
   decisions. These are manual restrictions, not server-enforced protection.
