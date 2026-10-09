//! Schema v9 revision proposals: durability, the review state machine, compare-and-set protection, provenance, idempotency, concurrency
//! and rollback.

use std::sync::{Arc, Barrier};
use std::thread;

use super::capture_store::CaptureStore;
use super::identity_store::*;
use super::identity_store_tests::{claim, count, current, fx, fx_in, sql, staged, span_of, Fx, B_TEXT, DESKTOP};
use super::lineage_store::Changes;
use super::proposal_store::*;

const DRAFT: &str = "Arthur is a mobile application that also works on desktop.";

fn new_proposal(fx: &Fx, pending: &PendingClaim, base: &str, body: &str, change: &str) -> NewProposal {
    NewProposal {
        pending_claim_id: pending.id.clone(),
        object_id: fx.mobile.id.clone(),
        base_revision_id: base.to_string(),
        change: change.into(),
        kind: "idea".into(),
        title: "Mobile".into(),
        proposed_body: body.into(),
        retracts: None,
        evidence: vec![
            EvidenceRef { role: "existing".into(), capture_id: fx.a.id.clone(), start: 0, end: 31 },
            EvidenceRef { role: "claim".into(), capture_id: fx.b.id.clone(), start: pending.source_start, end: pending.source_end },
        ],
        synthesis_model: "gpt-6-luna-20260922".into(),
        verifier_model: "gpt-6-luna".into(),
        verification_mode: "same_family_review".into(),
        policy_version: "identity-core-1".into(),
    }
}

fn with_proposal(fx: &Fx) -> (PendingClaim, RevisionProposal) {
    let pending = staged(fx);
    let base = current(&fx.store, &fx.mobile);
    let (proposal, created) = fx.store.insert_revision_proposal(&new_proposal(fx, &pending, &base, DRAFT, "additive")).unwrap();
    assert!(created);
    (pending, proposal)
}

fn request(proposal: &RevisionProposal, action: ReviewAction, reviewed: Option<&str>) -> ReviewRequest {
    ReviewRequest { proposal_id: proposal.id.clone(), action, reviewed_revision_id: reviewed.map(str::to_string) }
}

fn revisions(fx: &Fx, object: &super::knowledge_store::KnowledgeObject) -> usize {
    fx.store.object_lineage(&object.id).unwrap().revisions.len()
}

fn body_of(fx: &Fx, object: &super::knowledge_store::KnowledgeObject) -> String {
    let lineage = fx.store.object_lineage(&object.id).unwrap();
    lineage.revisions.iter().find(|r| r.id == lineage.current_revision_id).unwrap().body.clone()
}

// --- creation and durability ------------------------------------------------------------------------------------------------------

#[test]
fn a_proposal_keeps_the_draft_its_evidence_models_and_mode_and_creating_it_twice_returns_the_first() {
    let fx = fx();
    let (pending, proposal) = with_proposal(&fx);
    assert_eq!((proposal.state.as_str(), proposal.proposed_body.as_str(), proposal.verification_mode.as_str(), proposal.verification_status.as_str()), ("open", DRAFT, "same_family_review", "passed"));
    assert_eq!((proposal.synthesis_model.as_str(), proposal.verifier_model.as_str(), proposal.evidence.len(), proposal.user_edited), ("gpt-6-luna-20260922", "gpt-6-luna", 2, false));
    assert_eq!(proposal.pending_claim_id, pending.id);
    let (again, created) = fx.store.insert_revision_proposal(&new_proposal(&fx, &pending, &proposal.base_revision_id, "something else entirely", "additive")).unwrap();
    assert!(!created);
    assert_eq!(again.id, proposal.id, "the claim already has its proposal");
    assert_eq!(count(&fx.store, "SELECT count(*) FROM revision_proposals"), 1);
    // nothing about credentials or provider payloads has anywhere to live in the row
    let columns: Vec<String> = fx.store.connection.lock().unwrap().prepare("SELECT name FROM pragma_table_info('revision_proposals')").unwrap().query_map([], |r| r.get(0)).unwrap().map(|c| c.unwrap()).collect();
    assert!(columns.iter().all(|c| !c.contains("key") && !c.contains("header") && !c.contains("payload") && !c.contains("raw")), "{columns:?}");
}

#[test]
fn proposals_and_their_claims_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("arthur.db");
    let (proposal_id, claim_id, base) = {
        let fx = fx_in(CaptureStore::open(&path).unwrap());
        let (pending, proposal) = with_proposal(&fx);
        (proposal.id, pending.id, proposal.base_revision_id)
    };
    let store = CaptureStore::open(&path).unwrap();
    let view = store.get_revision_proposal(&proposal_id).unwrap().unwrap();
    assert_eq!((view.state.as_str(), view.proposed.body.as_str(), view.base_revision_id.as_str(), view.stale), ("open", DRAFT, base.as_str(), false));
    assert_eq!(store.list_revision_proposals(None, &["open"]).unwrap().len(), 1);
    assert_eq!(store.get_pending_claim(&claim_id).unwrap().unwrap().state, "open");
    assert_eq!(store.list_unresolved_claims(None).unwrap()[0].proposal_id.as_deref(), Some(proposal_id.as_str()));
}

