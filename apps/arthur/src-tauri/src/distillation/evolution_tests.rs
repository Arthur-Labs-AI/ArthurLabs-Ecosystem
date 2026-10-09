//! End-to-end tests of the identity-aware distillation commit with a scripted classifier and drafter. No network, no provider key.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;

use super::evolution::*;
use super::*;
use crate::async_util::BoxFuture;
use crate::identity::fake::{signal, unanimous, MODEL};
use crate::identity::{Candidate as IdCandidate, ClassifierFailure, ClassifierOutput, ClassifyRequest, IdentityClassifier, Relation, ResolverPolicy};
use crate::storage::capture_store::{Capture, CreateCaptureInput};
use crate::storage::evidence_store::{Attribution, EvidenceRole};
use crate::storage::knowledge_store::NewKnowledgeObject;
use crate::storage::lineage_store::{CasOrigin, Changes, ExpectedRevision, RevisionContent};

// --- doubles ----------------------------------------------------------------------------------------------------------------------

/// A distiller that answers by capture text, so several captures can be processed by one service.
struct ByText(Box<dyn Fn(&str) -> Result<Vec<Candidate>, DistillError> + Send + Sync>);

impl Distiller for ByText {
    fn distill<'a>(&'a self, capture: &'a str) -> BoxFuture<'a, Result<Vec<Candidate>, DistillError>> {
        Box::pin(async move { (self.0)(capture) })
    }
}

fn claim(kind: &str, title: &str, body: &str, evidence: &str) -> Candidate {
    Candidate { kind: kind.into(), title: title.into(), body: body.into(), evidence: evidence.into(), source_start: None, source_end: None }
}

type Decide = dyn Fn(&crate::identity::Claim, &IdCandidate) -> (f64, Relation) + Send + Sync;

/// Scores every candidate it is shown with `decide`; counts calls and records which candidates it saw.
struct Scripted {
    decide: Box<Decide>,
    calls: AtomicUsize,
    shown: Mutex<Vec<Vec<String>>>,
    before: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    failure: Mutex<Option<ClassifierFailure>>,
}

impl Scripted {
    fn new(decide: impl Fn(&crate::identity::Claim, &IdCandidate) -> (f64, Relation) + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { decide: Box::new(decide), calls: AtomicUsize::new(0), shown: Mutex::new(vec![]), before: Mutex::new(None), failure: Mutex::new(None) })
    }
    fn failing(failure: ClassifierFailure) -> Arc<Self> {
        let scripted = Self::new(|_, _| (0.0, Relation::Unrelated));
        *scripted.failure.lock().unwrap() = Some(failure);
        scripted
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
    /// Runs once per call, before the answer: the world can change while "inference is in flight".
    fn before(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self.before.lock().unwrap() = Some(Arc::new(hook));
    }
}

impl IdentityClassifier for Scripted {
    fn classify(&self, request: &ClassifyRequest<'_>) -> Result<ClassifierOutput, ClassifierFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.shown.lock().unwrap().push(request.candidates.iter().map(|c| c.object_id.clone()).collect());
        // cloned out of the lock: two concurrent calls must both be able to reach the hook (it may wait for the other)
        let hook = self.before.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook();
        }
        if let Some(failure) = *self.failure.lock().unwrap() {
            return Err(failure);
        }
        Ok(unanimous(
            request
                .candidates
                .iter()
                .map(|candidate| {
                    let (same, relation) = (self.decide)(request.claim, candidate);
                    signal(&candidate.object_id, same, relation)
                })
                .collect(),
        ))
    }
}

