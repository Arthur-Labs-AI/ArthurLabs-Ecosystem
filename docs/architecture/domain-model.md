# Domain Model

```text
Project → ManagedProjectCopy → ProjectRevision → ProjectSnapshot
                                              ├─► ProjectContextSnapshot
                                              └─► QARun + RunInstructions + Policy
                                                    ├─► AgentRun × N
                                                    │    ├─► InitialInvestigationPlan
                                                    │    ├─► EmergentHypothesis × N
                                                    │    ├─► Finding × N
                                                    │    └─► Evidence × N
                                                    ├─► RunActivity tree
                                                    └─► UnifiedIssue → VerificationAttempt
                                                                           └─► FixProposal (advice)
```

Every persisted or transport structure carries `schemaVersion: 1`; embedded
value objects reuse strict schemas without unnecessary entity identity.

## Project lifecycle and immutable run inputs

- `Project` identifies the user's external local folder. Sentry never writes to it.
- `ManagedProjectCopy` identifies the current revision and its
  `ready|updating|locked_for_run|error` lifecycle. Only a locked copy has
  `lockedByQARunId`.
- `ProjectRevision` is one immutable successful import/update: project, source
  path, timestamp, content hash, optional safe-integer stats and source Git state.
- `ProjectSnapshot` is the exact immutable run-start identity derived from a
  revision. Its bounded manifest summary references a streamed NDJSON Artifact;
  individual lines validate as `SnapshotFileEntry`.
- `ProjectContextSnapshot` records purpose, architecture, critical flows,
  business rules, constraints, limitations, out-of-scope facts, stack detection,
  and source/user/inference provenance for the same revision.
- Embedded `RunInstructions` are optional explicit user guidance for one run.
  They take precedence over conflicting inferred context without changing the
  context or suppressing factual runtime evidence.

`QARun` references project, snapshot, and context IDs and snapshots selected
Agent Stack IDs, policy, verification level, instructions, and optional
operational safeguards. `DEFAULT_VERIFICATION_LEVEL` is `strict`; the schema does
not inject a default. Selected stacks are arbitrary N where N ≥ 1.

## Independent agent investigation

One `AgentRun` represents one Agent Stack and task. Status includes explicit
`planning` and terminal `interrupted`; failed/interrupted/timed-out agents carry bounded
structured failure details. The request and contracts expose no other agents.

`InitialInvestigationPlan`/`AgentInvestigationPlan` captures the agent's immutable
project understanding, critical flows, weak points, and all planned checks before
active investigation. It contains no priority or skip mechanism.
`EmergentHypothesis` is a separate append-only structure discovered during work;
it never mutates the initial plan.

## Findings, evidence, disagreement, and advice

- `Finding` is one agent's claim, with severity separate from confidence.
- `Evidence` is a strict discriminated union whose `environmentState` distinguishes
  clean-baseline evidence from evidence gathered after workspace modification.
- `UnifiedIssue` groups IDs and keeps `agreementState`
  (`single_source|aligned|mixed|disputed`) independent from verification status.
- `VerificationAttempt` records an independent check. Future verification begins
  from the run baseline, never a mutated investigation workspace.
- `FixProposal` contains a summary, rationale, suggested file changes, affected
  paths, optional suggested patch artifact, and regression-test advice. It has no
  application/validation status or transition and grants no write authority.

## Retest

`mode: retest` requires `RetestTarget` with the historical QARun and UnifiedIssue.
The Retest's own snapshot points to the current revision. Optional `RetestResult`
records `fixed|still_reproducible|partially_fixed|inconclusive` plus evidence IDs.
Non-Retest modes reject Retest-only fields.

## Observability, exports, and usage

`HarnessEvent` is adapter-bound output for one agent. `RunActivity` is a normalized
Core-owned activity with optional agent and parent IDs, enabling a major workflow
graph plus expandable child steps. `RunExportManifest` references implemented
human `.log` and structured `.json` artifacts generated from persisted state.

`AgentUsage` stores optional input, output, and cached-input token counts, turns,
and duration. Monetary data is absent. Aggregate tokens/turns are summed;
summed worker duration is named `aggregateAgentExecutionMs` and is never confused
with QARun wall-clock time derived from run timestamps.

## Cross-entity invariants

Zod validates individual shapes. Pure domain helpers validate relationships:
snapshot/context ↔ revision/project, run ↔ snapshot, agent ↔ run, plan ↔
agent/run/snapshot/context, and Retest ↔ earlier run/issue. Pure transition tables
govern QARun, AgentRun, VerificationAttempt, and ManagedProjectCopy. Worker-outcome
aggregation uses explicit `producedUsableOutput` and distinguishes completed,
partial, failed, and whole-run cancellation.

CICDPlan and Artifact remain versioned supporting contracts. Large bytes, diffs,
logs, screenshots, reports, and patches are referenced by `ArtifactId`, never
embedded into core DTOs.
