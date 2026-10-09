# Branching and release review

Sentry uses one integration trunk with isolated change/release branches.
Immutable version tags identify distributions.

| Ref                               | Purpose                     | Rule                                                                  |
| --------------------------------- | --------------------------- | --------------------------------------------------------------------- |
| `main`                            | Development integration     | Owner-reviewed PRs with passing CI; no direct agent pushes            |
| `codex/<topic>`                   | Feature or fix              | One task per branch; PR to main                                       |
| `codex/release-v<version>`        | Release stabilization       | Freeze scope, fix blockers, record validation, draft PR to main       |
| `codex/hotfix-v<version>-<topic>` | Released-version repair     | Start from affected tag; validate/review and bring fixes back to main |
| `v<version>`                      | Annotated immutable release | Approved validated commit only; never overwrite                       |

Current preparation: `codex/release-v0.1.0-beta.1`. The original main checkout
and uncommitted owner work remain separate. Do not rewrite shared history,
force-push, or delete existing branches/tags. Use a new version for any
post-publication distribution change.

## Gates

PRs run CI on all branches. Pushes to main/release/hotfix branches also run
quality, Windows launcher, and generic Linux launcher jobs. Mandatory failures
fail CI. Capability-dependent security proofs remain mandatory wherever
supported and explicitly unverified elsewhere.

Require owner review, passing checks on the exact candidate commit, and a
platform acceptance report before merge/tag/publication. Prepare a draft
pre-release with accurate notes; attach only tested real assets. This beta
ships source. Keep beta users on tags; development main is an explicit opt-in.

## Server enforcement limitation

On 2026-10-09 GitHub returned HTTP 403 for main protection and repository
rulesets: this private repository's plan requires an upgrade to enable them.
Policy/CI are not server-enforced approval. Visibility stays private.

With an eligible plan, protect main/release/hotfix branches with required PR
review, current CI, blocked force pushes/deletions, and administrator coverage
where appropriate. Required checks are `quality`, `launcher (windows, no WSL)`,
and `launcher (linux, no CachyOS)`; verify names in Actions before configuring.
Until then, owner review and PR-only integration are procedural requirements.