#[test]
fn the_schema_refuses_a_proposal_for_a_closed_claim_a_non_candidate_or_a_stale_base() {
    let fx = fx();
    let pending = staged(&fx);
    let base = current(&fx.store, &fx.mobile);
    // not one of the claim's candidates
    let mut wrong_object = new_proposal(&fx, &pending, &fx.voice.id, DRAFT, "additive");
    wrong_object.object_id = fx.voice.id.clone();
    wrong_object.base_revision_id = current(&fx.store, &fx.voice);
    assert!(fx.store.insert_revision_proposal(&wrong_object).is_err());
    // a base that is not the object's current revision
    assert!(fx.store.insert_revision_proposal(&new_proposal(&fx, &pending, "not-a-revision", DRAFT, "additive")).is_err());
    fx.store.update_object(&fx.mobile.id, Changes { body: Some("Arthur is a mobile app, edited.".into()), ..Default::default() }).unwrap();
    assert!(fx.store.insert_revision_proposal(&new_proposal(&fx, &pending, &base, DRAFT, "additive")).is_err(), "the base moved on");
    // invalid content
    let current_base = current(&fx.store, &fx.mobile);
    for bad in [new_proposal(&fx, &pending, &current_base, "  ", "additive"), new_proposal(&fx, &pending, &current_base, DRAFT, "merge")] {
        assert!(fx.store.insert_revision_proposal(&bad).is_err());
    }
    // a claim that is no longer open
    fx.store.defer_pending_claim(&pending.id, None).unwrap();
    assert!(fx.store.insert_revision_proposal(&new_proposal(&fx, &pending, &current_base, DRAFT, "additive")).is_err(), "only an open claim");
    assert_eq!(count(&fx.store, "SELECT count(*) FROM revision_proposals"), 0);
}

#[test]
fn a_proposal_is_immutable_never_deleted_and_its_terminal_states_are_final() {
    let fx = fx();
    let (_, proposal) = with_proposal(&fx);
    for tamper in [
        "UPDATE revision_proposals SET proposed_body = 'rewritten'",
        "UPDATE revision_proposals SET verification_mode = 'independent'",
        "UPDATE revision_proposals SET synthesis_model = 'other'",
        "UPDATE revision_proposals SET evidence_json = '[]'",
        "UPDATE revision_proposals SET object_id = (SELECT id FROM knowledge_objects WHERE id <> object_id LIMIT 1)",
        "DELETE FROM revision_proposals",
        "UPDATE revision_proposals SET state = 'approved', final_body = 'x', result_revision_id = base_revision_id, reviewed_at = 'now'",
        "UPDATE revision_proposals SET state = 'bogus'",
    ] {
        assert!(sql(&fx.store, tamper).is_err(), "{tamper}");
    }
    fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Reject, None)).unwrap();
    for later in ["UPDATE revision_proposals SET state = 'open'", "UPDATE revision_proposals SET state = 'deferred'", "UPDATE revision_proposals SET reviewed_at = 'x'"] {
        assert!(sql(&fx.store, later).is_err(), "{later}");
    }
}

// --- approve ------------------------------------------------------------------------------------------------------------------------

