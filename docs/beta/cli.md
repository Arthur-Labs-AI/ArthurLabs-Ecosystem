# Sentry CLI (`sentry cli`)

`sentry cli` controls the same running Sentry instance as the Electron Desktop.
It is a frontend only: every command travels a local named pipe to the Desktop
broker (named pipe on Windows, Unix socket on CachyOS), which dispatches through
the shared router to the canonical WSL2 or native CachyOS runtime
(`~/.local/share/sentry`). The CLI never opens the database, never
owns leases, never instantiates harnesses, and never carries provider secrets.

```text
Nexus / humans
  sentry cli  -->  Electron broker  -->  WSL SentryRuntimeHost
```

## Prerequisites

```powershell
sentry open
```

Desktop must be running first. While it runs, the Environment page shows
`CLI started`, plus the names of connected external clients (for example
`Nexus connected`), or `No external clients`. If Desktop is not running,
`sentry cli` fails deterministically with `SENTRY_DESKTOP_NOT_RUNNING`
(human text points at `sentry open`; `--json` mode returns the code).

Provider credentials stay in Desktop Settings. Never export provider keys
for the CLI; the CLI environment is ignored for secrets.

## Nexus machine contract

Always pass `--json`. Then stdout is exactly one JSON document and stderr
carries human diagnostics only. Parse stdout with `JSON.parse`; depend on
`error.code`, never on message text.

Success envelope:

```json
{
  "schemaVersion": 1,
  "command": "run.start",
  "ok": true,
  "data": { "runId": "run_...", "operationId": "dop_...", "status": "running" }
}
```

Error envelope:

```json
{
  "schemaVersion": 1,
  "command": "run.start",
  "ok": false,
  "error": { "code": "PROVIDER_NOT_READY", "message": "..." }
}
```

Exit codes: `0` success; `2` invalid argument; `3` not found; `4` conflict or
retryable; `5` findings present; `6` execution failed; `7` partial; `8`
cancelled; other failures `1`. `SENTRY_DESKTOP_NOT_RUNNING` exits `1`.

## Nexus lifecycle

```powershell
sentry cli capabilities --json
sentry cli project list --json
sentry cli run start proj_... --mode full --agents opencode,deepseek,glm --json
```

Async start returns `runId` + `operationId` plus the persisted initial run
status immediately; the CLI performs no follow-up request, so a later pipe
cut, restart, or timeout can never hide an already-created (possibly paid)
run or invite a duplicate retry. The CLI process may exit and the WSL
runtime keeps owning the run. Poll, then fetch the result:

```powershell
sentry cli run status run_... --json
sentry cli run result run_... --json
```

`run result --json` emits the canonical structured JSON for exactly that run
(decoded from the runtime `runs.exportContent` bytes; no second format).
Pass `--wait` to `run start` to observe the canonical run until it
terminalizes instead of returning early. Targeted runs:

```powershell
sentry cli run start proj_... --mode targeted --paths src/auth,src/api --json
```

CLI-started runs are the same canonical runs as UI-started runs: they appear
in the Desktop run workspace through the existing live updates. A dropped CLI
connection never cancels a run; cancel explicitly with `run cancel`.

## Command reference

```text
capabilities [--json]
project list/add/show/update/delete/revisions/doctor
agent list | agent doctor opencode|deepseek|glm
run start/list/show/status/cancel/result/export
issue list/show/history
retest start/show/cancel
```

`project add` accepts normal Windows paths (`C:\Projects\Nexus`); the
Desktop service translates them to WSL paths. `project delete` keeps the
`--yes` confirmation. `run export` materializes broker bytes at `--out
<path>`; use `run result --json` for stdout JSON.

## Command parity

A. Canonical through the broker: capabilities, agent list/doctor, project
add/list/show/update/delete/revisions/doctor, run
start/list/show/status/cancel/result/export, issue list/show/history,
retest start/show/cancel, plus system/runtime status reads.

B. Added to the canonical runtime for this interface: `projects.delete`
(with `--yes` preserved), the `runs:export-content` channel, and the
`cli:status` channel behind the Environment indicator.

C. Development-only or retired (production CLI rejects them with
`INVALID_ARGUMENT`; rerun with `SENTRY_CLI_TRANSPORT=direct` only for
deterministic local development):

```text
run simulate ......... FAKE harness runs (development only).
run merge ............ retired merger RPC (use the Desktop run workspace).
issue ingest ......... retired merger RPC.
verify start/show/doctor .. retired verifier RPCs.
doctor storage/cleanup/config .. Windows-local inspection; the data root now
   lives in WSL, so use the Desktop Environment page instead.
```

Nothing silently falls back to the old Windows database.

## Protocol (for integrators)

Windows Beta uses the named pipe `\\.\pipe\sentry-cli-v1-<scope>`, where
`<scope>` is a stable hash of the local launcher home (no usernames, no
network listeners). Framed NDJSON, protocol version 1, bounded messages.

