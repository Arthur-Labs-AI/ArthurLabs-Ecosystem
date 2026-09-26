# Sentry Beta — Updating

For v0.1 Beta, `sentry update` tracks the **latest Git commits from `main`**:

```powershell
sentry update
```

It does NOT update from GitHub Releases yet. This is intentional:
Releases are milestones with notes; Beta fixes flow through commits.

## What update does

1. Records the current commit; refuses if the tree is dirty (commit, stash,
   or discard first — Sentry never resets or stashes for you).
2. Gracefully stops Sentry (`sentry stop` semantics).
3. `git fetch --prune origin` then `git pull --ff-only` (fast-forward only;
   a diverged branch must be resolved manually).
4. If already up to date, reports so (unless `-Repair` forces a rebuild).
5. Hands off to the **new** launcher code (the update may have changed the
   launcher itself), then: `pnpm install --frozen-lockfile`, `pnpm build`,
   versioned WSL runtime redeploy, distro-preference sync, handshake check.
6. Reopens Sentry. Provider settings, projects, and run history are
   preserved — no reconfiguration needed.

Update prints the transition, e.g. `Updated: e9e0b80 → a1b2c3d`.

## Requirements

- Install from `git clone` (a ZIP download has no remote to pull from).
- A clean tree: `git status --porcelain` must be empty.
- Internet access to fetch `origin`.

## If update fails midway

The failing stage is printed. Your projects, credentials, and the previous
runtime version are never deleted by an update. Fix the reported stage
(usually a build error from a new commit) and rerun `sentry update`.