#[test]
fn approving_applies_the_draft_once_with_the_claims_evidence_and_closes_proposal_and_claim_together() {
    let fx = fx();
    let (pending, proposal) = with_proposal(&fx);
    let base = proposal.base_revision_id.clone();
    let result = fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Approve, Some(&base))).unwrap();
    assert!(result.applied);
    let applied = result.revision.clone().unwrap();
    assert_eq!((applied.object_id.as_str(), applied.previous_revision_id.as_str()), (fx.mobile.id.as_str(), base.as_str()));
    assert_eq!((result.proposal.state.as_str(), result.proposal.final_body.as_deref(), result.proposal.user_edited), ("approved", Some(DRAFT), false));
    assert_eq!(result.proposal.result_revision_id.as_deref(), Some(applied.revision_id.as_str()));
    assert_eq!(body_of(&fx, &fx.mobile), DRAFT);
    // the revision DAG grew by exactly one child of the base; nothing was overwritten
    let lineage = fx.store.object_lineage(&fx.mobile.id).unwrap();
    assert_eq!(lineage.revisions.len(), 2);
    let revision = lineage.revisions.iter().find(|r| r.id == applied.revision_id).unwrap();
    assert_eq!((revision.origin.as_str(), revision.parent_revision_ids.clone()), ("system", vec![base.clone()]));
    assert_eq!(lineage.revisions.iter().find(|r| r.id == base).unwrap().body, "Arthur is a mobile application.");
    // the claim is accepted into that very revision and its exact span supports it
    let claim_now = fx.store.get_pending_claim(&pending.id).unwrap().unwrap();
    assert_eq!((claim_now.state.as_str(), claim_now.resolved_revision_id.as_deref(), claim_now.resolved_method.as_deref()), ("accepted", Some(applied.revision_id.as_str()), Some("user")));
    let support = fx.store.evidence_support(&applied.revision_id).unwrap();
    let active: Vec<(String, i64, i64)> = support.active.iter().map(|e| (e.capture_id.clone(), e.source_start, e.source_end)).collect();
    assert!(active.contains(&(fx.b.id.clone(), pending.source_start, pending.source_end)), "the claim's exact words support the new text: {active:?}");
    assert!(active.iter().any(|(capture, _, _)| *capture == fx.a.id), "an additive revision keeps the original support: {active:?}");
    // repeating it is a no-op that reports the same result
    let again = fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Approve, Some(&base))).unwrap();
    assert!(!again.applied);
    assert_eq!((again.proposal.result_revision_id, revisions(&fx, &fx.mobile)), (Some(applied.revision_id), 2));
    // a different decision on a resolved proposal is refused
    assert!(matches!(fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Reject, None)), Err(ReviewError::AlreadyResolved(s)) if s == "approved"));
    assert!(matches!(fx.store.review_revision_proposal(&request(&proposal, ReviewAction::KeepSeparate, None)), Err(ReviewError::AlreadyResolved(_))));
}

#[test]
fn editing_before_approving_records_the_text_the_person_approved_and_marks_it_user_edited() {
    let fx = fx();
    let (_, proposal) = with_proposal(&fx);
    let base = proposal.base_revision_id.clone();
    let mine = "Arthur is a mobile application; desktop is planned.";
    // an edit must state which revision the person read
    assert!(matches!(fx.store.review_revision_proposal(&request(&proposal, ReviewAction::EditAndApprove { body: mine.into() }, None)), Err(ReviewError::Stale { .. })));
    assert_eq!(revisions(&fx, &fx.mobile), 1);
    let result = fx.store.review_revision_proposal(&request(&proposal, ReviewAction::EditAndApprove { body: mine.into() }, Some(&base))).unwrap();
    assert_eq!((result.proposal.user_edited, result.proposal.final_body.as_deref(), result.proposal.state.as_str()), (true, Some(mine), "approved"));
    assert_eq!(result.proposal.proposed.body, DRAFT, "the AI's draft is kept as it was written");
    assert_eq!(body_of(&fx, &fx.mobile), mine);
    // an "edit" that equals the draft is the draft, not a user edit
    let fx2 = self::fx();
    let (_, p2) = with_proposal(&fx2);
    let same = fx2.store.review_revision_proposal(&request(&p2, ReviewAction::EditAndApprove { body: format!("  {DRAFT} ") }, Some(&p2.base_revision_id))).unwrap();
    assert!(!same.proposal.user_edited);
    // empty and unchanged text are refused and write nothing
    let fx3 = self::fx();
    let (_, p3) = with_proposal(&fx3);
    for bad in ["   ", "Arthur is a mobile application."] {
        assert!(matches!(fx3.store.review_revision_proposal(&request(&p3, ReviewAction::EditAndApprove { body: bad.into() }, Some(&p3.base_revision_id))), Err(ReviewError::Invalid(_))), "{bad:?}");
    }
    assert_eq!((revisions(&fx3, &fx3.mobile), count(&fx3.store, "SELECT count(*) FROM revision_evidence")), (1, 0));
}

#[test]
fn a_user_edit_after_the_draft_blocks_one_click_approval_and_never_overwrites_the_newer_text() {
    let fx = fx();
    let (pending, proposal) = with_proposal(&fx);
    let theirs = "Arthur is a mobile application, built with Tauri.";
    let edited = fx.store.update_object(&fx.mobile.id, Changes { body: Some(theirs.into()), ..Default::default() }).unwrap();
    let view = fx.store.get_revision_proposal(&proposal.id).unwrap().unwrap();
    assert!(view.stale && view.blocked.is_none());
    assert_eq!(view.current.as_ref().unwrap().body, theirs);
    assert_eq!(view.current.as_ref().unwrap().origin, "user_edit");
    // one-click approval is refused, with or without stating what was read
    for reviewed in [None, Some(proposal.base_revision_id.as_str()), Some(edited.id.as_str())] {
        let outcome = fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Approve, reviewed));
        assert!(matches!(&outcome, Err(ReviewError::Stale { current_revision_id }) if *current_revision_id == edited.id), "{reviewed:?}: {outcome:?}");
    }
    assert_eq!((body_of(&fx, &fx.mobile), revisions(&fx, &fx.mobile)), (theirs.to_string(), 2), "their edit is untouched");
    assert_eq!(fx.store.get_pending_claim(&pending.id).unwrap().unwrap().state, "open");
    // re-review: the person reads the CURRENT text and approves their own wording against it
    let wording = "Arthur is a mobile application, built with Tauri, and will also run on desktop.";
    assert!(matches!(fx.store.review_revision_proposal(&request(&proposal, ReviewAction::EditAndApprove { body: wording.into() }, Some(&proposal.base_revision_id))), Err(ReviewError::Stale { .. })), "reading the OLD text is not a review of the new one");
    let result = fx.store.review_revision_proposal(&request(&proposal, ReviewAction::EditAndApprove { body: wording.into() }, Some(&edited.id))).unwrap();
    assert!(result.applied && result.proposal.user_edited);
    let lineage = fx.store.object_lineage(&fx.mobile.id).unwrap();
    assert_eq!(lineage.revisions.len(), 3);
    assert_eq!(lineage.revisions.iter().find(|r| Some(&r.id) == result.proposal.result_revision_id.as_ref()).unwrap().parent_revision_ids, vec![edited.id], "built on THEIR edit, which is history, not overwritten");
}

