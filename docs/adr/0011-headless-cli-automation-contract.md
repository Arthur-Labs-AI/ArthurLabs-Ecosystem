# ADR-0011: Headless CLI automation contract

Status: accepted

## Context

Scripts, CI jobs, external coding agents, and a future Sentry UI need a reliable
local interface. Human terminal text is unstable and unsafe to scrape. Read-only
inspection must also remain safe while a different process owns an active run.

## Decision

Machine mode is a first-class public Sentry interface. `--json` emits exactly one
strict JSON response on stdout, using `schemaVersion: 1`, a stable command ID,
and either typed `data` or a sanitized typed `error`. Normal progress and human
formatting never enter machine stdout. Stderr is reserved for diagnostics and
warnings. Process exit codes classify success, invalid input, missing entities,
conflicts, findings, execution failure, partial results, and cancellation.

The CLI parses arguments, calls existing project/run application services once,
validates the resulting DTO against the command-specific public schema, and then
selects a human or machine renderer. It does not implement a parallel project or
QA workflow. List/status DTOs are deliberately bounded. `run status` performs
targeted database reads and never loads events, evidence, or activity history.

Read commands open SQLite without a RuntimeInstance lease and do not run
recovery. Mutation commands retain the Phase 2.1 lease, recovery, and `finally`
release lifecycle. The same project manager and run engine remain reusable by a
future UI.

## Compatibility policy

Within `schemaVersion: 1`, command IDs, envelope fields, error-code meanings,
stdout/stderr separation, and exit-code meanings are stable. New optional result
fields and new commands may be added compatibly. Removing or changing required
fields, reinterpreting codes, or changing result shapes requires a new contract
schema version. Callers must branch on `schemaVersion`, `command`, and `ok` and
must not parse human output.

## Consequences

Automation can distinguish a successful QA finding defects from Sentry failing.
Machine responses do not expose stack traces or raw dependency exceptions. The
CLI has a small amount of contract-specific mapping and rendering code, but
business state and mutation remain owned by existing services. Real execution,
background run ownership, and cancellation remain future capabilities rather
than simulated promises.
