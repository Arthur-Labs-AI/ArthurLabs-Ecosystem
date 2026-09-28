# Sentry Beta — Getting started

From a fresh Windows machine to your first Full QA run, without knowing
monorepo internals.

## 1. Clone and set up

```powershell
git clone https://github.com/Mert1026/Sentry.git
cd Sentry
.\sentry.ps1 setup
```

Setup is idempotent: rerunning it after a reboot, a partial failure, or an
update is safe and resumes where it left off.

What setup does (7 phases):

1. **Windows** — verifies Git, Node >= 22, and the pinned pnpm.
2. **WSL** — reuses a compatible WSL2 distro (or installs Ubuntu and asks
   you to reboot + rerun).
3. **Linux toolchain** — systemd user services, Linux Node >= 22 visible to
   direct `wsl.exe` execution, pinned Linux pnpm, git/curl/sandbox tools.
4. **Sentry dependencies** — `pnpm install --frozen-lockfile` + full build.
5. **WSL runtime** — deploys a versioned runtime (`<version>-<commit>`) and
   verifies the `runtime.hello` handshake.
6. **Agent tools** — tested OpenCode 1.18.32, DeepSeek SDK 0.1.5-rc.2,
   Claude Code 2.1.270.
7. **Launcher** — installs the `sentry` command on your user PATH.

Setup never asks for API keys. If your terminal does not recognize `sentry`
after setup, open a new PowerShell window.

## 2. Open Sentry

```powershell
sentry open
```

## 3. Configure providers

Open **Settings → Providers** and enter your provider credentials. Secrets
stay in Electron safeStorage (Windows DPAPI) on this machine.

## 4. Verify the environment

Open **Environment** and confirm every agent shows ready. From a terminal,
`sentry doctor` runs the same checks without spending anything on providers.

## 5. Add a project

Add a local folder as a project. Sentry copies it into a managed copy and
records an immutable revision — agents never touch your original folder.

## 6. Start Full QA

Start a **Full QA** run. Three agents (OpenCode, DeepSeek, GLM) each plan
and investigate independently in isolated workspaces against the same
snapshot. Watch progress in the run workspace; inspect each agent's
findings, evidence, and token usage when it finishes.

For a narrower question, use **Targeted QA** with specific paths.

## Next steps

- `sentry cli` — drive the same running instance from a terminal or automation ([CLI guide](cli.md)).
- `sentry update` — pull the latest Beta commits (see updating.md).
- `sentry stop` — gracefully stop Sentry when you are done.
- [troubleshooting.md](troubleshooting.md) — when something fails, run
  `sentry doctor` first.
