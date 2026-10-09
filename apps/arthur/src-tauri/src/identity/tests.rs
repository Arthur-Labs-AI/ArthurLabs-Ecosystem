use super::fake::*;
use super::*;

fn project(id: &str) -> ProjectState {
    ProjectState { id: id.into(), archived: false, is_inbox: false }
}

fn claim_with(kind: &str, text: &str, ordinal: usize) -> Claim {
    Claim {
        ordinal,
        kind: kind.into(),
        title: "Desktop".into(),
        body: text.into(),
        evidence: EvidenceSpan { capture_id: "cap-2".into(), start: 0, end: text.chars().count() as i64 },
        evidence_text: text.into(),
        project: project("arthur"),
    }
}

fn claim() -> Claim {
    claim_with("idea", "Arthur will also support desktop.", 0)
}

fn candidate(id: &str) -> Candidate {
    Candidate {
        object_id: id.into(),
        project: project("arthur"),
        lifecycle: ObjectLifecycle::Active,
        current_revision_id: format!("{id}-r1"),
        revision: RevisionView { id: format!("{id}-r1"), origin: "initial".into(), kind: "idea".into(), title: "Mobile".into(), body: "Arthur is a mobile app.".into() },
    }
}

fn policy() -> ResolverPolicy {
    ResolverPolicy { enabled: true, accepted_models: vec![MODEL.into()], ..ResolverPolicy::default() }
}

fn yes(id: &str, relation: Relation) -> FakeClassifier {
    FakeClassifier::replying(Ok(unanimous(vec![signal(id, 0.97, relation)])))
}

// --- the three outcomes ------------------------------------------------------------------------------------------------------

#[test]
fn a_clear_additive_refinement_of_one_unique_target_is_revise_with_an_exact_snapshot() {
    let classifier = yes("a", Relation::AdditiveRefinement);
    let r = resolve(&claim(), &[candidate("a")], &policy(), &classifier);
    assert_eq!(r.outcome, Outcome::Revise { target: TargetSnapshot { object_id: "a".into(), project_id: "arthur".into(), base_revision_id: "a-r1".into() }, relation: Relation::AdditiveRefinement });
    assert_eq!(r.identity, Identity::Same { target_id: "a".into(), relation: Relation::AdditiveRefinement });
    assert_eq!(r.permission, Permission::Automatic);
    assert_eq!((r.audit.model_id.as_deref(), r.audit.policy_version.as_str(), r.audit.runs), (Some(MODEL), "identity-core-1", 3));
    assert!(r.audit.vetoes.is_empty());
}

#[test]
fn a_correction_is_revise() {
    let r = resolve(&claim_with("idea", "Actually the launch is in May, not June.", 0), &[candidate("a")], &policy(), &yes("a", Relation::Correction));
    assert!(r.is_revise());
}

#[test]
fn a_distinct_feature_in_the_same_project_is_new() {
    // "voice recognition" vs "offline storage": same project, different proposition.
    let classifier = FakeClassifier::replying(Ok(unanimous(vec![signal("a", 0.12, Relation::DistinctSameProject)])));
    let r = resolve(&claim_with("idea", "Arthur needs offline storage.", 0), &[candidate("a")], &policy(), &classifier);
    assert_eq!((r.outcome, r.identity, r.permission), (Outcome::New { reason: NewReason::Distinct }, Identity::Distinct, Permission::NotApplicable));
}

#[test]
fn identity_and_permission_are_separate_same_object_may_still_need_confirmation() {
    let mut c = candidate("a");
    c.revision.origin = "user_edit".into();
    let r = resolve(&claim(), &[c], &policy(), &yes("a", Relation::AdditiveRefinement));
    assert_eq!(r.identity, Identity::Same { target_id: "a".into(), relation: Relation::AdditiveRefinement }, "it IS the same object");
    assert_eq!(r.permission, Permission::Confirmation(vec![Veto::UserOwnedRevision]), "but may not be changed unasked");
    assert!(matches!(r.outcome, Outcome::Uncertain { .. }));
}

// --- additive refinement vs reframing ----------------------------------------------------------------------------------------