#[test]
fn another_automatic_revision_or_a_move_between_projects_also_blocks_approval() {
    let fx = fx();
    let (pending, proposal) = with_proposal(&fx);
    // the object itself moves to another project: the claim and the object are no longer in the same project
    let other = fx.store.create_project("Elsewhere").unwrap();
    fx.store.move_knowledge_object(&fx.mobile.id, &other.id).unwrap();
    let view = fx.store.get_revision_proposal(&proposal.id).unwrap().unwrap();
    assert_eq!(view.blocked.as_deref(), Some("claim_moved"));
    let outcome = fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Approve, Some(&proposal.base_revision_id)));
    assert!(matches!(outcome, Err(ReviewError::Blocked("claim_moved"))), "{outcome:?}");
    assert_eq!((revisions(&fx, &fx.mobile), fx.store.get_pending_claim(&pending.id).unwrap().unwrap().state.as_str().to_string()), (1, "open".to_string()));
    // the capture moves too: project boundary holds again, and the same proposal can be applied
    fx.store.move_capture(&fx.b.id, &other.id).unwrap();
    let again = fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Approve, Some(&proposal.base_revision_id)));
    assert!(again.is_ok(), "{again:?}");
}

#[test]
fn an_archived_project_blocks_every_applying_action_but_not_dismissal() {
    let fx = fx();
    let (_, proposal) = with_proposal(&fx);
    fx.store.archive_project(&crate::storage::migrations::INBOX_PROJECT_ID.to_string()).ok();
    // the fixture lives in the Inbox, which cannot be archived: use a project-owned fixture instead
    let fx = self::fx();
    let project = fx.store.create_project("Work").unwrap();
    fx.store.move_capture(&fx.b.id, &project.id).unwrap();
    fx.store.move_knowledge_object(&fx.mobile.id, &project.id).unwrap();
    let (_, proposal2) = with_proposal(&fx);
    fx.store.archive_project(&project.id).unwrap();
    let view = fx.store.get_revision_proposal(&proposal2.id).unwrap().unwrap();
    assert_eq!(view.blocked.as_deref(), Some("project_archived"));
    for action in [ReviewAction::Approve, ReviewAction::KeepSeparate] {
        assert!(fx.store.review_revision_proposal(&request(&proposal2, action, Some(&proposal2.base_revision_id))).is_err());
    }
    assert_eq!(revisions(&fx, &fx.mobile), 1);
    assert!(fx.store.list_unresolved_claims(None).unwrap().iter().any(|c| c.project_archived), "an archived project's claims are still listed");
    fx.store.restore_project(&project.id).unwrap();
    assert!(fx.store.review_revision_proposal(&request(&proposal2, ReviewAction::Approve, Some(&proposal2.base_revision_id))).is_ok());
    let _ = proposal;
}

// --- reject / keep separate / defer ---------------------------------------------------------------------------------------------

#[test]
fn rejecting_dismisses_only_the_draft_and_the_captured_claim_stays_open_and_visible() {
    let fx = fx();
    let (pending, proposal) = with_proposal(&fx);
    let captures_before = fx.store.list().unwrap().len();
    let result = fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Reject, None)).unwrap();
    assert_eq!((result.proposal.state.as_str(), result.applied, result.revision.is_none()), ("rejected", true, true));
    assert_eq!(fx.store.get_pending_claim(&pending.id).unwrap().unwrap().state, "open", "the claim is NOT resolved by dismissing its draft");
    assert_eq!((revisions(&fx, &fx.mobile), fx.store.list().unwrap().len()), (1, captures_before));
    assert_eq!(fx.store.get_captures(&[fx.b.id.clone()]).unwrap()[0].content, B_TEXT, "the raw capture is untouched");
    let unresolved = fx.store.list_unresolved_claims(None).unwrap();
    assert_eq!((unresolved.len(), unresolved[0].proposal_state.as_deref()), (1, Some("rejected")));
    // dismissing is idempotent, and the person can still make the explicit choice afterwards
    assert!(!fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Reject, None)).unwrap().applied);
    let kept = fx.store.resolve_unresolved_claim(&pending.id, ClaimAction::KeepSeparate).unwrap();
    assert_eq!(kept.claim_state, "separated");
    assert!(kept.created_object_id.is_some());
    assert_eq!(fx.store.get_revision_proposal(&proposal.id).unwrap().unwrap().state, "rejected", "history of the dismissal is kept");
}

