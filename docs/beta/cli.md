# Sentry CLI (`sentry cli`)

`sentry cli` controls the same running Sentry instance as the Electron Desktop.
It is a frontend only: every command travels a local named pipe to the Desktop
broker, which dispatches it through the shared command router to the canonical
WSL runtime (`~/.local/share/sentry`). The CLI never opens the database, never
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

Async start returns `runId` + `operationId` immediately; the CLI process may
exit and the WSL runtime keeps owning the run. Poll, then fetch the result:

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
