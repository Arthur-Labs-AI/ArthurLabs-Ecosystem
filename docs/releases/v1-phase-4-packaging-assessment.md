# Phase 4 packaging assessment

Audit before implementation, 2026-10-12. Approved origin/main:
`76257348a86406c8605f8f49cf17652c1dca75fa`. PR #5 is merged; Actions
38216565256 completed successfully in all three required jobs. Hosted sandbox
mount proofs were unavailable (existing fallback), not established by that CI.
The owner's primary checkout at 9c57e3f has unrelated modifications and is preserved.

## Observed architecture

```text
Git checkout + Windows Node/pnpm -> tsc main/preload + Vite renderer
  -> node_modules/electron/dist/electron[.exe] . --sentry-app
  -> Desktop: safeStorage + typed IPC + stdio client
  -> Windows: selected WSL2 distro / native Linux: CachyOS gate
  -> standalone Linux Node -> runtime/current/apps/runtime/dist/host.js
  -> SQLite, managed revisions/snapshots, independent selected agents

setup -> deploy-inner.sh -> Linux-owned version.tmp -> frozen install/build
      -> entry validation -> version directory -> current symlink
      -> external hello -> restore previous current on failure
```

Inspected README, architecture/v1-pipeline, development/branching, roadmap,
release checklist and beta/Phase 3 reports; beta getting-started/updating/
troubleshooting, WSL/native setup; package metadata/workspace/lock and ci.yml;
sentry.ps1/sentry, Windows launcher module/prerequisites/wsl-setup/commands,
native launcher/setup/open/update/status/deploy/desktop-ctl/CachyOS adapter;
deploy-wsl-runtime/deploy-inner; Desktop index/bootstrap, both platform
implementations, stdio client, provider credentials and Electron smoke.

| Classification                             | Evidence / implication                                                                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed packaging blocker                | No artifact build command exists. Development launchers resolve Electron under node_modules and pass `.`. Installed binaries need different argv and paths.                                                                                 |
| Confirmed packaging blocker                | Desktop main uses workspace ESM packages; copying dist alone cannot resolve them outside pnpm. Preserve dist/main, dist/preload, dist/renderer and assets relative paths; bundle the reachable main dependency graph and inspect externals. |
| Confirmed packaging blocker                | Runtime and launcher identity depend on Git or hardcoded beta fallbacks. Same product version spans many commits; release identity must include full source SHA and must fail closed when malformed.                                        |
| Confirmed installation/update safety issue | deploy-inner deletes an existing same-name version before renaming; repeating the same revision can destroy the rollback target. Release bootstrap must use unique deployment names and never overwrite an active candidate.                |
| Existing behavior safe to reuse            | Source updater requires clean main and fast-forward only. Keep release routing separate, with no fetch/update/download-on-open.                                                                                                             |
| Existing behavior safe to reuse            | Owned Desktop graceful shutdown refuses active QA; runtime transport refuses busy work. Keep this behavior; maintenance must stop or refuse before changing runtime.                                                                        |
| Existing behavior safe to reuse            | Source staging exclusions, frozen Linux install, transitive Turbo build and external handshake/rollback. Retain previous directories and use disposable data for candidate validation.                                                      |
| Platform-specific requirement              | Windows Electron uses WSL distro preference, wslpath and Linux Node, never Windows dependencies. Node >=22/pnpm 9.12.3 are Linux bootstrap prerequisites. WSL installation/conversion can require consent/reboot.                           |
| Platform-specific requirement              | Native Desktop factory enforces CachyOS; native launcher additionally needs graphical session, pacman, systemd user services, bubblewrap and socat. Ubuntu CI is portable logic evidence only.                                              |
| Platform-specific requirement              | Provider settings use Electron userData. Packaged product naming can change its default; explicitly retain the source application's @qa/desktop directory before credential loading. No credential conversion or copying between hosts.     |
| Future enhancement outside Phase 4         | Signing, NSIS/MSI, AppImage/AUR, automatic updates and offline Linux dependency payload. No stable release/tag/publication in this task.                                                                                                    |

Persistent state is outside the checkout: Linux ~/.local/share/sentry owns
runtime versions, canonical database, projects, revisions, workspaces, tools
and launcher/logs; Desktop appData/@qa/desktop owns encrypted credentials and
sentry-prefs. Windows launcher config/shim live under LOCALAPPDATA/Sentry.
Runtime deployment does not migrate/copy user data. An interrupted pre-activation
stage must leave current unchanged; an unverified first install has no current.
Runtime startup can run existing database migrations: candidate tests must use
disposable data and binary rollback must never promise a database downgrade.

