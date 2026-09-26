# Sentry Beta — Updating

For v0.1 Beta, `sentry update` tracks **`origin/main`** explicitly:

```powershell
sentry update
```

It does NOT update from GitHub Releases yet. This is intentional:
Releases are milestones with notes; Beta fixes flow through commits.

Beta updates require branch `main`. On any other branch, update refuses
immediately (zero Git mutations) and tells you to `git switch main`.

## What update does

1. Refuses on a non-`main` branch or a dirty tree (commit, stash, or
   discard first — Sentry never resets, stashes, or rebases for you).
2. `git fetch --prune origin main` and compares `HEAD` with `origin/main`.
3. If already up to date, reports so and **leaves a running Sentry alone**
   (unless `-Repair` forces a rebuild).
4. If an update is available: gracefully stops Sentry, then
   `git merge --ff-only origin/main` (a diverged `main` must be resolved
   manually).
5. Hands off to the **new** launcher code, then: `pnpm install
--frozen-lockfile`, `pnpm build`, versioned WSL runtime redeploy,
   distro-preference sync, handshake check, managed-tool revalidation.
6. Reopens Sentry (or restores its prior stopped state after `-Repair`).
   Provider settings, projects, and run history are preserved.

Update prints the transition, e.g. `Updated: e9e0b80 → a1b2c3d`.

## Requirements

- Install from `git clone` (a ZIP download has no remote to pull from).
- Branch `main` tracking `origin/main`.
- A clean tree: `git status --porcelain` must be empty.
- Internet access to fetch `origin`.

## If update fails midway

The failing stage is printed. Your projects, credentials, and the previous
runtime version are never deleted by an update. Fix the reported stage
(usually a build error from a new commit) and rerun `sentry update`.
