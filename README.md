# ArthurLabs Ecosystem

Monorepo for the ArthurLabs products: **Nexus**, an AI engineering harness; **Sentry**, a local-first AI QA desktop app; **A.R.T.H.U.R.**, a local-first knowledge app; and the **ArthurLabs website**.

| Project | Path | What it is | Stack |
| --- | --- | --- | --- |
| **Nexus** | [`systems/nexus`](systems/nexus) | AI engineering assistant. A deterministic controller owns routing, attempts, verification and completion; the model implements. Ships in two editions: **Nexus DSH** and **Nexus Native** (see below). | Rust, Tauri v2, React, TypeScript, PowerShell/POSIX installers |
| **Sentry** | [`systems/sentry`](systems/sentry) | Local-first AI QA. OpenCode, DeepSeek and GLM (via Claude Code) independently investigate one immutable project snapshot and return findings, evidence, token usage and persistent run history. | TypeScript, pnpm + Turbo monorepo, Electron desktop, CLI |
| **A.R.T.H.U.R.** | [`systems/arthur`](systems/arthur) | Local-first knowledge app. Captures text and Android voice, distills it into knowledge objects with source provenance, projects, relations and immutable revision history, with recall and review-first evolution. One native runtime owns an app-local SQLite store. | Tauri v2, React, TypeScript, Rust, Android |
| **Website** | [`website`](website) | Marketing site for the ArthurLabs product line (Suite, Studio, Nexus, Sentry, Hardware). | Next.js, React, Tailwind, GSAP, Playwright |

Studio and Hardware appear as pages on the website only. Their implementations are not in this repository. Import history: [Nexus](docs/integration/NEXUS-IMPORT-REPORT.md), [Sentry](docs/integration/SENTRY-IMPORT-REPORT.md), [A.R.T.H.U.R.](docs/integration/ARTHUR-IMPORT-REPORT.md).

## Repository layout

```
.
├── systems/
│   ├── nexus/
│   │   ├── native/             Nexus Native: Rust workspace (kernel, broker, daemon, CLI, tools, store, runtime)
│   │   ├── apps/nexus-desktop  Nexus Native desktop app (Tauri, React + Rust) and release packaging
│   │   ├── runtime/, ui/       Nexus DSH: pinned DSH runtime, vendored agent, patches, Control Room UI
│   │   ├── bin/, config/, scripts/  `aih` commands, profiles, registry config, helpers (DSH)
│   │   ├── docs/               Architecture, operations, Linux guide
│   │   └── setup.sh, setup.ps1 Installers (Linux, Windows) for Nexus DSH
│   ├── sentry/
│   │   ├── apps/               desktop, cli, runtime
│   │   ├── packages/           run-engine, snapshot-engine, harnesses (claude-code, deepseek, opencode), persistence, ...
│   │   └── docs/               Setup, security, architecture, ADRs
│   └── arthur/
│       ├── apps/arthur         Tauri app (React UI + Rust runtime + SQLite store), Android
│       ├── packages/, src/     Shared packages and the older CLI/HTTP TypeScript runtime (frozen)
│       └── docs/, hardware/    Architecture, milestone gates, hardware notes
├── website/                    Next.js site (self-contained)
├── docs/integration/           Import and validation reports
└── .github/workflows/          CI: Nexus release workflow
```

## Nexus

Nexus moves engineering state out of the model and into deterministic controller records. Task identity, attempts, verification evidence, review requirements and completion live in the controller, and the UI observes that state. Key points:

- Execution classes (`deterministic`, `engineer_normal`, `engineer_deep`, `reviewer`, `solver`) bound to models by an engineering profile.
- Independent, read-only review when policy requires it.
- Durable task state and fail-closed behavior on missing or corrupt records.

Details: [`systems/nexus/README.md`](systems/nexus/README.md) and [`systems/nexus/docs`](systems/nexus/docs).

### Two editions

Both editions are maintained. Neither replaces the other.

