# ADR-0003: Versioned persisted and protocol schemas

Status: accepted

## Context

Snapshots, runs, findings, evidence, issues, verification, fixes, run requests,
and harness events persist or cross process boundaries. Structures will evolve.

## Decision

Every persisted/transported structure carries `schemaVersion: 1`; the protocol
version (`HARNESS_PROTOCOL_VERSION = 1`) is tracked independently. Phase 1
validates strictly (unknown versions rejected). Future changes add a new version
with an explicit migration (`migrateV1ToV2`) and dual-version acceptance tests;
never silent coercion, never in-place reinterpretation.

## Consequences

Forward-detectable incompatibility today; additive migrations later without
rewriting history. Cost: each schema change ships a migration + test.