#[test]
fn additive_refinement_is_not_a_reframing_but_a_reframing_relation_is_never_automatic() {
    let additive = resolve(&claim(), &[candidate("a")], &policy(), &yes("a", Relation::AdditiveRefinement));
    assert!(additive.is_revise());
    let reframing = resolve(&claim_with("idea", "Arthur is a thinking tool, not an app.", 0), &[candidate("a")], &policy(), &yes("a", Relation::Reframing));
    assert!(matches!(&reframing.identity, Identity::Same { relation: Relation::Reframing, .. }), "same object, fundamentally reframed");
    assert_eq!(reframing.permission, Permission::Confirmation(vec![Veto::FundamentalReframing]));
    assert!(!reframing.is_revise());
}

#[test]
fn a_high_reframing_score_blocks_even_a_claim_labelled_additive() {
    let mut s = signal("a", 0.97, Relation::AdditiveRefinement);
    s.reframing = 0.8;
    let r = resolve(&claim(), &[candidate("a")], &policy(), &FakeClassifier::replying(Ok(unanimous(vec![s]))));
    assert_eq!(r.permission, Permission::Confirmation(vec![Veto::ReframingSignal]));
}

#[test]
fn one_run_with_a_high_reframing_score_is_enough_to_block() {
    let calm = vec![signal("a", 0.97, Relation::AdditiveRefinement)];
    let mut alarmed = calm.clone();
    alarmed[0].reframing = 0.9;
    let out = ClassifierOutput { model_id: MODEL.into(), runs: vec![calm.clone(), alarmed, calm] };
    assert!(!resolve(&claim(), &[candidate("a")], &policy(), &FakeClassifier::replying(Ok(out))).is_revise());
}

#[test]
fn a_decision_replacement_needs_a_prior_decision_and_explicit_wording_in_the_claim_itself() {
    let mut target = candidate("a");
    target.revision.kind = "decision".into();
    target.revision.body = "We use Postgres.".into();
    let replace = |text: &str, explicit: bool, target: Candidate| {
        let mut s = signal("a", 0.97, Relation::DecisionReplacement);
        s.explicit_supersession = Some(explicit);
        resolve(&claim_with("decision", text, 0), &[target], &policy(), &FakeClassifier::replying(Ok(unanimous(vec![s]))))
    };
    assert!(replace("We switch from Postgres to SQLite instead.", true, target.clone()).is_revise());
    assert!(replace("Вместо Postgres ползваме SQLite.", true, target.clone()).is_revise(), "Bulgarian wording");
    // the provider says explicit, but the claim's own words do not
    assert_eq!(replace("We use SQLite.", true, target.clone()).permission, Permission::Confirmation(vec![Veto::SupersessionNotExplicit]));
    // the words are there, but the provider does not vouch
    assert_eq!(replace("We switch from Postgres to SQLite.", false, target.clone()).permission, Permission::Confirmation(vec![Veto::SupersessionNotExplicit]));
    // the target was never a decision
    let idea = candidate("a");
    assert!(replace("We switch from Postgres to SQLite.", true, idea).permission == Permission::Confirmation(vec![Veto::IncompatibleKind, Veto::NotAPriorDecision]));
}

#[test]
fn a_subtask_of_an_existing_task_is_uncertain_never_a_revision() {
    let mut target = candidate("a");
    target.revision.kind = "task".into();
    target.revision.body = "Plan the trip to Rome.".into();
    let r = resolve(&claim_with("task", "Book the hotel in Rome.", 0), &[target], &policy(), &yes("a", Relation::Subtask));
    assert_eq!((r.identity, r.permission), (Identity::Unknown, Permission::Confirmation(vec![Veto::SubtaskOfTarget])));
    assert!(matches!(r.outcome, Outcome::Uncertain { .. }));
}

// --- project / lifecycle gates -----------------------------------------------------------------------------------------------

#[test]
fn a_candidate_from_another_project_is_never_shown_and_never_a_target() {
    let mut other = candidate("b");
    other.project = project("orbit");
    let classifier = yes("a", Relation::AdditiveRefinement);
    let r = resolve(&claim(), &[other, candidate("a")], &policy(), &classifier);
    assert_eq!(classifier.shown(), vec![vec!["a".to_string()]], "cross-project text never reaches the classifier");
    assert_eq!(r.audit.excluded, vec![("b".to_string(), Veto::ProjectMismatch)]);
}

