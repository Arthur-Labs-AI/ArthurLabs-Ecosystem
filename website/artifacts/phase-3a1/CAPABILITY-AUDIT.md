# Nexus Phase 3A.1 factual audit — before implementation

Source reviewed read-only: `/home/kaloyan/Projects/Nexus`. Existing website audit and actual modules were rechecked. No application commands, tests, services or writes are performed. Source presence is not a shipped-release or enabled-runtime claim.

| Feature / mechanism | Classification | Evidence | Presentation limit |
| --- | --- | --- | --- |
| Rust kernel, daemon, client, CLI, broker, journal/store | Implemented source components; enabled behavior is scope-dependent | `native/Cargo.toml`, kernel/lib.rs, broker/lib.rs, desktop README | Explain real boundaries; no universal speed/security guarantee or live task. |
| Desktop vs execution authority | Implemented source boundary | desktop README: typed Tauri/client/daemon; renderer does not own SQLite/routing/credentials | UI captures and displays; infrastructure authorizes/executes/records supported work. CLI/desktop entry abstractions are simplified. |
| Nova v3 | Planned, non-selectable, non-runnable | `config/registry/modes/engineering-v3.json` | Nine-step simulator is a proposed/illustrative walkthrough, not implemented agent output. Declared slots do not prove a functioning orchestrator. |
| CCv2 safe-point decision | Implemented primitive | `config/ContextSafePointV2.cjs` | Checks coherent operational boundaries/open edges. Does not trigger compaction or guarantee safety. |
| CCv2 structured checkpoint / provenance / integrity | Implemented primitives | `ContextCheckpointV2.cjs`, `ContextTrustV2.cjs` | Explain grounded state and source trust. Integrity seal is unkeyed, not authentication. |
| CCv2 retention planning | Implemented planning primitive | `ContextRetentionV2.cjs` | Plans a contiguous eligible old prefix and retained suffix. Age/size alone cannot justify removal; planner itself does not delete or apply. |
| CCv2 durable mutation | Restricted / disabled in inspected policy | `ContextDurableMutationPolicyV2.cjs`: returns false | Before/After sample illustrates disposition, not an enabled production compaction operation. |
| Recovery fault injection | Test-only mechanism | `ContextRecoveryFaultV2.cjs` | Do not advertise test harness as production recovery. Explain checkpoint validation/reference requirements without asserting seamless recovery. |
| Registry compilation / validation | Implemented source | `config/registry/resolver.cjs`: mode/slot/reference/capability/route/connection validation; immutable snapshots; fail closed | Registry supplies configuration and validation; it does not plan tasks or independently orchestrate. |
| Real models / providers / limits / availability | Not verified for this website | No live catalog imported or queried | Fictional models/providers/policies/statuses only, clearly labeled. No prices, scores or token sizes. |
| Sentry relationship | Separate product; conceptual integration handoff | Approved product topology; Nova manifest not runnable | External verification handoff/feedback is illustrative; no claim of native-core ownership or completed integration. |

## Audit of existing concept / reuse

- Keep the premium single-interface Hero, purple Nexus identity, authentic screenshot and native ratio; the entry anchor now leads to a role overview.
- Reuse the source-backed explanations, sample model names, technical line language and selected-state emphasis.
- Reuse the *idea* of Native Core depth; replace small generic morphing nodes with a dedicated layered system map and a persistent responsibility inspector.
- Retire the rendered `Engine` / `createEngine` continuous scroll timeline, four-chapter rail and combined film. Its source remains unused for historical comparison; no ScrollTrigger is mounted by the revised route.
- Replace the compact/static reference comparison and Registry cards with full educational experiences. Preserve their useful semantics and sample names rather than their shallow interaction model.
- Existing Landing/Suite/product sources and shared styling are protected by starting hashes.
