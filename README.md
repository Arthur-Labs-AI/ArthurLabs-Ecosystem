# ArthurLabs Ecosystem

Monorepo for the ArthurLabs products: **Nexus**, an AI engineering harness with a native desktop app, and the **ArthurLabs website**.

| Project | Path | What it is | Stack |
| --- | --- | --- | --- |
| **Nexus** | [`systems/nexus`](systems/nexus) | AI engineering assistant. A deterministic controller owns routing, attempts, verification and completion; the model implements. Includes the native Rust engine and the Tauri desktop app. | Rust, Tauri v2, React, TypeScript, PowerShell/POSIX installers |
| **Website** | [`website`](website) | Marketing site for the ArthurLabs product line (Suite, Studio, Nexus, Sentry, Hardware). | Next.js, React, Tailwind, GSAP, Playwright |

Studio, Sentry and Hardware appear as pages on the website. Their implementations are **not** in this repository. The Nexus snapshot contains Sentry-facing UI and audit fixtures, which belong to Nexus. See [the import report](docs/integration/NEXUS-IMPORT-REPORT.md).

## Repository layout

```
.
├── systems/
│   └── nexus/
│       ├── native/            Rust workspace: kernel, broker, daemon, CLI, tools, store, runtime
│       ├── apps/nexus-desktop Tauri desktop app (React UI + Rust backend) and release packaging
│       ├── runtime/           Pinned DSH runtime dependencies, vendored agent, patches
│       ├── config/, scripts/  Profiles, registry config, helper scripts
│       ├── docs/              Architecture, operations, Linux guide
│       └── setup.sh, setup.ps1  Installers for Linux and Windows
├── website/                   Next.js site (self-contained)
├── docs/integration/          Import and validation reports
└── .github/workflows/         CI: Nexus release workflow
```

## Nexus

Nexus moves engineering state out of the model and into deterministic controller records. Task identity, attempts, verification evidence, review requirements and completion live in the controller, and the UI observes that state. Key points:

- Execution classes (`deterministic`, `engineer_normal`, `engineer_deep`, `reviewer`, `solver`) bound to models by an engineering profile.
- Independent, read-only review when policy requires it.
- Durable task state and fail-closed behavior on missing or corrupt records.
- Sandboxed native engine on Linux, with a permission model for command execution.

Details: [`systems/nexus/README.md`](systems/nexus/README.md) and [`systems/nexus/docs`](systems/nexus/docs).

### Platform support

| Platform | Status |
| --- | --- |
| Linux x86_64 | Full app: native engine, sandbox, `.deb` package. Debian/Ubuntu (glibc 2.39+). |
| Linux ARM64 | Development builds (Fedora 44 verified). The release packaging scripts do not target ARM64. |
| macOS (Apple Silicon) | Desktop **shell only**. The sandboxed engine is Linux-bound, so engine commands return `engine-unavailable`. See [`M1-MACOS-DESKTOP-REPORT.md`](systems/nexus/M1-MACOS-DESKTOP-REPORT.md). |
| Windows | Supported by the legacy installer (`setup.ps1`). Not part of the native release workflow. |

### Run Nexus from source

Linux (user-scoped install, no sudo):

```sh
cd systems/nexus
./setup.sh
aih-key        # set your provider key
aih -Open      # open the app
```

Desktop app development (Fedora/Debian-style Linux, Rust and Node.js 22+):

```sh
cd systems/nexus/apps/nexus-desktop
npm ci
npm run desktop
```

On Fedora, install `gtk3-devel webkit2gtk4.1-devel librsvg2-devel patchelf` first. See [`apps/nexus-desktop/README.md`](systems/nexus/apps/nexus-desktop/README.md) for environment variables and troubleshooting.

### Checks

```sh
# Frontend
cd systems/nexus/apps/nexus-desktop
npm run typecheck && npm run lint && npm test

# Native workspace
cd systems/nexus/native
cargo fmt --check && cargo clippy --all-targets && cargo test
```

## Website

```sh
cd website
npm ci
npm run dev        # http://localhost:3000
npm run build
npm run typecheck
```

Needs Node.js 20.9+. End-to-end tests run with Playwright against the production export. See [`website/README.md`](website/README.md) for the full procedure, routes and structure.

## Releases

Nexus installers are built by [`.github/workflows/nexus-release.yml`](.github/workflows/nexus-release.yml):

- Trigger: push a `nexus-v*` tag, or run **Nexus release** from the Actions tab with a tag name.
- Linux job: builds and content-verifies the `.deb`.
- macOS job: builds the arm64 `.dmg`. It is ad-hoc signed and not notarized, so Gatekeeper will warn on first launch (right-click, then Open).
- The workflow creates a **draft** GitHub release with both installers and SHA-256 files. It never publishes on its own.

Published builds are listed under [Releases](https://github.com/Arthur-Labs-AI/ArthurLabs-Ecosystem/releases).

## Contributing

- Commits follow Conventional Commits with a scope: `feat(native): …`, `fix(registry): …`, `docs: …`, `test(native): …`.
- Branches are named `type/short-slug`, for example `feat/nexus-release-workflow`.
- Work in the subproject you are changing and run its checks before opening a PR.

## Security

Never commit provider keys, `auth.json`, `.env` files, logs, or session captures. If a credential is committed, rotate it right away. See [`systems/nexus/SECURITY.md`](systems/nexus/SECURITY.md).

## License

No license file is present in this repository yet. Until one is added, all rights are reserved by the authors.
