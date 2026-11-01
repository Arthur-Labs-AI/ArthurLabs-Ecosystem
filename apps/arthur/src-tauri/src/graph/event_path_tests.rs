//! The whole path of Automatic Connections, from a saved capture to a persisted relation the UI can read, through the production seams:
//! `DistillationService` -> `change_events` -> the door (`commands::integration::admit`) -> the worker (`process` ->
//! `IntegrationService::integrate`) -> Stage A / Stage B (scripted) -> the admission policy -> the guarded write.
//!
//! The model is a script that answers from declared facts, so these tests prove the plumbing and the policy, not model quality. They
//! exist because "no connection appeared" had several indistinguishable causes; every cause now has its own diagnosis code.

use std::sync::atomic::Ordering;

use super::diagnostics::Outcome;
use super::integration::*;
use super::integration_tests::{Double, Rig};
use super::RelationError;
use crate::async_util::BoxFuture;
use crate::commands::integration::{admit, process};
use crate::distillation::{change_events, Candidate, DistillError, DistillationService, Distiller};
use crate::recall::testing::run;
use crate::storage::capture_store::CreateCaptureInput;
use std::sync::Arc;

/// The model "reads" a capture as ONE object whose title and body are the words the person wrote.
struct Verbatim(&'static str);

impl Distiller for Verbatim {
    fn distill<'a>(
        &'a self,
        capture: &'a str,
    ) -> BoxFuture<'a, Result<Vec<Candidate>, DistillError>> {
        Box::pin(async move {
            Ok(vec![Candidate {
                kind: "decision".into(),
                title: self.0.into(),
                body: capture.trim().into(),
                evidence: capture.trim().into(),
                source_start: None,
                source_end: None,
            }])
        })
    }
}

/// Capture -> distillation -> the events a command would announce. Identity merging is not involved: this is the plain path.
fn capture_and_distill(rig: &Rig, title: &'static str, text: &str) -> Vec<ChangedKnowledge> {
    let store = &rig.lab.store;
    let capture = store
        .create(CreateCaptureInput {
            source: "text".into(),
            content: text.into(),
            project_id: Some(rig.project.clone()),
        })
        .unwrap();
    let outcome =
        run(DistillationService::new(Arc::new(Verbatim(title)))
            .distill_detailed(store, &capture.id))
        .unwrap();
    change_events(store, &outcome)
}

/// What the app does with each event: the door, then the worker.
fn deliver(rig: &Rig, events: Vec<ChangedKnowledge>) -> Vec<IntegrationReport> {
    events
        .into_iter()
        .filter(|_| admit(&rig.service))
        .map(|event| run(process(&rig.service, &rig.lab.store, &rig.recall, event)))
        .collect()
}

/// The Bulgarian scenario that was reported: two decisions about one frontend, the second replacing the first.
const FACTS: [super::integration_tests::Fact; 1] = [("supersedes", "Vite", "Next.js")];

fn homeo(rig: &Rig) -> (String, String, String) {
    (
        rig.add(
            "idea",
            "HomeoAI",
            "HomeoAI is a project for homeopathic recommendations.",
        ),
        rig.add("decision", "C# backend", "HomeoAI will have a C# backend."),
        rig.add(
            "decision",
            "Frontend on Next.js",
            "The frontend will be built on Next.js.",
        ),
    )
}