#[test]
fn only_a_wrong_project_candidate_means_new_without_calling_the_classifier() {
    let mut other = candidate("b");
    other.project = project("orbit");
    let classifier = yes("b", Relation::AdditiveRefinement);
    let r = resolve(&claim(), &[other], &policy(), &classifier);
    assert_eq!(r.outcome, Outcome::New { reason: NewReason::Unchecked(UncheckedReason::NoEligibleCandidates) });
    assert_eq!(classifier.calls(), 0);
}

#[test]
fn a_provider_naming_a_withheld_cross_project_candidate_cannot_make_it_a_target() {
    let mut other = candidate("b");
    other.project = project("orbit");
    // The classifier was only shown "a" but answers about "b" (a hallucinated or injected id).
    let classifier = FakeClassifier::replying(Ok(unanimous(vec![signal("a", 0.1, Relation::Unrelated), signal("b", 0.99, Relation::AdditiveRefinement)])));
    let r = resolve(&claim(), &[other, candidate("a")], &policy(), &classifier);
    assert!(!r.is_revise());
    assert_eq!(r.audit.vetoes, vec![Veto::UnknownCandidateId]);
}

#[test]
fn an_archived_target_or_archived_project_is_never_a_target() {
    let mut archived_object = candidate("a");
    archived_object.lifecycle = ObjectLifecycle::Archived;
    let r = resolve(&claim(), &[archived_object], &policy(), &yes("a", Relation::AdditiveRefinement));
    assert_eq!(r.audit.excluded, vec![("a".to_string(), Veto::TargetArchived)]);
    assert!(!r.is_revise());

    let mut archived_project = candidate("a");
    archived_project.project.archived = true;
    assert_eq!(resolve(&claim(), &[archived_project], &policy(), &yes("a", Relation::AdditiveRefinement)).audit.excluded[0].1, Veto::ProjectArchived);

    let mut claim_in_archived = claim();
    claim_in_archived.project.archived = true;
    assert!(!resolve(&claim_in_archived, &[candidate("a")], &policy(), &yes("a", Relation::AdditiveRefinement)).is_revise());
}

#[test]
fn an_inconsistent_snapshot_is_excluded() {
    let mut c = candidate("a");
    c.current_revision_id = "a-r9".into();
    assert_eq!(resolve(&claim(), &[c], &policy(), &yes("a", Relation::AdditiveRefinement)).audit.excluded[0].1, Veto::InconsistentSnapshot);
}

#[test]
fn in_the_inbox_a_match_is_only_ever_a_suggestion() {
    let mut inbox_claim = claim();
    inbox_claim.project = ProjectState { id: "inbox".into(), archived: false, is_inbox: true };
    let mut c = candidate("a");
    c.project = inbox_claim.project.clone();
    let r = resolve(&inbox_claim, &[c], &policy(), &yes("a", Relation::AdditiveRefinement));
    assert_eq!(r.permission, Permission::Confirmation(vec![Veto::InboxRequiresConfirmation]));
}

#[test]
fn incompatible_kinds_and_unresolved_referents_downgrade() {
    let mut task = candidate("a");
    task.revision.kind = "task".into();
    assert_eq!(resolve(&claim(), &[task], &policy(), &yes("a", Relation::AdditiveRefinement)).permission, Permission::Confirmation(vec![Veto::IncompatibleKind]));
    let mut pronoun = signal("a", 0.97, Relation::AdditiveRefinement);
    pronoun.referent_resolved = Some(false);
    let r = resolve(&claim_with("idea", "Make it faster.", 0), &[candidate("a")], &policy(), &FakeClassifier::replying(Ok(unanimous(vec![pronoun]))));
    assert_eq!(r.permission, Permission::Confirmation(vec![Veto::ReferentUnresolved]));
}

#[test]
fn an_idea_and_a_note_are_compatible_but_not_an_idea_and_a_question() {
    assert!(policy::kinds_compatible("idea", "note") && policy::kinds_compatible("decision", "decision"));
    assert!(!policy::kinds_compatible("idea", "question") && !policy::kinds_compatible("idea", "gizmo"));
}

// --- ambiguity -------------------------------------------------------------------------------------------------------------

#[test]
fn two_plausible_candidates_are_uncertain_even_if_one_scores_higher() {
    let classifier = FakeClassifier::replying(Ok(unanimous(vec![signal("a", 0.97, Relation::AdditiveRefinement), signal("b", 0.7, Relation::AdditiveRefinement)])));
    let r = resolve(&claim(), &[candidate("a"), candidate("b")], &policy(), &classifier);
    assert_eq!(r.identity, Identity::Ambiguous);
    assert_eq!(r.outcome, Outcome::Uncertain { candidates: vec!["a".into(), "b".into()], reason: vec![Veto::AmbiguousTarget] });
}

