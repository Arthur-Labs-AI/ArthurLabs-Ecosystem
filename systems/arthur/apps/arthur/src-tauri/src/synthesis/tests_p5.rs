//! Phase 5 end to end: Capture -> Distillation -> identity -> synthesis -> same-family check -> a durable PROPOSAL -> a person's review.
//! The pipeline here is built exactly as production builds it (`new_same_family_review`, review-first). No key, no network.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::authorization::{ProviderAuthorization, Purpose};
use super::fake::*;
use super::stage::{StageLimits, SynthesisStage};
use super::tests::*;
use super::*;
use crate::distillation::evolution::{
    ClassifierBackend, EvolutionLimits, EvolutionPipeline, EvolutionSettings,
};
use crate::distillation::{change_events, DistillationOutcome, DistillationService};
use crate::identity::fake::MODEL as ID_MODEL;
use crate::identity::{Relation, ResolverPolicy};
use crate::storage::capture_store::CaptureStore;
use crate::storage::lineage_store::Changes;
use crate::storage::proposal_store::{ReviewAction, ReviewRequest};

const DRAFTED: &str = "Arthur is a mobile and desktop application.";

struct Rig {
    synth: Arc<ScriptedSynthesizer>,
    verifier: Arc<ScriptedVerifier>,
    synthesis_auth: Arc<ProviderAuthorization>,
    verification_auth: Arc<ProviderAuthorization>,
    consent: Arc<AtomicBool>,
    settings: Arc<EvolutionSettings>,
    judge: Arc<Judge>,
    limits: EvolutionLimits,
}

impl Rig {
    fn standard() -> Self {
        Self::with(|r| Ok(additive(r, DRAFTED)), |_| Verdict::Pass)
    }

    fn with(
        draft: impl Fn(&SynthesisRequest) -> Result<SynthesisDraft, SynthesisFailure>
            + Send
            + Sync
            + 'static,
        verdict: impl Fn(&VerifyRequest) -> Verdict + Send + Sync + 'static,
    ) -> Self {
        Self {
            // the SAME family as the verifier: this is the production pairing (GPT-6 Luna writing, GPT-6 Luna checking)
            synth: ScriptedSynthesizer::in_family("fake-verifier-family", draft),
            verifier: ScriptedVerifier::new(verdict),
            synthesis_auth: Arc::new(ProviderAuthorization::in_memory(
                "openai",
                Purpose::Synthesis,
                true,
            )),
            verification_auth: Arc::new(ProviderAuthorization::in_memory(
                "openai",
                Purpose::Verification,
                true,
            )),
            consent: Arc::new(AtomicBool::new(true)),
            settings: Arc::new(EvolutionSettings::in_memory(true)),
            judge: Judge::additive(),
            limits: EvolutionLimits::default(),
        }
    }

    fn service(&self) -> DistillationService {
        let consent = self.consent.clone();
        let stage = SynthesisStage::new_same_family_review(
            self.synth.clone(),
            self.verifier.clone(),
            self.synthesis_auth.clone(),
            self.verification_auth.clone(),
            StageLimits::default(),
        )
        .unwrap();
        DistillationService::new(Arc::new(ByText(Box::new(claim_of_any)))).with_evolution(
            EvolutionPipeline {
                settings: self.settings.clone(),
                classifier: ClassifierBackend::Sync(self.judge.clone()),
                still_allowed: Some(Arc::new(move || consent.load(Ordering::SeqCst))),
                drafter: Arc::new(NeverDrafts),
                synthesis: Some(stage),
                policy: ResolverPolicy {
                    accepted_models: vec![ID_MODEL.into()],
                    ..ResolverPolicy::default()
                },
                limits: self.limits.clone(),
            },
        )
    }
}

fn proposals(w: &World) -> Vec<crate::storage::proposal_store::ProposalView> {
    w.store.list_revision_proposals(None, &[]).unwrap()
}

fn request(id: &str, action: ReviewAction, reviewed: Option<&str>) -> ReviewRequest {
    ReviewRequest {
        proposal_id: id.into(),
        action,
        reviewed_revision_id: reviewed.map(str::to_string),
    }
}

