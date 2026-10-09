# M04.7B Phase 1: deterministic identity core, revision CAS, and the v8 / pending-claim specifications

Status: Phase 1 implemented (offline, unwired). Schema v8 and pending claims are SPECIFICATIONS only; nothing here changes schema v7.

## 1. Identity semantics (corrected)
Identity ("which object is this about") and permission ("may Arthur change it unasked") are separate decisions.

| Relation | Identity | Automatic revision (first experimental version) |
|---|---|---|
| Additive refinement of the same proposition | same | yes, if every gate passes and no reframing signal |
| Correction of the same proposition | same | yes, same gates |
| Replacement of an explicit prior decision | same | only if the target is a `decision`, the provider vouches AND the claim's own words contain supersession wording |
| Fundamental conceptual reframing | same (or arguable) | never; confirmation required |
| Distinct feature/idea in the same project | distinct | never; NEW |
| Subtask vs existing task | unknown | never; UNCERTAIN |

Additive refinement is not reframing. A provider-labelled "additive" claim with a high reframing score is still blocked. "Same object" may still require confirmation (user-owned revision, Inbox, referent, kind).

## 2. Code (this phase)
`src/identity/` (pure: `types`, `classifier` trait, `policy`, `resolver`; test-only `fake`). `storage::lineage_store::revise_if_current` is the compare-and-set writer. Neither is called by distillation, commands, Graph, or UI. Default OFF (`identity::policy::DEFAULT_ENABLED`); a policy that names no model accepts none.

## 3. Evidence contract for schema v8 (finalized)
Principle: evidence is verbatim capture spans; synthesized text is interpretation and never receives a manufactured span (auto revisions have NULL span columns, origin `system`).

Distinguish three things:
* **Historical evidence**: every span that ever contributed to any revision (the evolution story). Never deleted.
* **Active supporting evidence**: evidence that supports claims still present in the CURRENT revision.
* **Withdrawn evidence**: historical evidence whose proposition a later revision corrected or replaced. Never presented as support for current truth.

`revision_evidence` therefore needs more than the Phase 0 sketch:
```
revision_evidence(
  revision_id, ordinal,                       -- PK
  capture_id, source_start, source_end,       -- verbatim span, validated like object_sources
  role  CHECK IN ('asserts','corrects','replaces'),
  retracts_revision_id, retracts_ordinal,     -- optional FK to an earlier evidence row this row withdraws
  claim_label TEXT NULL                       -- short model-written label of the proposition: marked interpretation, never quoted as source
)
```
Rules (derived at read time over `revision_parents`; revisions are immutable so nothing is copied):
* `asserts` (additive refinement): inherited evidence stays active; the new span becomes active.
* `corrects` / `replaces`: the new span is active. If `retracts_*` names earlier rows, those become withdrawn. If the proposition cannot be mapped to specific earlier spans, the conservative rule applies: ALL inherited evidence becomes historical-only unless re-asserted. Under-claiming support is the safe error.
* A `user_edit` or `merge` revision adds none and does not claim inherited evidence supports its new text: inherited evidence is shown as history ("original source") along that edge, not as "based on".
* The initial revision's span (existing columns / `object_sources`) is the origin evidence; no backfill.
* Claim-level attribution beyond `claim_label` is deliberately not stored: attributing sentences of synthesized text to spans would be fabricated precision.
* Reframing and supersession-with-stance-history are not automatic and use the existing `supersedes` relation, not evidence roles.

Other v8 tables (`identity_decisions` audit, `pending_claims`) stand as in the Phase 0 report; `identity_decisions.audit_json` holds ids/scores/versions only. Migration remains additive (no `thought_revisions` rebuild: origin `system` already passes its CHECK).

## 4. UNCERTAIN lifecycle (specification; `pending_claims` stays)
States: `open` -> `deferred` -> terminal `accepted` (revision applied) | `separated` (promoted to its own KnowledgeObject). Expiry is a transition to `separated` (an object is created), never deletion.
* **Discoverable**: every non-terminal claim (open, deferred, blocked) is listed in a review surface with its capture quote; deferred claims reappear (badge/weekly review). Defer never hides them.
* **Safe path to separate**: "Keep separate" and expiry both create a NEW object from the stored claim in one transaction with the decision row; no AI call is needed.
* **Idempotent resolution**: resolve is a compare-and-set on `state`; repeating the same resolution returns the recorded result; a conflicting second resolution is a typed conflict. The promoted object/revision id is stored on the claim.
* **Quota**: a cap on open claims (e.g. 50 per project) never discards: once full, an incoming UNCERTAIN claim is committed straight to a separate object (`method='quota_overflow'`), never merged and never dropped.
* **Independence**: the Capture and the distillation run commit regardless; staging happens in the same transaction as the run, and any identity failure degrades to NEW (unchecked).
* **Accept** re-reads the target's CURRENT revision, synthesizes then, validates, and applies via `revise_if_current`; a stale base re-evaluates once, then returns the claim to `open` with reason `target_changed`.
* **Relaunch**: rows are durable. A bounded, network-free sweep promotes claims past expiry; no identity or AI call runs at launch and no backlog is created.
* **Projects**: a claim is bound to its capture's project as of resolution time. Archived project: claims stay visible read-only and are not promoted (the open-project triggers would refuse); they become actionable on restore (`blocked`, not lost). Capture moved: "Update" candidates must be in the new project, otherwise only "Keep separate"/re-pick is offered. Target moved or its project archived: "Update" is disabled, "Keep separate" remains.

## 5. Contracts Phase 2 must preserve
* **`unchecked` is not a verified NEW.** `NewReason::Distinct` means a classifier ran, validated, and found no plausible referent. `NewReason::Unchecked(..)` (disabled, invalid input, no eligible candidate, classifier failure, malformed signals) means identity was NOT established. Persistence (`identity_decisions.outcome`: `new` vs `unchecked`), the UI and any metric must keep them apart; only `Distinct` may count as an identity decision.
* **Historical, active and withdrawn evidence stay three different things** (section 3). No query, label or UI string may present historical or withdrawn evidence as support for the current revision.
* **Model repetition is not independent verification.** Unanimity over repeated runs of one model removes sampling noise only; the runs share that model's biases (Noul and Choice are likewise one model). Independent verification requires a different model family or a deterministic check, and may only veto.
