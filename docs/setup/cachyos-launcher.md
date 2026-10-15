# CachyOS native launcher

**DEFERRED — FUTURE NATIVE LINUX RELEASE.** Windows 11 x64/WSL2 is the only
initial v1 release target. This retained experimental native implementation
targets **CachyOS only** (`ID=cachyos` in `/etc/os-release`).
Ubuntu, Arch, Fedora, and Debian are rejected with `LINUX_DISTRO_UNSUPPORTED`;
CI on `ubuntu-latest` proves generic-Linux code paths, never Ubuntu support.

## Commands

From a clone, or from anywhere after setup installs the user shim:

```bash
./sentry setup     # idempotent: host, packages, node, pnpm, build, deploy, verify, agents, shim
./sentry open      # launch Sentry Desktop (detached; single-instance focuses)
./sentry status    # installation status (broker handshake proves liveness)
./sentry stop      # graceful shutdown through the running instance (never killall)
./sentry doctor    # non-destructive diagnostics, no secrets printed
./sentry update    # DEVELOPMENT main only; beta tags stay pinned
./sentry cli ...   # automation CLI, same contract as Desktop (uses --json)
./sentry version   # product version, commit, branch
./sentry help
```

`help` and `version` work on any host. Every other command fails closed
off CachyOS before doing anything.

## Setup phases

`sentry setup --list-phases` prints the ordered phases (kept in sync with
`scripts/launcher/launcher-logic.mjs` by test): host, base, packages,
node, pnpm, systemd-sandbox, dependencies, build, deploy, verify, agents, shim.

Rerunning setup is safe: valid state is reused, only missing pieces are
installed, deployment is two-phase (deploy-inner activates `current` after
its build/entry validation, then an external `runtime.hello` handshake
checks protocol 1, linux, non-Windows, non-Electron). On verification
failure the previous target is restored — or `current` is removed when no
previous runtime existed — while the failed version directory is retained
for diagnostics.

## Privilege model

Setup never uses hidden sudo. Missing system packages print the exact
`sudo pacman -S --needed ...` command and either ask explicitly
(interactive TTY) or fail closed with `--non-interactive`. Agent tools
install into rootless user prefixes; the `~/.local/bin/sentry` shim is a
user-owned symlink and shell rc files are never edited.

## State layout (all user-owned)

- Runtime deployments: `~/.local/share/sentry/runtime/<version>/`, `current` symlink
- Launcher state (node path, repo path, no secrets): `~/.local/share/sentry/launcher/`
- Command shim: `~/.local/bin/sentry`
- Logs: `~/.local/share/sentry/logs/`

## Acceptance (clean CachyOS machine)

See the Stage 3 report for the full checklist: clone, `./sentry setup`,
`sentry doctor`, `sentry open`, `sentry status`, `sentry stop`,
`sentry update`, `sentry version`, `sentry help`, then runtime hello,
native host status, project import, CLI broker, and provider readiness.
The owner reports 3/3 success on CachyOS. Candidate changes still need target
acceptance; see [beta validation](../releases/v0.1.0-beta.1-validation.md).
This release is beta software, not a production-readiness claim.
