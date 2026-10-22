# M05 Authoritative Writer Coverage Matrix

Single-owner native persistence. One meaningful transaction finalizes exactly one journal bundle, regardless of how many entity tables it touches. Nested helpers never emit individual events.

Status values: JOURNALED (private adapter routes through JournalKernel, one bundle per outer tx), LOCAL-ONLY / DERIVED (projection or preference state outside the replicated profile), READ-ONLY, UNREACHABLE / TEST-ONLY, BLOCKED (exact reason).

## 1. Projects (`projects`)

| Entrypoint | Owner | Affected entities | Adapter | Context/proof | No-op | Regression | Activation |
|---|---|---|---|---|---|---|---|
| `create_project` | ProjectStore | projects(record) | `create_project` | none (create) | NameTaken | w03 | JOURNALED |
| `rename_project` | ProjectStore | projects(record) | `rename_project` | none (metadata) | same name, no bundle when alone | w03 | JOURNALED |
| `archive_project` / `restore_project` | ProjectStore | projects(record) | `archive_project` / `restore_project` | none (metadata) | already archived/restored, no bundle | w03 | JOURNALED |
| `move_capture`, `move_knowledge_object` | ProjectStore | captures/projects, objects/projects (membership+head) | `move_capture`, `move_knowledge_object` | none (membership) | no-op move, no bundle | w04/w09 | JOURNALED |
| `set_active_project` | ProjectStore | none (local preference) | `set_active_project` | n/a | always silent when alone | w03/w11 | LOCAL-ONLY |

## 2. Captures (`captures`)

| Entrypoint | Owner | Affected entities | Adapter | Context/proof | No-op | Regression | Activation |
|---|---|---|---|---|---|---|---|
| `create` | CaptureStore | captures(record) | `create_capture` | none (create) | validation errors roll back | w02 | JOURNALED |

## 3. Distillation (`distillation_runs`, `knowledge_objects`, `object_sources`, `thought_revisions`)

| Entrypoint | Owner | Affected entities | Adapter | Context/proof | No-op | Regression | Activation |
|---|---|---|---|---|---|---|---|
| `record_distillation` | KnowledgeStore | run + objects + sources + initial revisions + parents | `record_distillation` | none (creates) | repeated/empty plans, zero-object runs | w05 | JOURNALED |
| `insert_object_in` (via evolution/review) | KnowledgeStore | object + source + initial revision | internal to composition adapters | none (create) | n/a | w24 | JOURNALED |
| `begin_distillation_in` | KnowledgeStore | run (Fresh) or none (Existing) | internal | n/a | Existing run commits nothing | w24/evolution | JOURNALED |
| `update_object` (user edit) | LineageStore | revision + parents + object head | `update_object` | none (user revision) | identical content still writes | w07 | JOURNALED |
| `create_revision_from` (branch) | LineageStore | revision + parents | `create_revision_from` | none | n/a | w07 | JOURNALED |
| `merge_revisions` | LineageStore | revisions + parents + head | `merge_revisions` | none | n/a | w07 | JOURNALED |
| `revise_from_capture` | LineageStore | revision + evidence? + head | `revise_from_capture` | none (user revision) | n/a | w07 | JOURNALED |
| `revise_if_current` user CAS | LineageStore | revision + parents + head | `revise_if_current` (User) | none | stale base rejected | w07 | JOURNALED |
| `revise_if_current` system CAS | LineageStore (via accept/evolution) | revision + parents + head | `accept_pending_claim`, `evolve_capture` | evidence required same-event | stale/mismatch rejected | w17/w19/w24 | JOURNALED |
| `restore_revision` | LineageStore | revision + head | `restore_revision` | none | n/a | w07 | JOURNALED |

## 4. Relations (`relations`, `integration_*`)

| Entrypoint | Owner | Affected entities | Adapter | Context/proof | No-op | Regression | Activation |
|---|---|---|---|---|---|---|---|
| `create_relation`, `record_relations` | RelationStore | relations | `create_relation`, `record_relations` | origin model/system, canonicalization | duplicate edge, no bundle | w08 | JOURNALED |
| `apply_integration` (MODEL replace) | IntegrationStore | relations (remove + create) | `apply_integration` | legacy creation refs | non-stale additions only | w09 | JOURNALED |
| domain-trigger deletions | SQLite triggers | relations (remove tombstone) | n/a (effect of owning tx) | modern/legacy provenance preserved | n/a | k12 | JOURNALED |

## 5. Identity (`identity_decisions`, `pending_claims`)