fn no_revised_event(w: &World, out: &DistillationOutcome) -> bool {
    change_events(&w.store, out)
        .iter()
        .all(|e| e.reason != crate::graph::integration::ChangeReason::Revised)
}

#[test]
fn a_capture_becomes_a_persisted_proposal_and_never_a_revision() {
    let w = world();
    let rig = Rig::standard();
    let out = run(&rig.service(), &w, B);
    assert_eq!(
        (
            out.revised.len(),
            out.pending.len(),
            out.proposals.len(),
            out.objects.len()
        ),
        (0, 1, 1, 0)
    );
    assert_eq!(
        current_body(&w),
        A,
        "a passing same-family check changes nothing by itself"
    );
    assert_eq!((revisions(&w), count(&w, "revision_evidence")), (1, 0));
    assert!(
        no_revised_event(&w, &out),
        "no Graph event for something that was not applied"
    );
    let all = proposals(&w);
    assert_eq!(all.len(), 1);
    let p = &all[0];
    assert_eq!(
        (
            p.state.as_str(),
            p.proposed.body.as_str(),
            p.change.as_str(),
            p.object_id.as_str()
        ),
        ("open", DRAFTED, "additive", w.object.id.as_str())
    );
    assert_eq!(
        (
            p.verification.mode.as_str(),
            p.verification.status.as_str(),
            p.verification.verifier_model.as_str()
        ),
        ("same_family_review", "passed", "verifier-1")
    );
    assert_eq!(
        p.verification.synthesis_model, "gpt-6-luna-20260922",
        "the model that actually answered"
    );
    assert_eq!(
        (p.stale, p.blocked.clone(), p.base_revision_id.clone()),
        (
            false,
            None,
            w.store
                .object_lineage(&w.object.id)
                .unwrap()
                .current_revision_id
        )
    );
    // validated evidence references, resolved by the server: the target's existing support and the claim's exact words
    assert!(
        p.evidence.iter().any(|e| e.role == "existing")
            && p.evidence.iter().any(|e| e.role == "claim")
    );
    let claim = &p.claim;
    assert_eq!(
        (claim.title.as_str(), claim.state.as_str()),
        ("Desktop", "open")
    );
    assert!(claim.reasons.contains(&"review_required".to_string()));
    // the source capture is untouched and the claim keeps the exact span
    assert_eq!(
        w.store.get_captures(&[claim.capture_id.clone()]).unwrap()[0].content,
        B
    );
    assert_eq!(
        rig.synth.calls() + rig.verifier.calls(),
        2,
        "one draft, one check"
    );
}

#[test]
fn proposals_survive_a_restart_and_can_then_be_approved() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("arthur.db");
    let (object_id, capture_text_id) = {
        let store = CaptureStore::open(&path).unwrap();
        let project = store.create_project("Arthur").unwrap().id;
        let object = seed(&store, &project, A, "Mobile", "idea");
        let w = World {
            store: Arc::new(store),
            project,
            object,
        };
        let out = run(&Rig::standard().service(), &w, B);
        assert_eq!(out.proposals.len(), 1);
        (w.object.id.clone(), out.pending[0].capture_id.clone())
    };
    let store = CaptureStore::open(&path).unwrap();
    let views = store.list_revision_proposals(None, &["open"]).unwrap();
    assert_eq!(views.len(), 1, "the draft survived the restart");
    assert_eq!(
        (
            views[0].object_id.as_str(),
            views[0].proposed.body.as_str(),
            views[0].claim.capture_id.as_str()
        ),
        (object_id.as_str(), DRAFTED, capture_text_id.as_str())
    );
    let base = views[0].base_revision_id.clone();
    let result = store
        .review_revision_proposal(&request(&views[0].id, ReviewAction::Approve, Some(&base)))
        .unwrap();
    assert!(result.applied);
    assert_eq!(
        store
            .get_knowledge_object(&object_id)
            .unwrap()
            .unwrap()
            .body,
        DRAFTED
    );
}