#[test]
fn keeping_separate_creates_the_claims_own_idea_from_its_exact_span_and_closes_both_records() {
    let fx = fx();
    let (pending, proposal) = with_proposal(&fx);
    let result = fx.store.review_revision_proposal(&request(&proposal, ReviewAction::KeepSeparate, None)).unwrap();
    assert_eq!(result.proposal.state, "separated");
    let object_id = result.created_object_id.clone().unwrap();
    let object = fx.store.get_knowledge_object(&object_id).unwrap().unwrap();
    assert_eq!((object.title.as_str(), object.provenance.capture_id.as_str(), object.provenance.source_start), ("Desktop", fx.b.id.as_str(), pending.source_start));
    assert_eq!(revisions(&fx, &fx.mobile), 1, "the existing idea is untouched");
    let again = fx.store.review_revision_proposal(&request(&proposal, ReviewAction::KeepSeparate, None)).unwrap();
    assert!(!again.applied);
    assert_eq!(again.created_object_id.as_deref(), Some(object_id.as_str()), "repeating returns the same object, not a second one");
    assert_eq!(count(&fx.store, "SELECT count(*) FROM knowledge_objects"), 3);
    assert!(matches!(fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Approve, Some(&proposal.base_revision_id))), Err(ReviewError::AlreadyResolved(_))));
}

#[test]
fn deferring_and_reopening_move_claim_and_proposal_together_and_lose_nothing() {
    let fx = fx();
    let (pending, proposal) = with_proposal(&fx);
    let deferred = fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Defer { due_at: Some("2030-01-01T00:00:00Z".into()) }, None)).unwrap();
    assert_eq!(deferred.proposal.state, "deferred");
    assert_eq!(fx.store.get_pending_claim(&pending.id).unwrap().unwrap().state, "deferred");
    assert_eq!(fx.store.list_unresolved_claims(None).unwrap().len(), 1, "a deferred claim is still listed");
    // a deferred proposal can still be approved
    let reopened = fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Reopen, None)).unwrap();
    assert_eq!(reopened.proposal.state, "open");
    assert_eq!(fx.store.get_pending_claim(&pending.id).unwrap().unwrap().state, "open");
    fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Defer { due_at: None }, None)).unwrap();
    assert!(fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Approve, Some(&proposal.base_revision_id))).unwrap().applied);
}

#[test]
fn a_claim_resolved_by_any_other_route_supersedes_its_reviewable_proposal() {
    let fx = fx();
    let (pending, proposal) = with_proposal(&fx);
    fx.store.separate_pending_claim(&pending.id, "user").unwrap();
    let view = fx.store.get_revision_proposal(&proposal.id).unwrap().unwrap();
    assert_eq!(view.state, "superseded");
    assert!(matches!(fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Approve, Some(&proposal.base_revision_id))), Err(ReviewError::AlreadyResolved(s)) if s == "superseded"));
}

// --- concurrency, rollback ----------------------------------------------------------------------------------------------------------