| | **Nexus DSH** | **Nexus Native** |
| --- | --- | --- |
| Built on | The DeepSeek Harness (DSH) runtime: its sessions, tools, permissions, Git integration and web UI | A Rust engine with its own kernel, broker, daemon and sandboxed tools |
| Interface | Universal Nexus app and Control Room, opened with `aih -Open` | Tauri desktop app |
| Install | `setup.sh` (Linux) or `setup.ps1` (Windows) | `.deb` / `.dmg` from [Releases](https://github.com/Arthur-Labs-AI/ArthurLabs-Ecosystem/releases), or build from source |
| Platforms | Windows and Linux x86_64 | Linux x86_64 and macOS Apple Silicon |
| Code | `runtime/`, `ui/`, `bin/`, `config/`, `scripts/` | `native/`, `apps/nexus-desktop/` |

### Platform support

| Platform | Nexus DSH | Nexus Native |
| --- | --- | --- |
| Linux x86_64 | Supported | Full app: engine, sandbox, `.deb` package (Debian/Ubuntu, glibc 2.39+) |
| Linux ARM64 | Not documented | Development builds (Fedora 44 verified). Release packaging does not target ARM64. |
| macOS (Apple Silicon) | Not documented | Full app. The sandboxed Linux engine runs in an embedded headless microVM (Apple Virtualization.framework, no UTM or SSH), about 3 s to ready. Builds without the engine image are a UI-only shell. See [`M4-EMBEDDED-ENGINE-REPORT.md`](systems/nexus/M4-EMBEDDED-ENGINE-REPORT.md). |
| Windows | Supported | Not part of the native release workflow |

### Run Nexus DSH from source

Linux (user-scoped install, no sudo):

```sh
cd systems/nexus
./setup.sh
aih-key        # set your provider key
aih -Open      # open the app
```

Windows: run `setup.ps1` from PowerShell. See [`systems/nexus/README.md`](systems/nexus/README.md) and the [Linux guide](systems/nexus/docs/linux.md).

### Run Nexus Native from source

Needs Rust and Node.js 22+. On Fedora, first install `gtk3-devel webkit2gtk4.1-devel librsvg2-devel patchelf`.

```sh
cd systems/nexus/apps/nexus-desktop
npm ci
npm run desktop
```

See [`apps/nexus-desktop/README.md`](systems/nexus/apps/nexus-desktop/README.md) for environment variables and troubleshooting.

### Checks

```sh
# Nexus Native frontend
cd systems/nexus/apps/nexus-desktop
npm run typecheck && npm run lint && npm test

# Nexus Native Rust workspace
cd systems/nexus/native
cargo fmt --check && cargo clippy --all-targets && cargo test

# Nexus DSH
cd systems/nexus
aih-test
```

## Sentry

Sentry imports a project into a managed copy with an immutable revision, then lets one to three agents investigate it independently. Projects and history stay local. Selected agents send relevant source and evidence to the providers you configure, so review their policies before importing confidential code.

- **Platform:** Windows 11 x64 with WSL2 (Ubuntu preferred). Native Linux desktop is deferred.
- **Latest stable:** [Sentry v1.0.2](https://github.com/Mert1026/Sentry/releases/tag/v1.0.2). The ZIP is unsigned and bootstraps its Linux runtime online. There is no automatic updater.
- **Install and use:** `sentry setup`, `sentry open`, `sentry doctor`, and `sentry cli ... --json` for automation. See [`systems/sentry/README.md`](systems/sentry/README.md).

Develop (Node 22+, pnpm 9.12.3):

```sh
cd systems/sentry
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm --filter @qa/desktop dev:electron
```

Development needs a Linux or WSL environment with systemd user services, bubblewrap and socat. See [`CONTRIBUTING.md`](systems/sentry/CONTRIBUTING.md) and the [documentation index](systems/sentry/docs/README.md).

## A.R.T.H.U.R.

A.R.T.H.U.R. keeps your knowledge in an app-local SQLite store owned by one native runtime; the UI reaches it through `ArthurClient` and native commands. Model responses only *propose* candidates. Native code validates authority, source spans and expected revisions before anything is committed. Cloud features need provider credentials and can send relevant content to the selected provider.

- **Status:** in development. M05 synchronization is a dormant qualification candidate, not an enabled feature. Production stays on schema v9 with closed trust/LAN activation. See [M05 readiness](systems/arthur/docs/architecture/m05-activation-readiness.md).
- **Legacy runtime:** the older CLI/HTTP TypeScript runtime under `src/` is under a [frozen subsystem policy](systems/arthur/docs/competition/FROZEN_SUBSYSTEMS.md) and is not the app's authoritative store.

Develop (Node.js 24.13.1 and Rust 1.99.1 in CI):

```sh
cd systems/arthur
npm ci
npm run arthur:install
npm run arthur:dev                # browser preview with a native-free client (no SQLite)
cd apps/arthur && npm run tauri -- dev   # the real native app
```

Android builds need the JDK, Android SDK/NDK and the Rust Android target. See [`systems/arthur/README.md`](systems/arthur/README.md) and [`apps/arthur/README.md`](systems/arthur/apps/arthur/README.md).

Checks (from `systems/arthur`): `npm run test:architecture` and `npm run arthur:check`, plus `cargo fmt`, `cargo clippy` and `cargo test` against `apps/arthur/src-tauri/Cargo.toml` as listed in its README.

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

**Nexus Native** installers are built by [`.github/workflows/nexus-release.yml`](.github/workflows/nexus-release.yml):

- Trigger: push a `nexus-v*` tag, or run **Nexus release** from the Actions tab with a tag name.
- Linux job: builds and content-verifies the `.deb`.
- Engine image job: builds the Fedora ARM64 guest image and kernel on an ARM64 Linux runner.
- macOS job: builds the app with the embedded VM engine and packages the arm64 `.dmg` (about 430 MB). It is ad-hoc signed and not notarized, so Gatekeeper will warn on first launch (right-click, then Open).
- The workflow creates a **draft** GitHub release with both installers and SHA-256 files. It never publishes on its own.

Published builds are listed under [Releases](https://github.com/Arthur-Labs-AI/ArthurLabs-Ecosystem/releases). Sentry releases are published separately on its own repository (link above).

## Contributing

- Commits follow Conventional Commits with a scope: `feat(native): …`, `fix(registry): …`, `docs: …`, `test(native): …`.
- Branches are named `type/short-slug`, for example `feat/nexus-release-workflow`.
- Work in the subproject you are changing and run its checks before opening a PR.
- A.R.T.H.U.R. enforces architecture boundaries in CI (`npm run test:architecture`); run it before opening a PR.
- Sentry has its own rules (branching, review, agent instruction files): read [`systems/sentry/CONTRIBUTING.md`](systems/sentry/CONTRIBUTING.md) first.

## Security

Never commit provider keys, `auth.json`, `.env` files, logs, or session captures. If a credential is committed, rotate it right away. See [`systems/nexus/SECURITY.md`](systems/nexus/SECURITY.md) and the Sentry [threat model](systems/sentry/docs/security/V1_THREAT_MODEL.md).

## License

Licenses are per project:

- **Sentry:** MIT, see [`systems/sentry/LICENSE`](systems/sentry/LICENSE).
- **A.R.T.H.U.R.:** `UNLICENSED` in its `package.json` (proprietary, no open-source license).
- **Nexus and website:** no license file yet. Until one is added, all rights are reserved by the authors.