| Entrypoint | Owner | Affected entities | Adapter | Context/proof | No-op | Regression | Activation |
|---|---|---|---|---|---|---|---|
| `record_identity_decision_in` | IdentityStore | decisions | `record_identity_decision` | none (create) | idempotent repeat | w15 | JOURNALED |
| `stage_uncertain_claim_in` | IdentityStore | decision + claim | `stage_uncertain_claim` | none (creates) | identical retry, no bundle | w15 | JOURNALED |
| `accept_pending_claim[_hooked]_in` | IdentityStore (via review/evolution/adapter) | claim + revision + parents + evidence + object head (+ proposal via hook/trigger) | `accept_pending_claim`, `review_proposal`, `evolve_capture` | Approve + user, resolved rows | terminal repeat, no bundle | w17/w19/w20/w24 | JOURNALED |
| `separate_pending_claim[_hooked]_in` | IdentityStore (via review/resolve/adapter) | claim + object + source + revision (+ proposal via hook/trigger) | `separate_pending_claim`, `review_proposal`, `resolve_claim` | KeepSeparate + user/expiry | terminal repeat, no bundle | w18/w19 | JOURNALED |
| `defer_pending_claim_in` | IdentityStore (via resolve/adapter) | claim (+ proposal via review path) | `defer_claim`, `resolve_claim`, `review_proposal` | Defer + user | same-state defer emits proof-free bundle | w04/w18/w23 | JOURNALED |
| `reopen_pending_claim_in` | IdentityStore (via resolve/adapter) | claim (+ proposal via review path) | `reopen_claim`, `resolve_claim`, `review_proposal` | Reopen + user | same-state reopen emits proof-free bundle | w18 | JOURNALED |
| `resolve_unresolved_claim` (public) | ProposalStore | delegates to the above | `resolve_claim` (journal-native re-dispatch) | per action above | per action above | w18 | JOURNALED |

## 6. Proposals (`revision_proposals`)

| Entrypoint | Owner | Affected entities | Adapter | Context/proof | No-op | Regression | Activation |
|---|---|---|---|---|---|---|---|
| `insert_proposal_in` | ProposalStore | proposals | `insert_proposal` | none (create) | identical retry, no bundle; stale base rejected | w16 | JOURNALED |
| `review_in` Approve/EditAndApprove | ProposalStore | proposal + claim + revision + parents + evidence + head | `review_proposal` | row-bound proof, action/state agreement | idempotent repeat, no bundle | w17 | JOURNALED |
| `review_in` Reject | ProposalStore | proposal | `review_proposal` | Reject + user | idempotent repeat | w18 | JOURNALED |
| `review_in` Defer/Reopen | ProposalStore | proposal + claim | `review_proposal`, `resolve_claim` | Defer/Reopen + user | metadata-only bump, no proof | w18 | JOURNALED |
| `review_in` KeepSeparate | ProposalStore | proposal + claim + new object | `review_proposal`, `resolve_claim` | KeepSeparate + user | n/a | w18 | JOURNALED |
| trigger supersession on claim resolve | SQLite triggers | proposals (open/deferred -> superseded) | observed + `track_superseded` (DerivedClaimResolution) | Supersede + derived | n/a | w20 | JOURNALED |
| proposal expiry/dissolution | Scheduler (future) | proposals | not yet wired | n/a | n/a | n/a | BLOCKED - no scheduler-owned adapter yet; expiry path must reuse review contexts, not invent them |

## 7. Evidence (`revision_evidence`)

| Entrypoint | Owner | Affected entities | Adapter | Context/proof | No-op | Regression | Activation |
|---|---|---|---|---|---|---|---|
| `attach_revision_evidence_in` | EvidenceStore | evidence | `attach_revision_evidence` | none (creates, system-only) | identical span, no bundle; role/target conflict rejected | w14 | JOURNALED |
| initial-revision origin spans | LineageStore (insert paths) | evidence (role=origin) | internal to revision adapters | none | n/a | w05/w07 | JOURNALED |

## 8. Evolution composition (`distillation::evolution`)

| Entrypoint | Owner | Affected entities | Adapter | Context/proof | No-op | Regression | Activation |
|---|---|---|---|---|---|---|---|
| `apply` (planned composition) | Evolution pipeline | run + objects/revisions/evidence/decisions/claims/proposals | `evolve_capture` | SAVEPOINT-scoped; no reviews on inserts | Existing run commits nothing | w24/w25 | JOURNALED |
| `try_revise` SAVEPOINT fallback | Evolution pipeline | rolls back attempt, stages uncertainty | same tx via `evolve_capture` | no leaked context/reviews | stale target falls back | w25 | JOURNALED |
| provider planning (classifier/drafter/synthesis) | Provider workstream | none (outside tx) | n/a (pre-tx) | n/a | n/a | evolution_tests | LOCAL-ONLY (pre-transaction input) |

## 9. Unreachable / test-only / derived

| Entrypoint | Classification | Reason |
|---|---|---|
| `CaptureStore` getters, `list_*`, `view_in`, `proposal_in`, resolvers | READ-ONLY | No SQL writes. |
| `JournalTx::sql` raw access | TEST-ONLY | `#[cfg(test)]`; no production path opens arbitrary SQL inside the journal. |
| `sync_*` maintenance readers (`stored_head`, quota, stream check) | DERIVED | Projection/cache reads, never domain writes. |
| `EvolutionSettings`, provider doubles, recall/query | LOCAL-ONLY / TEST-ONLY | Configuration or pre-transaction planning. |
| FTS and recall indexes (`recall_*`, `*_fts`) | DERIVED | Maintained by SQLite FTS triggers from domain writes; journaled via their base rows. |

## 10. Double-journaling rule

Nested helpers never emit events. `JournalTx::with_domain` runs domain SQL on the single borrowed connection; only `finalize` (once per outer `JournalKernel::write`) produces at most one bundle. Adapters perform reads and writes freely inside one closure; the commit boundary is the only publication point. A no-op closure finalizes to `Ok(None)` with zero bundles. Covered by w10 (composed writers, one core + sequence) and the new w27 multi-entity test below.