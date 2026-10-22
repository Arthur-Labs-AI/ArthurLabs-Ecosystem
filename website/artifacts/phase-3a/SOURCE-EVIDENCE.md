# Read-only technical evidence and claim boundaries

Inspected checkout: `/home/kaloyan/Projects/Nexus`. This is a local source snapshot, not a shipped-release attestation. No application commands, tests, services, Git operations or modifications were performed. Source hashes accompany the inspection; old planning documents are not treated as proof of implemented functionality.

| Topic | Inspected evidence | Website treatment |
| --- | --- | --- |
| Rust Native Core | `native/Cargo.toml`: kernel/store/daemon/client/CLI/model/broker/runtime crates. `native/nexus-kernel/src/lib.rs`: acceptance, approvals, integrity, readiness and tools; execution scopes default disabled. `native/nexus-store/src/lib.rs`: transactional SQLite store and journal/witness modules. | Existing source components; scope-dependent execution, no benchmark or “everything enabled” claim. |
| Desktop boundary | `apps/nexus-desktop/README.md`: React → typed Tauri commands → client → daemon IPC → kernel; renderer does not own SQLite, credentials or model routing. | Crisp explanatory cutaway. Screenshot remains an authentic static interface capture, not a live app. |
| Broker/provider boundary | `native/nexus-broker/src/lib.rs`: narrow user-intent front door; Registry issuance and daemon chain. | Boundary abstraction, no claim of arbitrary tool access or cryptographic issuer identity. |
| Nova | `config/registry/modes/engineering-v3.json`: status planned, selectable false, runnable false; planner/engineer/reviewer/verifier/specialist slots. `docs/architecture/registry-r3-ui.md` likewise marks preview. | Explicitly planned and illustrative in hero, chapter, node details and reference. Task decomposition is an example, not generated model output. |
| CCv2 primitives | `config/ContextSafePointV2.cjs`: pure operational-boundary decision; no open execution edge; does not create checkpoints. `ContextCheckpointV2.cjs`: structured artifact schema/identity. `ContextTrustV2.cjs`: provenance classification/content-integrity binding; unkeyed seal is not authentication. | Explain purpose and boundaries, not perfect information retention, universal safety or a compression ratio. |
| CCv2 active status | `config/ContextDurableMutationPolicyV2.cjs`: `durableMutationEnabledV2()` returns false; durable mutation throws. | Durable mutation disabled is prominent. Visual reorganization is an illustrative sample, not a completed durable compaction operation. |
| Registry | `config/registry/resolver.cjs`: deterministic validation/compiler; role/capability compatibility, route eligibility, immutable snapshots and fail-closed errors. `docs/architecture/registry-r1-core.md`: implemented core with planned Nova placeholder. | Explain model/provider/role separation. No real provider names, capabilities, context sizes, pricing, credentials or routing availability are imported. |
| Sentry | Existing ArthurLabs product identity and approved Suite integration topology. | Separate application at an illustrative integration handoff, never inside the Native Core. No live integration/run claim. |

## Deliberately illustrative content

“Build and test an offline-first task manager,” local storage decisions, execution state, observations, artifact references, checkpoint examples and open questions are authored examples. No repository file, test result, completion status or model response is fabricated. Seven example context facts remain represented before and after reorganization; this does not claim arbitrary real-world context can be compacted losslessly.

Sample A / B / C and Provider One / Two are fictional. Exact sample role mapping is planner→A, coder→B, reviewer→C. Selection exposes sample tags and context policies, not numerical context limits or benchmarks. It does not edit any real Registry configuration.

## Future product page recommendations

Before promoting the concept to `/nexus`, reconfirm Nova and CCv2 status against the intended release, replace source-snapshot labels only with executed release evidence, and review the architecture diagram with the runtime maintainers. Add Engineering Mode, CLI/Desktop, Sentry integration, download compatibility and installation as separately designed sections. Only publish verified release artifacts and official documentation/source destinations. Keep the interactive architecture optional beside a concise product explanation. Validate accelerated desktop and real mobile frame pacing and accessibility before production acceptance.