Handshake:

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "client": { "type": "cli", "name": "Nexus", "version": "0.1.0" }
}
```

The broker replies with a `welcome` carrying the product version. Requests
are `{ "type": "request", "id", "command", "payload" }`; responses
carry `ok` plus `result` or a coded `error`. Provider-secret and admin
channels (`providers:save/clear/*`, `runtime:select-distro`) are rejected
with `CLI_COMMAND_FORBIDDEN`; external clients only reach the operational
allowlist.

## Capabilities: production truth

`features.fakeRunSimulation` stays `true` for contract history: it describes
the development/direct transport, not production. Nexus must consult
`productionCommands` to decide what production `sentry cli` supports:

```json
{
  "cliContractVersion": 1,
  "productionCommands": {
    "runSimulation": false,
    "realRunExecution": true,
    "runResult": true,
    "runExport": true
  }
}
```

The CLI contract version stays 1; all new fields are additive and optional.

## Run timeouts

`run start --timeout-ms <ms>` (integer, 1000–43200000) overrides the engine
run timeout for that run and propagates canonically:
CLI parser → frontend → Desktop `runs:start` → WSL `runs.start` →
RunCoordinator execution safeguards. Omitted keeps the 30-minute production
default, so UI-started runs are unaffected. Out-of-range values fail with
`INVALID_ARGUMENT` at the parser; nothing is silently ignored.

## Client identity (Nexus)

Nexus should identify itself so Desktop shows `Nexus connected` while a
command is active. Supported mechanism (documented, tested, no secrets):

```powershell
$env:SENTRY_CLI_CLIENT_NAME = 'Nexus'
$env:SENTRY_CLI_CLIENT_VERSION = '0.1.0'
sentry cli run status run_... --json
```

Names are informational identity only, never authentication: they are
truncated to 100/50 characters, extra handshake fields are ignored, and
nameless handshakes are rejected. Never put secrets in client metadata.

## Named-pipe security model

Sentry itself creates no TCP listener. The CLI broker uses a Windows
named pipe. Windows may provide remote named-pipe semantics depending
on system services and ACL configuration; this Beta does not install a
custom DACL that explicitly denies remote identities.

The current Beta trust boundary assumes Nexus and Sentry run under the
same Windows user. Security additionally relies on the explicit command
allowlist, strict payload validation, absence of credential-management
commands from the external surface, and the fact that provider secrets
are never transmitted through the CLI protocol.

Preserved facts: client names are informational identity, never
authentication; the pipe scope hash is not authentication; same-user
processes are inside the Beta trust boundary. No current-user-only ACL,
session-only access, LAN-impossible, or remote-impossible behavior is
claimed, because the implementation does not explicitly enforce it. No
handshake secret is added: a same-user-readable secret would not
meaningfully improve this threat model, and no native ACL dependency is
introduced for this cleanup.
See [Named Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights).

## Size limits

All IPC bounds are UTF-8 bytes (never JS character counts). The external
CLI broker allows 256 KiB per request and 32 MiB per response/line, but the
effective bound for run exports is set by the lower WSL runtime transport,
whose NDJSON lines are capped at 8 MiB:

```text
RunExporter artifact
  -> base64 (4/3 expansion, JSON-safe alphabet)
  -> runtime RPC response line (max 8 MiB)
  -> WslRuntimeClient -> Desktop service -> CLI broker (max 32 MiB)
  -> SentryDesktopClient -> Nexus JSON
```

Canonical exports up to 6,000,000 raw bytes are proven to fit (exactly
8,000,000 base64 chars plus framing stays below the 8 MiB line cap); the
runtime refuses anything larger with `EXPORT_TOO_LARGE` (exit 4) before
bytes are materialized. Desktop Export with Save As uses the same
`runs.exportContent` bytes and therefore shares the same deterministic
bound — it does not bypass it. `RESPONSE_TOO_LARGE` remains the outer
broker-level guard. An oversized frame on the runtime transport fails
exactly the affected request instead of hanging until timeout; oversize
notifications are dropped as hints and reconciled by polling. JSON is never
silently truncated.

## Public error codes

Nexus branches on `error.code` only. Stable across
WSL runtime → Desktop service → router → broker → CLI:
`PROJECT_NOT_FOUND`, `RUN_NOT_FOUND`, `RUN_NOT_COMPLETE`, `ISSUE_NOT_FOUND`,
`PROVIDER_NOT_READY`, `ACTIVE_RUN_EXISTS`, `PROJECT_LOCKED`,
`CLI_COMMAND_FORBIDDEN`, `SENTRY_DESKTOP_NOT_RUNNING`, `RESPONSE_TOO_LARGE`,
`EXPORT_TOO_LARGE`, `RUNTIME_MESSAGE_TOO_LARGE`,
`PROTOCOL_VERSION_MISMATCH`, `RUN_MAY_HAVE_STARTED`, plus the historical
harness codes. Unknown future codes collapse to `INTERNAL_ERROR`; messages
are human diagnostics and must not be parsed.

## Development transport warning

`SENTRY_CLI_TRANSPORT=direct` executes against Windows-local state with its
own database and harness construction. It does not represent Desktop state,
may use Windows-local data, is not supported for Nexus, and must not be used
as production automation.
