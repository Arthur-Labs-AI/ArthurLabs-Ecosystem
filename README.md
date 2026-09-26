# Sentry

Sentry is a local-first AI software QA desktop application that runs
multiple independent AI QA agents against the same immutable project snapshot.

Current release: v0.1 Beta
Platform: Windows 11 + WSL2

Three agents run independently against every project snapshot — no agent sees
another agent's conclusions before reporting its own:

- **OpenCode** — broad QA coverage through the OpenCode harness (OpenRouter provider path).
- **DeepSeek** — independent QA pass through the DeepSeek harness SDK.
- **GLM** — independent QA pass through the Claude Code adapter (GLM provider).

Each agent produces its own findings with evidence. Sentry preserves
agreement AND disagreement: nothing is merged away, every finding keeps its
source, token usage, and observable run history until you delete it.

## Quick start

```powershell
git clone https://github.com/Mert1026/Sentry.git
cd Sentry
.\sentry.ps1 setup
sentry open
```

Then:

1. Open Settings → Providers and configure your provider accounts.
2. Open Environment and verify readiness.
3. Add a project.
4. Start Full or Targeted QA.

Use `git clone`, not a ZIP download: `sentry update` needs a Git checkout.

## Requirements

- Windows 11 with internet access during setup.
- WSL2 (see below) — the execution runtime is Linux.
- Node >= 22 and pnpm 9.12.3 on Windows (setup installs pnpm if missing and
  guides you if Node needs attention).
- Provider accounts / API credentials for the agents you want to run.
- Administrator approval may be needed when WSL itself must be installed;
  a reboot may be required — setup tells you and resumes afterwards.

### If WSL2 already exists

If WSL2 already exists, Sentry reuses a compatible distribution and does not
reinstall WSL. Your default distro, home files, and installed packages are
left alone; setup only adds the missing Sentry prerequisites (Node >= 22
visible to direct `wsl.exe` execution, pnpm, systemd user services,
sandbox utilities, the Sentry runtime, and the tested agent tools).
Utility distros such as `docker-desktop` are ignored.

### If WSL is missing

If WSL is missing, setup can install WSL2 + Ubuntu for you with
`wsl --install -d Ubuntu`. Windows may require a reboot; rerun
`sentry setup` afterwards and setup resumes where it left off.
A brand-new Ubuntu may ask you to create a Linux username/password once.

## Everyday commands

After setup, `sentry` works from any directory:

```powershell
sentry open      # launch Sentry Desktop
sentry update    # pull latest commits and update Sentry
sentry stop      # gracefully stop Sentry (only Sentry, never other apps)
sentry status    # fast installation status (add -Json for machine-readable)
sentry doctor    # detailed diagnostics (no paid API calls, no secrets printed)
sentry version   # product version + commit
sentry help      # all commands
```

The classic developer workflow still works and is never required to change:

```powershell
pnpm --filter @qa/desktop build
pnpm --filter @qa/desktop dev:electron
```

## Updating

`sentry update` tracks `origin/main` explicitly (branch `main` required) —
it does NOT update from GitHub Releases yet. This is intentional for v0.1 Beta:
Releases mark milestones and carry notes, while day-to-day Beta fixes flow
through commits. Update refuses to run with local changes (commit, stash,
or discard them first); it never resets or stashes for you.

See [docs/beta/updating.md](docs/beta/updating.md).

## Provider security

- API keys are entered in the Desktop UI (Settings → Providers).
- Secrets use Electron safeStorage / Windows DPAPI on this machine.
- PowerShell setup never asks for, stores, or logs provider credentials.
- WSL receives credentials only at runtime where the existing execution
  architecture requires it; setup/doctor output never contains secrets.

## What you get

- Desktop QA workspace (projects, run workspace, finding inspection).
- Full QA and Targeted QA across OpenCode, DeepSeek, and GLM.
- Independent findings with evidence, JSON/log export, native Save As.
- WSL2 execution runtime with isolated agent workspaces.
- Secure provider settings, responsive redesigned UI.

## Documentation

- [docs/beta/getting-started.md](docs/beta/getting-started.md) — from a fresh
  Windows machine to your first Full QA run.
- [docs/beta/troubleshooting.md](docs/beta/troubleshooting.md) — common
  failures; run `sentry doctor` first.
- [docs/beta/updating.md](docs/beta/updating.md) — Beta update policy.
- [docs/releases/v0.1.0-beta.1.md](docs/releases/v0.1.0-beta.1.md) — release notes.
- [CHANGELOG.md](CHANGELOG.md) — user-facing changelog.

Historical architecture records (`docs/architecture`, `docs/adr`) describe
how Sentry was built, including retired workflows. They are history, not
current instructions.

## Beta limitations

- Windows + WSL2 only for this Beta.
- Source-based installation (`git clone` + `sentry setup`); no signed
  installer yet.
- Installing WSL may require a Windows reboot.
- Provider access/keys are required to run agents.
- Updates track latest `main` commits (see above).
- Beta software: report bugs with `sentry status` output and the
  FAIL/WARN lines from `sentry doctor` (never paste API keys).

## License

See [LICENSE](LICENSE).
