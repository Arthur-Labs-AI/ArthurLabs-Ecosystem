# Sentry Private Beta — Troubleshooting

Common real failures and what to check. Never disable trust checks to
work around them.

## Provider unavailable

`qa agent doctor <opencode|deepseek|glm>` reports `unavailable`. Check the
binary path, the model environment variable, and authentication for that
provider (OpenCode needs `OPENROUTER_API_KEY` plus `SENTRY_OPENCODE_MODEL`). Sentry never falls back to another stack silently — select only
configured stacks with `--agents`.

## Agent invalid report rejected

A run ends `partial` with `*_INVALID_RESULT` (e.g. `GLM_INVALID_RESULT`).
The trust pipeline rejected a malformed agent report and kept the other
agents' outputs. This is working as designed; retry the run. Only a
repeated identical rejection across runs indicates a contract ambiguity
worth reporting.

## WSL/systemd verifier unavailable

`qa verify doctor` reports `sandboxAvailable: false`. Verifier replay is
unsupported on this host: ensure WSL2 Ubuntu with a systemd user session
(or direct Linux). Verification outcomes stay `inconclusive` until the
backend is available. There is no host-execution fallback.

## Missing project runtime

Verification steps report `unsupported` for a toolchain the project needs
(e.g. a language runtime not installed in the sandbox). Install the
toolchain in the environment or accept `inconclusive` for those claims.

## Project update conflict

`PROJECT_LOCKED` / `ACTIVE_RUN_EXISTS` (exit 4): a run holds the project
lock. Wait for it, or `qa run cancel <run-id>` a genuinely stuck
nonterminal run, then retry.

## Sandbox unavailable

Agent startup fails with `*_SANDBOX_UNAVAILABLE`. The harness could not
establish its contained execution boundary; the run stops rather than
running unconfined. Check host sandbox prerequisites for that harness.

## Run interrupted

A run shows `interrupted` after Sentry stopped mid-run. Completed agent
outputs are retained; restart Sentry and inspect `qa run status` /
`qa run show`. Stale nonterminal rows are recovered honestly, never
resumed silently.

## Disk/storage issue

`INSUFFICIENT_STORAGE` or SQLite `SQLITE_BUSY` (exit 4, retryable): free
disk space or retry shortly when another local process holds the data.
History is retained until explicit deletion — check data-root growth with
standard disk tools if the database grows unexpectedly.

## Targeted run rejected

`INVALID_ARGUMENT` (exit 2) for `--paths`: paths must be
project-relative, without `..`, and must exist in the frozen snapshot.
List real paths via the project source or a prior snapshot manifest.

## Retest refused

`ISSUE_CONFLICT` (exit 6): the target revision belongs to another
project — retest is strictly project-scoped. `PROJECT_COPY_DRIFT`:
the working copy is not at the requested target revision; update the
project first. Same-revision retests are rejected: update the project to
create revision B before retesting.

## Storage pressure

`qa doctor storage --json` reports database, artifact, and workspace
sizes plus orphan candidates without deleting anything. `qa doctor
cleanup --json` dry-runs orphan removal; add `--apply` to execute.
Only Sentry-owned temporary directories older than 24h with no active
ownership are ever removed.

## Project not ready

`qa project doctor <project-id> --json` reports managed-copy state,
revision history, detected ecosystem, runtime availability, and verifier
readiness with warnings. `ready: false` names the reason — commonly a
locked copy (wait or cancel the stuck run) or an unavailable sandbox
(WSL2/systemd requirement).
