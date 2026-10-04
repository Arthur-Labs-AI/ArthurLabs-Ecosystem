# apps/arthur

The single A.R.T.H.U.R. product application: Tauri v2 + React + TypeScript + Vite.
One shared UI for Linux, Windows and (later) Android; macOS and iOS after that.

**Status:** foundation shell. It renders runtime information obtained through
`ArthurClient`. Capture, graph, sync, voice and EMG are not implemented.

```text
src/                  React UI (platform-independent)
  app/                providers, layout, App
  client/             ArthurClient interface + desktop / mobile / preview implementations
  features/           one folder per product area (only settings/ so far)
  hooks/              shared hooks (useArthurClient)
src-tauri/            Rust native layer
  src/commands/       Tauri commands exposed to the UI
  src/platform/       OS detection
  capabilities/       Tauri permission sets
```

Shared data shapes live in [`packages/contracts`](../../packages/contracts) and
are imported as `@arthur/contracts`.

## Rules

- **UI talks to Arthur through `ArthurClient` only** (`src/client/arthur-client.ts`).
  Components do not use `@tauri-apps/*`, `fetch`, localhost or Tailscale
  addresses, SQLite, Node APIs, or `src/` (Arthur Core).
- `@tauri-apps/*` is imported only in `src/client/tauri-ipc.ts`.
- The client implementation is chosen once, in `app/providers.tsx`.
- To give the UI a new capability: add it to the `ArthurClient` interface and
  its contract types, implement it in each client, and add a Tauri command if
  it needs the native layer.

These rules are enforced by `tests/architecture` in the repository root.

## Commands

Run from this directory, or use the `arthur:*` scripts from the repository root.

```bash
npm ci               # install (root: npm run arthur:install)
npm run dev          # Vite in the browser; uses the native-free preview client
npm test             # Vitest
npm run check        # tests + typecheck + production build (root: npm run arthur:check)
npm run tauri dev    # native window; needs the toolchain below
npm run tauri build  # bundle for the current OS
```

## Native toolchain

`npm run dev`, `npm test` and `npm run check` need only Node. The native shell
also needs Rust (via [rustup](https://rustup.rs/)) and the platform libraries
listed in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
(on Linux: WebKitGTK 4.1 and its build dependencies).

Commit `src-tauri/Cargo.lock` after the first native build.

## Android (not set up yet)

The crate is already structured for mobile (`cdylib`/`staticlib` library and a
`mobile_entry_point`). To add Android later, install the Android SDK and NDK,
add the Rust Android targets, then run `npm run tauri android init`. Commit the
generated `src-tauri/gen/android`; `src-tauri/gen/schemas` stays ignored.