struct Drafter {
    draft: Box<dyn Fn(&DraftRequest<'_>) -> Result<RevisionDraft, DraftFailure> + Send + Sync>,
    calls: AtomicUsize,
}

impl Drafter {
    fn new(draft: impl Fn(&DraftRequest<'_>) -> Result<RevisionDraft, DraftFailure> + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { draft: Box::new(draft), calls: AtomicUsize::new(0) })
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl RevisionDrafter for Drafter {
    fn draft(&self, request: &DraftRequest<'_>) -> Result<RevisionDraft, DraftFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        (self.draft)(request)
    }
}

fn asserting(body: &'static str) -> Arc<Drafter> {
    Drafter::new(move |request| Ok(RevisionDraft { content: RevisionContent { kind: "idea".into(), title: request.target.revision.title.clone(), body: body.into() }, role: EvidenceRole::Asserts, retracts: None, interpretation_label: None }))
}

// --- rig ----------------------------------------------------------------------------------------------------------------------------

struct Rig {
    store: Arc<CaptureStore>,
    project: String,
    mobile: KnowledgeObject,
    voice: KnowledgeObject,
}

const A_TEXT: &str = "Arthur is a mobile application.";
const V_TEXT: &str = "Arthur needs voice recognition.";

fn seed(store: &CaptureStore, project: &str, text: &str, title: &str) -> KnowledgeObject {
    let capture = store.create(CreateCaptureInput { source: "text".into(), content: text.into(), project_id: Some(project.into()) }).unwrap();
    let end = text.chars().count() as i64;
    store.record_distillation(&capture.id, vec![NewKnowledgeObject { kind: "idea".into(), title: title.into(), body: text.into(), source_start: 0, source_end: end }]).unwrap().remove(0)
}

fn rig() -> Rig {
    rig_on(CaptureStore::open_in_memory().unwrap())
}

fn rig_on(store: CaptureStore) -> Rig {
    let project = store.create_project("Arthur").unwrap().id;
    let mobile = seed(&store, &project, A_TEXT, "Mobile");
    let voice = seed(&store, &project, V_TEXT, "Voice");
    Rig { store: Arc::new(store), project, mobile, voice }
}

fn capture_in(rig: &Rig, text: &str) -> Capture {
    rig.store.create(CreateCaptureInput { source: "voice".into(), content: text.into(), project_id: Some(rig.project.clone()) }).unwrap()
}

fn distiller(table: Vec<(&'static str, Vec<Candidate>)>) -> Arc<ByText> {
    Arc::new(ByText(Box::new(move |text| table.iter().find(|(t, _)| *t == text).map(|(_, c)| c.clone()).ok_or(DistillError::Refused))))
}

fn pipeline(classifier: Arc<Scripted>, drafter: Arc<Drafter>, enabled: bool) -> EvolutionPipeline {
    EvolutionPipeline {
        settings: Arc::new(EvolutionSettings::in_memory(enabled)),
        classifier: ClassifierBackend::Sync(classifier),
        still_allowed: None,
        drafter,
        synthesis: None,
        policy: ResolverPolicy { accepted_models: vec![MODEL.into()], ..ResolverPolicy::default() },
        limits: EvolutionLimits::default(),
    }
}

fn service(d: Arc<ByText>, classifier: &Arc<Scripted>, drafter: &Arc<Drafter>) -> DistillationService {
    DistillationService::new(d).with_evolution(pipeline(classifier.clone(), drafter.clone(), true))
}

fn run(service: &DistillationService, store: &CaptureStore, id: &str) -> Result<DistillationOutcome, DistillError> {
    tauri::async_runtime::block_on(service.distill_detailed(store, id))
}

fn count(store: &CaptureStore, sql: &str) -> i64 {
    store.query_i64_for_test(sql)
}

fn title_of(c: &IdCandidate) -> &str {
    &c.revision.title
}

/// "Mobile" is the target of the claim; everything else is a different idea.
fn mobile_only(relation: Relation) -> impl Fn(&crate::identity::Claim, &IdCandidate) -> (f64, Relation) + Send + Sync + 'static {
    move |_, candidate| if title_of(candidate) == "Mobile" { (0.97, relation) } else { (0.05, Relation::Unrelated) }
}

const B_DESKTOP: &str = "Arthur will also support desktop.";

fn desktop_distiller() -> Arc<ByText> {
    distiller(vec![(B_DESKTOP, vec![claim("idea", "Desktop", "Arthur will also support desktop.", "Arthur will also support desktop")])])
}

// --- 1. feature OFF --------------------------------------------------------------------------------------------------------------

fn shape(objects: &[KnowledgeObject]) -> Vec<(String, String, String, i64, i64, String)> {
    objects.iter().map(|o| (o.kind.clone(), o.title.clone(), o.body.clone(), o.provenance.source_start, o.provenance.source_end, o.project_id.clone())).collect()
}

#[test]
fn with_the_feature_off_distillation_is_exactly_what_it_was_and_no_identity_work_happens() {
    let text = "Arthur will also support desktop. Arthur needs offline storage.";
    let table = vec![(text, vec![claim("idea", "Desktop", "Arthur will also support desktop.", "Arthur will also support desktop"), claim("idea", "Offline", "Arthur needs offline storage.", "Arthur needs offline storage")])];

    // (a) no pipeline at all, (b) a pipeline injected but its own setting OFF
    let plain = rig();
    let plain_out = run(&DistillationService::new(distiller(table.clone())), &plain.store, &capture_in(&plain, text).id).unwrap();

    let off = rig();
    let classifier = Scripted::new(mobile_only(Relation::AdditiveRefinement));
    let drafter = asserting("never used");
    let service = DistillationService::new(distiller(table)).with_evolution(pipeline(classifier.clone(), drafter.clone(), false));
    let off_out = run(&service, &off.store, &capture_in(&off, text).id).unwrap();

    assert_eq!(shape(&plain_out.objects), shape(&off_out.objects).iter().map(|row| { let mut r = row.clone(); r.5 = plain.project.clone(); r }).collect::<Vec<_>>());
    assert_eq!(plain_out.objects.len(), 2);
    for outcome in [&plain_out, &off_out] {
        assert!(outcome.revised.is_empty() && outcome.pending.is_empty() && outcome.fresh);
    }
    assert_eq!((classifier.calls(), drafter.calls()), (0, 0), "no classifier, no drafter");
    for store in [&plain.store, &off.store] {
        for table in ["identity_decisions", "pending_claims", "revision_evidence"] {
            assert_eq!(count(store, &format!("SELECT count(*) FROM {table}")), 0, "{table}");
        }
        assert_eq!(count(store, "SELECT count(*) FROM thought_revisions WHERE origin = 'system'"), 0);
        assert_eq!(count(store, "SELECT count(*) FROM object_sources"), 4);
        assert_eq!(count(store, "SELECT count(*) FROM thought_revisions"), 4, "one initial revision per object, as before");
    }
}

#[test]
fn production_cannot_activate_the_pipeline_and_its_setting_is_independent_and_off_by_default() {
    // The constructor used by the app has no pipeline; the injector exists only under cfg(test).
    let service = DistillationService::new(desktop_distiller());
    assert!(service.evolution.is_none());
    assert!(!DEFAULT_ENABLED);

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("evolution").join("settings.json");
    assert!(!EvolutionSettings::new(path.clone()).enabled(), "a missing file means OFF");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"{ not json").unwrap();
    assert!(!EvolutionSettings::new(path.clone()).enabled(), "a damaged file means OFF");

    // its own file: turning it on does not touch Automatic Connections, and the other way round
    let graph_path = dir.path().join("graph").join("settings.json");
    let evolution = EvolutionSettings::new(path.clone());
    let graph = crate::graph::integration::IntegrationSettings::new(graph_path.clone());
    evolution.set(true).unwrap();
    assert!(EvolutionSettings::new(path.clone()).enabled() && !graph.enabled() && !graph_path.exists());
    graph.set(true).unwrap();
    evolution.set(false).unwrap();
    assert!(graph.enabled() && !EvolutionSettings::new(path).enabled());
    assert!(crate::graph::integration::IntegrationSettings::new(graph_path).enabled());
}

// --- 2-4. the three outcomes -------------------------------------------------------------------------------------------------------

#[test]
fn a_claim_with_no_plausible_referent_becomes_a_new_object_recorded_as_a_verified_decision() {
    let rig = rig();
    let text = "Arthur needs offline storage.";
    let classifier = Scripted::new(|_, _| (0.05, Relation::DistinctSameProject));
    let drafter = asserting("unused");
    let service = service(distiller(vec![(text, vec![claim("idea", "Offline", text, "Arthur needs offline storage")])]), &classifier, &drafter);
    let capture = capture_in(&rig, text);

    let out = run(&service, &rig.store, &capture.id).unwrap();

    assert_eq!((out.objects.len(), out.revised.len(), out.pending.len()), (1, 0, 0));
    let object = &out.objects[0];
    assert_eq!(rig.store.object_lineage(&object.id).unwrap().revisions.len(), 1);
    let decisions = rig.store.identity_decisions_for(&capture.id).unwrap();
    assert_eq!((decisions.len(), decisions[0].input.outcome, decisions[0].input.created_object_id.clone(), decisions[0].input.model_id.clone()), (1, DecisionOutcome::New, Some(object.id.clone()), Some(MODEL.into())));
    assert_eq!(drafter.calls(), 0);
    assert_eq!(rig.store.distillation_for(&capture.id).unwrap().unwrap(), out.objects, "the existing read contract sees the same objects");
}

use crate::storage::identity_store::DecisionOutcome;

#[test]
fn a_clear_refinement_revises_the_target_with_a_system_revision_and_real_evidence() {
    let rig = rig();
    let classifier = Scripted::new(mobile_only(Relation::AdditiveRefinement));
    let drafter = asserting("Arthur is a mobile and desktop application.");
    let service = service(desktop_distiller(), &classifier, &drafter);
    let b = capture_in(&rig, B_DESKTOP);
    let r1 = rig.store.object_lineage(&rig.mobile.id).unwrap().current_revision_id;
    let objects_before = count(&rig.store, "SELECT count(*) FROM knowledge_objects");

    let out = run(&service, &rig.store, &b.id).unwrap();

    assert_eq!((out.objects.len(), out.revised.len(), out.pending.len()), (0, 1, 0), "one KnowledgeObject, revised, nothing created");
    assert_eq!(count(&rig.store, "SELECT count(*) FROM knowledge_objects"), objects_before);
    let lineage = rig.store.object_lineage(&rig.mobile.id).unwrap();
    assert_eq!(lineage.revisions.len(), 2);
    let r2 = lineage.revisions.last().unwrap();
    assert_eq!((lineage.current_revision_id.as_str(), r2.origin.as_str(), r2.parent_revision_ids.clone(), r2.provenance.clone()), (r2.id.as_str(), "system", vec![r1.clone()], None), "no fabricated direct span");
    assert_eq!(rig.store.get_revision(&r1).unwrap().body, A_TEXT, "revision 1 stays readable and unchanged");
    assert_eq!(rig.store.list_knowledge_objects().unwrap().iter().find(|o| o.id == rig.mobile.id).unwrap().body, "Arthur is a mobile and desktop application.");
    assert_eq!(out.revised[0], RevisedObject { object_id: rig.mobile.id.clone(), previous_revision_id: r1.clone(), revision_id: r2.id.clone() });

    // the evidence is the real spans of BOTH captures, never conflated
    let support = rig.store.evidence_support(&r2.id).unwrap();
    assert!(support.synthesized);
    assert_eq!(support.active.iter().map(|e| (e.capture_id.clone(), e.role.clone())).collect::<Vec<_>>(), vec![(rig.mobile.provenance.capture_id.clone(), "origin".into()), (b.id.clone(), "asserts".into())]);
    assert!(support.historical.is_empty() && support.withdrawn.is_empty());
    assert_eq!(support.attribution, Attribution::ContributingSpans { inherited_demoted: false });
    let decision = &rig.store.identity_decisions_for(&b.id).unwrap()[0];
    assert_eq!((decision.input.outcome, decision.input.target_object_id.clone(), decision.input.base_revision_id.clone(), decision.input.result_revision_id.clone()), (DecisionOutcome::Revise, Some(rig.mobile.id.clone()), Some(r1), Some(r2.id.clone())));
    // the second capture produced no object of its own, and the run is recorded
    assert_eq!(rig.store.distillation_for(&b.id).unwrap(), Some(vec![]));
}

#[test]
fn an_uncertain_claim_is_kept_whole_as_a_pending_claim_and_nothing_is_revised() {
    let rig = rig();
    let classifier = Scripted::new(|_, c| if title_of(c) == "Mobile" { (0.75, Relation::AdditiveRefinement) } else { (0.05, Relation::Unrelated) });
    let drafter = asserting("unused");
    let service = service(desktop_distiller(), &classifier, &drafter);
    let b = capture_in(&rig, B_DESKTOP);
    let r1 = rig.store.object_lineage(&rig.mobile.id).unwrap().current_revision_id;

    let out = run(&service, &rig.store, &b.id).unwrap();

    assert_eq!((out.objects.len(), out.revised.len(), out.pending.len()), (0, 0, 1));
    assert_eq!(rig.store.object_lineage(&rig.mobile.id).unwrap().current_revision_id, r1, "no existing object changed");
    let pending = &out.pending[0];
    assert_eq!((pending.state.as_str(), pending.kind.as_str(), pending.title.as_str(), pending.body.as_str(), pending.candidate_ids.clone()), ("open", "idea", "Desktop", "Arthur will also support desktop.", vec![rig.mobile.id.clone()]));
    assert!(pending.due_at.is_some());
    let chars: Vec<char> = B_DESKTOP.chars().collect();
    assert_eq!(chars[pending.source_start as usize..pending.source_end as usize].iter().collect::<String>(), "Arthur will also support desktop");
    assert_eq!(rig.store.identity_decisions_for(&b.id).unwrap()[0].input.outcome, DecisionOutcome::Uncertain);
    assert_eq!(rig.store.get_capture(&b.id).unwrap().unwrap().content, B_DESKTOP, "the capture is untouched");
    assert_eq!(rig.store.list_pending_claims(Some(&rig.project), &["open"]).unwrap().len(), 1, "discoverable in the review list");
    assert!(change_events(&rig.store, &out).is_empty(), "no Graph event for an unresolved claim");
}

// --- 5. mixed capture --------------------------------------------------------------------------------------------------------------

const MIXED: &str = "Arthur needs offline storage. Arthur will also support desktop. Maybe voice commands someday.";

fn mixed_distiller() -> Arc<ByText> {
    distiller(vec![(
        MIXED,
        vec![
            claim("idea", "Offline", "Arthur needs offline storage.", "Arthur needs offline storage"),
            claim("idea", "Desktop", "Arthur will also support desktop.", "Arthur will also support desktop"),
            claim("idea", "Voice commands", "Maybe voice commands someday.", "Maybe voice commands someday"),
        ],
    )])
}

fn mixed_classifier() -> Arc<Scripted> {
    Scripted::new(|claim, candidate| match (claim.ordinal, title_of(candidate)) {
        (1, "Mobile") => (0.97, Relation::AdditiveRefinement),
        (2, "Voice") => (0.7, Relation::AdditiveRefinement),
        _ => (0.05, Relation::DistinctSameProject),
    })
}

#[test]
fn one_capture_can_commit_a_new_object_a_revision_and_a_pending_claim_together() {
    let rig = rig();
    let (classifier, drafter) = (mixed_classifier(), asserting("Arthur is a mobile and desktop application."));
    let service = service(mixed_distiller(), &classifier, &drafter);
    let capture = capture_in(&rig, MIXED);

    let out = run(&service, &rig.store, &capture.id).unwrap();

    assert_eq!((out.objects.len(), out.revised.len(), out.pending.len()), (1, 1, 1));
    assert_eq!(out.objects[0].title, "Offline");
    assert_eq!(out.revised[0].object_id, rig.mobile.id);
    assert_eq!(out.pending[0].title, "Voice commands");
    let decisions = rig.store.identity_decisions_for(&capture.id).unwrap();
    assert_eq!(decisions.iter().map(|d| (d.input.ordinal, d.input.outcome)).collect::<Vec<_>>(), [(0, DecisionOutcome::New), (1, DecisionOutcome::Revise), (2, DecisionOutcome::Uncertain)]);
    assert_eq!(count(&rig.store, &format!("SELECT count(*) FROM distillation_runs WHERE capture_id = '{}'", capture.id)), 1, "one run for the whole capture");
    assert_eq!(count(&rig.store, "SELECT count(*) FROM thought_revisions WHERE origin = 'system'"), 1);
    // the events of the committed outcome, in claim order: created for the NEW object, revised for the REVISE, nothing for the pending claim
    let events = change_events(&rig.store, &out);
    assert_eq!(events.len(), 2);
    assert_eq!((events[0].reason, events[0].object_id.clone()), (crate::graph::integration::ChangeReason::Created, out.objects[0].id.clone()));
    assert_eq!((events[1].reason, events[1].object_id.clone(), events[1].previous_revision_id.clone(), events[1].current_revision_id.clone()), (crate::graph::integration::ChangeReason::Revised, rig.mobile.id.clone(), Some(out.revised[0].previous_revision_id.clone()), out.revised[0].revision_id.clone()));
}

// --- 6. several claims, one target ---------------------------------------------------------------------------------------------------

#[test]
fn two_claims_aimed_at_one_object_never_produce_competing_revisions() {
    let rig = rig();
    let text = "Arthur will also support desktop. Arthur will also support tablets.";
    let d = distiller(vec![(text, vec![claim("idea", "Desktop", "Arthur will also support desktop.", "Arthur will also support desktop"), claim("idea", "Tablets", "Arthur will also support tablets.", "Arthur will also support tablets")])]);
    let (classifier, drafter) = (Scripted::new(mobile_only(Relation::AdditiveRefinement)), asserting("Arthur is a mobile, desktop and tablet application."));
    let capture = capture_in(&rig, text);
    let out = run(&service(d, &classifier, &drafter), &rig.store, &capture.id).unwrap();
    assert_eq!((out.revised.len(), out.pending.len(), out.objects.len()), (0, 2, 0));
    assert_eq!(rig.store.object_lineage(&rig.mobile.id).unwrap().revisions.len(), 1);
    assert!(out.pending.iter().all(|p| p.reasons.contains(&"conflicting_claims".to_string())));
    assert_eq!(drafter.calls(), 0, "no draft is even requested for a conflicted claim");
}

// --- 7/9. the world changes while the classifier works --------------------------------------------------------------------------------

#[test]
fn a_user_edit_during_inference_wins_and_the_stale_decision_becomes_a_pending_claim() {
    let rig = rig();
    let (classifier, drafter) = (Scripted::new(mobile_only(Relation::AdditiveRefinement)), asserting("Arthur is a mobile and desktop application."));
    // The hook writes to the SAME store while the classifier "works": it would deadlock if the pipeline held the SQLite lock.
    let (store, id) = (rig.store.clone(), rig.mobile.id.clone());
    classifier.before(move || {
        store.update_object(&id, Changes { body: Some("Arthur is a mobile app, written by me.".into()), ..Changes::default() }).unwrap();
    });
    let b = capture_in(&rig, B_DESKTOP);

    let out = run(&service(desktop_distiller(), &classifier, &drafter), &rig.store, &b.id).unwrap();

    let lineage = rig.store.object_lineage(&rig.mobile.id).unwrap();
    assert_eq!(lineage.revisions.iter().map(|r| r.origin.as_str()).collect::<Vec<_>>(), ["initial", "user_edit"], "no automatic revision was written");
    assert_eq!(lineage.revisions.last().unwrap().body, "Arthur is a mobile app, written by me.");
    assert_eq!((out.revised.len(), out.pending.len(), count(&rig.store, "SELECT count(*) FROM revision_evidence")), (0, 1, 0));
    assert!(out.pending[0].reasons.contains(&"stale_target".to_string()));
    assert_eq!(rig.store.identity_decisions_for(&b.id).unwrap()[0].input.outcome, DecisionOutcome::Uncertain, "never silently converted to a revision");
}

#[test]
fn two_captures_racing_for_one_object_produce_one_revision_and_one_pending_claim() {
    let rig = rig();
    let (t1, t2) = ("Arthur will also support desktop.", "Arthur will also support tablets.");
    let d = distiller(vec![
        (t1, vec![claim("idea", "Desktop", t1, "Arthur will also support desktop")]),
        (t2, vec![claim("idea", "Tablets", t2, "Arthur will also support tablets")]),
    ]);
    let classifier = Scripted::new(mobile_only(Relation::AdditiveRefinement));
    let barrier = Arc::new(Barrier::new(2));
    classifier.before({
        let barrier = barrier.clone();
        move || {
            barrier.wait(); // both captures have taken their snapshot and are classified before either commits
        }
    });
    let drafter = Drafter::new(|request| Ok(RevisionDraft { content: RevisionContent { kind: "idea".into(), title: "Mobile".into(), body: format!("Arthur is a mobile application ({}).", request.claim.title) }, role: EvidenceRole::Asserts, retracts: None, interpretation_label: None }));
    let service = Arc::new(service(d, &classifier, &drafter));
    let (c1, c2) = (capture_in(&rig, t1), capture_in(&rig, t2));

    let handles: Vec<_> = [c1.id.clone(), c2.id.clone()]
        .into_iter()
        .map(|id| {
            let (service, store) = (service.clone(), rig.store.clone());
            thread::spawn(move || run(&service, &store, &id).unwrap())
        })
        .collect();
    let outcomes: Vec<DistillationOutcome> = handles.into_iter().map(|h| h.join().unwrap()).collect();

    assert_eq!(outcomes.iter().map(|o| o.revised.len()).sum::<usize>(), 1, "exactly one capture revised the object");
    assert_eq!(outcomes.iter().map(|o| o.pending.len()).sum::<usize>(), 1, "the other was held for a decision, not lost");
    let lineage = rig.store.object_lineage(&rig.mobile.id).unwrap();
    assert_eq!(lineage.revisions.len(), 2);
    let pending = outcomes.iter().flat_map(|o| o.pending.iter()).next().unwrap();
    assert!(pending.reasons.contains(&"stale_target".to_string()));
    assert_eq!(count(&rig.store, "SELECT count(*) FROM distillation_runs WHERE capture_id IN (SELECT id FROM captures WHERE content LIKE 'Arthur will also support%')"), 2);
}

#[test]
fn a_target_that_left_the_project_is_never_revised_and_the_claim_is_still_kept() {
    let rig = rig();
    let other = rig.store.create_project("Elsewhere").unwrap().id;
    let (classifier, drafter) = (Scripted::new(mobile_only(Relation::AdditiveRefinement)), asserting("Arthur is a mobile and desktop application."));
    let (store, id, other_project) = (rig.store.clone(), rig.mobile.id.clone(), other.clone());
    classifier.before(move || {
        store.move_knowledge_object(&id, &other_project).unwrap();
    });
    let b = capture_in(&rig, B_DESKTOP);
    let out = run(&service(desktop_distiller(), &classifier, &drafter), &rig.store, &b.id).unwrap();
    assert_eq!(rig.store.object_lineage(&rig.mobile.id).unwrap().revisions.len(), 1);
    assert_eq!((out.revised.len(), out.pending.len(), out.objects.len()), (0, 0, 1), "its candidate left the project: the claim becomes its own object, recorded as unchecked");
    let decision = &rig.store.identity_decisions_for(&b.id).unwrap()[0];
    assert_eq!((decision.input.outcome, decision.input.unchecked_reason.as_deref()), (DecisionOutcome::Unchecked, Some("invalid_candidates")));
}

// --- 10/11. project isolation ---------------------------------------------------------------------------------------------------------

#[test]
fn another_projects_objects_are_never_shown_to_the_classifier_or_chosen_as_a_target() {
    let rig = rig();
    let q = rig.store.create_project("Quiet").unwrap().id;
    let (classifier, drafter) = (Scripted::new(|_, _| (0.99, Relation::AdditiveRefinement)), asserting("must not be used"));
    let service = service(desktop_distiller(), &classifier, &drafter);

    // an empty project: the strong lookalike next door is invisible, and the classifier is not even called
    let in_empty = rig.store.create(CreateCaptureInput { source: "text".into(), content: B_DESKTOP.into(), project_id: Some(q.clone()) }).unwrap();
    let out = run(&service, &rig.store, &in_empty.id).unwrap();
    assert_eq!((classifier.calls(), out.objects.len(), out.revised.len()), (0, 1, 0));
    assert_eq!(rig.store.identity_decisions_for(&in_empty.id).unwrap()[0].input.unchecked_reason.as_deref(), Some("no_eligible_candidates"));
    assert_eq!(rig.store.get_knowledge_object(&out.objects[0].id).unwrap().unwrap().project_id, q);

    // a project with one object: only that object is ever shown
    let q_project = q.clone();
    let own = seed(&rig.store, &q, "Arthur has a web client.", "Web");
    let text = "Arthur will also support desktop. ";
    let again = rig.store.create(CreateCaptureInput { source: "text".into(), content: text.into(), project_id: Some(q) }).unwrap();
    let d = distiller(vec![(text, vec![claim("idea", "Desktop two", "Arthur will also support desktop clients.", "Arthur will also support desktop")])]);
    let _ = run(&DistillationService::new(d).with_evolution(pipeline(classifier.clone(), drafter.clone(), true)), &rig.store, &again.id).unwrap();
    let shown: Vec<String> = classifier.shown.lock().unwrap().iter().flatten().cloned().collect();
    assert!(shown.contains(&own.id) && !shown.contains(&rig.mobile.id) && !shown.contains(&rig.voice.id), "{shown:?}");
    for id in &shown {
        assert_eq!(rig.store.get_knowledge_object(id).unwrap().unwrap().project_id, q_project, "only the capture's own project is ever shown");
    }
    assert_eq!(rig.store.object_lineage(&rig.mobile.id).unwrap().revisions.len(), 1);
}

#[test]
fn an_archived_project_behaves_exactly_as_before_and_recovers_after_restore() {
    for enabled in [false, true] {
        let rig = rig();
        let (classifier, drafter) = (Scripted::new(mobile_only(Relation::AdditiveRefinement)), asserting("Arthur is a mobile and desktop application."));
        let service = DistillationService::new(desktop_distiller()).with_evolution(pipeline(classifier, drafter, enabled));
        let b = capture_in(&rig, B_DESKTOP);
        rig.store.archive_project(&rig.project).unwrap();

        let error = run(&service, &rig.store, &b.id).unwrap_err();

        assert_eq!(error.code(), "storage_failed", "enabled = {enabled}");
        for table in ["distillation_runs WHERE capture_id = (SELECT id FROM captures WHERE content = 'Arthur will also support desktop.')", "identity_decisions", "pending_claims", "revision_evidence"] {
            assert_eq!(count(&rig.store, &format!("SELECT count(*) FROM {table}")), 0, "{table}");
        }
        assert_eq!(rig.store.get_capture(&b.id).unwrap().unwrap().content, B_DESKTOP);
        assert_eq!(service.organization_states(&rig.store).unwrap().into_iter().find(|s| s.capture_id == b.id).unwrap().status, "failed");
        rig.store.restore_project(&rig.project).unwrap();
        assert!(run(&service, &rig.store, &b.id).is_ok(), "a retry after restoring works");
    }
}

#[test]
fn in_the_inbox_even_a_clear_match_waits_for_confirmation() {
    let store = CaptureStore::open_in_memory().unwrap();
    let mobile = seed(&store, crate::storage::migrations::INBOX_PROJECT_ID, A_TEXT, "Mobile");
    let b = store.create(CreateCaptureInput { source: "text".into(), content: B_DESKTOP.into(), project_id: None }).unwrap();
    let (classifier, drafter) = (Scripted::new(mobile_only(Relation::AdditiveRefinement)), asserting("Arthur is a mobile and desktop application."));
    let out = run(&service(desktop_distiller(), &classifier, &drafter), &store, &b.id).unwrap();
    assert_eq!((out.revised.len(), out.pending.len()), (0, 1));
    assert!(out.pending[0].reasons.contains(&"inbox_requires_confirmation".to_string()));
    assert_eq!(store.object_lineage(&mobile.id).unwrap().revisions.len(), 1);
}

// --- 12. failures fall back safely ---------------------------------------------------------------------------------------------------------

#[test]
fn a_classifier_failure_keeps_the_claim_as_an_object_recorded_as_unchecked_never_as_verified_new() {
    for failure in [ClassifierFailure::Timeout, ClassifierFailure::Network, ClassifierFailure::Refused] {
        let rig = rig();
        let (classifier, drafter) = (Scripted::failing(failure), asserting("unused"));
        let b = capture_in(&rig, B_DESKTOP);
        let out = run(&service(desktop_distiller(), &classifier, &drafter), &rig.store, &b.id).unwrap();
        assert_eq!((out.objects.len(), out.revised.len(), out.pending.len()), (1, 0, 0));
        let decision = &rig.store.identity_decisions_for(&b.id).unwrap()[0];
        assert_eq!((decision.input.outcome, decision.input.unchecked_reason.as_deref(), decision.input.model_id.clone(), decision.decided_by.as_str()), (DecisionOutcome::Unchecked, Some("classifier_failed"), None, "fallback"));
        assert_eq!(decision.input.vetoes, vec!["classifier_failed".to_string()]);
        assert_eq!(rig.store.get_capture(&b.id).unwrap().unwrap().content, B_DESKTOP);
        assert_eq!(count(&rig.store, "SELECT count(*) FROM identity_decisions WHERE outcome = 'new'"), 0, "nothing is called verified");
    }
}

#[test]
fn an_unknown_model_or_malformed_signals_also_fail_closed() {
    let rig = rig();
    struct Wrong;
    impl IdentityClassifier for Wrong {
        fn classify(&self, request: &ClassifyRequest<'_>) -> Result<ClassifierOutput, ClassifierFailure> {
            let mut out = unanimous(request.candidates.iter().map(|c| signal(&c.object_id, 0.99, Relation::AdditiveRefinement)).collect());
            out.model_id = "someone-else".into();
            Ok(out)
        }
    }
    let _ = Wrong;
    let classifier = Scripted::new(mobile_only(Relation::AdditiveRefinement));
    let wrong_model = EvolutionPipeline { policy: ResolverPolicy { accepted_models: vec!["only-this-one".into()], ..ResolverPolicy::default() }, ..pipeline(classifier, asserting("unused"), true) };
    let b = capture_in(&rig, B_DESKTOP);
    let out = run(&DistillationService::new(desktop_distiller()).with_evolution(wrong_model), &rig.store, &b.id).unwrap();
    assert_eq!((out.objects.len(), out.revised.len()), (1, 0));
    assert_eq!(rig.store.identity_decisions_for(&b.id).unwrap()[0].input.unchecked_reason.as_deref(), Some("malformed_signals"));
}

#[test]
fn an_invalid_or_failed_draft_never_becomes_a_revision() {
    let bad_drafts: Vec<(&str, Arc<Drafter>)> = vec![
        ("refused", Drafter::new(|_| Err(DraftFailure::Refused))),
        ("unchanged text", Drafter::new(|r| Ok(RevisionDraft { content: RevisionContent { kind: "idea".into(), title: r.target.revision.title.clone(), body: r.target.revision.body.clone() }, role: EvidenceRole::Asserts, retracts: None, interpretation_label: None }))),
        ("empty body", Drafter::new(|r| Ok(RevisionDraft { content: RevisionContent { kind: "idea".into(), title: r.target.revision.title.clone(), body: "  ".into() }, role: EvidenceRole::Asserts, retracts: None, interpretation_label: None }))),
        ("unknown kind", Drafter::new(|r| Ok(RevisionDraft { content: RevisionContent { kind: "gizmo".into(), title: "t".into(), body: r.claim.body.clone() }, role: EvidenceRole::Asserts, retracts: None, interpretation_label: None }))),
        ("withdraws evidence that is not active", Drafter::new(|r| Ok(RevisionDraft { content: RevisionContent { kind: "idea".into(), title: "t".into(), body: r.claim.body.clone() }, role: EvidenceRole::Corrects, retracts: Some(("no-such-revision".into(), 0)), interpretation_label: None }))),
        ("asserts but names a target", Drafter::new(|r| Ok(RevisionDraft { content: RevisionContent { kind: "idea".into(), title: "t".into(), body: r.claim.body.clone() }, role: EvidenceRole::Asserts, retracts: Some((r.support.revision_id.clone(), 0)), interpretation_label: None }))),
    ];
    for (name, drafter) in bad_drafts {
        let rig = rig();
        let classifier = Scripted::new(mobile_only(Relation::AdditiveRefinement));
        let b = capture_in(&rig, B_DESKTOP);
        let out = run(&service(desktop_distiller(), &classifier, &drafter), &rig.store, &b.id).unwrap();
        assert_eq!((out.revised.len(), out.pending.len(), out.objects.len()), (0, 1, 0), "{name}");
        assert!(out.pending[0].reasons.contains(&"invalid_draft".to_string()), "{name}");
        assert_eq!(rig.store.object_lineage(&rig.mobile.id).unwrap().revisions.len(), 1, "{name}");
        assert_eq!(count(&rig.store, "SELECT count(*) FROM revision_evidence"), 0, "{name}");
    }
}

// --- 14/15. provenance across captures, corrections ------------------------------------------------------------------------------------

#[test]
fn evidence_accumulates_across_captures_and_a_correction_withdraws_exactly_what_it_names() {
    let rig = rig();
    let tablets = "Arthur will also support tablets.";
    let correction = "Correction: Arthur will not support desktop.";
    let d = distiller(vec![
        (B_DESKTOP, vec![claim("idea", "Desktop", B_DESKTOP, "Arthur will also support desktop")]),
        (tablets, vec![claim("idea", "Tablets", tablets, "Arthur will also support tablets")]),
        (correction, vec![claim("idea", "No desktop", correction, "Arthur will not support desktop")]),
    ]);
    let classifier = Scripted::new(mobile_only(Relation::AdditiveRefinement));
    let drafter = Drafter::new(|request| {
        let corrects = request.claim.body.starts_with("Correction");
        let retracts = corrects.then(|| request.support.active.iter().find(|e| e.role == "asserts").map(|e| (e.revision_id.clone(), e.ordinal.unwrap())).expect("an assertion to withdraw")).filter(|_| true);
        let body = if corrects { "Arthur is a mobile and tablet application.".to_string() } else { format!("{} + {}", request.target.revision.body.trim_end_matches('.'), request.claim.title.to_lowercase()) };
        Ok(RevisionDraft { content: RevisionContent { kind: "idea".into(), title: "Mobile".into(), body }, role: if corrects { EvidenceRole::Corrects } else { EvidenceRole::Asserts }, retracts, interpretation_label: None })
    });
    let service = service(d, &classifier, &drafter);
    let (b, t) = (capture_in(&rig, B_DESKTOP), capture_in(&rig, tablets));
    let r1 = rig.store.object_lineage(&rig.mobile.id).unwrap().current_revision_id;
    run(&service, &rig.store, &b.id).unwrap();
    run(&service, &rig.store, &t.id).unwrap();
    let lineage = rig.store.object_lineage(&rig.mobile.id).unwrap();
    assert_eq!(lineage.revisions.len(), 3);
    let r3 = lineage.current_revision_id.clone();
    let support = rig.store.evidence_support(&r3).unwrap();
    assert_eq!(support.active.iter().map(|e| e.capture_id.clone()).collect::<Vec<_>>(), vec![rig.mobile.provenance.capture_id.clone(), b.id.clone(), t.id.clone()], "A, B and C all contribute");
    assert!(support.historical.is_empty() && support.withdrawn.is_empty());

    let c = capture_in(&rig, correction);
    run(&service, &rig.store, &c.id).unwrap();
    let lineage = rig.store.object_lineage(&rig.mobile.id).unwrap();
    assert_eq!(lineage.revisions.len(), 4);
    let r4 = &lineage.current_revision_id;
    let now = rig.store.evidence_support(r4).unwrap();
    assert_eq!(now.withdrawn.iter().map(|(e, _)| e.capture_id.clone()).collect::<Vec<_>>(), vec![b.id.clone()], "only the desktop assertion is withdrawn");
    assert!(now.active.iter().all(|e| e.capture_id != b.id), "withdrawn evidence is not current support");
    assert_eq!(now.active.iter().map(|e| e.capture_id.clone()).collect::<Vec<_>>(), vec![rig.mobile.provenance.capture_id.clone(), t.id.clone(), c.id.clone()]);
    assert!(now.historical.is_empty(), "withdrawn evidence is not also listed as history");
    // history is intact: revision 3 still shows B as support, revision 1 is unchanged
    let before = rig.store.evidence_support(&r3).unwrap();
    assert!(before.active.iter().any(|e| e.capture_id == b.id));
    assert_eq!(rig.store.get_revision(&r1).unwrap().body, A_TEXT);
}

// --- 16. repeated processing ----------------------------------------------------------------------------------------------------------------

#[test]
fn processing_a_capture_twice_adds_nothing_and_asks_no_one_again() {
    let rig = rig();
    let (classifier, drafter) = (mixed_classifier(), asserting("Arthur is a mobile and desktop application."));
    let service = service(mixed_distiller(), &classifier, &drafter);
    let capture = capture_in(&rig, MIXED);
    let first = run(&service, &rig.store, &capture.id).unwrap();
    let tables = || ["knowledge_objects", "thought_revisions", "revision_evidence", "identity_decisions", "pending_claims"].map(|t| count(&rig.store, &format!("SELECT count(*) FROM {t}")));
    let after_first = tables();

    let second = run(&service, &rig.store, &capture.id).unwrap();

    assert!(first.fresh && !second.fresh);
    assert_eq!(second.objects, first.objects);
    assert!(second.revised.is_empty() && second.pending.is_empty(), "nothing is re-reported");
    assert_eq!(tables(), after_first);
    assert_eq!(classifier.calls(), 3, "classified once per claim, on the first pass only");
    assert!(change_events(&rig.store, &second).iter().all(|e| e.reason == crate::graph::integration::ChangeReason::Created), "no second revised event");
}

#[test]
fn two_workers_on_the_same_capture_commit_it_once() {
    let rig = rig();
    let classifier = Scripted::new(mobile_only(Relation::AdditiveRefinement));
    let barrier = Arc::new(Barrier::new(2));
    classifier.before({
        let barrier = barrier.clone();
        move || {
            barrier.wait();
        }
    });
    let service = Arc::new(service(desktop_distiller(), &classifier, &asserting("Arthur is a mobile and desktop application.")));
    let b = capture_in(&rig, B_DESKTOP);
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let (service, store, id) = (service.clone(), rig.store.clone(), b.id.clone());
            thread::spawn(move || run(&service, &store, &id).unwrap())
        })
        .collect();
    let outcomes: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(outcomes.iter().filter(|o| o.fresh).count(), 1);
    assert_eq!(rig.store.object_lineage(&rig.mobile.id).unwrap().revisions.len(), 2, "one revision, not two");
    assert_eq!((count(&rig.store, "SELECT count(*) FROM identity_decisions"), count(&rig.store, "SELECT count(*) FROM revision_evidence")), (1, 1));
}

// --- 17/18. rollback and restart ---------------------------------------------------------------------------------------------------------------

#[test]
fn a_failure_midway_rolls_the_whole_capture_back_and_survives_a_restart_for_a_clean_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("arthur.db");
    let (project, mobile, voice, capture) = {
        let rig = rig_on(CaptureStore::open(&path).unwrap());
        let capture = capture_in(&rig, MIXED);
        // fail on the LAST decision: the new object, the revision, its evidence and two decisions have all been written by then
        rig.store.execute_sql_for_test("CREATE TRIGGER poison BEFORE INSERT ON identity_decisions WHEN NEW.ordinal = 2 BEGIN SELECT RAISE(ABORT, 'boom'); END;");
        let tables = || ["knowledge_objects", "thought_revisions", "revision_evidence", "identity_decisions", "pending_claims", "distillation_runs"].map(|t| count(&rig.store, &format!("SELECT count(*) FROM {t}")));
        let before = tables();
        let (classifier, drafter) = (mixed_classifier(), asserting("Arthur is a mobile and desktop application."));
        let service = service(mixed_distiller(), &classifier, &drafter);

        let error = run(&service, &rig.store, &capture.id).unwrap_err();

        assert_eq!(error.code(), "storage_failed");
        assert_eq!(tables(), before, "every part of the attempt was undone");
        assert_eq!(rig.store.object_lineage(&rig.mobile.id).unwrap().revisions.len(), 1);
        assert_eq!(rig.store.get_capture(&capture.id).unwrap().unwrap().content, MIXED, "the capture survives");
        assert_eq!(service.organization_states(&rig.store).unwrap().into_iter().find(|s| s.capture_id == capture.id).unwrap().status, "failed");
        assert!(change_events(&rig.store, &DistillationOutcome::plain(vec![])).is_empty(), "a failed attempt has no outcome, so no event can exist");
        (rig.project.clone(), rig.mobile.clone(), rig.voice.clone(), capture)
    };

