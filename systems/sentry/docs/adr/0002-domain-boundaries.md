# ADR-0002: Vendor harness SDKs cannot enter the QA domain

Status: accepted

## Context

Muse Code, DeepSeek Harness, and Claude Code SDKs expose vendor-specific auth,
transports, and tool schemas. Importing any of them into the core would couple
every QA concept to today's vendors and block future harnesses.

## Decision

Enforce ports-and-adapters: `@qa/domain` and `@qa/schemas` depend only on
`@qa/shared` and `zod`. All vendor contact lives behind the `HarnessAdapter`
contract in `@qa/harness-protocol`, which itself carries zero vendor dependencies.

## Consequences

New harnesses (OpenCode, Kimi, future agents) ship as new adapters. The domain
contains no vendor branching — verified by the future-stack test and by keeping
`no-explicit-any` plus package-boundary imports (`@qa/*` only) green in lint.