#[test]
fn a_new_idea_travels_from_the_capture_to_a_persisted_relation_through_the_real_dispatch() {
    let rig = Rig::new(&FACTS);
    rig.service.diagnostics.mark_worker_started();
    let (_idea, _backend, next) = homeo(&rig);
    // the person's own connection exists already and must survive everything below
    let backend = rig
        .lab
        .store
        .list_knowledge_objects()
        .unwrap()
        .into_iter()
        .find(|o| o.title == "C# backend")
        .unwrap();
    rig.lab.relate("related_to", &backend.id, &next);

    let events = capture_and_distill(
        &rig,
        "Use Vite instead of Next.js",
        "Actually, use Vite instead of Next.js.",
    );
    assert_eq!(events.len(), 1, "distillation announces the new object");
    let reports = deliver(&rig, events);
    assert_eq!(reports.len(), 1, "the door let it in");
    assert_eq!(reports[0].status, Status::Integrated);
    assert_eq!((reports[0].added, reports[0].removed), (1, 0));

    // the worker really called Stage A once and Stage B twice, with the whole (small) project as candidates
    assert_eq!(
        (
            rig.double.proposer_calls.load(Ordering::SeqCst),
            rig.double.verifier_calls.load(Ordering::SeqCst)
        ),
        (1, 2)
    );
    assert_eq!(
        rig.double.pools.lock().unwrap()[0].len(),
        4,
        "the changed idea and its three project neighbours"
    );
    // the relation is durable and readable the way the UI reads it
    let edges = rig.edges();
    assert!(
        edges.contains(
            &"supersedes Use Vite instead of Next.js -> Frontend on Next.js [model]".to_string()
        ),
        "{edges:?}"
    );
    // a symmetric relation is stored in id order, which is random here
    assert!(
        edges.iter().any(
            |e| e == "related_to Frontend on Next.js -> C# backend [user]"
                || e == "related_to C# backend -> Frontend on Next.js [user]"
        ),
        "the person's relation is untouched: {edges:?}"
    );
    let vite = rig
        .lab
        .store
        .list_knowledge_objects()
        .unwrap()
        .into_iter()
        .find(|o| o.title.starts_with("Use Vite"))
        .unwrap();
    assert_eq!(
        rig.lab
            .store
            .object_relations(
                &vite.id,
                crate::storage::relation_store::Direction::Any,
                None
            )
            .unwrap()
            .len(),
        1
    );

    // the diagnostics tell exactly that story, in counts
    let snapshot = rig.service.diagnostics.snapshot(true);
    assert_eq!(snapshot.diagnosis.code, "SUCCESS");
    let t = &snapshot.totals;
    assert_eq!(
        (
            t.events_emitted,
            t.events_dropped_disabled,
            t.events_received,
            t.runs_completed
        ),
        (1, 0, 1, 1)
    );
    assert_eq!(
        (
            t.stage_a_attempted,
            t.stage_a_succeeded,
            t.stage_a_failed,
            t.stage_b_attempted,
            t.stage_b_succeeded,
            t.stage_b_failed
        ),
        (1, 1, 0, 2, 2, 0)
    );
    assert_eq!(
        (
            t.proposed,
            t.verified,
            t.survived,
            t.rejected,
            t.relations_accepted,
            t.relations_persisted
        ),
        (1, 1, 1, 0, 1, 1)
    );
    assert_eq!(t.candidate_pairs, 3);
    assert_eq!(snapshot.recent_runs[0].outcome, Outcome::Success);
}

#[test]
fn the_same_event_again_does_no_provider_work_and_writes_nothing() {
    let rig = Rig::new(&FACTS);
    homeo(&rig);
    let events = capture_and_distill(
        &rig,
        "Use Vite instead of Next.js",
        "Actually, use Vite instead of Next.js.",
    );
    deliver(&rig, events.clone());
    let calls = (
        rig.double.proposer_calls.load(Ordering::SeqCst),
        rig.double.verifier_calls.load(Ordering::SeqCst),
    );
    let before = rig.edges();
    let again = deliver(&rig, events);
    assert_eq!(again[0].status, Status::Skipped(Skip::AlreadyIntegrated));
    assert_eq!(
        (
            rig.double.proposer_calls.load(Ordering::SeqCst),
            rig.double.verifier_calls.load(Ordering::SeqCst)
        ),
        calls
    );
    assert_eq!(rig.edges(), before);
    assert_eq!(
        rig.service.diagnostics.snapshot(true).recent_runs[0].outcome,
        Outcome::Skipped
    );
}

