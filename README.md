# A.R.T.H.U.R.

A.R.T.H.U.R. is a local-first knowledge application built with Tauri v2,
React, TypeScript and Rust. The product lives in [`apps/arthur`](apps/arthur).
One native runtime owns its app-local SQLite store; the UI accesses it through
`ArthurClient` and native commands.

The app supports text and Android voice capture, distillation into knowledge
objects with source provenance, projects, relations, immutable revision history,
recall, and review-first evolution. Model responses propose candidates; native
code validates authority, source spans and expected revisions before committing.
Cloud features require configured provider credentials and can send relevant
content to the selected provider.

## Development status

The development branch is `feature/nodes-integration`. M05 synchronization is a
**dormant qualification candidate**, not an enabled product feature. Production
remains schema v9 with closed trust/LAN activation. Passing debug tests does not
approve enrollment, physical LAN operation or a release.

See [M05 readiness and remaining gates](docs/architecture/m05-activation-readiness.md)
and the [M05 scope](docs/architecture/m05-project-capture-mvp.md). G5 owner policy,
G4 physical bounds and independent security/platform approvals remain required.

The older CLI/HTTP TypeScript runtime remains under its
[frozen subsystem policy](docs/competition/FROZEN_SUBSYSTEMS.md). Its separate
stores and configuration are not the product app's authoritative store.
Its previous setup guide is preserved as a
[historical reference](docs/legacy-runtime-setup.md).

## Get started

CI uses Node.js 24.13.1 and Rust 1.99.1. Install Node/npm first. Native desktop
builds also require Rust and the OS dependencies in the
[app toolchain guide](apps/arthur/README.md#native-toolchain).

```powershell
git clone https://github.com/Kaloyan3D/A.R.T.H.U.R.git
cd A.R.T.H.U.R
git switch feature/nodes-integration
npm ci
npm run arthur:install
npm run arthur:dev
```

`arthur:dev` runs the browser preview with a native-free preview client. It does
not open the native SQLite store. To run the real native app:

```powershell
cd apps/arthur
npm run tauri -- dev
```

Android builds require the JDK, SDK/NDK and Rust Android target. Follow the
[Android instructions](apps/arthur/README.md#android). Identity instrumentation
uses a separate qualification feature and application ID; leave that feature
off for normal builds.

## Verification

Run these from the repository root:

```powershell
npm run test:architecture
npm run arthur:check
cargo fmt --manifest-path apps/arthur/src-tauri/Cargo.toml -- --check
cargo clippy --locked --offline --manifest-path apps/arthur/src-tauri/Cargo.toml --lib -- -D clippy::all
cargo test --locked --offline --manifest-path apps/arthur/src-tauri/Cargo.toml --lib -- --test-threads=1
```

For a fresh Rust checkout, first run
`cargo fetch --locked --manifest-path apps/arthur/src-tauri/Cargo.toml`.
Install `rustfmt` and `clippy` with rustup if needed. The
[M05 workflow](.github/workflows/m05.yml) checks Windows native code,
architecture boundaries, frontend tests/typecheck/build and dependency isolation.
Single-threaded native execution preserves existing fault/qualification conditions.

Clippy warnings fail CI. Existing Rust dead-code warnings for dormant candidate
code remain visible; this is not a claim of `-D warnings` cleanliness. No new
blanket lint suppression is used to make the gate pass. Advisory review is a
separate release gate: the documented N1 blocker is not waived by these checks.

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/arthur/src` | React UI and `ArthurClient` boundary |
| `apps/arthur/src-tauri` | Rust runtime, SQLite, providers and platform adapters |
| `packages/contracts` | Shared UI/native data contracts |
| `tests/architecture` | Boundary, freeze and integration checks |
| `src`, `apps/cli`, `apps/api` | Older TypeScript runtime and entry points |
| `docs/architecture` | Contracts, decisions and readiness evidence |
| `hardware`, `tools` | Hardware work and development/qualification utilities |

UI code does not access SQLite, provider credentials, raw networking or Tauri
directly. Only the app's `src/client/tauri-ipc.ts` imports `@tauri-apps/*`.
Keep the single SQLite owner and frozen canonical journal/reducer/snapshot
contracts when changing native code.
