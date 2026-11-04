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
| `due_pending_claims` / `due_pending_claims_in` | IdentityStore | none (read-only) | shared `claim_is_due`; private `due_pending_claim_in` recheck | none | read-only including limit=0 | expiry_tests::x01/x09/x17 | READ-ONLY; production v9 reporting unchanged |
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
| Dormant due/expiry batch | Explicit private execution candidate | due claims + new objects/sources/initial revisions + actual linked proposal supersession | `Writers::execute_due_expiry(DormantExpiryRequest)` -> `separate_pending_claim(..., "expiry")` | KeepSeparate / Expiry; Supersede / DerivedClaimResolution from actual v9 trigger | empty, zero-limit and repeated passes emit no bundle | expiry_tests::x01-x18 | IMPLEMENTED AND TESTED (synthetic v10); live policy OWNER APPROVAL PENDING; production scheduler NOT WIRED |

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

## 11. Task 14A dormant expiry boundary

`identity_store::due_pending_claims_in` borrows the owning connection and streams
claims in their original unique `pending_claims.seq` order. Public
`CaptureStore::due_pending_claims` uses `DueSelection::Reporting`, preserving
v9's reporting-only behavior, including ignoring malformed persisted due dates.
The private candidate uses `DueSelection::Execution`: malformed due dates fail
closed. Both use `claim_is_due`, RFC 3339 parsed instants (including offsets),
open/deferred states and the Capture's CURRENT project/archive state. Equality
with the supplied boundary instant is eligible; no local-clock text comparison.
The result limit is explicit, and zero returns no rows without writing.

Only the private journal module can construct `DormantExpiryRequest::candidate`.
This explicit dormant request is not an owner-approved automatic expiry policy.
`MAX_EXPIRY_BATCH = 32` is an engineering safety ceiling only; the existing
journal effect/dependency/size/quota limits can still reject a whole batch.
There is no caller-supplied ID list. `Writers::execute_due_expiry` selects and
rechecks each claim through `expiry::select` / `expiry::recheck` on the SAME
JournalTx connection, validates persisted claim/proposal metadata, then calls
the existing `Writers::separate_pending_claim(id, "expiry")`. No second mutex,
connection, transaction or per-claim finalizer is introduced. A caught writer
error remains fatal to the owning batch. X14/X15 compare every persistent table,
including observer metadata, bundles, heads and origin tips, after rollback.

A successful claim is `separated`, `resolved_method=expiry`, references the
actual new object, and has no resolved revision ID. Its source and sole initial
revision preserve the original claim content and Capture span. The unchanged
`pending_claims_resolution_supersedes_open_proposals` trigger closes open/deferred
drafts as `superseded`; `track_superseded` registers DerivedClaimResolution,
never a fabricated user review. Legitimate terminal drafts remain unchanged.
No new `expired` proposal state exists. A malformed persisted proposal closure
is an explicit error, not permission to proceed (X09).

| Architecture question | Task 14A answer |
|---|---|
| Source of truth | Existing SQLite domain rows; no scheduler-side preview or duplicate store is authoritative. |
| Ownership | CaptureStore owns the connection; JournalKernel owns the only BEGIN IMMEDIATE and COMMIT. |
| Dependency direction | Journal adapter -> stable shared domain selector/resolver; IdentityStore has no dependency on its journal caller. |
| Boundary | A private typed timestamp/batch request crosses into Writers; SQL handles and preview IDs do not escape. |
| Failure | Invalid metadata, domain errors and journal finalization errors roll back the whole batch; no partial success. |
| Lifecycle | One explicit invocation, bounded result, owning commit or rollback; no worker/timer requiring teardown. |
| Test seams | Synthetic v10 fixtures, explicit boundary timestamps, actual kernel fault injection; no timing sleeps or providers. |
| Compatibility | No migration/codec/reducer changes; public v9 remains reporting-only; revert the adapter without transforming data. |
| Observability | Returned actual resolutions only after owning commit, typed errors, immutable canonical event; no payload logging. |
| Security | Module-private candidate only; due_at grants no authority and production automatic policy still needs owner approval. |

Dormant due/expiry selection and dormant expiry writer: **IMPLEMENTED AND TESTED**
in synthetic v10 (`storage::journal::expiry_tests`, X01-X18). This is not physical
crash/durability evidence or production scheduling approval. Production automatic
expiry policy: **OWNER APPROVAL PENDING**. Production scheduler wiring:
**NOT IMPLEMENTED**. Production v10 activation: **NOT PERFORMED**.
