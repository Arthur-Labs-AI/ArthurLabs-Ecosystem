# Sentry Beta — Updating

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

## Development channel: explicit opt-in

`sentry update` tracks **development origin/main**, potentially outside a tested
beta. The launcher prints this policy. Switching to main opts in:

```text
git switch main
sentry update
```

Requires a clean clone, branch main and origin/internet access. Sentry never
resets, stashes or rebases your work.

## Development update steps

1. Refuse non-main branches and dirty trees.
2. Fetch origin/main and compare HEAD.
3. Leave running Sentry alone if current (Windows `-Repair` can rebuild).
4. Stop gracefully; failure aborts before merge/build/deploy.
5. Fast-forward only, run updated launcher, install frozen dependencies,
   build, deploy versioned runtime, handshake and recheck managed tools.
6. Restore running/stopped state and preserve settings/data. Runtime handshake
   failure restores the previous runtime target.

## Recovery

Stop failure: cancel work, close window, run `sentry stop`, retry. The launcher
does not kill processes as a maintenance shortcut.
Build/deploy failure after Git advances: resolve the printed failure and rerun
setup for that revision. A no-op update does not rebuild advanced source. Retain
the previous runtime for diagnosis; never delete databases/credentials as a fix.
