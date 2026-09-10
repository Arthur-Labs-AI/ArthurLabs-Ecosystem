# Phase 1.1 — Final Domain and Protocol Baseline

## Status: COMPLETE

**Sentry Phase 1 + Phase 1.1 are complete and form the final domain/protocol baseline for Phase 2 implementation.**

This status covers contracts, validation, pure state/invariant helpers, fixtures,
the deterministic fake adapter, and documentation. It does not claim that project
copying, AI execution, persistence, export, recovery, verification, or UI exists.

## Final domain flow

```text
ORIGINAL LOCAL PROJECT
        │ Import / Update
        ▼
SENTRY MANAGED PROJECT COPY ──► PROJECT REVISION ──► RUN-START SNAPSHOT
                                                        │
                         ┌──────────────────────────────┼─────────────────────┐
                         ▼                              ▼                     ▼
                  PROJECT CONTEXT              RUN INSTRUCTIONS          QA POLICY
                         └──────────────────────────────┼─────────────────────┘
                                                        ▼
                                                     QA RUN
                         ┌──────────────────────────────┼─────────────────────┐
                         ▼                              ▼                     ▼
                      Agent A                        Agent B               Agent N
                   private plan                  private plan          private plan
                   isolated workspace            isolated workspace   isolated workspace
                         └──────────────────────────────┼─────────────────────┘
                                                        ▼
                                      observable events, findings, evidence,
                                      hypotheses, activities, token usage
                                                        ▼
                                         MERGER (disagreement preserved)
                                                        ▼
                                  VERIFICATION (fresh baseline) ──► FINAL REPORT
                                                        │
                                                run.log / run.json
```

Agents receive no peer identities, plans, findings, evidence, or progress. Full
QA is a comprehensive mission: each agent inspects all relevant areas it
identifies and does not intentionally skip identified weak points or critical
flows because of ranking alone. This is broad, not a claim of mathematically
exhausting every possible program state. Applicable areas are determined by the
project—from build, tests, APIs, UI, data, security, runtime, and configuration
through architecture, performance, concurrency, CI/CD, and edge cases. User
`RunInstructions` override conflicting inferred context for that run only; they
do not hide factual evidence and never mutate `ProjectContextSnapshot`.

## Retest

```text
Full QA → Issue X → user fixes original project → Update Project Copy
        → new ProjectRevision → Retest Issue X on the current snapshot
        → reproduce original + focused regression checks
        → fixed | still_reproducible | partially_fixed | inconclusive
```

`RetestTarget` points to the historical QARun and UnifiedIssue while the Retest
QARun points to the current snapshot/context. Any positive number of selected
independent Agent Stacks is valid.

## Observability and failure isolation

`HarnessEvent` is what one adapter emits. `RunActivity` is Sentry's normalized,
hierarchical view across project preparation, agents, merger, verification, and
reporting. A future projector may derive activities from events; the UI never owns
orchestration state. `OperationId` correlates tool start/completion independently
of tool name, ordering, or timestamp proximity. Large diffs and outputs remain
Artifact references.

The future run page projects a compact workflow graph with major Preparation,
Snapshot, Context, Baseline, selected Agent, Merger, Verification, and Report
nodes. Agent nodes expand into planning, build, test, API, browser, evidence, and
finding substeps rather than flooding the main graph with raw actions. Waiting is
neutral, running is animated, completed is green, warning/partial is amber, and
failed is red. Meaningful nodes are clickable, but all state is derived from Core
data; the UI owns none of it.

Future `.log` output is chronological and human-readable. Future `.json` output
can represent or reference run metadata, revision, snapshot, context,
instructions, agents, plans, hypotheses, activities, events, findings, evidence,
verification, issues, advisory fixes, token usage, artifacts, and final-report
metadata. Large binary content remains behind Artifact IDs. `RunExportManifest`
defines only the two required export artifacts; generation is deferred.

Raw valid event streams still require one terminal event. A transport that ends
without one is invalid; the future coordinator maps transport loss to a structured
`AgentRun.interrupted` outside raw stream validation. Incrementally retained
pre-crash data remains useful. All completed workers yield `completed`; mixed
completed and failed/timed-out/interrupted workers yield `partial`; no usable
workers yields `failed`. Whole-run user cancellation remains `cancelled`.

Evidence records whether it came from the clean baseline or a modified agent
workspace. Important issues must later be independently verified in a fresh
environment derived from the run baseline.

## Scope boundary

Phase 2+ remains responsible for real folder import/update and atomic filesystem
swap, streaming hash/copy, context generation, harness/vendor integrations,
coordinator scheduling, incremental persistence/SQLite, activity projection,
crash recovery, clean verification workspaces, report synthesis, `.log`/`.json`
exporters, Electron UI, REST/MCP, Docker/browser execution, and CI/CD generation.
Phase 1.1 intentionally adds none of those runtime systems.