    // restart: a brand new connection and a brand new service
    let store = Arc::new(CaptureStore::open(&path).unwrap());
    assert_eq!(count(&store, "SELECT count(*) FROM distillation_runs WHERE capture_id NOT IN (SELECT capture_id FROM object_sources)"), 0, "no half-finished run was left behind");
    store.execute_sql_for_test("DROP TRIGGER poison");
    let rig = Rig { store, project, mobile, voice };
    let (classifier, drafter) = (mixed_classifier(), asserting("Arthur is a mobile and desktop application."));
    let service = service(mixed_distiller(), &classifier, &drafter);
    let out = run(&service, &rig.store, &capture.id).unwrap();
    assert_eq!((out.objects.len(), out.revised.len(), out.pending.len()), (1, 1, 1), "the retry commits the full result");
    assert_eq!(service.organization_states(&rig.store).unwrap().into_iter().find(|s| s.capture_id == capture.id).unwrap().status, "succeeded");
    assert_eq!(count(&rig.store, "SELECT count(*) FROM organization_failures"), 0);
    assert_eq!(rig.store.identity_decisions_for(&capture.id).unwrap().len(), 3);
}

// --- quota and expiry -----------------------------------------------------------------------------------------------------------------------------

#[test]
fn a_full_review_queue_keeps_the_claim_as_an_unchecked_object_and_drops_nothing() {
    let rig = rig();
    let classifier = Scripted::new(|_, c| if title_of(c) == "Mobile" { (0.75, Relation::AdditiveRefinement) } else { (0.05, Relation::Unrelated) });
    let mut one = pipeline(classifier, asserting("unused"), true);
    one.limits.max_unresolved_pending = 1;
    let service = DistillationService::new(desktop_distiller()).with_evolution(one);
    let (first, second) = (capture_in(&rig, B_DESKTOP), capture_in(&rig, B_DESKTOP));

    let a = run(&service, &rig.store, &first.id).unwrap();
    let b = run(&service, &rig.store, &second.id).unwrap();

    assert_eq!((a.pending.len(), a.objects.len()), (1, 0));
    assert_eq!((b.pending.len(), b.objects.len()), (0, 1), "the overflow is kept as an object");
    let decision = &rig.store.identity_decisions_for(&second.id).unwrap()[0];
    assert_eq!((decision.input.outcome, decision.input.unchecked_reason.as_deref()), (DecisionOutcome::Unchecked, Some("review_quota")));
    assert!(decision.input.vetoes.contains(&"weak_evidence".to_string()), "the reason it was uncertain is kept");
    assert_eq!(rig.store.list_pending_claims(Some(&rig.project), &["open"]).unwrap().len(), 1, "the first claim is still waiting");
    assert_eq!(count(&rig.store, "SELECT count(*) FROM identity_decisions WHERE outcome = 'new'"), 0, "never presented as identity-verified");
}

