# Documentation

## Users

- [Getting started](getting-started.md)
- [Windows installation, prerequisites, manual updates and maintenance](setup/distribution.md)
- [Troubleshooting](beta/troubleshooting.md)
- [Stable v1.0.2 CLI release notes](releases/v1.0.2.md), [v1.0.1 patch notes](releases/v1.0.1.md), [v1.0.0 notes](releases/v1.0.0.md) and [changelog](../CHANGELOG.md)
- [Recovery policy](releases/v1-recovery-policy-decision.md) and [paired-backup contract](releases/v1-g10-recovery-contract.md)
- [Security/threat model](security/V1_THREAT_MODEL.md) and [privileged maintenance boundary](security/wsl-maintenance.md)

## Maintainers and integrators

- [Contributing](../CONTRIBUTING.md) and [testing](development/testing.md)
- [Architecture](architecture/README.md) and [branching](development/branching.md)
- [Release checklist](releases/RELEASE_CHECKLIST.md) and [next Windows release requirements](development/next-windows-release.md)
- [CLI broker contract](beta/cli.md) and [source update policy](beta/updating.md)
- [Windows runtime details](setup/wsl-runtime.md), [OpenCode setup](setup/opencode.md)
  and [native Linux workstream](development/native-linux.md) and [experimental CachyOS setup](setup/cachyos-launcher.md)
- [Historical reports, screenshots and original failed gates](history.md)

The beta/cli, beta/updating and beta/troubleshooting paths are retained because
source launchers reference them. The v1.0.2 Windows archive includes the production CLI frontend and uses its
included Electron runtime. Native Desktop remains a deferred development target.
