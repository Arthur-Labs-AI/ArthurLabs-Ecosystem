# Sentry

Sentry is a local-first AI QA desktop application. OpenCode, DeepSeek, and
GLM through Claude Code independently investigate one immutable project snapshot
and return findings, evidence, token usage, and observable run history.

**Beta candidate: `v0.1.0-beta.1`.** Supported hosts: **Windows 11 + WSL2**
and **native CachyOS**. This is early tester software, not production-ready.
See [release notes](docs/releases/v0.1.0-beta.1.md) and
[validation](docs/releases/v0.1.0-beta.1-validation.md).

## Capabilities

- Electron Desktop for projects, revisions, runs, findings, and evidence.
- Full and Targeted QA with independent reports and cancellation.
- Isolated Linux workspaces, persistent history and restart recovery.
- JSON/log export, native Save As, and CLI control of the running Desktop.
- Provider settings, environment checks, and resumable source-based setup.

Historical merger/verifier/issue-lineage components remain in the repository.
Merge/verification ingestion is not exposed by current Desktop runtime RPC;
it is not a promised beta user flow. Existing issue/retest data and compatibility
paths remain. Architecture records may describe retired features.

## Prerequisites

- Git and internet during setup. Install from a clone, not a source ZIP.
- Node.js >= 22 and pnpm **9.12.3**. Setup resolves pinned tools and guides
  missing prerequisites; Node 22 is the CI baseline.
- Provider accounts, API credentials, supported models, and API credit for
  enabled agents. Runs can incur charges.
- Windows: Windows 11 and a usable WSL2 distro (Ubuntu preferred). Initial WSL
  installation can require administrator approval and a reboot.
- CachyOS: graphical session, `ID=cachyos`, systemd user services, and pacman.
  Setup checks Git, curl, CA certificates, Node/npm, bubblewrap, socat, and
  base Linux utilities. It shows required package installation commands.

Other native Linux distributions and macOS are unsupported. Ubuntu in WSL2
is supported as the Windows runtime; Ubuntu CI is not CachyOS acceptance.

## Install on Windows 11

Once the beta tag is available, in PowerShell:

```powershell
git clone --branch v0.1.0-beta.1 https://github.com/Mert1026/Sentry.git
cd Sentry
.\sentry.ps1 setup
sentry open
```

Setup reuses compatible WSL2 distros, ignoring utility distros such as
`docker-desktop`. If none is usable it guides WSL2/Ubuntu installation.
After reboot or initial Linux account creation, rerun setup. Open a new
terminal if `sentry` is not yet on PATH.

## Install on native CachyOS

Once the beta tag is available, in your graphical session:

```bash
git clone --branch v0.1.0-beta.1 https://github.com/Mert1026/Sentry.git
cd Sentry
./sentry setup
./sentry open
```

The shim is `~/.local/bin/sentry`. If not on PATH, use `./sentry` from the
clone. Shell rc files are not edited. See [CachyOS setup](docs/setup/cachyos-launcher.md).
The repository is private: testers need access to clone/read releases.
A draft is visible to authorized maintainers. No standalone installer is shipped.

## Configure providers and run QA

1. Open **Settings → Providers**. Configure OpenCode's provider/model
   (OpenRouter is the default path), DeepSeek's key/model, and GLM's token,
   provider base URL and model for Claude Code.
2. Check selected agents in **Environment**. `sentry doctor` makes no paid
   requests; credential presence does not prove credit or provider acceptance.
3. Add a project. Sentry creates a managed copy and immutable revision.
4. Start Full QA or select paths for Targeted QA. Inspect independent reports
   and evidence; export JSON/logs if needed.
5. Cancel active work and wait for it to settle before exit or maintenance.

Setup pins OpenCode **1.18.32**, DeepSeek SDK **0.1.5-rc.2**, and Claude Code
**2.1.270**. Keep these until a tested release changes them.

## Everyday commands

```text
sentry open       Launch Desktop; reopening focuses its window
sentry stop       Graceful Sentry shutdown
sentry status     Installation and liveness status
sentry doctor     Diagnostics without paid requests
sentry version    Product version, commit, and branch
sentry cli ...    Control running Desktop; use --json for automation
sentry setup      Rerun setup for the checked-out source revision
sentry help       Platform-specific help
```

Use `sentry status -Json` on Windows or `sentry status --json` on CachyOS.
Windows also provides `sentry repair` to rerun setup.

## Updates

Beta installations stay pinned to version tags in detached HEAD state.
`sentry update` refuses there; it only tracks **development origin/main**.
Switching to main explicitly opts into potentially untested changes. There is
no automatic GitHub Release updater. For a later beta: cancel work, stop,
fetch the announced tag, check it out, and rerun setup. See [updating](docs/beta/updating.md).
Setup/update aborts on failed graceful stop; dirty trees are never reset/stashed.

## Security and privacy

Projects/history are local. Agents send prompts and relevant source/evidence to
configured providers; review policies before importing confidential code.
Isolation does not make model output trusted or guarantee detection of every bug.
Secrets use Electron safeStorage (Windows DPAPI or the available Linux backend).
Assess backend security on the target desktop; unavailable encryption has no
plaintext persistence fallback. Credentials reach the runtime as required by
integrations. Review exports/logs before sharing; never share API keys,
provider stores, databases, or retained workspaces in bug reports.

## Troubleshooting

- Run `sentry doctor`; see [troubleshooting](docs/beta/troubleshooting.md).
- Windows runtime offline: check WSL2, directly executable Linux Node, and
  systemd user services; resolve the reported failure and rerun setup.
- CachyOS launch failure: use a graphical session and inspect the printed log.
  The short startup check proves process survival only; verify Environment
  and `sentry cli capabilities --json` after launch.
- GLM unavailable: repair bubblewrap/socat/systemd; keep sandbox controls enabled.
- Quota/auth failures: check account credit, endpoint, key and model.
- Stop timeout: cancel work, close the window, run `sentry stop`, then retry.
  Do not rebuild while Desktop is running.

Report via [GitHub Issues](https://github.com/Mert1026/Sentry/issues) with
version/commit, host OS, WSL distro if applicable, reproduction, expected/actual
behavior, and reviewed status/doctor output. Never include keys.

## Documentation and development

- [Getting started](docs/beta/getting-started.md)
- [CLI guide](docs/beta/cli.md)
- [Changelog](CHANGELOG.md)
- [Release checklist](docs/releases/RELEASE_CHECKLIST.md)
- [Branching and review](docs/development/branching.md)

Development: `pnpm install --frozen-lockfile`, `pnpm build`, then
`pnpm --filter @qa/desktop dev:electron`. Runtime prerequisites still apply.
See [LICENSE](LICENSE).