#[test]
fn due_claims_are_only_reported_and_stay_pending() {
    let rig = rig();
    let classifier = Scripted::new(|_, c| if title_of(c) == "Mobile" { (0.75, Relation::AdditiveRefinement) } else { (0.05, Relation::Unrelated) });
    let mut p = pipeline(classifier, asserting("unused"), true);
    p.limits.pending_due_days = 0;
    let service = DistillationService::new(desktop_distiller()).with_evolution(p);
    let b = capture_in(&rig, B_DESKTOP);
    run(&service, &rig.store, &b.id).unwrap();
    let due = rig.store.due_pending_claims("2999-01-01T00:00:00Z", 10).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(rig.store.get_pending_claim(&due[0].id).unwrap().unwrap().state, "open", "reporting resolved nothing");
    assert_eq!(count(&rig.store, "SELECT count(*) FROM knowledge_objects"), 2);
}

// --- Graph ----------------------------------------------------------------------------------------------------------------------------------------

#[test]
fn with_automatic_connections_off_a_revision_event_does_no_graph_work() {
    use crate::graph::integration::{IntegrationService, IntegrationSettings, Ledger, Skip, Status};
    use crate::graph::verify::{Presentation, RelationVerifier, Verdict, VerifyCandidate};
    use crate::graph::{GraphService, RelationCandidate, RelationError, RelationProposer};
    use crate::recall::settings::SemanticSettings;
    use crate::recall::testing::ConceptEmbedder;
    use crate::recall::RecallService;
    use crate::storage::relation_store::Relation as Edge;

    struct Proposer(AtomicUsize);
    impl RelationProposer for Proposer {
        fn propose<'a>(&'a self, _: &'a [KnowledgeObject], _: &'a [Edge]) -> BoxFuture<'a, Result<Vec<RelationCandidate>, RelationError>> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(vec![]) })
        }
    }
    struct Verifier(AtomicUsize);
    impl RelationVerifier for Verifier {
        fn verify<'a>(&'a self, _: &'a [VerifyCandidate], _: Presentation) -> BoxFuture<'a, Result<Vec<Verdict>, RelationError>> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(vec![]) })
        }
    }
    let rig = rig();
    let (classifier, drafter) = (Scripted::new(mobile_only(Relation::AdditiveRefinement)), asserting("Arthur is a mobile and desktop application."));
    let b = capture_in(&rig, B_DESKTOP);
    let out = run(&service(desktop_distiller(), &classifier, &drafter), &rig.store, &b.id).unwrap();
    let events = change_events(&rig.store, &out);
    assert_eq!(events.len(), 1);

    let (proposer, verifier) = (Arc::new(Proposer(AtomicUsize::new(0))), Arc::new(Verifier(AtomicUsize::new(0))));
    let dir = tempfile::tempdir().unwrap();
    let integration = IntegrationService::new(GraphService::new(proposer.clone(), verifier.clone()), IntegrationSettings::in_memory(false), Ledger::in_memory());
    let recall = RecallService::new(Arc::new(ConceptEmbedder::plain(8)), Arc::new(SemanticSettings::new(dir.path().join("semantic.json"))));
    let relations_before = rig.store.list_relations().unwrap();

    let report = tauri::async_runtime::block_on(integration.integrate(&rig.store, &recall, events[0].clone()));

    assert_eq!(report.status, Status::Skipped(Skip::Disabled));
    assert_eq!((proposer.0.load(Ordering::SeqCst), verifier.0.load(Ordering::SeqCst)), (0, 0), "no provider call");
    assert_eq!(rig.store.list_relations().unwrap(), relations_before, "the graph is untouched");
    assert_eq!(integration.ledger.pending(), 0);
    let _ = CasOrigin::System;
    let _ = ExpectedRevision { object_id: "", project_id: "", base_revision_id: "" };
}

