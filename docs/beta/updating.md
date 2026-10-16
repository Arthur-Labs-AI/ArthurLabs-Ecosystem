# Source updates and packaged manual upgrades

Packaged Windows Stable uses the [distribution upgrade procedure](../setup/distribution.md).
This path is retained for source-launcher compatibility; source channels below are separate from packaged installation.

Archive `update` refuses development tracking; source commands below keep their
existing policy.

## Beta channel: explicit tags

Install from announced Git tags. Tag clones use detached HEAD: setup/open work,
while `sentry update` refuses before Git mutations. This pins your revision.
GitHub Releases provide notes; there is no automatic Release updater.

For a later announced beta: use a clean checkout, cancel active work and wait,
then `sentry stop`. Fetch with `git fetch origin tag <announced-tag>`, review
notes and run `git switch --detach <announced-tag>`. Rerun `.\sentry.ps1 setup`
on Windows or `./sentry setup` on CachyOS; open and verify Environment/doctor.
Do not overwrite tags or discard local changes automatically.

For same-revision repair rerun setup. Windows also has `sentry repair`;
CachyOS uses `sentry setup`.

## Source channels: explicit branch tracking (since the 2026-10-12 branching transition)

Source checkouts update only from the explicitly selected channel:

| Current branch                                           | `sentry update` tracks | Notes                                                                                                                                     |
| -------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`                                                    | `origin/dev`           | Development stream.                                                                                                                       |
| `main`                                                   | `origin/main`          | Stable integration/release stream. Existing `main` checkouts stay on `main` until you explicitly switch; nothing redirects them to `dev`. |
| Detached tag (e.g. `v0.1.0-beta.1`)                      | Refuses                | Pinned installs stay pinned.                                                                                                              |
| `feature/*`, `fix/*`, `codex/*`, `release/*`, `hotfix/*` | Refuses                | Switch to `dev` or `main` explicitly first.                                                                                               |

`main` is the stable stream, not the experimental stream; `dev` is the
development stream. Sentry never switches your branch automatically. To change
channels, choose explicitly:

```text
git switch dev     # follow development (tracks origin/dev)
git switch main    # follow stable (tracks origin/main)
sentry update
```

Requires a clean tree and origin/internet access. Sentry never resets, stashes
or rebases your work.

## Source update steps

1. Identify the current branch and resolve the matching remote ref (`origin/dev`
   or `origin/main`); refuse any other checkout with zero Git mutations.
2. Refuse dirty trees (commit, stash, or discard first).
3. `git fetch --prune origin <dev|main>` for the current channel only, then
   compare HEAD with the matching remote ref.
4. Leave running Sentry alone if current (Windows `-Repair` can rebuild).
5. Stop gracefully; failure aborts before merge/build/deploy.
6. Fast-forward only (`git merge --ff-only`); a diverged branch must be resolved
   manually. Run the updated launcher: install frozen dependencies, build,
   deploy the versioned runtime, handshake, and recheck managed tools.
7. Restore running/stopped state and preserve settings/data. Runtime handshake
   failure restores the previous runtime target.

Update prints the channel and transition, e.g.
`source channel: origin/dev` then `Updated: e9e0b80 -> a1b2c3d`.

## Recovery

Stop failure: cancel work, close window, run `sentry stop`, retry. The launcher
does not kill processes as a maintenance shortcut.
Build/deploy failure after Git advances: resolve the printed failure and rerun
setup for that revision. A no-op update does not rebuild advanced source. Retain
the previous runtime for diagnosis; never delete databases/credentials as a fix.
