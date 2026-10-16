# Getting started with Windows Stable

1. Run the PowerShell download/install commands on the [v1.0.1 Release](https://github.com/Mert1026/Sentry/releases/tag/v1.0.1). They use absolute paths and verify the downloaded ZIP against its SHA256 sidecar.
2. Follow the [installation guide](setup/distribution.md): verify the checksum,
   extract into a new version/source directory, install WSL prerequisites, and run
   setup/tools/open from that directory. Windows11 x64 + WSL2 is required; Ubuntu
   is preferred. Native Desktop is deferred and this ZIP is unsigned.
3. Configure **Settings → Providers**. Credentials persist with OS-backed
   encryption; unavailable encryption has no plaintext persistence fallback.
4. Check **Environment**. Diagnostics do not spend provider credit, but readiness
   does not guarantee account credit or provider acceptance.
5. Import a local source folder. Sentry creates managed data and an immutable
   revision, preserving the original source.
6. Select agents and start Full QA or Targeted QA. Providers receive relevant
   source/evidence and may charge for requests. Inspect findings and exports.
7. Cancel work and wait before closing or maintenance. Project removal confirms
   managed-data/history deletion while preserving the imported source folder.

After setup, open a new terminal and use `sentry doctor`, `sentry status`,
`sentry stop` and `sentry open` from any folder. Keep the archive directory in
place; run `.\sentry.ps1 register-command` there after moving it. Use stop/open for
graceful restart. Updates require another verified archive in a separate directory;
there is no automatic updater. See [troubleshooting](beta/troubleshooting.md),
[recovery boundaries](releases/v1-recovery-policy-decision.md), and the
[source CLI contract](beta/cli.md) for integrators using a source checkout.
