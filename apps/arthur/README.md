# apps/arthur

The single A.R.T.H.U.R. product application: Tauri v2 + React + TypeScript + Vite.
One shared UI for Linux, Windows and (later) Android; macOS and iOS after that.

**Status:** shell with runtime info and local text capture (create + list, persisted in app-local SQLite). Voice, sync, graph and EMG are not implemented.

```text
src/                  React UI (platform-independent)
  app/                providers, layout, App
  client/             ArthurClient interface + desktop / mobile / preview implementations
  features/           one folder per product area (capture/, settings/)
  hooks/              shared hooks (useArthurClient)
src-tauri/            Rust native layer
  src/commands/       Tauri commands exposed to the UI
  src/platform/       OS detection
  src/storage/        SQLite capture store (the only code that touches SQLite)
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

## Android

The Android project is generated into `src-tauri/gen/android` (committed;
`gen/schemas` stays ignored). The application id is `dev.kaloyan.arthur`.

One-time setup: JDK 17+, the Android SDK and NDK (tested with NDK 27.1), and
the Rust Android targets:

```bash
rustup target add aarch64-linux-android x86_64-linux-android
export ANDROID_HOME=~/Android/Sdk NDK_HOME=$ANDROID_HOME/ndk/27.1.12297006
```

```bash
npm run tauri android build -- --debug --target x86_64 --apk   # emulator
npm run tauri android build -- --debug --target aarch64 --apk  # physical device
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

`build.rs` links the native library with 16 KB page alignment, which newer
Android devices and Google Play require.

## Local capture storage

Captures are stored by the native layer in SQLite (`arthur.db` in the app data
directory; on Android `/data/user/0/dev.kaloyan.arthur/arthur.db`, app-private).
The schema is versioned with `PRAGMA user_version` and created on first launch.
This is app-local storage, not the future Home Node Cognitive Store. The UI never
touches it: `CapturePanel` -> `ArthurClient` -> Tauri command -> `src-tauri/src/storage`.
