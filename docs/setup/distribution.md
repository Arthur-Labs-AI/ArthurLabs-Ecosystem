# Installing a pinned Sentry distribution candidate

Phase 4 candidates are unsigned review artifacts, not a v1 release. Supported
hosts are Windows 11 x64 with WSL2, and native CachyOS x64 with a graphical
session. Ubuntu CI/WSL builds do not establish native CachyOS acceptance.
There is no automatic update, offline install, signed installer or macOS support.
Versions remain 0.1.0-beta.1; **the full source SHA distinguishes candidates**.

Current review acceptance uses the [Phase5.3 exact I1 lock](../releases/v1-phase-5-3-candidate-lock.md)
and [native operator workflow](../releases/v1-phase-5-3-cachyos-operator.md).
The [recovery decision](../releases/v1-recovery-policy-decision.md) is pending
owner adoption; original-beta G10 remains historical FAIL. These handoffs do
not publish or authorize a release.

## Obtain, verify and extract

Use only an owner-approved private delivery channel. Private GitHub Actions
artifacts expire after seven days and are unsigned review candidates. Access
requires authorization; no GitHub token is embedded or needed during installation.
Obtain the matching `.sha256` through the owner's trusted channel. A checksum
detects corruption, not publisher identity if both files are substituted.

Archive names include version, 12-digit source SHA and target platform. Each
contains a versioned top-level directory. Never extract over an existing install.
Keep the previous verified archive/directory until the new candidate is accepted.

Windows PowerShell (replace placeholders with the actual approved filename):

```powershell
$archive = 'sentry-<version>-<sha12>-windows-x64.zip'
$expected = ((Get-Content -LiteralPath ($archive + '.sha256')) -split '\s+')[0]
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Checksum mismatch' }
Expand-Archive -LiteralPath $archive -DestinationPath "$env:LOCALAPPDATA\Sentry\distributions\<sha12>"
cd "$env:LOCALAPPDATA\Sentry\distributions\<sha12>\sentry-<version>-<sha12>-windows-x64"
.\sentry.ps1 version
```

CachyOS:

```bash
sha256sum -c sentry-<version>-<sha12>-cachyos-x64.tar.gz.sha256
mkdir -p "$HOME/.local/share/sentry/distributions/<sha12>"
tar -xzf sentry-<version>-<sha12>-cachyos-x64.tar.gz -C "$HOME/.local/share/sentry/distributions/<sha12>"
cd "$HOME/.local/share/sentry/distributions/<sha12>/sentry-<version>-<sha12>-cachyos-x64"
./sentry version
```

Keep this directory immutable. `version` checks the entire per-file inventory,
Desktop/runtime identities, and required resources without consulting Git.
Reject unexpected files, mismatched SHA/version, unsupported architecture and
missing components. Do not edit the manifest to repair an invalid archive.

## Windows 11 and WSL2 installation

Desktop bundles Electron and its reachable production dependency graph. Windows
Node, pnpm and Git are not required to launch/install Desktop. PowerShell and WSL
are host dependencies. Setup reuses the existing distro-selection/conversion/
reboot guidance, ignores utility distros, and can pause with exit 75. Rerun after
reboot/Ubuntu account creation. It does not start a paid agent.

```powershell
.\sentry.ps1 setup -Distro Ubuntu
```

Bootstrap requires **standalone Linux Node >=22** and **Linux pnpm 9.12.3**,
systemd user services, bubblewrap and socat. If absent it fails with guidance.
Install prerequisites inside Ubuntu/WSL (not in Windows):

```bash
node --version                         # >=22; must also resolve via direct wsl.exe execution
npm install --prefix "$HOME/.local/share/sentry/pnpm" pnpm@9.12.3
export PATH="$HOME/.local/share/sentry/pnpm/node_modules/.bin:$PATH"
sudo apt update
sudo apt install -y bubblewrap socat systemd
systemctl --user show-environment
```

For missing Node follow [the WSL setup guide](wsl-runtime.md); install Linux Node
22+ so `wsl -d Ubuntu -- node --version` succeeds. For pinned pnpm, add a
user-owned symlink from its executable to `~/.local/bin/pnpm` and make that
directory visible to direct WSL execution, or install the pin through the
host's existing supported package manager. A login-shell-only PATH is insufficient.
Enable `systemd=true` under `[boot]` in `/etc/wsl.conf`, preserving/backing up
existing settings; terminate only the selected idle distro and restart it.
If required, `sudo loginctl enable-linger "$USER"`. These privileged commands
are **manual, explicit actions**. Bootstrap does not run hidden sudo.

