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

Setup detects a WSL1-only distro and asks for confirmation before
converting exactly that distro (`wsl --set-version <distro> 2`); it never
installs a duplicate Ubuntu first. Non-interactive setup converts only a
distro named with `-Distro`. The conversion result is re-checked before
setup continues.

## Node missing in WSL

The runtime launches as `wsl.exe -d <distro> -- node <entry> --stdio`, so
Node must resolve under **direct** execution — an `nvm`-only install that
lives in `.bashrc` is not enough. Verify with:

```powershell
wsl -d Ubuntu -- node --version   # must print v22+
```

Setup installs Node 22 via NodeSource on apt distros. On non-apt distros,
install Node >= 22 manually so the command above works, then rerun setup.

## GLM sandbox: `socat` / `bubblewrap` missing

The GLM sandbox runs fail-closed: if `socat` or `bubblewrap` is missing
(or bubblewrap cannot initialize), GLM runs fail instead of running
unsandboxed. `sentry doctor` reports exactly which piece is missing.

Check (Ubuntu / WSL — run these **inside** Ubuntu, not in Windows
PowerShell):

```bash
command -v socat
command -v bwrap
```

Install (Ubuntu / WSL):

```bash
sudo apt update
sudo apt install -y socat bubblewrap
```

Then rerun `sentry doctor`. `sentry setup` installs these automatically on
apt distros; on other distros install them manually. Never disable the
sandbox to work around this (`sandbox.failIfUnavailable` stays on).

> Windows `winget` commands run in **Windows PowerShell** only — never
> inside Ubuntu. Conversely `sudo apt ...` runs **inside Ubuntu** only.

## Per-tool probes (Ubuntu / WSL)

```bash
$HOME/.local/share/sentry/tools/opencode/node_modules/.bin/opencode --version
$HOME/.local/share/sentry/tools/deepseek/bin/dsh --version
```

`$HOME` avoids username-specific paths entirely.

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
- **DeepSeek**: setup resolves the pinned DSH runtime (`0.1.5-rc.2`) from
  the deployed Linux runtime and exposes it at the Sentry-managed
  `~/.local/share/sentry/tools/deepseek/bin/dsh`, then persists that path
  as the `SENTRY_DEEPSEEK_BINARY` override. Setup reports DeepSeek ready
  only after the managed binary answers its version probe (the same probe
  production preflight performs). That managed file is a Bash wrapper that
  follows `runtime/current`; the SDK launches its own pinned DSH runtime
  from it at startup. Do not replace the wrapper with a JavaScript file.
- **Claude**: setup uses adapter-tested `2.1.270` from a Sentry-managed
  install (`~/.local/share/sentry/tools/claude-code`) and never touches
  your global `claude` (no sudo, no global npm changes). An existing exact
  native install may be reused; version `2.1.276` is known-incompatible. A
  `claude` resolved from `/mnt/c/...` (Windows mount) is refused.

After installing a tool manually, rerun `sentry doctor` to verify.

## Provider credential missing

Configure credentials in Sentry → Settings → Providers (Electron
safeStorage / Windows DPAPI). Setup and doctor never handle secrets; an
agent that reports "unconfigured" needs its provider saved in the UI.
Provider settings survive `sentry update`.

## Update refuses (branch / dirty tree)

Beta updates track `origin/main` only: on any other branch, `sentry update`
refuses and tells you to `git switch main` (it never switches branches for
you). It also refuses when `git status --porcelain` shows anything —
commit, stash, or discard first. Sentry never resets, cleans, rebases, or
stashes automatically, and a refused update leaves a running Sentry alone.

## Desktop already running

`sentry open` while Sentry runs focuses the existing window (single
instance) instead of starting a second runtime. If the window seems lost,
run `sentry stop`, then `sentry open` again.

## Runtime outdated after `git pull`

A manual `git pull` does not rebuild or redeploy. Run `sentry update`
(rebuilds Desktop, redeploys the versioned runtime, reopens Sentry) or
`sentry setup -NonInteractive` to resync everything.