#[test]
fn two_equally_strong_candidates_are_uncertain() {
    let classifier = FakeClassifier::replying(Ok(unanimous(vec![signal("a", 0.96, Relation::Correction), signal("b", 0.96, Relation::Correction)])));
    assert!(!resolve(&claim(), &[candidate("a"), candidate("b")], &policy(), &classifier).is_revise());
}

#[test]
fn a_target_below_the_bar_is_uncertain_not_new_and_not_revise() {
    let r = resolve(&claim(), &[candidate("a")], &policy(), &FakeClassifier::replying(Ok(unanimous(vec![signal("a", 0.75, Relation::AdditiveRefinement)]))));
    assert_eq!(r.outcome, Outcome::Uncertain { candidates: vec!["a".into()], reason: vec![Veto::WeakEvidence] });
}

#[test]
fn runs_must_be_unanimous_on_the_target() {
    let yes_run = vec![signal("a", 0.97, Relation::AdditiveRefinement), signal("b", 0.05, Relation::Unrelated)];
    let swapped = vec![signal("a", 0.05, Relation::Unrelated), signal("b", 0.97, Relation::AdditiveRefinement)];
    let out = ClassifierOutput { model_id: MODEL.into(), runs: vec![yes_run.clone(), yes_run, swapped] };
    let r = resolve(&claim(), &[candidate("a"), candidate("b")], &policy(), &FakeClassifier::replying(Ok(out)));
    assert!(!r.is_revise());
}

#[test]
fn runs_that_disagree_on_the_relation_are_not_trusted() {
    let one = vec![signal("a", 0.97, Relation::AdditiveRefinement)];
    let two = vec![signal("a", 0.97, Relation::Correction)];
    let out = ClassifierOutput { model_id: MODEL.into(), runs: vec![one.clone(), two, one] };
    let r = resolve(&claim(), &[candidate("a")], &policy(), &FakeClassifier::replying(Ok(out)));
    assert_eq!(r.audit.vetoes, vec![Veto::RunsDisagree]);
    assert!(!r.is_revise());
}

#[test]
fn a_high_score_with_a_distinct_relation_is_a_contradiction_not_a_merge() {
    let r = resolve(&claim(), &[candidate("a")], &policy(), &FakeClassifier::replying(Ok(unanimous(vec![signal("a", 0.98, Relation::DistinctSameProject)]))));
    assert_eq!(r.audit.vetoes, vec![Veto::RelationContradictsScore]);
    assert!(!r.is_revise());
}

// --- failure, malformed and untrusted signals ---------------------------------------------------------------------------------

#[test]
fn a_provider_failure_or_timeout_fails_closed_to_new() {
    for failure in [ClassifierFailure::Timeout, ClassifierFailure::Network, ClassifierFailure::Refused, ClassifierFailure::Unavailable, ClassifierFailure::Unreadable] {
        let r = resolve(&claim(), &[candidate("a")], &policy(), &FakeClassifier::replying(Err(failure)));
        assert_eq!(r.outcome, Outcome::New { reason: NewReason::Unchecked(UncheckedReason::ClassifierFailed) });
        assert_eq!(r.audit.vetoes, vec![Veto::ClassifierFailed(failure)]);
        assert_eq!(r.permission, Permission::NotApplicable);
    }
}

fn never_revises(output: ClassifierOutput) -> Resolution {
    let r = resolve(&claim(), &[candidate("a"), candidate("b")], &policy(), &FakeClassifier::replying(Ok(output)));
    assert!(!r.is_revise(), "{r:?}");
    r
}

fn good_run() -> Vec<CandidateSignal> {
    vec![signal("a", 0.97, Relation::AdditiveRefinement), signal("b", 0.02, Relation::Unrelated)]
}

#[test]
fn an_unknown_model_never_permits_revise() {
    let mut out = unanimous(good_run());
    out.model_id = "someone-else".into();
    assert_eq!(never_revises(out).audit.vetoes, vec![Veto::UnknownModel]);
    // and with the default policy (no model accepted at all)
    let r = resolve(&claim(), &[candidate("a"), candidate("b")], &ResolverPolicy { enabled: true, ..ResolverPolicy::default() }, &FakeClassifier::replying(Ok(unanimous(good_run()))));
    assert!(!r.is_revise());
}