// --- architecture ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn nothing_that_ships_can_construct_the_pipeline_except_the_review_first_composition() {
    // Only `evolution_runtime` builds the pipeline, and it builds it review-first; neither the app setup nor any command names it.
    for (name, source) in [
        ("lib.rs", include_str!("../lib.rs")),
        ("commands/distill.rs", include_str!("../commands/distill.rs")),
        ("commands/integration.rs", include_str!("../commands/integration.rs")),
        ("commands/evolution.rs", include_str!("../commands/evolution.rs")),
    ] {
        for word in ["EvolutionPipeline", "EvolutionSettings"] {
            assert!(!source.contains(word), "{name} mentions {word}");
        }
    }
    // the only production caller of the injector is the lib.rs setup, fed by the review-first builder
    let lib = include_str!("../lib.rs");
    assert_eq!(lib.matches("with_evolution(").count(), 1);
    assert!(lib.contains("evolution_runtime::build("));
    let runtime = include_str!("../evolution_runtime.rs");
    assert!(runtime.contains("debug_assert!(pipeline.review_first())") && runtime.contains("NoHandwrittenDrafts"));
    // the pipeline itself refuses to write a revision when it is review-first
    let evolution = include_str!("evolution.rs");
    assert!(evolution.contains("Plan::Revise { target, .. } if review_first"));
    // and the setting never shares storage with Automatic Connections
    assert!(!evolution.contains("IntegrationSettings") && !evolution.contains("graph/settings"));
}
