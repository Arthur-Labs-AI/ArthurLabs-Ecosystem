# ADR-0003: Versioned persisted and protocol schemas

Status: accepted

## Context

Projects, snapshots, runs, findings, evidence, issues, verification, fixes,
artifacts, CI/CD plans, run requests, and harness events persist or cross process
boundaries. Structures will evolve.

## Decision

Every persisted/transported structure carries `schemaVersion: 1`; the protocol
version (`HARNESS_PROTOCOL_VERSION = 1`) is tracked independently. Phase 1
validates strictly (unknown versions rejected). Future changes add a new version
with an explicit migration (`migrateV1ToV2`) and dual-version acceptance tests;
never silent coercion, never in-place reinterpretation.

Project and AgentRun are included deliberately: both become persisted records in
the local-first model, even though the persistence adapter itself is deferred.

## Consequences

Forward-detectable incompatibility today; additive migrations later without
rewriting history. Cost: each schema change ships a migration + test.
