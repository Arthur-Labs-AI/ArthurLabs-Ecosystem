# Sentry Beta — Troubleshooting

Run `sentry doctor` first. It performs zero paid requests and never prints
secrets — only presence information.

```powershell
sentry doctor
sentry status -Json   # attach this (with FAIL/WARN lines) to bug reports
```

Never paste API keys, provider tokens, or credential files into bug reports.

## `sentry` command not found

The shim lives at `%LOCALAPPDATA%\Sentry\bin\sentry.cmd` with that
directory on your **user** PATH. Open a new PowerShell window after setup.
If it is still missing, rerun `sentry setup` (it reinstalls the shim) and
check `sentry status`.

## Setup says reboot required

First-time WSL installation needs a Windows restart. This is normal, not a
failure. After restarting:

```powershell
cd <your-clone-path>
.\sentry.ps1 setup
```

Setup resumes where it left off (exit code 75 means "reboot requested").

## WSL installed but distro missing

Setup installs Ubuntu via `wsl --install -d Ubuntu` when no usable WSL2
distro exists, then asks you to rerun setup. Utility distros such as
`docker-desktop` are intentionally ignored — they cannot host the runtime.

## WSL distro is WSL1

Sentry requires WSL2. Setup offers to convert the selected distro with
`wsl --set-version <distro> 2` (only that distro, with your confirmation
via the setup flow). Re-run setup after conversion.

## Node missing in WSL

The runtime launches as `wsl.exe -d <distro> -- node <entry> --stdio`, so
Node must resolve under **direct** execution — an `nvm`-only install that
lives in `.bashrc` is not enough. Verify with:

```powershell
wsl -d Ubuntu -- node --version   # must print v22+
```

Setup installs Node 22 via NodeSource on apt distros. On non-apt distros,
install Node >= 22 manually so the command above works, then rerun setup.

## systemd unavailable

Sentry uses systemd user services for worker isolation. Setup enables
`systemd=true` in `/etc/wsl.conf` (backing up your file first and
preserving your other settings), then restarts only the selected distro
(`wsl --terminate <distro>`, not a full shutdown). If it still fails, check
that your distro supports systemd and rerun `sentry setup`.

## Runtime handshake failed

`runtime.hello` must answer with protocol 1 on Linux, from a host whose
executable is not `electron.exe`. If the handshake fails after a deploy:

1. Run `sentry doctor` and read the exact failing line.
2. Rerun `sentry setup` (redeploys the versioned runtime atomically; the
   previous runtime stays usable until the new one validates).
3. Check `%LOCALAPPDATA%\Sentry\launcher\logs\` for the deploy log.

## OpenCode / DeepSeek / Claude missing

- **OpenCode**: setup installs tested `1.18.32` into the Sentry-managed
  location (`~/.local/share/sentry/tools/opencode`) and reuses an existing
  compatible install.
- **DeepSeek**: runs through the runtime-bundled SDK client (`0.1.5-rc.2`);
  a separate `dsh` binary is optional, not required.
- **Claude**: setup installs adapter-tested `2.1.270` as a native Linux
  binary. Version `2.1.276` is known-incompatible and is refused. A `claude`
  resolved from `/mnt/c/...` (Windows mount) is refused — install the Linux
  build inside WSL instead.

After installing a tool manually, rerun `sentry doctor` to verify.

## Provider credential missing

Configure credentials in Sentry → Settings → Providers (Electron
safeStorage / Windows DPAPI). Setup and doctor never handle secrets; an
agent that reports "unconfigured" needs its provider saved in the UI.
Provider settings survive `sentry update`.

## Dirty Git tree blocks update

`sentry update` refuses when `git status --porcelain` shows anything.
Commit, stash, or discard your changes first — Sentry never resets,
cleans, or stashes automatically.

## Desktop already running

`sentry open` while Sentry runs focuses the existing window (single
instance) instead of starting a second runtime. If the window seems lost,
run `sentry stop`, then `sentry open` again.

## Runtime outdated after `git pull`

A manual `git pull` does not rebuild or redeploy. Run `sentry update`
(rebuilds Desktop, redeploys the versioned runtime, reopens Sentry) or
`sentry setup -NonInteractive` to resync everything.