After prerequisites, repeat setup from the archive. It copies only the allowlisted
runtime source into a Linux-owned unique version directory, installs the frozen
dependency graph and builds it there. Logs are under Linux
`~/.local/share/sentry/logs/release-*.log`. Internet is required for npm/pnpm
dependencies and provider tooling, and potentially OS packages. No manual monorepo
build is required. Runtime validation and shutdown use disposable data, not your DB.

```powershell
.\sentry.ps1 tools -Distro Ubuntu       # pinned tool provisioning; no provider requests
.\sentry.ps1 open
.\sentry.ps1 status
.\sentry.ps1 doctor
.\sentry.ps1 stop
```

The selected WSL distro is saved through Desktop's existing preference mechanism.
`tools` installs tested OpenCode 1.18.32, DeepSeek SDK wrapper 0.1.5-rc.2 and
Claude Code 2.1.270, and persists non-secret binary paths through Desktop.
Configure credentials only in **Settings → Providers**. Verify Environment's
connected Linux runtime and readiness for your selected agents before QA.
Process launch or credential presence does not prove provider credit/readiness.

## CachyOS installation

Use your normal graphical session, never root. Setup rejects other native Linux
distributions and missing graphics. System prerequisites (explicit manual action):

```bash
sudo pacman -S --needed nodejs npm systemd bubblewrap socat curl ca-certificates
node --version                          # >=22
systemctl --user show-environment
bwrap --dev-bind / / --proc /proc /usr/bin/true
npm install --prefix "$HOME/.local/share/sentry/pnpm" pnpm@9.12.3
export PATH="$HOME/.local/share/sentry/pnpm/node_modules/.bin:$PATH"
./sentry setup
./sentry tools
./sentry open
./sentry status
./sentry doctor
./sentry stop
```

No system package hooks, global npm provider installs or automatic shell-rc edits.
Keep Electron/worker sandboxes enabled. If Chromium cannot create its sandbox,
repair host user-namespace/prerequisite configuration; never add `--no-sandbox`.
`tools` uses the existing managed installers and persists paths through packaged
Desktop. Configure credentials and check Environment. These native steps remain
**ENVIRONMENT UNAVAILABLE in the Phase 4 agent validation** until the owner runs
them on actual CachyOS. No AppImage/AUR/native package is promised.

## Explicit release upgrade, repair and source-beta migration

`sentry update` in an archive always refuses. It never follows origin/dev,
origin/main, or downloads another candidate. Source clones retain the development-only updater;
pinned source-beta tags retain their existing refusal. Archive commands do not
replace the existing global source shim: invoke `./sentry` / `.\sentry.ps1` in the
chosen archive directory or create your own user-owned shortcut after acceptance.
This avoids silently changing the owner's source channel.

1. Cancel QA and retests, wait for terminal outcomes, stop the owning Desktop.
   Setup requests graceful Windows shutdown and refuses if processes remain;
   Linux bootstrap conservatively refuses any running Sentry runtime. No process
   is killed as a maintenance shortcut. Also close source Desktop instances that
   are offline before maintenance. Do not run source setup and release setup together.
2. With all Sentry components stopped, back up the **actual** Linux data root
   shown by Environment (default `~/.local/share/sentry`; honor any prior
   `SENTRY_DATA_ROOT` / XDG override), plus Desktop's
   `%APPDATA%\@qa\desktop` or Linux appData `@qa/desktop` directory. Keep the
   backup private. It contains databases/projects and encrypted provider stores.
   Do not copy/decrypt credentials to another OS/user/keychain.
3. Extract and verify the newly approved archive in a separate version/SHA
   directory. Run its setup/tools; open it and confirm Environment, import a
   disposable project, and reopen history/results. Runtime and Desktop must match
   full SHA/version; a mismatch refuses boot instead of reporting health.
4. Setup validates the candidate before atomically moving `runtime/current`, then
   verifies that target again. Failure restores the previous symlink or removes
   current on first-install failure. Unique directories preserve same-version
   rollback candidates. User data and encrypted settings are never deleted.
5. Repair is the same archive's `setup` (`repair` is an alias). It stages another
   unique runtime; it never overwrites the currently active directory.

This is the supported **manual side-by-side beta migration**; there is no automatic
discovery/conversion of arbitrary source installations. The runtime data layout
and database schema are unchanged in Phase 4; existing project/revision/run/
findings/evidence/issue/retest records stay canonical. Automated fixtures verify
that maintenance leaves synthetic existing files byte-identical. The Phase 4
packaged Windows smoke also reopens a disposable database seeded by the published
beta, including completed QA, finding/evidence and historical issue/retest records.
Real user history and encrypted-settings continuity remain owner acceptance gates;
see [the validation report](../releases/v1-phase-4-validation.md).