#[test]
fn approving_a_pipeline_proposal_gives_a_truthful_history() {
    let w = world();
    let out = run(&Rig::standard().service(), &w, B);
    let p = proposals(&w).remove(0);
    let result = w
        .store
        .review_revision_proposal(&request(
            &p.id,
            ReviewAction::Approve,
            Some(&p.base_revision_id),
        ))
        .unwrap();
    let applied = result.revision.unwrap();
    assert_eq!(current_body(&w), DRAFTED);
    // the revision is `system`-origin (the only origin that may carry evidence); the approval record says a person approved it unedited
    let approvals = w.store.approvals_for_object(&w.object.id).unwrap();
    assert_eq!(
        (
            approvals.len(),
            approvals[0].revision_id.as_str(),
            approvals[0].user_edited,
            approvals[0].verification_mode.as_str()
        ),
        (1, applied.revision_id.as_str(), false, "same_family_review")
    );
    let support = w.store.evidence_support(&applied.revision_id).unwrap();
    assert!(
        support
            .active
            .iter()
            .any(|e| e.capture_id == out.pending[0].capture_id),
        "the new capture supports the new text"
    );
    assert!(
        support
            .active
            .iter()
            .any(|e| e.capture_id == w.object.provenance.capture_id),
        "the original support is still active for an additive change"
    );
    // an edit is recorded as the person's words, and the AI's draft stays as written
    let w2 = world();
    run(&Rig::standard().service(), &w2, B);
    let p2 = proposals(&w2).remove(0);
    let mine = "Arthur is a mobile application and desktop is planned.";
    let edited = w2
        .store
        .review_revision_proposal(&request(
            &p2.id,
            ReviewAction::EditAndApprove { body: mine.into() },
            Some(&p2.base_revision_id),
        ))
        .unwrap();
    assert_eq!(
        (
            edited.proposal.user_edited,
            edited.proposal.final_body.as_deref(),
            edited.proposal.proposed.body.as_str()
        ),
        (true, Some(mine), DRAFTED)
    );
    assert!(w2.store.approvals_for_object(&w2.object.id).unwrap()[0].user_edited);
}

#[test]
fn with_the_feature_off_nothing_is_classified_synthesized_checked_or_stored() {
    let w = world();
    let rig = Rig::standard();
    rig.settings.set(false).unwrap();
    let out = run(&rig.service(), &w, B);
    assert_eq!(
        (
            out.objects.len(),
            out.revised.len(),
            out.pending.len(),
            out.proposals.len()
        ),
        (1, 0, 0, 0),
        "the legacy path: the claim becomes its own idea"
    );
    assert_eq!(
        (rig.judge.calls(), rig.synth.calls(), rig.verifier.calls()),
        (0, 0, 0)
    );
    assert!(proposals(&w).is_empty());
    assert_eq!(count(&w, "identity_decisions"), 0);
}

#[test]
fn a_veto_an_unusable_check_or_a_bad_draft_stores_no_proposal_and_keeps_the_claim() {
    let cases: Vec<(&str, Rig, &str)> = vec![
        (
            "veto",
            Rig::with(
                |r| Ok(additive(r, DRAFTED)),
                |_| Verdict::Veto(vec![VetoReason::UnsupportedAssertion]),
            ),
            "verifier_veto",
        ),
        (
            "verifier down",
            Rig::with(
                |r| Ok(additive(r, DRAFTED)),
                |_| Verdict::Unavailable(UnavailableReason::Provider),
            ),
            "verifier_unavailable",
        ),
        (
            "verifier garbage",
            Rig::with(
                |r| Ok(additive(r, DRAFTED)),
                |_| Verdict::Unavailable(UnavailableReason::InvalidResponse),
            ),
            "verifier_unavailable",
        ),
        (
            "synthesis down",
            Rig::with(|_| Err(SynthesisFailure::Network), |_| Verdict::Pass),
            "synthesis_unavailable",
        ),
        (
            "synthesis garbage",
            Rig::with(
                |_| Err(SynthesisFailure::Unreadable("not json")),
                |_| Verdict::Pass,
            ),
            "synthesis_unavailable",
        ),
        (
            "an invented fact",
            Rig::with(
                |r| {
                    Ok(additive(
                        r,
                        "Arthur is a mobile app launching in 2031 with Postgres.",
                    ))
                },
                |_| Verdict::Pass,
            ),
            "draft_unsupported_fact",
        ),
    ];
    for (name, rig, reason) in cases {
        let w = world();
        let out = run(&rig.service(), &w, B);
        assert_kept_for_a_person(&out, reason);
        assert!(
            proposals(&w).is_empty(),
            "{name}: no draft exists, so none is invented"
        );
        assert_eq!(
            (current_body(&w), revisions(&w)),
            (A.to_string(), 1),
            "{name}"
        );
        assert!(no_revised_event(&w, &out), "{name}");
        // the claim is still listed for an explicit decision, with no draft
        let listed = w.store.list_unresolved_claims(None).unwrap();
        assert_eq!(
            (listed.len(), listed[0].proposal_id.clone()),
            (1, None),
            "{name}"
        );
    }
}

