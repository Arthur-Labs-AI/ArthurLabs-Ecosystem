# Windows ↔ WSL2 Sentry Runtime

> Starting with the final Phase 8 Desktop architecture, Sentry exposes no simulation execution mode. Desktop QA execution always uses the configured production Muse, DeepSeek and GLM AgentStacks. Automated tests may use mocks/test doubles internally, but those are not persisted or exposed as a product execution mode.

## Why WSL exists

The Windows Electron host cannot serve as the Node host for provider CLIs: `process.execPath`
is `electron.exe`, while the DeepSeek SDK launcher assumes a real Node binary. Spawning `.js`
harness entries from Electron fails (EFTYPE / timeout class, e.g. `DeepSeek --version did not
complete within 5 seconds`). The Verifier v3 systemd sandbox likewise needs real Linux.
So: Windows owns presentation, WSL2 owns execution.

## Responsibilities

### Windows (Electron desktop)

- Renderer + Run Canvas + inspectors.
- Native folder picker, safeStorage credentials, WSL lifecycle manager.
- Typed renderer IPC; `DesktopApplicationService` as a pure RPC adapter.
- Windows→WSL path translation via `wslpath`.
- Live-update fan-out from runtime notifications + bounded polling.

### WSL2 (Sentry runtime, `@qa/runtime`)

- `SentryDatabase`, `SentryRepository`, `RuntimeInstanceLease`, `ProjectManager`.
- `HarnessAdapterRegistry` with the real Muse / DeepSeek / GLM registrations.
- `RunCoordinator` execution, agent workspaces, Merger v2, Verifier v3 (systemd),
  Issues, Retest workflows, doctors.
- Linux-native data root `~/.local/share/sentry` (database, managed copies,
  snapshots, workspaces, verification attempts, exports).

## Runtime lifecycle

1. Desktop resolves the WSL2 distro (preferred or auto).
2. Spawns one long-lived `wsl.exe -d <distro> -- node <entry> --stdio` (argv only, no shell).
3. `runtime.hello` handshake; protocol mismatch / non-Linux / electron-host rejected.
4. `runtime.configure` pushes models + secrets into runtime memory only.
5. Awaited `recover()` inside the runtime before the window presents live state.
6. `runtime.shutdown` on clean exit; stdin EOF stops the runtime without inventing run states.

## RPC protocol (`@qa/runtime-protocol`, version 1)

- NDJSON over stdio: stdin requests, stdout responses/notifications, stderr diagnostics.
- `request { id, method, params }`, `response { id, ok, result?/error? }`,
  `notification { event, payload? }`. Concurrent requests by id; bounded timeouts.
- `runs.start` / `retests.start` return the persisted id as soon as the row exists;
  live snapshots drive the canvas afterwards.

## Secret transfer

- Windows safeStorage decrypts in Electron main only.
- `runtime.configure` carries secrets over the private RPC stdin (never argv, shell,
  files, SQLite, stdout, or logs). Runtime keeps them memory-only and forwards them
  into provider child environments. Renderer never receives values.
- Credential Save/Clear re-pushes configuration; no restart required.

## Project import

- Desktop translates `C:\...` via `wslpath -u` inside the selected distro.
- Runtime validates readability, imports into the Linux-native managed copy, then
  Revision → Snapshot → agent workspaces, all under the Linux data root.
- Original Windows source is read-only input. Legacy Windows data roots are detected,
  preserved untouched, and reported (no silent partial migration).

## Provider execution

- DeepSeek `dsh` resolves inside WSL (`which dsh` / SDK-bundled); `process.execPath` is
  Linux Node. Probe timeout is bounded (10–15 s) with runtime/executable/phase diagnostics.
- Muse runs in WSL; `muse login` happens inside the selected distro.
- GLM/Claude Code runs in WSL with the trusted Z.AI endpoint validation intact.

## Verifier

- `SystemdSandboxBackend.preflight()` runs in WSL against real systemd; the sandbox
  canary is authoritative. Windows never constructs the sandbox backend for production.

## Failure handling

- Runtime crash: desktop marks disconnected, stops sending, surfaces bounded stderr,
  restarts when safe, and re-runs recovery (persisted truth wins).
- Cancel: renderer → IPC → `runs.cancel` RPC → `requestRunCancellation`; owner workers
  terminalize; UI reflects `cancellation_requested` → terminal from runtime state.
- No Windows provider fallback, no local terminalization, no fake progress.

## Security boundaries

- `nodeIntegration=false`, `contextIsolation=true`, `sandbox=true`; preload exposes
  explicit methods only; IPC allowlists provider keys (never arbitrary env names).
- Error paths redact `Bearer`/KEY/TOKEN/SECRET/PASSWORD patterns (main, RPC, renderer
  ErrorBoundary, localStorage diagnostics).
