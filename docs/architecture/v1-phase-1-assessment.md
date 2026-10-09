# v1 Phase 1 assessment

Inspected before implementation on 2026-10-09, against approved `origin/main`
`0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38` (also `v0.1.0-beta.1`).

## Production and compatibility paths

| Area inspected                                                                                             | Current responsibility                                                                                                   | Phase 1 decision                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/services/desktop-service.ts`, `desktop-command-router.ts`, `shared/ipc-contract.ts` | Validated Renderer/CLI commands, credentials, Linux runtime RPC; snapshot contract retains legacy arrays                 | Preserve commands and payloads; test retired channels stay absent                                                                     |
| `apps/runtime/src/runtime.ts`                                                                              | Owns repository, lease, coordinator, adapters, notifications and `runs.get`; dispatch excludes merge/verify/ingest       | Preserve production dispatch and historical reads; test both                                                                          |
| `packages/run-engine/src/index.ts`                                                                         | Snapshot freeze, selected parallel adapters, per-agent persistence, terminal outcome, exports, cancellation and recovery | Production final stages contain only report; preserve execution                                                                       |
| `apps/desktop/src/renderer/lib/run-graph.ts`, `pages/RunWorkspace.tsx`                                     | Independent agent canvas and inspectors filtered by `agentRunId`                                                         | Already excludes downstream stages; remove invented three-agent fallback for records with no selection or AgentRuns                   |
| `components/PipelineInspectors.tsx`, `pages/RetestWorkspace.tsx`, `components/nodes/PipelineNode.tsx`      | Compatibility renderers and retest node dispatch                                                                         | Keep renderers/data; remove instructions promising active merge/verify orchestration and label retained pipeline detail as historical |
| `packages/merger`, `packages/verifier`                                                                     | Legacy clustering/replay services, source lineage and retained compatibility APIs                                        | Keep; not obligatory production QA stages                                                                                             |
| `packages/run-engine/src/retest-service.ts`, `issue-service.ts`, `exporters.ts`                            | Existing issue occurrences, historical source steps, retest comparisons and historical export sections                   | Retests still call `mergeRun` and `verifyMerge` internally after independent agents; preserve this bounded compatibility dependency   |
| `packages/persistence/src/migrations.ts`, `repository.ts`                                                  | SQLite ownership constraints and versioned payloads for runs, evidence, merge/verification and issue/retest lineage      | No tables, schemas or migrations removed or changed                                                                                   |
| `apps/cli/src/application.ts`, `frontend-application.ts`, `arguments.ts`, `docs/beta/cli.md`               | Production CLI brokers through Desktop; explicit development direct transport retains old commands                       | Preserve compatibility transport; guide already identifies retired RPCs; no new merge/verify commands                                 |

## Findings and bounded plan

Normal Full/Targeted production QA already follows project → revision → immutable
snapshot → selected independent agents → individual results. No production
coordinator change is justified. Findings and evidence remain separately keyed
to their originating `agentRunId`; historical Muse stack IDs remain readable.

The graph falls back to all three modern stacks when neither configuration nor
AgentRuns establishes a selection. That invents execution state for empty
historical records. Use recorded configuration, or recorded AgentRuns when
configuration is absent; keep configured waiting placeholders unchanged.

The retained verifier inspector says “Run Verify after merging”, and the edge
inspector promises flow into the current Merger/Verifier. Those instructions
conflict with the retired RPC surface. Replace them with descriptions of saved
compatibility data and independent-agent execution. Keep stored outcomes and
source attribution visible, without deriving confidence from agreement.

Existing graph tests already protect the retired topology. Existing merger,
verifier, simulation, export and retest tests are compatibility/security coverage,
not evidence that those stages should be restored to active QA. Keep them.
Add coverage for every nonempty subset of current agents in Full/Targeted mode,
evidence attribution, empty/older records, retained inspector data, runtime
historical reads and retired RPC rejection. Run existing issue/retest and IPC
regressions rather than replacing their model.

Documentation changes: refine branch policy and manual merge gates, update the
PR template, establish the [v1 contract](v1-pipeline.md), and describe remaining
milestones in the [roadmap](../releases/V1_ROADMAP.md). No provider harness,
execution, database, version, release tag or future phase changes are planned.
