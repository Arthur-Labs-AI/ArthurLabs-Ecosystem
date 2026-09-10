# ADR-0005: Harness event identity and lifecycle integrity

Status: accepted

## Context

Early Protocol v1 shapes duplicated Finding IDs, Evidence IDs, and usage cost at
the event level. Those copies could disagree with the embedded DTOs. Individual
event validation also could not detect a mixed-AgentRun stream or events emitted
after termination.

## Decision

The embedded Finding or Evidence owns its ID, and AgentUsage owns all cost fields.
The redundant event-level copies are removed. `validateHarnessEventSequence`
separately enforces one `run.started` first, one terminal event last, a single
AgentRun ID, and agreement between an event and its submitted Finding/Evidence.
When request context is available, submitted QARun IDs must also match it.

Expected parse, event, and sequence failures use bounded protocol errors with
stable codes and positions; raw payloads are not copied into messages.

## Consequences

Adapters have one authoritative value for each identity and cost datum, while
stream validation remains lightweight and optional for incremental transport.
This is a breaking correction within pre-production Protocol v1, so no v2 or
compatibility layer is required. Protocol v1 becomes the Phase 2 baseline.
