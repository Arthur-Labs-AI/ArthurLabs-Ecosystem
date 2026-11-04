# Windows CLI and upgrade release acceptance

These are the owner-required CLI and upgrade gates for v1.0.2 and later releases. Published Windows v1.0.0 and v1.0.1 omit the CLI frontend and
do not implement `sentry cli` in their archive launchers. The Desktop broker and
source CLI remain implemented. The v1.0.2 source implements the bundled frontend and
launcher forwarding for newly built archives. Release integration, exact-source
verification and publication still follow the normal owner-reviewed procedure.

## Packaged CLI acceptance

- Bundle the CLI frontend and everything needed to run it on a supported Windows
  installation. Do not silently introduce a requirement for Windows Node, pnpm,
  Git or a source checkout; the current archive installation requires none of them.
- Forward arguments through the registered `sentry` command and archive launcher.
  Verify invocation from any directory, paths containing spaces and Unicode,
  JSON stdout, diagnostic stderr, exit codes and expected missing-Desktop errors.
- Use the existing Desktop broker and canonical runtime. Project imports, QA,
  cancellation, results and exports must refer to the same records shown in the UI.
  Keep credentials in Desktop, retain the operational allowlist and never fall
  back to the development/direct database or weaken execution isolation.
- Exercise the exact extracted archive, with no source-checkout assistance:
  capabilities; agent readiness; project add/list/show/update/revisions/doctor;
  Full and Targeted QA; async start and polling; show/list/status; cancellation;
  JSON result; JSON/log export; and confirmed project deletion. Use disposable
  data and deterministic fixtures for automated run tests. Actual provider
  execution requires separate owner authorization; report its status honestly.
- Preserve async run IDs and uncertain-start errors so a transport failure cannot
  cause an automatic duplicate paid run. Cover complete machine JSON, export
  bounds and a disconnected CLI leaving an already-started run owned by runtime.
- Check command examples against the packaged parser and transport. Cover the
  actual workflow, not just `--help` or source-frontend mocks. Record command,
  archive checksum, source identity, platform, results and any unexecuted gates.

## Public wording and command examples

Use generic names such as "CLI", "automation client" and "external integration"
throughout new release notes, installation documentation, examples, visible help
and CLI output. Do not name a particular external application. Review generated
help from the packaged launcher and frontend as well as Markdown. Existing
source help strings have been made generic in this implementation; review their
generated output before publishing. Historical immutable tags and downloads stay unchanged.

Include copyable PowerShell examples for the operational commands in the
[CLI guide](../beta/cli.md#command-examples), with real flag names, clearly marked
ID/path placeholders, provider prerequisites, start/status/result/export order,
and explicit cancellation/deletion sections. Separate alternatives so copying
examples does not start several runs or delete a project unintentionally.
Only advertise additional legacy issue/retest operations after verifying that
the release's production runtime exposes and supports them.

## Updating an existing installation

Every new GitHub Release page must include an explicit **Update an existing
installation** section alongside its fresh-install PowerShell block. Populate
commands with that release's real version, asset names, full source SHA and pinned
SHA256; do not publish unresolved version placeholders or assumed filenames.

The documented procedure must:

1. Finish or cancel active work and gracefully stop the current Desktop/runtime.
2. Back up the actual stopped runtime data and Windows Desktop profile securely,
   honoring custom data roots and same-account/machine credential boundaries.
   Preserve projects, run history and provider settings; do not uninstall user
   data, delete WSL or require keys to be entered again as a normal upgrade step.
3. Download the exact ZIP and SHA256 sidecar with PowerShell using absolute paths
   that work from any working directory. Fail on download, sidecar, checksum or
   identity errors before installation. Never extract over the current directory.
4. Extract into a new version/source directory, verify it, and run that archive's
   setup/tools. Explain how successful setup registers the new command, when to
   open a new terminal, and how `register-command` repairs a moved archive.
5. Open the new Desktop and verify matching runtime/source/version, existing
   projects/results/settings, and `sentry version`, `sentry cli capabilities --json`
   and `sentry cli project list --json` through the registered command.
6. Retain the prior matched archive/runtime and stopped backup until acceptance.
   Explain failure handling and schema compatibility; binary rollback alone does
   not authorize restoring an older database or downgrading a migrated one.

Validate the update from the preceding stable release, v1.0.1 for the v1.0.2 transition, using
disposable populated data/profile and secure-settings fixtures. Report automated,
prepared-host and clean-machine evidence separately. A fresh install test does
not establish upgrade continuity. Follow the maintained
[upgrade/recovery procedure](../setup/distribution.md#explicit-release-upgrade-repair-and-source-beta-migration)
and [release checklist](../releases/RELEASE_CHECKLIST.md).

No version number, release date, publication, new archive or paid test is
authorized by these requirements alone.