#[test]
fn revoking_a_permission_while_the_models_work_stores_nothing() {
    for which in ["synthesis", "verification", "consent", "switch"] {
        let w = world();
        let rig = Rig::standard();
        let (s, v, c, e) = (
            rig.synthesis_auth.clone(),
            rig.verification_auth.clone(),
            rig.consent.clone(),
            rig.settings.clone(),
        );
        match which {
            "synthesis" => rig.verifier.during(move || s.revoke().unwrap()),
            "verification" => rig.synth.during(move || v.revoke().unwrap()),
            "consent" => rig
                .verifier
                .during(move || c.store(false, Ordering::SeqCst)),
            _ => rig.verifier.during(move || e.set(false).unwrap()),
        }
        let out = run(&rig.service(), &w, B);
        assert!(
            proposals(&w).is_empty(),
            "{which}: a result that arrives after the permission was withdrawn is discarded"
        );
        assert_eq!(
            (out.revised.len(), out.proposals.len(), current_body(&w)),
            (0, 0, A.to_string()),
            "{which}"
        );
        // the claim is never lost
        assert_eq!(out.objects.len() + out.pending.len(), 1, "{which}");
    }
}

#[test]
fn an_edit_made_while_the_draft_was_being_written_wins_and_no_stale_proposal_is_stored() {
    let w = world();
    let rig = Rig::standard();
    let store = w.store.clone();
    let id = w.object.id.clone();
    rig.verifier.during(move || {
        store
            .update_object(
                &id,
                Changes {
                    body: Some("Arthur is a mobile application, edited meanwhile.".into()),
                    ..Default::default()
                },
            )
            .unwrap();
    });
    let out = run(&rig.service(), &w, B);
    assert!(
        proposals(&w).is_empty(),
        "a draft for text that no longer exists is not kept"
    );
    assert_eq!((out.pending.len(), out.proposals.len()), (1, 0));
    assert!(out.pending[0].reasons.contains(&"stale_target".to_string()));
    assert_eq!(
        current_body(&w),
        "Arthur is a mobile application, edited meanwhile."
    );
}

#[test]
fn processing_a_capture_twice_stores_one_proposal() {
    let w = world();
    let rig = Rig::standard();
    let service = rig.service();
    let id = capture(&w, B);
    let first = tauri::async_runtime::block_on(service.distill_detailed(&w.store, &id)).unwrap();
    let second = tauri::async_runtime::block_on(service.distill_detailed(&w.store, &id)).unwrap();
    assert_eq!(
        (first.proposals.len(), second.proposals.len(), second.fresh),
        (1, 0, false)
    );
    assert_eq!(proposals(&w).len(), 1);
    assert_eq!(rig.synth.calls(), 1);
}

#[test]
fn a_full_review_queue_keeps_the_claim_as_its_own_idea_and_stores_no_proposal() {
    let w = world();
    let mut rig = Rig::standard();
    rig.limits = EvolutionLimits {
        max_unresolved_pending: 1,
        pending_due_days: 14,
    };
    let service = rig.service();
    let first = run(&service, &w, B);
    assert_eq!(first.proposals.len(), 1);
    let second = run(&service, &w, "Arthur will also have a watch companion.");
    assert_eq!(
        (
            second.pending.len(),
            second.proposals.len(),
            second.objects.len()
        ),
        (0, 0, 1),
        "over quota: kept as a separate idea, never dropped"
    );
    assert_eq!(proposals(&w).len(), 1);
    assert_eq!(
        count(
            &w,
            "identity_decisions WHERE unchecked_reason = 'review_quota'"
        ),
        1
    );
}

