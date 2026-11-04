# Testing and verification

Run the applicable gates from the exact candidate checkout:

```text
pnpm install --frozen-lockfile
pnpm repository:check
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm distribution:test
git diff --check
```

Full shared/runtime and physical sandbox tests need a capable Linux host with
systemd user services and bubblewrap. Windows platform skips do not establish
Linux trust. Hosted quality can explicitly report sandbox trust unverified;
record separately executed capable-host evidence when required. For constrained
hosts, limit workers while retaining all tests, for example:

```text
pnpm exec turbo run test --force --concurrency=2 -- --maxWorkers=1 --minWorkers=1
pnpm --filter @qa/desktop exec vitest run --maxWorkers=2 --minWorkers=1
```

Use disposable data and explicit profiles for packaged Electron/runtime tests.
Verify full source/version/protocol, secure settings, original source preservation,
history, stop/reopen and refusal/cancellation paths. Clean-machine provisioning,
paid-provider campaigns and real elevated compaction are separate operator gates;
do not claim them from mocks or prepared-host checks. Never weaken sandbox or
evidence assertions to obtain a pass. Report PASS, FAIL and NOT EXECUTED with the
actual command, source and platform. Historical failures stay attributable through
the [immutable history index](../history.md).

Before documentation changes merge, verify internal Markdown paths/anchors,
README navigation and immutable historical links, and ensure build/launcher
documentation dependencies still resolve. Packaging copies setup/distribution.md
into INSTALL.md; retain accurate installation and recovery guidance there.