#[test]
fn when_the_model_proposes_nothing_the_run_says_so_and_it_is_not_a_failure_or_a_rejection() {
    let rig = Rig::new(&[]);
    rig.service.diagnostics.mark_worker_started();
    homeo(&rig);
    deliver(
        &rig,
        capture_and_distill(
            &rig,
            "Use Vite instead of Next.js",
            "Actually, use Vite instead of Next.js.",
        ),
    );
    assert!(rig.relations().is_empty());
    let snapshot = rig.service.diagnostics.snapshot(true);
    assert_eq!(snapshot.diagnosis.code, "SUCCESS_NO_NEW_EDGES");
    let t = &snapshot.totals;
    assert_eq!(
        (
            t.stage_a_succeeded,
            t.proposed,
            t.stage_b_attempted,
            t.rejected
        ),
        (1, 0, 0, 0),
        "Stage A answered with an empty list, so Stage B was never needed"
    );
}

#[test]
fn when_the_model_proposes_and_the_verifier_rejects_every_claim_the_run_says_all_rejected() {
    let rig = Rig::new(&[]);
    rig.service.diagnostics.mark_worker_started();
    homeo(&rig);
    *rig.double.noise.lock().unwrap() = vec![("supersedes", "Vite", "Next.js")];
    deliver(
        &rig,
        capture_and_distill(
            &rig,
            "Use Vite instead of Next.js",
            "Actually, use Vite instead of Next.js.",
        ),
    );
    assert!(
        rig.relations().is_empty(),
        "a rejected claim is never persisted"
    );
    let snapshot = rig.service.diagnostics.snapshot(true);
    assert_eq!(snapshot.diagnosis.code, "ALL_REJECTED");
    let t = &snapshot.totals;
    assert_eq!(
        (
            t.proposed,
            t.verified,
            t.survived,
            t.rejected,
            t.stage_b_succeeded
        ),
        (1, 1, 0, 1, 2)
    );
}

#[test]
fn a_provider_failure_is_its_own_outcome_with_an_error_code_and_nothing_is_written() {
    let rig = Rig::new(&FACTS);
    rig.service.diagnostics.mark_worker_started();
    homeo(&rig);
    rig.double
        .fail_with
        .lock()
        .unwrap()
        .push(RelationError::Network);
    let reports = deliver(
        &rig,
        capture_and_distill(
            &rig,
            "Use Vite instead of Next.js",
            "Actually, use Vite instead of Next.js.",
        ),
    );
    assert!(
        matches!(reports[0].status, Status::Deferred(_)),
        "{:?}",
        reports[0].status
    );
    assert!(rig.relations().is_empty());
    let snapshot = rig.service.diagnostics.snapshot(true);
    assert_eq!(snapshot.diagnosis.code, "PROVIDER_FAILED");
    assert_eq!(
        (snapshot.totals.stage_a_failed, snapshot.totals.runs_failed),
        (1, 1)
    );
    assert_eq!(
        snapshot.recent_runs[0].detail.as_deref(),
        Some("llm_failed")
    );
    assert_eq!(snapshot.recent_runs[0].stage_a, "failed");
    // and a Stage B failure is attributed to Stage B
    let rig = Rig::new(&FACTS);
    homeo(&rig);
    rig.double
        .fail_verifier
        .lock()
        .unwrap()
        .push(RelationError::InvalidOutput("bad".into()));
    rig.double
        .fail_verifier
        .lock()
        .unwrap()
        .push(RelationError::InvalidOutput("bad".into()));
    rig.double
        .fail_verifier
        .lock()
        .unwrap()
        .push(RelationError::InvalidOutput("bad".into()));
    deliver(
        &rig,
        capture_and_distill(
            &rig,
            "Use Vite instead of Next.js",
            "Actually, use Vite instead of Next.js.",
        ),
    );
    let t = rig.service.diagnostics.snapshot(true).totals;
    assert_eq!(
        (
            t.stage_a_succeeded,
            t.stage_b_failed >= 1,
            t.contract_errors >= 1
        ),
        (1, true, true)
    );
}