#[test]
fn a_classifier_failure_never_reaches_synthesis_and_the_claim_stays_its_own_idea() {
    use crate::identity::{ClassifierFailure, IdentityClassifier};
    struct Down;
    impl IdentityClassifier for Down {
        fn classify(
            &self,
            _: &crate::identity::ClassifyRequest<'_>,
        ) -> Result<crate::identity::ClassifierOutput, ClassifierFailure> {
            Err(ClassifierFailure::Unavailable)
        }
    }
    let w = world();
    let rig = Rig::standard();
    let stage = SynthesisStage::new_same_family_review(
        rig.synth.clone(),
        rig.verifier.clone(),
        rig.synthesis_auth.clone(),
        rig.verification_auth.clone(),
        StageLimits::default(),
    )
    .unwrap();
    let service = DistillationService::new(Arc::new(ByText(Box::new(claim_of_any))))
        .with_evolution(EvolutionPipeline {
            settings: rig.settings.clone(),
            classifier: ClassifierBackend::Sync(Arc::new(Down)),
            still_allowed: None,
            drafter: Arc::new(NeverDrafts),
            synthesis: Some(stage),
            policy: ResolverPolicy {
                accepted_models: vec![ID_MODEL.into()],
                ..ResolverPolicy::default()
            },
            limits: EvolutionLimits::default(),
        });
    let out = run(&service, &w, B);
    assert_eq!(
        (out.objects.len(), out.pending.len(), out.proposals.len()),
        (1, 0, 0),
        "offline identity: unchecked, kept as its own idea"
    );
    assert_eq!(
        (rig.synth.calls(), rig.verifier.calls()),
        (0, 0),
        "nothing was sent to a model"
    );
}

#[test]
fn another_projects_ideas_never_become_proposal_targets() {
    let w = world();
    let other = w.store.create_project("Elsewhere").unwrap().id;
    let foreign = seed(
        &w.store,
        &other,
        "Arthur is a mobile application.",
        "Mobile",
        "idea",
    );
    let rig = Rig::standard();
    run(&rig.service(), &w, B);
    let views = proposals(&w);
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].object_id, w.object.id);
    assert_ne!(views[0].object_id, foreign.id);
    assert!(
        rig.synth.seen.lock().unwrap().iter().all(|r| !r
            .sources
            .iter()
            .any(|s| s.capture_id == foreign.provenance.capture_id)),
        "nothing of the other project reached the models"
    );
}

#[test]
fn a_reframing_claim_never_gets_a_draft_and_waits_for_an_explicit_choice() {
    let w = world();
    let mut rig = Rig::standard();
    rig.judge = Judge::new(|_, c| {
        let mut s = sig(&c.object_id, 0.95, Relation::AdditiveRefinement);
        s.reframing = 0.9;
        s
    });
    let out = run(&rig.service(), &w, B);
    assert_eq!(
        (out.pending.len(), out.proposals.len(), rig.synth.calls()),
        (1, 0, 0),
        "no model was asked to write over a reframing"
    );
    assert!(out.pending[0].reframing);
    let listed = w.store.list_unresolved_claims(None).unwrap();
    assert!(listed[0].reframing && listed[0].proposal_id.is_none());
    let kept = w
        .store
        .resolve_unresolved_claim(
            &out.pending[0].id,
            crate::storage::proposal_store::ClaimAction::KeepSeparate,
        )
        .unwrap();
    assert!(kept.created_object_id.is_some());
}

#[test]
fn production_never_applies_a_revision_even_if_a_plan_asked_for_one() {
    // The independent form (tests only) may still revise; the production form must not.
    let independent = {
        let w = world();
        let kit = Kit::standard();
        let out = run(&kit.text_service(), &w, B);
        (out.revised.len(), current_body(&w))
    };
    assert_eq!(
        independent,
        (1, DRAFTED.to_string()),
        "contrast: an independent pass can apply in a test"
    );
    let w = world();
    let out = run(&Rig::standard().service(), &w, B);
    assert_eq!((out.revised.len(), current_body(&w)), (0, A.to_string()));
}