#[test]
fn too_few_runs_never_permit_revise() {
    assert_eq!(never_revises(ClassifierOutput { model_id: MODEL.into(), runs: vec![good_run()] }).audit.vetoes, vec![Veto::TooFewRuns]);
    assert_eq!(never_revises(ClassifierOutput { model_id: MODEL.into(), runs: vec![] }).audit.vetoes, vec![Veto::TooFewRuns]);
}

#[test]
fn malformed_or_incomplete_signals_never_permit_revise() {
    let cases: Vec<(&str, Box<dyn Fn(&mut Vec<CandidateSignal>)>, Veto)> = vec![
        ("missing candidate", Box::new(|run| run.truncate(1)), Veto::IncompleteSignals),
        ("duplicate candidate", Box::new(|run| run[1] = run[0].clone()), Veto::DuplicateSignal),
        ("unknown candidate id", Box::new(|run| run[1].candidate_id = "ghost".into()), Veto::UnknownCandidateId),
        ("NaN score", Box::new(|run| run[0].same_proposition = f64::NAN), Veto::OutOfRangeScore),
        ("score above 1", Box::new(|run| run[0].same_proposition = 1.5), Veto::OutOfRangeScore),
        ("negative reframing", Box::new(|run| run[0].reframing = -0.1), Veto::OutOfRangeScore),
        ("infinite", Box::new(|run| run[0].reframing = f64::INFINITY), Veto::OutOfRangeScore),
        ("plausible but no relation", Box::new(|run| run[0].relation = None), Veto::IncompleteSignals),
        ("plausible but no referent flag", Box::new(|run| run[0].referent_resolved = None), Veto::IncompleteSignals),
        ("plausible but no supersession flag", Box::new(|run| run[0].explicit_supersession = None), Veto::IncompleteSignals),
    ];
    for (name, corrupt, veto) in cases {
        let mut broken = good_run();
        corrupt(&mut broken);
        // the corruption is in ONE run only: a single bad reading is enough to distrust the whole answer
        let out = ClassifierOutput { model_id: MODEL.into(), runs: vec![good_run(), broken, good_run()] };
        let r = never_revises(out);
        assert_eq!(r.audit.vetoes, vec![veto], "{name}");
        assert_eq!(r.outcome, Outcome::New { reason: NewReason::Unchecked(UncheckedReason::MalformedSignals) }, "{name}");
    }
}

#[test]
fn a_disabled_policy_or_an_invalid_claim_or_candidate_set_never_calls_the_classifier() {
    let classifier = yes("a", Relation::AdditiveRefinement);
    let off = resolve(&claim(), &[candidate("a")], &ResolverPolicy { enabled: false, ..policy() }, &classifier);
    assert_eq!(off.outcome, Outcome::New { reason: NewReason::Unchecked(UncheckedReason::Disabled) });

    let mut bad_span = claim();
    bad_span.evidence.end = bad_span.evidence.start;
    let mut wrong_length = claim();
    wrong_length.evidence.end += 1;
    let mut bad_kind = claim();
    bad_kind.kind = "gizmo".into();
    let mut empty_body = claim();
    empty_body.body = "  ".into();
    for invalid in [bad_span, wrong_length, bad_kind, empty_body] {
        assert_eq!(resolve(&invalid, &[candidate("a")], &policy(), &classifier).outcome, Outcome::New { reason: NewReason::Unchecked(UncheckedReason::InvalidClaim) });
    }
    let five: Vec<Candidate> = (0..5).map(|i| candidate(&format!("c{i}"))).collect();
    assert_eq!(resolve(&claim(), &five, &policy(), &classifier).outcome, Outcome::New { reason: NewReason::Unchecked(UncheckedReason::InvalidCandidates) });
    assert_eq!(resolve(&claim(), &[candidate("a"), candidate("a")], &policy(), &classifier).outcome, Outcome::New { reason: NewReason::Unchecked(UncheckedReason::InvalidCandidates) });
    assert_eq!(classifier.calls(), 0);
}

// --- user-owned protection ------------------------------------------------------------------------------------------------

