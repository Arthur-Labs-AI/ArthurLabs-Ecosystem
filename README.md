# Sentry

Sentry is a local-first AI QA desktop application. OpenCode, DeepSeek, and GLM
through Claude Code independently investigate one immutable project snapshot
and return findings, evidence, token usage, and persistent run history.

**[Sentry v1.0.1 — Windows Stable](https://github.com/Mert1026/Sentry/releases/tag/v1.0.1)**
supports **Windows 11 x64 with WSL2**, with Ubuntu preferred. The unsigned ZIP uses
an online Linux runtime bootstrap. Native Linux Desktop is deferred.

## Install and start

Use the PowerShell download/install block on the stable Release page to obtain
the Windows ZIP and matching SHA256 sidecar from any working directory.
[Verify the checksum and extract into a new directory](docs/setup/distribution.md),
then run from the extracted archive:

```powershell
.\sentry.ps1 version
.\sentry.ps1 setup -Distro Ubuntu
.\sentry.ps1 tools -Distro Ubuntu
.\sentry.ps1 open
```

Windows Node/pnpm/Git are not required for packaged Desktop. WSL setup requires
standalone Linux Node >=22, pnpm **9.12.3**, systemd user services, bubblewrap and socat.
Prerequisites can require manual administrator actions and a reboot. There is no
automatic updater or signed installer. See [getting started](docs/getting-started.md)
and the [installation and maintenance guide](docs/setup/distribution.md).

Successful v1.0.1 setup registers the per-user command. Open a new PowerShell or
Command Prompt window and use `sentry open`, `sentry stop`, `sentry status`,
`sentry doctor` or `sentry version` from any folder. Keep the extracted archive
in place; after moving it, run `.\sentry.ps1 register-command` there.

New imports skip common generated caches and environments. Source selection does
not evaluate `.gitignore`; data directories remain eligible. Existing revision
hashes stay compatible. See [project imports](docs/setup/distribution.md#project-imports).

## Run QA

1. Configure **Settings → Providers** and check **Environment**. Third-party
   accounts and provider charges may apply; diagnostics do not make paid calls.
2. Add a project. Sentry creates a managed copy and immutable revision while
   preserving the original source folder.
3. Select one, two or three agents and start Full QA or Targeted QA with paths.
4. Inspect independent findings/evidence and export JSON or logs. Cancel active
   work and wait for it to settle before shutdown or maintenance.

Project removal confirms deletion of managed data/history and preserves imported
originals. Optional WSL disk reclamation requires confirmation and administrator
consent; reclaimed Windows space varies. Historical merger/verifier/retest
components are not advertised as active Desktop QA flows.

## Security and recovery

Projects/history stay local, but selected agents send relevant source and evidence
to configured providers. Assess provider policies before importing confidential
code. Model output is untrusted and QA cannot guarantee every defect is found.
Credentials use OS-backed encryption, with no plaintext persistence fallback.
Never share provider keys, profile databases, credential stores or unreviewed logs.

Read the [threat model](docs/security/V1_THREAT_MODEL.md),
[maintenance boundary](docs/security/wsl-maintenance.md), and
[recovery policy](docs/releases/v1-recovery-policy-decision.md).
The original beta executable is not an approved credential downgrade target.

## Documentation and development

- [Documentation index](docs/README.md)
- [Troubleshooting](docs/beta/troubleshooting.md)
- [Source CLI and broker automation](docs/beta/cli.md)
- [Contributing and development](CONTRIBUTING.md)
- [Architecture](docs/architecture/README.md) and [decision records](docs/adr/0001-monorepo.md)
- [Stable notes](docs/releases/v1.0.1.md) and [changelog](CHANGELOG.md)
- [Testing](docs/development/testing.md), [release procedure](docs/releases/RELEASE_CHECKLIST.md)
  and [branching policy](docs/development/branching.md)
- [Historical reports and failed-test evidence](docs/history.md)

See [LICENSE](LICENSE).
