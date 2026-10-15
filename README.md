# Sentry

Sentry is a local-first AI QA desktop application. OpenCode, DeepSeek, and
GLM through Claude Code independently investigate one immutable project snapshot
and return findings, evidence, token usage, and observable run history.

**Windows v1.0.0 Stable is published as an unsigned ZIP.**
The initial release target is **Windows 11 x64 with WSL2** (Ubuntu preferred).
Windows Desktop continues using the Linux execution runtime, systemd user services
and bubblewrap isolation. Native Linux Desktop, including CachyOS, is deferred.
See the [stable release notes](docs/releases/v1.0.0.md),
[installation guide](docs/setup/distribution.md) and
[Phase 6.6 readiness handoff](docs/releases/v1-phase-6-6-stable-readiness.md).
Use the [official Windows release](https://github.com/Mert1026/Sentry/releases/tag/v1.0.0)
for PowerShell download and installation commands. Development fixes do not replace
its immutable archive or tag. Historical RC receipts retain their identities.

The historical `v0.1.0-beta.1` remains available:
[beta notes](docs/releases/v0.1.0-beta.1.md),
[validation](docs/releases/v0.1.0-beta.1-validation.md).
Its immutable executable is not an accepted credential-recovery downgrade target.

## Capabilities

- Electron Desktop for projects, revisions, runs, findings, and evidence.
- Full and Targeted QA with independent reports and cancellation.
- Isolated Linux workspaces, persistent history and restart recovery.
- JSON/log export, native Save As, and CLI control of the running Desktop.
- Provider settings, environment checks, and resumable source-based setup.
- Confirmed project removal of managed data and history, preserving original sources.
- Explicit Windows disk reclamation with active-operation refusal and reconnection.

Historical merger/verifier/issue-lineage components remain in the repository.
Merge/verification ingestion is not exposed by current Desktop runtime RPC;
it is not a promised beta user flow. Existing issue/retest data and compatibility
paths remain. Architecture records may describe retired features.

## Install Windows

Use the owner-approved Windows ZIP and its trusted SHA256 sidecar. Verify the
checksum, extract into a new version/source directory, and run that archive's
`.\sentry.ps1 version`, `.\sentry.ps1 setup -Distro Ubuntu`,
`.\sentry.ps1 tools -Distro Ubuntu`, then `.\sentry.ps1 open`.
Setup builds the Linux runtime through WSL2 using frozen dependencies. See the
[distribution guide](docs/setup/distribution.md) for checksums, prerequisites,
installation and safe maintenance procedure. Review candidates require owner
approval; there is no automatic updater.
Windows Node/pnpm/Git are not required for the packaged Desktop. Linux Node >=22,
pnpm 9.12.3, systemd user services, bubblewrap and socat remain required in WSL2.

Windows archives built from this revision register `sentry` during successful
setup. Open a new PowerShell or Command Prompt window and use `sentry open`,
`sentry stop`, `sentry status`, `sentry doctor` or `sentry version` from any folder.
If that archive moves, run `.\sentry.ps1 register-command` from its new directory.
The original published v1.0.0 archive predates built-in registration; its Release
page provides the matching installation instructions.

New imports omit common Python caches/environments and Next/Nuxt build output.
Source selection does not evaluate `.gitignore`; project data directories remain
eligible. Existing imported revision hashes remain compatible. Unreadable required
paths produce a permission error identifying the path. See the
[distribution guide](docs/setup/distribution.md#project-imports) for details.

## Historical source-beta installation prerequisites

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

## Historical Windows source-beta installation

Historical published-beta source reference, in PowerShell (the current Windows candidate uses the
separately approved archive/identity in the distribution guide):

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

## Deferred native CachyOS development / historical beta

Native Desktop is deferred for v1. These historical source-beta instructions
remain for development reference; they are not the Windows stable installation path.
In your graphical session:

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
`sentry update` refuses there. Source checkouts track only their selected
channel: branch `dev` follows `origin/dev`, branch `main` follows `origin/main`
— nothing switches channels automatically. There is no automatic GitHub
Release updater. For a later beta: cancel work, stop, fetch the announced tag,
check it out, and rerun setup. See [updating](docs/beta/updating.md).
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