#[test]
fn concurrent_approvals_apply_exactly_once_and_every_caller_sees_the_same_result() {
    let fx = fx();
    let (_, proposal) = with_proposal(&fx);
    let store = Arc::new(fx.store);
    let barrier = Arc::new(Barrier::new(8));
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let (store, barrier, proposal) = (store.clone(), barrier.clone(), proposal.clone());
            thread::spawn(move || {
                barrier.wait();
                store.review_revision_proposal(&request(&proposal, ReviewAction::Approve, Some(&proposal.base_revision_id)))
            })
        })
        .collect();
    let results: Vec<ReviewResult> = handles.into_iter().map(|h| h.join().unwrap().expect("every caller succeeds")).collect();
    assert_eq!(results.iter().filter(|r| r.applied).count(), 1, "exactly one caller wrote");
    let revision = results[0].proposal.result_revision_id.clone();
    assert!(results.iter().all(|r| r.proposal.result_revision_id == revision && r.proposal.state == "approved"));
    assert_eq!(store.object_lineage(&fx.mobile.id).unwrap().revisions.len(), 2);
    assert_eq!(store.connection.lock().unwrap().query_row("SELECT count(*) FROM revision_evidence", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
}

#[test]
fn approve_racing_reject_has_one_winner_and_a_consistent_outcome() {
    for _ in 0..10 {
        let fx = fx();
        let (pending, proposal) = with_proposal(&fx);
        let store = Arc::new(fx.store);
        let barrier = Arc::new(Barrier::new(2));
        let a = {
            let (s, b, p) = (store.clone(), barrier.clone(), proposal.clone());
            thread::spawn(move || {
                b.wait();
                s.review_revision_proposal(&request(&p, ReviewAction::Approve, Some(&p.base_revision_id)))
            })
        };
        let r = {
            let (s, b, p) = (store.clone(), barrier.clone(), proposal.clone());
            thread::spawn(move || {
                b.wait();
                s.review_revision_proposal(&request(&p, ReviewAction::Reject, None))
            })
        };
        let (approve, reject) = (a.join().unwrap(), r.join().unwrap());
        let state = store.get_revision_proposal(&proposal.id).unwrap().unwrap().state;
        let revisions = store.object_lineage(&fx.mobile.id).unwrap().revisions.len();
        match state.as_str() {
            "approved" => assert!(approve.is_ok() && matches!(reject, Err(ReviewError::AlreadyResolved(_))) && revisions == 2),
            "rejected" => assert!(reject.is_ok() && matches!(approve, Err(ReviewError::AlreadyResolved(_))) && revisions == 1 && store.get_pending_claim(&pending.id).unwrap().unwrap().state == "open"),
            other => panic!("unexpected final state {other}"),
        }
    }
}

#[test]
fn a_failure_while_approving_rolls_back_the_revision_the_evidence_and_the_claim() {
    let fx = fx();
    let (pending, proposal) = with_proposal(&fx);
    // make the very last write of the approval fail: the revision, its evidence and the claim state have all been written by then
    sql(&fx.store, "CREATE TRIGGER sabotage BEFORE UPDATE ON revision_proposals WHEN NEW.state = 'approved' BEGIN SELECT RAISE(ABORT, 'disk on fire'); END;").unwrap();
    let outcome = fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Approve, Some(&proposal.base_revision_id)));
    assert!(outcome.is_err());
    assert_eq!(revisions(&fx, &fx.mobile), 1);
    assert_eq!(count(&fx.store, "SELECT count(*) FROM revision_evidence"), 0);
    assert_eq!(fx.store.get_pending_claim(&pending.id).unwrap().unwrap().state, "open");
    assert_eq!(fx.store.get_revision_proposal(&proposal.id).unwrap().unwrap().state, "open");
    sql(&fx.store, "DROP TRIGGER sabotage").unwrap();
    assert!(fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Approve, Some(&proposal.base_revision_id))).unwrap().applied, "a retry after the failure works");
}

// --- history and corrections -----------------------------------------------------------------------------------------------------------

#[test]
fn a_correction_approved_after_an_earlier_approval_withdraws_exactly_the_evidence_it_names() {
    let fx = fx();
    let (_, first) = with_proposal(&fx);
    let first_result = fx.store.review_revision_proposal(&request(&first, ReviewAction::Approve, Some(&first.base_revision_id))).unwrap();
    let r1 = first_result.revision.unwrap().revision_id;
    // a second claim of the same capture corrects the first approved assertion
    let (s, e) = span_of(B_TEXT, "Нещо друго");
    let mut second_claim = claim(&fx, 1, "Нещо друго", &[&fx.mobile]);
    second_claim.source_start = s;
    second_claim.source_end = e;
    let pending2 = fx.store.stage_uncertain_claim(&second_claim).unwrap().0;
    let mut correction = new_proposal(&fx, &pending2, &r1, "Arthur is a mobile application that works on desktop later.", "correction");
    correction.retracts = Some((r1.clone(), 0));
    let (second, _) = fx.store.insert_revision_proposal(&correction).unwrap();
    let result = fx.store.review_revision_proposal(&request(&second, ReviewAction::Approve, Some(&r1))).unwrap();
    let r2 = result.revision.unwrap().revision_id;
    let support = fx.store.evidence_support(&r2).unwrap();
    assert_eq!(support.withdrawn.len(), 1, "the earlier assertion is explicitly withdrawn, not deleted");
    assert_eq!((support.withdrawn[0].0.revision_id.as_str(), support.withdrawn[0].1.0.as_str()), (r1.as_str(), r2.as_str()));
    assert!(support.active.iter().any(|a| a.capture_id == fx.b.id && a.source_start == s), "the correcting words support the current text");
    assert!(support.active.iter().all(|a| !(a.revision_id == r1 && a.ordinal == Some(0))), "the withdrawn assertion no longer counts as support");
    assert_eq!(fx.store.object_lineage(&fx.mobile.id).unwrap().revisions.len(), 3);
}

