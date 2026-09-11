# ADR-0009: Local runtime ownership and crash recovery

Status: accepted

## Context

CLI, desktop, or later local processes may share one SQLite store. Treating every
nonterminal row as abandoned lets a healthy second process interrupt live work.
Filesystem replacement also crosses transaction boundaries that SQLite cannot
make atomic.

## Decision

Mutation-capable processes persist a leased RuntimeInstance with heartbeat and
release state. Active QARuns, managed-copy locks, and project operations persist
the owner ID. Recovery requires the recorded owner to be absent, released, or
stale; read-only processes neither register ownership nor recover work.

Use `BEGIN IMMEDIATE` for project lock acquisition. Use durable operation journals
for project update/delete filesystem stages, with idempotent recovery decisions
based on both the journal and canonical database state. Keep each SQLite
transaction short and never hold it across recursive copy or filesystem cleanup.

## Consequences

Healthy concurrent runtimes can read safely, and only one can acquire a project
run lock. Recovery waits for a bounded stale interval after an unclean stop.
Heartbeats add small periodic writes, and filesystem residue may remain until the
next mutation-capable startup, but canonical state remains explicit and
recoverable.