## Format decision

| Candidate                                | Installation / privileges                                                          | Runtime and maintenance                                                    | Validation / cost                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Windows unpacked Electron ZIP (selected) | Extract into a version/SHA directory, user-owned, no admin for Desktop             | Explicit WSL bootstrap, retain old archive/directory, no auto-update       | Actual Windows build/launch available; unsigned checksum only; low complexity             |
| NSIS / MSI                               | Wizard and shortcuts, extra install-state/privilege semantics                      | Still needs WSL bootstrap; installer rollback cannot undo database changes | No clean Windows machine here; added maintenance and signing work without solving runtime |
| CachyOS versioned tar.gz (selected)      | Extract user-owned directory, explicit launch; system packages separately approved | Same Linux bootstrap/symlink model, explicit upgrade and rollback policy   | Can build on Linux WSL and inspect, but native CachyOS acceptance unavailable             |
| Native pacman/AUR package                | System package ownership and install scripts                                       | User runtime cannot safely be deployed by root package hooks               | Requires native packaging/host testing; private distribution and signing overhead         |
| AppImage                                 | Convenient executable, host FUSE/runtime differences                               | Still needs external Linux runtime and prerequisite bootstrap              | Additional compatibility surface; not a substitute for supported-host acceptance          |

All formats need authorized private delivery; no tokens in artifacts. Archives
need no Git on the tester host. Source setup remains available. Downloads for
Linux dependencies, host packages and pinned provider tools require internet.
Desktop includes Electron, so Windows Node/pnpm need not be end-user prerequisites.
Unsigned archives plus SHA256 detect corruption, not publisher authenticity:
obtain the checksum through the owner's trusted delivery channel.

Reference: [electron-builder v26 application contents](https://www.electron.build/v26/docs/contents/)
and [two-package staging](https://www.electron.build/v26/docs/tutorials/two-package-structure/).
Use a dedicated staged app with explicit files and no workspace symlinks; do
not trust v26 warnings as evidence of a complete dependency collection.

## Proposed boundaries and plan

```text
clean committed build input -> distribution builder
  -> bundled Desktop main + existing preload/renderer/assets + Electron
  -> allowlisted tracked Linux runtime source/build metadata + launcher scripts
  -> distribution.json + per-file SHA256 inventory + archive checksum
authorized extraction -> validate -> platform prerequisite checks
  -> stopped Desktop/runtime -> unique Linux candidate -> disposable hello
  -> current activation -> matching Desktop/runtime identity -> open
```

Architecture review answers:

1. Source of truth: root package version and clean Git HEAD at build time;
   generated manifest derives both. Runtime protocol remains owned by its package.
2. Ownership: builder writes artifacts only; bootstrap owns runtime staging/current;
   runtime alone owns domain storage; Electron alone owns encrypted preferences.
3. Dependencies: packaging consumes compiled app and tracked source, never reverses
   domain dependencies or changes the independent agent pipeline.
4. Boundary: manifest/checksum inventory and protocol hello carry public build
   identity, not credentials, live objects or database handles.
5. Failure: malformed/missing components reject before maintenance; failed staging
   leaves previous state; failed verification restores current or removes it.
6. Lifecycle: extract immutable Desktop directory, stage unique runtime, validate,
   activate; retain previous directories. Never remove data in repair/uninstall.
7. Tests: temporary roots, fake platform commands and real packaged Windows smoke;
   no destructive tests against the owner's installation.
8. Compatibility: source entry points retain old behavior; release commands refuse
   development update. Preserve userData naming and canonical Linux data paths.
   Beta migration is explicit backup/stop/side-by-side, with no schema downgrade promise.
9. Observability: manifest version/SHA, component checksums, hello identity, status,
   diagnostics and actual artifact smoke distinguish startup from readiness.
10. Security: allowlist tracked payloads, exclude private paths, reject unexpected
    files/symlinks/traversal, no hidden sudo, no paid probes, unchanged sandbox/IPC.

Implementation files: scripts/distribution (builder, validators, release entry
points, tests), minimal Desktop identity/packaged paths and runtime hello identity,
packaging workflow, platform guides and Phase 4 validation/roadmap/coordination.
Native CachyOS, clean Windows provisioning, beta GUI history acceptance and funded
provider checks remain separate gates. A bounded foundation is not Phase 4 closure.