Rollback after a failed pre-activation install uses the previous executable and
runtime. After launching a newer version, **do not downgrade a migrated DB**:
check migration/release policy first. If incompatible, restore the matching stopped
backup and matching old binary/runtime together. Binary rollback does not reverse
schema changes. Keep old source clones usable and untouched as a recovery option.

**Phase5 acceptance finding (2026-10-13):** a disposable same-account Windows
rollback to the immutable source beta, with matching stopped data/project/profile
and beta binary/runtime restored together, retained history/ciphertext but failed
credential availability. Candidate D could read the same encrypted store; beta
loaded it before Electron readiness. G10 is FAIL and this beta downgrade is not
an accepted credential-continuity recovery procedure. Retain private backups and
stop the affected rollback track pending owner disposition of the
[bounded correction proposal](../releases/v1-beta-rollback-credential-proposal.md).
No replacement rollback policy or real-owner key re-entry is authorized by this
guide. Full native CachyOS and complete upgrade/export acceptance remain outstanding.

**Phase5.2 recovery proposal:** actual disposable Windows I1 recovery restored a
verified stopped beta data/profile pair under the corrected Desktop/runtime,
retaining populated history, actual JSON/log exports, credentials and model
preferences through repeated restart/restore. See the [validation receipt](../releases/v1-phase-5-2-g10-recovery-validation.md),
[paired backup/recovery contract](../releases/v1-g10-recovery-contract.md) and
[unexecuted native handoff](../releases/v1-g10-recovery-cachyos-handoff.md).
This is a validated proposed recovery candidate pending owner adoption, not an
approved beta downgrade or automatic owner-data restore. Original G10 FAIL and
native/owner acceptance gates remain separate. Do not operate on live data or
replace a supported recovery policy based only on this synthetic result.

## Failed/interrupted setup and uninstall

Read the printed log and fix the prerequisite/corruption cause, then rerun setup.
Unverified staging directories are never considered active. A crash can leave
`runtime/.release-maintenance`; first confirm every Desktop/runtime and installer
is stopped, inspect its contents and current target, then remove **only that lock**
and retry. Do not erase the runtime root, credentials or databases to repair setup.
Retain failed candidate/logs for reviewed diagnostics, never publish them blindly.

To uninstall application components: stop Sentry, remove only the chosen archive
directory/shortcut. Runtime directories are separate; remove only identified
inactive deployments after checking current and retaining needed rollback versions.
Do not delete `~/.local/share/sentry`, Desktop appData or provider stores unless
separately choosing data removal. The source shim remains owned by source setup.

## Owner acceptance procedure (no paid calls by default)

For the v1 acceptance campaign use the comprehensive
[Windows/WSL and native CachyOS runbook](../releases/v1-owner-acceptance.md),
[per-host results template](../releases/v1-owner-acceptance-results.md) and
[v1 checklist](../releases/V1_ACCEPTANCE_CHECKLIST.md). The summary below remains
a setup reference. Final PR head and later merge SHA are distinct candidates;
record archive SHA256/full source identity and post-merge CI explicitly.

For **each actual supported host**, use a clean user/machine where possible and
record OS/build, Node/pnpm, full SHA, archive SHA256 and each result:

1. Validate checksum and `version`; try a tampered copy and an extraction path with spaces.
2. Exercise absent WSL/distro/reboot on Windows, or missing system packages on
   CachyOS. Verify guidance and absence of hidden elevation. Repair prerequisites.
3. Run setup, repeat setup; record distinct runtime directories and matching hello.
4. Run tools/open; verify Environment/secure preload and project import. Reopen
   history from a stopped beta backup. Confirm provider settings persist.
5. Open a second time and confirm a single instance; stop gracefully, then reopen.
6. With explicitly authorized provider execution only, run selected agents and
   attempt maintenance while QA is active; expect refusal and retained results.
   Cancel/wait, then retry. No funded calls are authorized by this procedure alone.
7. Install another approved SHA side by side; verify history/data/settings, then
   deliberately use a corrupted archive and confirm no replacement. Exercise
   candidate/active handshake failure only in disposable fixtures/installation.
8. Record repair, failed first-install recovery and upgrade rollback. Confirm
   runtime/current restoration and no database downgrade. Report manual outcomes
   separately from generic CI and mocked fixtures.

Maintainer build: clean committed native x64 checkout, `pnpm install --frozen-lockfile`,
`pnpm build`, `pnpm distribution:test`, then `pnpm distribution:build windows-x64`
on Windows or `pnpm distribution:build cachyos-x64` on Linux. Output is under
ignored `dist/distributions`; binaries are never committed or automatically published.
Same-SHA output directories are not overwritten; preserve receipts and use a new
clean validation checkout for a repeat build.