#[test]
fn unresolved_claims_without_any_draft_are_listed_and_resolved_explicitly_and_nothing_expires_into_deletion() {
    let fx = fx();
    let pending = staged(&fx);
    let listed = fx.store.list_unresolved_claims(None).unwrap();
    assert_eq!((listed.len(), listed[0].proposal_id.clone(), listed[0].candidates.len()), (1, None, 1), "no draft is invented");
    assert_eq!(listed[0].candidates[0].title, "Mobile");
    // old and due are only reported
    sql(&fx.store, "UPDATE pending_claims SET due_at = '2000-01-01T00:00:00Z'").ok();
    assert_eq!(fx.store.list_unresolved_claims(None).unwrap().len(), 1);
    let deferred = fx.store.resolve_unresolved_claim(&pending.id, ClaimAction::Defer { due_at: None }).unwrap();
    assert_eq!(deferred.claim_state, "deferred");
    let reopened = fx.store.resolve_unresolved_claim(&pending.id, ClaimAction::Reopen).unwrap();
    assert_eq!(reopened.claim_state, "open");
    let kept = fx.store.resolve_unresolved_claim(&pending.id, ClaimAction::KeepSeparate).unwrap();
    assert!(kept.applied && kept.created_object_id.is_some());
    assert!(!fx.store.resolve_unresolved_claim(&pending.id, ClaimAction::KeepSeparate).unwrap().applied, "idempotent");
    assert!(fx.store.list_unresolved_claims(None).unwrap().is_empty());
    let _ = DESKTOP;
}

// --- undo --------------------------------------------------------------------------------------------------------------------------

#[test]
fn undo_adds_a_new_revision_pointing_back_at_the_earlier_text_and_deletes_nothing() {
    let fx = fx();
    let (_, proposal) = with_proposal(&fx);
    let first = proposal.base_revision_id.clone();
    let approved = fx.store.review_revision_proposal(&request(&proposal, ReviewAction::Approve, Some(&first))).unwrap().revision.unwrap().revision_id;
    let before = fx.store.object_lineage(&fx.mobile.id).unwrap();
    assert_eq!(before.revisions.len(), 2);
    let restored = fx.store.restore_revision(&fx.mobile.id, &first, &approved).unwrap();
    let after = fx.store.object_lineage(&fx.mobile.id).unwrap();
    assert_eq!(after.revisions.len(), 3, "history only grows");
    assert_eq!((restored.origin.as_str(), restored.body.as_str()), ("merge", "Arthur is a mobile application."));
    let mut parents = restored.parent_revision_ids.clone();
    parents.sort();
    let mut expected = vec![approved.clone(), first.clone()];
    expected.sort();
    assert_eq!(parents, expected, "it points at what was undone AND at the text it went back to");
    assert_eq!(after.current_revision_id, restored.id);
    for old in &before.revisions {
        assert_eq!(after.revisions.iter().find(|r| r.id == old.id), Some(old), "no earlier revision changed");
    }
    // the approval record of the undone revision is kept: it is still true that it was approved
    assert_eq!(fx.store.approvals_for_object(&fx.mobile.id).unwrap().len(), 1);
    // restoring over a revision that is no longer current, or the text that is already current, writes nothing
    assert!(matches!(fx.store.restore_revision(&fx.mobile.id, &first, &approved), Err(crate::storage::lineage_store::ReviseConflict::Stale { .. })));
    assert!(matches!(fx.store.restore_revision(&fx.mobile.id, &first, &restored.id), Err(crate::storage::lineage_store::ReviseConflict::Rejected(_))));
    assert_eq!(fx.store.object_lineage(&fx.mobile.id).unwrap().revisions.len(), 3);
    // and the text before the undo can be brought back the same way
    let redo = fx.store.restore_revision(&fx.mobile.id, &approved, &restored.id).unwrap();
    assert_eq!(redo.body, DRAFT);
}

// --- downstream provenance ------------------------------------------------------------------------------------------------------------

