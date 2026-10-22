# Sentry Phase 4A capability audit

Inspected 2026-10-22. Application sources read only under `/home/kaloyan/Projects/Sentry`. Local HEAD names `feature/native-linux-support` and points to `6793a9c53a336d577ac4397735d0396f558b60f0`; the publicly published v1.0.2 source is `2640efcd78744cb02c517a405e648722e662bd60`. Local development and published distribution are distinct evidence scopes. No application command/provider invocation was run.

## Significant claims

| Claim | Classification | Inspected evidence and limits |
| --- | --- | --- |
| Desktop → supported CLI broker → Linux runtime authority | Implemented | `apps/desktop/src/main/{cli-server,desktop-command-router}.ts`, `services/desktop-service.ts`; `apps/runtime/src/runtime.ts`. Renderer is a consumer, runtime owns repository/coordinator. CLI is a frontend through Desktop; not a separate runtime/database. Same-user client identity is informational, not authentication. |
| Managed revisions and immutable snapshot manifest/retained bytes | Implemented | `packages/run-engine/src/index.ts` locks/integrity-checks revision, freezes snapshot; `packages/snapshot-engine/src/index.ts` hashes/writes manifest and stores snapshot. |
| Selected concurrent independent AgentRuns | Implemented | `RunCoordinator.run` validates nonempty selection, preflights selected stacks, maps selected workers and awaits `Promise.allSettled`. No mandatory execution of unselected stacks. |
| Disposable private workspaces | Implemented | `packages/workspace-factory/src/index.ts` creates per-AgentRun tree with snapshot baseline hash index, inert unsafe symlink policy, cleanup; retained diagnostics are a separate option. No shared writable peer workspace. |
| OpenCode / DeepSeek / GLM via Claude Code | Implemented, subject to prerequisites | Read all three registration adapters and their lazy selected-only preflight; provider/harness runtime readiness and credentials are required. No permanent quality/security/correctness role assignment. |
| Full / Targeted same topology | Implemented | Coordinator validates mode/TargetSpec then validates against frozen manifest; mode does not substitute a weaker architecture. |
| Findings/evidence attribution and persistence | Implemented | `FindingSchema` has agentRunId, sourceAgentStackId, evidenceIds. Evidence schema includes source state/hash and operation grounding. Repository saveFinding/saveEvidence and exporter source preserve originating identity. |
| Partial and failed outcomes preserve usable output | Implemented | `packages/domain/src/usage.ts`: all completed → completed; otherwise usable output → partial; otherwise failed. Coordinator gives cancellation precedence, independently persists peers. |
| A terminal AgentRun status called partial | NOT an implemented status in inspected aggregator | The website labels DeepSeek **Partial output** with underlying illustrative **failed** AgentRun and usable evidence. Parent QARun is partial. This avoids inventing an AgentRun enum from the brief's example label. |
| Production finalization reports/JSON/log | Implemented | Coordinator production finalStages contains only report. `RunExporter` preserves individual agent blocks and canonical JSON; exports are available at terminal outcomes. |
| Automatic merger → verifier → ingestion | Historical compatibility only | Retest/history/simulation still contain these records/services. Not an active Full/Targeted pipeline. The film's convergence means one overview retaining separate reports. |
| Cancellation/recovery | Implemented, environment-dependent | Coordinator durable cancellation, owner settlement/cleanup; runtime lease/recovery and documented reconnect reconciliation. No claim that lost transport means cancellation/completion. No execution/recovery campaign performed in this website milestone. |
| Grounding strength/confidence | Implemented with restrictions | Evidence reporting contracts limit source-only proof and prohibit invented operation keys; agreement does not upgrade confidence. Website sample uses source-reference evidence only, no reproduced test claim. |
| Native Linux Desktop | Implemented but restricted / future release | Local feature work exists, but published v1.0.2 release target remains Windows 11 x64 + WSL2. Native Linux Desktop deferred. No macOS evidence. |
| v1.0.0 prepared/unpublished state in supplied notes | Historical release preparation | Superseded by actual GitHub Releases: v1.0.0, 1.0.1 and 1.0.2 published. Do not repeat old unavailable claim as current. |
| Windows v1.0.2 ZIP with packaged CLI | Verified published distribution | GitHub release API latest stable has version1.0.2, exact Windows-x64 filename, release/source metadata and checksum. Streamed all 122,864,963 ZIP bytes without executing/storing an application; SHA256 matches GitHub asset digest AND fetched sidecar: `5265713af248297c543bf0d41093258bd0e7d8c177e0b1c544e733750347286f`. Receipt `references/artifact-verification.json`. Unsigned ZIP, online WSL bootstrap, not signed MSI/MSIX/EXE/offline installer. No clean-machine acceptance inferred from hash verification. |
| Native Nexus Sentry integration | Planned / unavailable in inspected Nexus Desktop | Prior inspected `apps/nexus-desktop/src/features/sentry/SentryPage.tsx` explicitly unavailable. Sentry CLI can be used by supported external clients; that does not prove Nexus's native UI is integrated. Optional return remains conceptual. |
| Film execution, sample code/findings/statuses | Illustrative website demonstration | Offline Task Manager, sample identities, source snippets, finding records and all choreography are authored local website data. No provider/network model request, project import, real review or live persistence. |

## Primary references

- [v1 pipeline](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/v1-pipeline.md)
- [v1 source assessment](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/v1-phase-1-assessment.md)
- [historical roadmap](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/V1_ROADMAP.md)
- [historical prepared v1 notes](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1.0.0.md)
- [current published v1.0.2](https://github.com/Mert1026/Sentry/releases/tag/v1.0.2)
- [pinned current notes](https://github.com/Mert1026/Sentry/blob/2640efcd78744cb02c517a405e648722e662bd60/docs/releases/v1.0.2.md)

Raw referenced documents and timestamped API responses are preserved under `references/`. Product summaries derive from read local source and pinned documents, not historical roadmap assumptions.
