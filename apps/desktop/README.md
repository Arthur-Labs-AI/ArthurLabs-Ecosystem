# Sentry Desktop

Electron main owns secure provider settings, runtime connection, native dialogs
and typed command routing. The renderer has no Node/SQLite access and consumes
validated preload IPC. The Linux runtime owns the canonical database, project
lifecycle, execution lease, independent agents and persistent results. See the
[current architecture](../../docs/architecture/README.md).

Full and Targeted QA use configured production agents and can incur provider
charges. There is no product simulation mode. Credentials persist through
OS-backed encryption with no plaintext fallback; secrets are not returned to the
renderer. Historical phase-specific merger/verifier/retest descriptions are in
the [immutable archive](../../docs/history.md), not supported current UI promises.

## Develop

Install frozen dependencies and build from the repository root. Start the renderer:

```text
pnpm --filter @qa/desktop dev
```

Then launch Electron in another terminal, with the renderer URL explicitly set:

```powershell
$env:SENTRY_DESKTOP_URL = 'http://127.0.0.1:5174'
pnpm --filter @qa/desktop dev:electron
```

Use a disposable profile/runtime for tests. Unit/component/service/smoke coverage
runs with pnpm --filter @qa/desktop test; Electron tests require a graphical host.
Run [shared/static/package gates](../../docs/development/testing.md) and follow
the [Windows installation guide](../../docs/setup/distribution.md) for distribution.
