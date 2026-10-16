# Branching and release review

| Ref                                                 | Responsibility                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| main                                                | Owner-reviewed stable integration; default branch                  |
| dev                                                 | Reviewed ongoing development integration                           |
| feature/native-linux-support                        | Future native Linux work, initially branched from stable main      |
| feature/, fix/, docs/, test/, chore/, release-prep/ | Task branches based on their approved workstream                   |
| hotfix/                                             | Owner-scoped repairs from a published tag/approved stable baseline |
| v<version>                                          | Annotated immutable approved release source                        |

Ordinary feature/fix work starts from approved origin/dev and targets dev. Release
corrections use the approved release branch and reviewed propagation to main/dev.
Explicitly authorized post-release documentation cleanup starts from current
origin/main and targets main through its own PR. Stable publication does not imply permission to merge another PR. Completed
release/fix branches may be retired after owner authorization and ancestry checks;
immutable release tags preserve their published source.

Names describe purpose, not the assistant: use the conventional prefixes above;
do not create new codex/ branches. Historical names and local worktree refs remain
valid history. See the [immutable transition/cleanup records](../history.md).

Before any task, fetch and inspect status, branch, HEAD, PRs, tags and worktrees.
Preserve dirty owner work; never automatically reset, stash, clean or force-update
main/dev/release. PRs require applicable tests/CI, honest unavailable-gate notes,
review and owner approval. Only the owner merges; agents do not enable auto-merge.
Server protections must be inspected independently; CI alone does not prove a
human approval gate is enforced.

Stable artifacts originate from an explicitly approved main commit and annotated
tag. Version tags and published assets must not be overwritten or moved. No push
workflow automatically publishes a release. Tag/Release mutation requires explicit
owner authorization of the exact source/bytes; follow the [release checklist](../releases/RELEASE_CHECKLIST.md).
Review artifacts and native-development archives are not official Windows assets.

After stable publication, inspect dev-only changes and prepare a normal main→dev
PR; preserve development history and stop for owner merge. If cleanup lands after
that synchronization, prepare a later cleanup propagation PR; if synchronization
is still pending, refresh its diff after owner merges cleanup. Never lose new dev
work through a reset or force-push. Native Desktop remains a separate future
workstream; shared Linux runtime/security tests remain required for Windows.

The owner authorized retirement of six merged release/fix branches after v1.0.1.
Their tips are all ancestors of main6793a9c53a336d577ac4397735d0396f558b60f0.
The retained remote workstreams are main, dev and feature/native-linux-support,
plus any active review branches. The Linux branch starts at that exact main
commit; follow the [native Linux handoff](native-linux.md) before development.