#[test]
fn user_edits_and_merges_are_protected_but_model_owned_origins_are_not() {
    for (origin, protected) in [("initial", false), ("distillation", false), ("system", false), ("user_edit", true), ("merge", true), ("anything-new", true)] {
        let mut c = candidate("a");
        c.revision.origin = origin.into();
        let r = resolve(&claim(), &[c], &policy(), &yes("a", Relation::AdditiveRefinement));
        assert_eq!(r.is_revise(), !protected, "{origin}");
    }
}

// --- one capture, several claims ---------------------------------------------------------------------------------------------

#[test]
fn two_claims_in_one_capture_aiming_at_the_same_object_both_wait_for_confirmation() {
    let classifier = yes("a", Relation::AdditiveRefinement);
    let items = vec![(claim_with("idea", "Arthur will also support desktop.", 0), vec![candidate("a")]), (claim_with("idea", "Arthur will also support tablets.", 1), vec![candidate("a")])];
    let out = resolve_capture(&items, &policy(), &classifier);
    assert!(out.iter().all(|r| !r.is_revise()));
    assert!(out.iter().all(|r| r.audit.vetoes.contains(&Veto::ConflictingClaims) && r.permission == Permission::Confirmation(vec![Veto::ConflictingClaims])));
}

#[test]
fn a_claim_that_is_merely_uncertain_about_the_same_object_also_blocks_the_revise() {
    let sure = (claim_with("idea", "Arthur will also support desktop.", 0), vec![candidate("a")]);
    let unsure = (claim_with("idea", "Maybe a web version.", 1), vec![candidate("a")]);
    let calls = std::sync::atomic::AtomicUsize::new(0);
    struct Alternating<'a>(&'a std::sync::atomic::AtomicUsize);
    impl IdentityClassifier for Alternating<'_> {
        fn classify(&self, _: &ClassifyRequest<'_>) -> Result<ClassifierOutput, ClassifierFailure> {
            let n = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(unanimous(vec![signal("a", if n == 0 { 0.97 } else { 0.7 }, Relation::AdditiveRefinement)]))
        }
    }
    let out = resolve_capture(&[sure, unsure], &policy(), &Alternating(&calls));
    assert!(matches!(out[1].outcome, Outcome::Uncertain { .. }));
    assert!(!out[0].is_revise());
}

#[test]
fn independent_claims_in_one_capture_are_decided_independently() {
    let mut other = candidate("b");
    other.revision.body = "Arthur needs voice recognition.".into();
    let items = vec![(claim_with("idea", "Arthur will also support desktop.", 0), vec![candidate("a")]), (claim_with("idea", "Arthur needs offline storage.", 1), vec![other])];
    struct ByClaim;
    impl IdentityClassifier for ByClaim {
        fn classify(&self, request: &ClassifyRequest<'_>) -> Result<ClassifierOutput, ClassifierFailure> {
            let id = request.candidates[0].object_id.as_str();
            Ok(unanimous(vec![if request.claim.ordinal == 0 { signal(id, 0.97, Relation::AdditiveRefinement) } else { signal(id, 0.1, Relation::DistinctSameProject) }]))
        }
    }
    let out = resolve_capture(&items, &policy(), &ByClaim);
    assert!(out[0].is_revise());
    assert_eq!(out[1].outcome, Outcome::New { reason: NewReason::Distinct });
}

// --- audit carries no text ---------------------------------------------------------------------------------------------------

#[test]
fn the_audit_has_ids_scores_and_versions_but_no_object_or_capture_text() {
    let r = resolve(&claim(), &[candidate("a")], &policy(), &yes("a", Relation::AdditiveRefinement));
    let dump = format!("{:?}", r.audit);
    for text in ["Arthur is a mobile app", "will also support desktop", "cap-2"] {
        assert!(!dump.contains(text), "{text}");
    }
    assert!(dump.contains("identity-core-1") && dump.contains(MODEL));
}

#[test]
fn nothing_in_the_resolution_invents_a_capture_span() {
    // A REVISE carries a target snapshot only; the evidence span belongs to the claim and is the caller's to record verbatim.
    let r = resolve(&claim(), &[candidate("a")], &policy(), &yes("a", Relation::AdditiveRefinement));
    let Outcome::Revise { target, .. } = r.outcome else { panic!() };
    assert_eq!(format!("{target:?}"), r#"TargetSnapshot { object_id: "a", project_id: "arthur", base_revision_id: "a-r1" }"#);
}