#[test]
fn a_failed_write_is_reported_as_a_persistence_failure_and_not_as_nothing_found() {
    let rig = Rig::new(&FACTS);
    rig.service.diagnostics.mark_worker_started();
    homeo(&rig);
    rig.lab.store.execute_sql_for_test("CREATE TRIGGER sabotage BEFORE INSERT ON relations BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    deliver(
        &rig,
        capture_and_distill(
            &rig,
            "Use Vite instead of Next.js",
            "Actually, use Vite instead of Next.js.",
        ),
    );
    assert!(rig.relations().is_empty());
    let snapshot = rig.service.diagnostics.snapshot(true);
    assert_eq!(snapshot.diagnosis.code, "PERSISTENCE_FAILED");
    assert_eq!(
        (
            snapshot.totals.persist_failed,
            snapshot.totals.relations_accepted
        ),
        (1, 1)
    );
}

#[test]
fn an_idea_alone_in_its_project_has_no_candidates_and_the_run_says_so() {
    let rig = Rig::new(&FACTS);
    rig.service.diagnostics.mark_worker_started();
    deliver(
        &rig,
        capture_and_distill(
            &rig,
            "Use Vite instead of Next.js",
            "Actually, use Vite instead of Next.js.",
        ),
    );
    let snapshot = rig.service.diagnostics.snapshot(true);
    assert_eq!(snapshot.diagnosis.code, "NO_CANDIDATES");
    assert_eq!(
        rig.double.proposer_calls.load(Ordering::SeqCst),
        0,
        "no provider request for a project of one"
    );
}

#[test]
fn other_projects_never_reach_the_model() {
    let rig = Rig::new(&FACTS);
    homeo(&rig);
    let other = rig.lab.project("Elsewhere");
    rig.lab.object(
        &other,
        "decision",
        "Frontend on Next.js",
        "A different project also uses Next.js.",
    );
    deliver(
        &rig,
        capture_and_distill(
            &rig,
            "Use Vite instead of Next.js",
            "Actually, use Vite instead of Next.js.",
        ),
    );
    let pools = rig.double.pools.lock().unwrap().clone();
    assert_eq!(pools.len(), 1);
    let foreign: Vec<String> = rig
        .lab
        .store
        .list_knowledge_objects_in(Some(&other))
        .unwrap()
        .into_iter()
        .map(|o| o.id)
        .collect();
    assert!(pools[0].iter().all(|id| !foreign.contains(id)));
    assert!(rig
        .relations()
        .iter()
        .all(|r| !foreign.contains(&r.source_object_id) && !foreign.contains(&r.target_object_id)));
}

#[test]
fn with_automatic_connections_off_the_door_stays_shut_and_says_why() {
    let rig = Rig::new(&FACTS);
    rig.service.diagnostics.mark_worker_started();
    homeo(&rig);
    rig.service.set_enabled(false).unwrap();
    let delivered = deliver(
        &rig,
        capture_and_distill(
            &rig,
            "Use Vite instead of Next.js",
            "Actually, use Vite instead of Next.js.",
        ),
    );
    assert!(delivered.is_empty());
    assert_eq!(rig.double.calls(), 0);
    let snapshot = rig.service.diagnostics.snapshot(false);
    assert_eq!(
        (
            snapshot.diagnosis.code,
            snapshot.totals.events_emitted,
            snapshot.totals.events_dropped_disabled,
            snapshot.totals.events_received
        ),
        ("DISABLED", 1, 1, 0)
    );
    // turned on again, the toggle is read dynamically (no stale OFF state is kept by the worker)
    rig.service.set_enabled(true).unwrap();
    let events = capture_and_distill(
        &rig,
        "Use Vite instead of Next.js again",
        "Actually, use Vite instead of Next.js, for real.",
    );
    let reports = deliver(&rig, events);
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].status, Status::Integrated);
}