#[test]
fn recall_is_told_who_made_an_approved_revision_and_never_calls_a_person_s_wording_ai_authored() {
    let ask = |fx: &Fx| {
        let ids = vec![fx.mobile.id.clone()];
        let detail = fx.store.recall_object_details(&ids).unwrap().remove(0);
        let history: Vec<String> = fx.store.recall_revisions_of(&ids).unwrap().into_iter().map(|r| r.origin).collect();
        (detail.current_origin, history)
    };
    // an approved suggestion as written
    let fx1 = fx();
    let (_, p1) = with_proposal(&fx1);
    assert_eq!(ask(&fx1).0, "initial");
    fx1.store.review_revision_proposal(&request(&p1, ReviewAction::Approve, Some(&p1.base_revision_id))).unwrap();
    let (current, history) = ask(&fx1);
    assert_eq!((current.as_str(), history.as_slice()), ("approved_suggestion", ["initial".to_string(), "approved_suggestion".to_string()].as_slice()));
    // the person's own wording
    let fx2 = fx();
    let (_, p2) = with_proposal(&fx2);
    fx2.store.review_revision_proposal(&request(&p2, ReviewAction::EditAndApprove { body: "Arthur is a mobile app; desktop later.".into() }, Some(&p2.base_revision_id))).unwrap();
    assert_eq!(ask(&fx2).0, "approved_edited");
    // an earlier fully automatic revision (no approval record) keeps its honest label
    let fx3 = fx();
    let (_, p3) = with_proposal(&fx3);
    fx3.store.revise_if_current(&super::lineage_store::ExpectedRevision { object_id: &fx3.mobile.id, project_id: &fx3.mobile.project_id, base_revision_id: &p3.base_revision_id }, super::lineage_store::RevisionContent { kind: "idea".into(), title: "Mobile".into(), body: "Arthur is a mobile app, automatically.".into() }, super::lineage_store::CasOrigin::System).unwrap();
    assert_eq!(ask(&fx3).0, "system");
    // Recall still treats every one of them as edited since the capture, so the original words are never offered as support for the new text
    let source = include_str!("../recall/package.rs");
    assert!(source.contains("\"approved_suggestion\" | \"approved_edited\""));
}

// --- Android acceptance data -------------------------------------------------------------------------------------------------------

/// Adds two real-looking suggestions (English with an emoji, and Bulgarian) to the database named by `ARTHUR_ACCEPTANCE_DB`, through the
/// same store APIs the pipeline uses, so the Android emulator has something to review without any provider being called. Not a test of
/// anything: it only produces data for the manual acceptance run.
#[test]
#[ignore = "writes data for the Android acceptance run: set ARTHUR_ACCEPTANCE_DB to a database file"]
fn write_the_android_acceptance_suggestions() {
    use super::capture_store::CreateCaptureInput;
    use super::knowledge_store::NewKnowledgeObject;
    let path = std::env::var("ARTHUR_ACCEPTANCE_DB").expect("ARTHUR_ACCEPTANCE_DB");
    let store = CaptureStore::open(std::path::Path::new(&path)).unwrap();
    let cases = [
        ("Arthur is a mobile application.", "Mobile", "Arthur ще работи и на desktop 😀.", "Desktop", "Arthur is a mobile application that will also work on desktop.", "additive"),
        ("Срещата е в понеделник.", "Среща", "Поправка: срещата е във вторник.", "Вторник", "Срещата е във вторник.", "correction"),
    ];
    for (base, title, note, claim_title, draft, change) in cases {
        let a = store.create(CreateCaptureInput { source: "text".into(), content: base.into(), project_id: None }).unwrap();
        let object = store.record_distillation(&a.id, vec![NewKnowledgeObject { kind: "idea".into(), title: title.into(), body: base.into(), source_start: 0, source_end: base.chars().count() as i64 }]).unwrap().remove(0);
        let b = store.create(CreateCaptureInput { source: "voice".into(), content: note.into(), project_id: None }).unwrap();
        store.record_distillation(&b.id, vec![]).unwrap();
        let end = note.chars().count() as i64;
        let pending = store
            .stage_uncertain_claim(&PendingClaimInput {
                decision: IdentityDecisionInput {
                    capture_id: b.id.clone(),
                    ordinal: 0,
                    outcome: DecisionOutcome::Uncertain,
                    unchecked_reason: None,
                    target_object_id: None,
                    base_revision_id: None,
                    result_revision_id: None,
                    created_object_id: None,
                    policy_version: "identity-core-1".into(),
                    model_id: Some("jev-1.13.0".into()),
                    vetoes: vec!["review_required".into()],
                    audit: DecisionAudit { candidates_sent: vec![object.id.clone()], excluded: vec![], scores: vec![(object.id.clone(), 0.96, 0.0)], runs: 3 },
                },
                kind: "idea".into(),
                title: claim_title.into(),
                body: note.into(),
                source_start: 0,
                source_end: end,
                candidate_ids: vec![object.id.clone()],
                due_at: None,
            })
            .unwrap()
            .0;
        let base_revision = store.object_lineage(&object.id).unwrap().current_revision_id;
        store
            .insert_revision_proposal(&NewProposal {
                pending_claim_id: pending.id,
                object_id: object.id,
                base_revision_id: base_revision,
                change: change.into(),
                kind: "idea".into(),
                title: title.into(),
                proposed_body: draft.into(),
                retracts: None,
                evidence: vec![
                    EvidenceRef { role: "existing".into(), capture_id: a.id.clone(), start: 0, end: base.chars().count() as i64 },
                    EvidenceRef { role: "claim".into(), capture_id: b.id.clone(), start: 0, end },
                ],
                synthesis_model: "gpt-6-luna-20260922".into(),
                verifier_model: "gpt-6-luna".into(),
                verification_mode: "same_family_review".into(),
                policy_version: "identity-core-1".into(),
            })
            .unwrap();
    }
}
