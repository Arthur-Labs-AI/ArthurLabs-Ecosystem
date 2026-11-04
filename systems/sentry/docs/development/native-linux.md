# Native Linux development handoff

The reserved branch `feature/native-linux-support` starts from main commit
`6793a9c53a336d577ac4397735d0396f558b60f0`, the published v1.0.1 source.
No Linux feature changes or native release acceptance are implied by its creation.

For a fresh development checkout:

```bash
git clone --branch feature/native-linux-support https://github.com/Mert1026/Sentry.git
cd Sentry
pnpm install --frozen-lockfile
pnpm build
```

Use Node >=22 and pnpm9.12.3. Coordinate integration PRs against dev with the
owner; keep main and published tags unchanged. After the documentation cleanup
lands, bring its documentation into this workstream through a reviewed merge.

Start with [architecture](../architecture/README.md), the
[Linux runtime boundary](../architecture/windows-wsl-runtime.md),
[experimental CachyOS setup](../setup/cachyos-launcher.md),
[testing](testing.md) and the [security model](../security/V1_THREAT_MODEL.md).
Windows Desktop relies on the shared Linux runtime, so preserve its tests and
isolation contracts while developing native Desktop support.

Historical evidence remains available at the immutable v1.0.0 tag:

- [Native large-import investigation](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/native-linux-large-import.md).
- [CachyOS archive smoke procedure](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-cachyos-rc1-smoke-guide.md).
- [Native recovery handoff](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-g10-recovery-cachyos-handoff.md).

Native import, graphical-session packaging and recovery need native-host evidence.
Ubuntu/WSL runtime or CI passes do not establish CachyOS Desktop acceptance.
See [history](../history.md) for the original reports and unresolved gates.