#[test]
fn a_worker_that_was_never_started_and_an_event_that_never_arrives_are_told_apart() {
    let rig = Rig::new(&FACTS);
    assert_eq!(
        rig.service.diagnostics.snapshot(true).diagnosis.code,
        "WORKER_NOT_STARTED"
    );
    rig.service.diagnostics.mark_worker_started();
    // announced at the door but never handed to the worker (the task was lost)
    assert!(admit(&rig.service));
    assert_eq!(
        rig.service.diagnostics.snapshot(true).diagnosis.code,
        "EVENT_NOT_DELIVERED"
    );
    assert_eq!(
        rig.service
            .diagnostics
            .snapshot(true)
            .totals
            .events_received,
        0
    );
}

#[test]
fn nothing_the_user_wrote_is_ever_kept_in_the_diagnostics() {
    let rig = Rig::new(&FACTS);
    rig.service.diagnostics.mark_worker_started();
    homeo(&rig);
    deliver(
        &rig,
        capture_and_distill(
            &rig,
            "Use Vite instead of Next.js",
            "Actually, use Vite instead of Next.js.",
        ),
    );
    let json = serde_json::to_string(&rig.service.diagnostics.snapshot(true)).unwrap();
    for secret in [
        "Vite",
        "Next.js",
        "HomeoAI",
        "C# backend",
        "Frontend on",
        "scripted",
        "sk-",
    ] {
        assert!(
            !json.contains(secret),
            "diagnostics must not contain {secret:?}"
        );
    }
    let _ = Double::new(&[]);
}

#[test]
fn find_connections_is_real_inference_and_its_empty_answers_are_told_apart() {
    use super::diagnostics::IntegrationDiagnostics;
    // proposes nothing
    let rig = Rig::new(&[]);
    homeo(&rig);
    let inference = run(
        super::GraphService::new(rig.double.clone(), rig.double.clone()).infer_with_report_in(
            &rig.lab.store,
            &[],
            Some(&rig.project),
        ),
    )
    .unwrap();
    let d = IntegrationDiagnostics::default();
    assert_eq!(inference.considered, 3);
    assert_eq!(
        d.record_manual(inference.considered, &inference.report)
            .outcome,
        Outcome::SuccessNoNewEdges
    );
    assert_eq!(
        rig.double.proposer_calls.load(Ordering::SeqCst),
        1,
        "the button asks the model"
    );
    // proposes, verifier rejects
    let rig = Rig::new(&[("related_to", "HomeoAI", "C# backend")]);
    homeo(&rig);
    *rig.double.vote_override.lock().unwrap() =
        Some(Box::new(|candidate, _| super::verify::Verdict {
            index: candidate.index,
            decision: super::verify::Decision::Reject,
            kind: candidate.kind.clone(),
            source_object_id: candidate.source.id.clone(),
            target_object_id: candidate.target.id.clone(),
            confidence: super::verify::Confidence::Low,
            forward_support: super::verify::Support::None,
            reverse_support: super::verify::Support::None,
            explicit_link: false,
            cancels_or_obsoletes: false,
            temporal_evidence: None,
            cancelled_plan_object_id: None,
            dependency_no_longer_required: false,
        }));
    let inference = run(
        super::GraphService::new(rig.double.clone(), rig.double.clone()).infer_with_report_in(
            &rig.lab.store,
            &[],
            Some(&rig.project),
        ),
    )
    .unwrap();
    assert_eq!(
        d.record_manual(inference.considered, &inference.report)
            .outcome,
        Outcome::AllRejected
    );
    // one object only
    let rig = Rig::new(&[]);
    rig.add("idea", "Alone", "Only one idea.");
    let inference = run(
        super::GraphService::new(rig.double.clone(), rig.double.clone()).infer_with_report_in(
            &rig.lab.store,
            &[],
            Some(&rig.project),
        ),
    )
    .unwrap();
    assert_eq!(
        d.record_manual(inference.considered, &inference.report)
            .outcome,
        Outcome::NoCandidates
    );
    assert_eq!(
        rig.double.proposer_calls.load(Ordering::SeqCst),
        0,
        "with fewer than two ideas the button does not call the model"
    );
}
