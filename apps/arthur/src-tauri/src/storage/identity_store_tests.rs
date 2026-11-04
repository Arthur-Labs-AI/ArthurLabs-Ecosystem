//! Schema v8 identity storage: decisions, pending claims, their state machine, idempotency, concurrency and rollback.

use std::sync::{Arc, Barrier};
use std::thread;

use super::capture_store::{Capture, CaptureStore, CreateCaptureInput};
use super::evidence_store::EvidenceRole;
use super::identity_store::*;
use super::knowledge_store::{KnowledgeObject, NewKnowledgeObject};
use super::lineage_store::{Changes, ReviseConflict, RevisionContent};

pub(super) const A_TEXT: &str = "Arthur is a mobile application. Arthur needs voice recognition.";
/// Bulgarian, English and an emoji: spans must count code points, not bytes or UTF-16 units.
pub(super) const B_TEXT: &str = "Arthur ще работи и на desktop 😀. Нещо друго.";

pub(super) fn span_of(content: &str, needle: &str) -> (i64, i64) {
    let byte = content.find(needle).expect("needle in content");
    let start = content[..byte].chars().count() as i64;
    (start, start + needle.chars().count() as i64)
}

pub(super) struct Fx {
    pub store: CaptureStore,
    /// "Arthur is a mobile application." and "Arthur needs voice recognition."
    pub a: Capture,
    pub mobile: KnowledgeObject,
    pub voice: KnowledgeObject,
    /// The capture whose claims are being decided. Its run produced no object (every claim was held back).
    pub b: Capture,
}

pub(super) fn fx() -> Fx {
    fx_in(CaptureStore::open_in_memory().unwrap())
}

pub(super) fn fx_in(store: CaptureStore) -> Fx {
    let a = store
        .create(CreateCaptureInput {
            source: "text".into(),
            content: A_TEXT.into(),
            project_id: None,
        })
        .unwrap();
    let (s1, e1) = span_of(A_TEXT, "Arthur is a mobile application.");
    let (s2, e2) = span_of(A_TEXT, "Arthur needs voice recognition.");
    let mut objects = store
        .record_distillation(
            &a.id,
            vec![
                NewKnowledgeObject {
                    kind: "idea".into(),
                    title: "Mobile".into(),
                    body: "Arthur is a mobile application.".into(),
                    source_start: s1,
                    source_end: e1,
                },
                NewKnowledgeObject {
                    kind: "idea".into(),
                    title: "Voice".into(),
                    body: "Arthur needs voice recognition.".into(),
                    source_start: s2,
                    source_end: e2,
                },
            ],
        )
        .unwrap();
    let voice = objects.remove(1);
    let mobile = objects.remove(0);
    let b = store
        .create(CreateCaptureInput {
            source: "voice".into(),
            content: B_TEXT.into(),
            project_id: None,
        })
        .unwrap();
    store.record_distillation(&b.id, vec![]).unwrap();
    Fx {
        store,
        a,
        mobile,
        voice,
        b,
    }
}

pub(super) fn sql(store: &CaptureStore, statement: &str) -> rusqlite::Result<()> {
    store.connection.lock().unwrap().execute_batch(statement)
}

pub(super) fn count(store: &CaptureStore, query: &str) -> i64 {
    store
        .connection
        .lock()
        .unwrap()
        .query_row(query, [], |row| row.get(0))
        .unwrap()
}

pub(super) fn audit(ids: &[&str]) -> DecisionAudit {
    DecisionAudit {
        candidates_sent: ids.iter().map(|s| s.to_string()).collect(),
        excluded: vec![],
        scores: ids.iter().map(|id| (id.to_string(), 0.7, 0.1)).collect(),
        runs: 3,
    }
}

pub(super) fn uncertain_decision(fx: &Fx, ordinal: i64, ids: &[&str]) -> IdentityDecisionInput {
    IdentityDecisionInput {
        capture_id: fx.b.id.clone(),
        ordinal,
        outcome: DecisionOutcome::Uncertain,
        unchecked_reason: None,
        target_object_id: None,
        base_revision_id: None,
        result_revision_id: None,
        created_object_id: None,
        policy_version: "identity-core-1".into(),
        model_id: Some("fake-1".into()),
        vetoes: vec!["ambiguous_target".into()],
        audit: audit(ids),
    }
}

pub(super) fn claim(
    fx: &Fx,
    ordinal: i64,
    needle: &str,
    candidates: &[&KnowledgeObject],
) -> PendingClaimInput {
    let (source_start, source_end) = span_of(B_TEXT, needle);
    let ids: Vec<&str> = candidates.iter().map(|o| o.id.as_str()).collect();
    PendingClaimInput {
        decision: uncertain_decision(fx, ordinal, &ids),
        kind: "idea".into(),
        title: "Desktop".into(),
        body: "Arthur will also work on desktop.".into(),
        source_start,
        source_end,
        candidate_ids: candidates.iter().map(|o| o.id.clone()).collect(),
        due_at: None,
    }
}

pub(super) fn current(store: &CaptureStore, object: &KnowledgeObject) -> String {
    store
        .object_lineage(&object.id)
        .unwrap()
        .current_revision_id
}

fn accept_input(
    pending: &PendingClaim,
    target: &KnowledgeObject,
    base: &str,
) -> AcceptPendingInput {
    AcceptPendingInput {
        pending_id: pending.id.clone(),
        target_object_id: target.id.clone(),
        expected_base_revision_id: base.to_string(),
        content: RevisionContent {
            kind: "idea".into(),
            title: "Mobile".into(),
            body: "Arthur is a mobile and desktop application.".into(),
        },
        role: EvidenceRole::Asserts,
        retracts: None,
        interpretation_label: Some("platforms".into()),
    }
}

pub(super) const DESKTOP: &str = "Arthur ще работи и на desktop 😀";

pub(super) fn staged(fx: &Fx) -> PendingClaim {
    fx.store
        .stage_uncertain_claim(&claim(fx, 0, DESKTOP, &[&fx.mobile]))
        .unwrap()
        .0
}

// --- decisions ---------------------------------------------------------------------------------------------------------------

fn new_decision(fx: &Fx, ordinal: i64) -> IdentityDecisionInput {
    // an object created from capture A stands in for "the object this claim became"
    IdentityDecisionInput {
        capture_id: fx.a.id.clone(),
        ordinal,
        outcome: DecisionOutcome::New,
        unchecked_reason: None,
        target_object_id: None,
        base_revision_id: None,
        result_revision_id: None,
        created_object_id: Some(if ordinal == 0 {
            fx.mobile.id.clone()
        } else {
            fx.voice.id.clone()
        }),
        policy_version: "identity-core-1".into(),
        model_id: Some("fake-1".into()),
        vetoes: vec![],
        audit: audit(&[&fx.voice.id]),
    }
}

#[test]
fn unchecked_is_stored_as_its_own_outcome_and_can_never_pass_for_a_verified_new() {
    let fx = fx();
    let verified = fx
        .store
        .record_identity_decision(&new_decision(&fx, 0))
        .unwrap()
        .0;
    let unchecked = IdentityDecisionInput {
        outcome: DecisionOutcome::Unchecked,
        unchecked_reason: Some("classifier_failed".into()),
        model_id: None,
        ordinal: 1,
        vetoes: vec!["classifier_failed".into()],
        ..new_decision(&fx, 1)
    };
    let fallback = fx.store.record_identity_decision(&unchecked).unwrap().0;
    assert_eq!(
        (
            verified.input.outcome,
            verified.decided_by.as_str(),
            verified.input.model_id.as_deref()
        ),
        (DecisionOutcome::New, "gate", Some("fake-1"))
    );
    assert_eq!(
        (
            fallback.input.outcome,
            fallback.decided_by.as_str(),
            fallback.input.model_id
        ),
        (DecisionOutcome::Unchecked, "fallback", None)
    );
    assert_eq!(
        fx.store
            .identity_decisions_for(&fx.a.id)
            .unwrap()
            .iter()
            .map(|d| d.input.outcome)
            .collect::<Vec<_>>(),
        [DecisionOutcome::New, DecisionOutcome::Unchecked]
    );

    // The disguise is refused twice: by the typed API and by the schema.
    let disguised = IdentityDecisionInput {
        model_id: None,
        ordinal: 2,
        ..new_decision(&fx, 1)
    };
    assert!(matches!(
        fx.store.record_identity_decision(&disguised),
        Err(IdentityStoreError::Invalid(_))
    ));
    let raw = format!(
        "INSERT INTO identity_decisions (capture_id, ordinal, outcome, created_object_id, policy_version, decided_by, vetoes_json, audit_json, decided_at) VALUES ('{}', 9, 'new', '{}', 'p', 'fallback', '[]', '{{}}', 'now')",
        fx.a.id, fx.voice.id
    );
    assert!(sql(&fx.store, &raw).is_err(), "new without a model id");
    assert!(
        sql(&fx.store, &raw.replace("'new'", "'unchecked'")).is_err(),
        "unchecked without a reason"
    );
}

#[test]
fn a_repeated_decision_is_a_no_op_and_a_different_one_is_a_conflict() {
    let fx = fx();
    let input = new_decision(&fx, 0);
    let (first, created) = fx.store.record_identity_decision(&input).unwrap();
    let (again, created_again) = fx.store.record_identity_decision(&input).unwrap();
    assert!((created, created_again) == (true, false) && first == again);
    assert_eq!(
        count(&fx.store, "SELECT count(*) FROM identity_decisions"),
        1
    );
    let different = IdentityDecisionInput {
        policy_version: "identity-core-2".into(),
        ..input
    };
    assert!(matches!(
        fx.store.record_identity_decision(&different),
        Err(IdentityStoreError::Conflict(_))
    ));
    assert_eq!(
        count(&fx.store, "SELECT count(*) FROM identity_decisions"),
        1
    );
}

#[test]
fn a_decision_needs_a_distillation_run_and_existing_references() {
    let fx = fx();
    let never_organized = fx
        .store
        .create(CreateCaptureInput {
            source: "text".into(),
            content: "never organized".into(),
            project_id: None,
        })
        .unwrap();
    let orphan = IdentityDecisionInput {
        capture_id: never_organized.id,
        ..new_decision(&fx, 0)
    };
    assert!(matches!(
        fx.store.record_identity_decision(&orphan),
        Err(IdentityStoreError::Invalid(_))
    ));
    let ghost = IdentityDecisionInput {
        created_object_id: Some("11111111-1111-4111-8111-111111111111".into()),
        ..new_decision(&fx, 0)
    };
    assert!(
        matches!(
            fx.store.record_identity_decision(&ghost),
            Err(IdentityStoreError::Store(_))
        ),
        "the foreign key / origin trigger refuses it"
    );
    let wrong_capture = IdentityDecisionInput {
        capture_id: fx.b.id.clone(),
        ..new_decision(&fx, 0)
    };
    assert!(
        fx.store.record_identity_decision(&wrong_capture).is_err(),
        "the object does not originate from that capture"
    );
    assert_eq!(
        count(&fx.store, "SELECT count(*) FROM identity_decisions"),
        0
    );
}

#[test]
fn the_audit_can_only_hold_ids_scores_and_known_names_never_text() {
    let fx = fx();
    let try_audit = |audit: DecisionAudit, vetoes: Vec<&str>| {
        fx.store.record_identity_decision(&IdentityDecisionInput {
            audit,
            vetoes: vetoes.into_iter().map(String::from).collect(),
            ..new_decision(&fx, 0)
        })
    };
    assert!(
        try_audit(
            DecisionAudit {
                candidates_sent: vec!["Arthur is a mobile application".into()],
                ..DecisionAudit::default()
            },
            vec![]
        )
        .is_err(),
        "text in place of an id"
    );
    assert!(
        try_audit(
            DecisionAudit::default(),
            vec!["Authorization: Bearer sk-secret"]
        )
        .is_err(),
        "free text as a veto"
    );
    assert!(try_audit(
        DecisionAudit {
            scores: vec![(fx.voice.id.clone(), f64::NAN, 0.0)],
            ..DecisionAudit::default()
        },
        vec![]
    )
    .is_err());
    assert!(try_audit(
        DecisionAudit {
            scores: vec![(fx.voice.id.clone(), 1.5, 0.0)],
            ..DecisionAudit::default()
        },
        vec![]
    )
    .is_err());
    assert!(try_audit(
        DecisionAudit {
            runs: 99,
            ..DecisionAudit::default()
        },
        vec![]
    )
    .is_err());
    assert!(try_audit(
        DecisionAudit {
            excluded: vec![(fx.voice.id.clone(), "not a veto".into())],
            ..DecisionAudit::default()
        },
        vec![]
    )
    .is_err());
    let stored = try_audit(audit(&[&fx.voice.id]), vec![]).unwrap().0;
    let dump = format!("{:?}", stored);
    assert!(!dump.contains("mobile application") && !dump.contains("Bearer"));
    // the schema repeats the shape: invalid or oversized JSON cannot be written around the API
    let base = |vetoes: &str, audit: &str| {
        format!("INSERT INTO identity_decisions (capture_id, ordinal, outcome, unchecked_reason, created_object_id, policy_version, decided_by, vetoes_json, audit_json, decided_at) VALUES ('{}', 5, 'unchecked', 'disabled', '{}', 'p', 'fallback', '{vetoes}', '{audit}', 'now')", fx.a.id, fx.voice.id)
    };
    assert!(sql(&fx.store, &base("not json", "{}")).is_err());
    assert!(
        sql(&fx.store, &base("{}", "{}")).is_err(),
        "vetoes must be an array"
    );
    assert!(
        sql(&fx.store, &base("[]", "[]")).is_err(),
        "audit must be an object"
    );
    assert!(
        sql(
            &fx.store,
            &base("[]", &format!("{{\"x\":\"{}\"}}", "a".repeat(5000)))
        )
        .is_err(),
        "oversized audit"
    );
    assert!(sql(&fx.store, &base("[]", "{}")).is_ok());
}

#[test]
fn decisions_are_append_only() {
    let fx = fx();
    fx.store
        .record_identity_decision(&new_decision(&fx, 0))
        .unwrap();
    assert!(sql(
        &fx.store,
        "UPDATE identity_decisions SET policy_version = 'x'"
    )
    .is_err());
    assert!(sql(&fx.store, "DELETE FROM identity_decisions").is_err());
    assert_eq!(
        count(
            &fx.store,
            "SELECT count(*) FROM identity_decisions WHERE policy_version = 'identity-core-1'"
        ),
        1
    );
}

// --- staging pending claims -----------------------------------------------------------------------------------------------

#[test]
fn staging_stores_the_decision_and_the_claim_together_and_is_idempotent() {
    let fx = fx();
    let input = claim(&fx, 0, DESKTOP, &[&fx.mobile]);
    let (pending, created) = fx.store.stage_uncertain_claim(&input).unwrap();
    assert!(created);
    assert_eq!(
        (
            pending.state.as_str(),
            pending.candidate_ids.clone(),
            pending.reasons.clone(),
            pending.reframing
        ),
        (
            "open",
            vec![fx.mobile.id.clone()],
            vec!["ambiguous_target".to_string()],
            false
        )
    );
    let chars: Vec<char> = B_TEXT.chars().collect();
    assert_eq!(
        chars[pending.source_start as usize..pending.source_end as usize]
            .iter()
            .collect::<String>(),
        DESKTOP,
        "a Unicode span in code points"
    );
    assert_eq!(fx.store.identity_decisions_for(&fx.b.id).unwrap().len(), 1);

    let (again, created_again) = fx.store.stage_uncertain_claim(&input).unwrap();
    assert!(!created_again && again == pending);
    assert_eq!(
        (
            count(&fx.store, "SELECT count(*) FROM pending_claims"),
            count(&fx.store, "SELECT count(*) FROM identity_decisions")
        ),
        (1, 1)
    );
    let different = PendingClaimInput {
        title: "Something else".into(),
        ..input
    };
    assert!(matches!(
        fx.store.stage_uncertain_claim(&different),
        Err(IdentityStoreError::Conflict(_))
    ));
    // a second claim of the same capture is independent
    let (second, _) = fx
        .store
        .stage_uncertain_claim(&claim(&fx, 1, "Нещо друго.", &[&fx.voice]))
        .unwrap();
    assert_ne!(second.id, pending.id);
}

#[test]
fn reframing_is_derived_from_the_vetoes() {
    let fx = fx();
    let mut input = claim(&fx, 0, DESKTOP, &[&fx.mobile]);
    input.decision.vetoes = vec!["fundamental_reframing".into()];
    assert!(fx.store.stage_uncertain_claim(&input).unwrap().0.reframing);
}

#[test]
fn staging_refuses_inconsistent_or_incomplete_claims_and_writes_nothing() {
    let fx = fx();
    let ok = claim(&fx, 0, DESKTOP, &[&fx.mobile]);
    let nexus = fx.store.create_project("Nexus").unwrap();
    let foreign = {
        let c = fx
            .store
            .create(CreateCaptureInput {
                source: "text".into(),
                content: "Something in Nexus.".into(),
                project_id: Some(nexus.id.clone()),
            })
            .unwrap();
        fx.store
            .record_distillation(
                &c.id,
                vec![NewKnowledgeObject {
                    kind: "idea".into(),
                    title: "N".into(),
                    body: "Something in Nexus.".into(),
                    source_start: 0,
                    source_end: 19,
                }],
            )
            .unwrap()
            .remove(0)
    };
    let bad: Vec<(&str, PendingClaimInput)> = vec![
        (
            "a non-uncertain decision",
            PendingClaimInput {
                decision: IdentityDecisionInput {
                    outcome: DecisionOutcome::New,
                    ..ok.decision.clone()
                },
                ..ok.clone()
            },
        ),
        (
            "no candidates",
            PendingClaimInput {
                candidate_ids: vec![],
                ..ok.clone()
            },
        ),
        (
            "five candidates",
            PendingClaimInput {
                candidate_ids: (0..5).map(|_| fx.mobile.id.clone()).collect(),
                ..ok.clone()
            },
        ),
        (
            "duplicate candidates",
            PendingClaimInput {
                candidate_ids: vec![fx.mobile.id.clone(), fx.mobile.id.clone()],
                ..ok.clone()
            },
        ),
        (
            "a malformed candidate id",
            PendingClaimInput {
                candidate_ids: vec!["not-an-id".into()],
                ..ok.clone()
            },
        ),
        (
            "a missing candidate",
            PendingClaimInput {
                candidate_ids: vec!["11111111-1111-4111-8111-111111111111".into()],
                ..ok.clone()
            },
        ),
        (
            "a candidate of another project",
            PendingClaimInput {
                candidate_ids: vec![foreign.id.clone()],
                ..ok.clone()
            },
        ),
        (
            "a span past the capture",
            PendingClaimInput {
                source_end: B_TEXT.chars().count() as i64 + 1,
                ..ok.clone()
            },
        ),
        (
            "a reversed span",
            PendingClaimInput {
                source_start: 5,
                source_end: 5,
                ..ok.clone()
            },
        ),
        (
            "an unknown kind",
            PendingClaimInput {
                kind: "gizmo".into(),
                ..ok.clone()
            },
        ),
        (
            "an empty body",
            PendingClaimInput {
                body: "  ".into(),
                ..ok.clone()
            },
        ),
        (
            "a bad due time",
            PendingClaimInput {
                due_at: Some("tomorrow".into()),
                ..ok.clone()
            },
        ),
    ];
    for (name, input) in bad {
        assert!(fx.store.stage_uncertain_claim(&input).is_err(), "{name}");
    }
    assert_eq!(
        (
            count(&fx.store, "SELECT count(*) FROM pending_claims"),
            count(&fx.store, "SELECT count(*) FROM identity_decisions")
        ),
        (0, 0),
        "a refused claim leaves no decision behind either"
    );
    assert!(fx.store.stage_uncertain_claim(&ok).is_ok());
}

#[test]
fn pending_claims_survive_a_reopen_and_are_never_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("arthur.db");
    let (id, capture) = {
        let store = CaptureStore::open(&path).unwrap();
        let a = store
            .create(CreateCaptureInput {
                source: "text".into(),
                content: A_TEXT.into(),
                project_id: None,
            })
            .unwrap();
        let mobile = store
            .record_distillation(
                &a.id,
                vec![NewKnowledgeObject {
                    kind: "idea".into(),
                    title: "M".into(),
                    body: "Arthur is a mobile application.".into(),
                    source_start: 0,
                    source_end: 31,
                }],
            )
            .unwrap()
            .remove(0);
        let b = store
            .create(CreateCaptureInput {
                source: "text".into(),
                content: B_TEXT.into(),
                project_id: None,
            })
            .unwrap();
        store.record_distillation(&b.id, vec![]).unwrap();
        let fx = Fx {
            store,
            a,
            mobile: mobile.clone(),
            voice: mobile,
            b: b.clone(),
        };
        (staged(&fx).id, b)
    };
    let store = CaptureStore::open(&path).unwrap();
    let claim = store.get_pending_claim(&id).unwrap().unwrap();
    assert_eq!(
        (claim.state.as_str(), claim.capture_id.as_str()),
        ("open", capture.id.as_str())
    );
    assert_eq!(store.list_pending_claims(None, &["open"]).unwrap().len(), 1);
    assert!(sql(&store, "DELETE FROM pending_claims").is_err());
    assert!(
        sql(
            &store,
            &format!("DELETE FROM captures WHERE id = '{}'", capture.id)
        )
        .is_err(),
        "the capture and its claim cannot be dropped from under each other"
    );
}

// --- state machine ----------------------------------------------------------------------------------------------------------

#[test]
fn defer_and_reopen_move_between_open_and_deferred_without_losing_the_claim() {
    let fx = fx();
    let pending = staged(&fx);
    let deferred = fx
        .store
        .defer_pending_claim(&pending.id, Some("2026-10-20T00:00:00Z"))
        .unwrap();
    assert_eq!(
        (
            deferred.state.as_str(),
            deferred.due_at.as_deref(),
            deferred.deferred_at.is_some()
        ),
        ("deferred", Some("2026-10-20T00:00:00Z"), true)
    );
    let again = fx.store.defer_pending_claim(&pending.id, None).unwrap();
    assert_eq!(
        (
            again.state.as_str(),
            again.due_at.as_deref(),
            again.deferred_at.clone()
        ),
        (
            "deferred",
            Some("2026-10-20T00:00:00Z"),
            deferred.deferred_at.clone()
        ),
        "deferring twice changes nothing"
    );
    assert_eq!(
        fx.store
            .list_pending_claims(None, &["deferred"])
            .unwrap()
            .len(),
        1,
        "a deferred claim stays discoverable"
    );
    assert_eq!(
        fx.store.reopen_pending_claim(&pending.id).unwrap().state,
        "open"
    );
    assert_eq!(
        fx.store.reopen_pending_claim(&pending.id).unwrap().state,
        "open"
    );
    assert!(fx
        .store
        .defer_pending_claim(&pending.id, Some("not a time"))
        .is_err());
    assert!(matches!(
        fx.store.defer_pending_claim("missing", None),
        Err(IdentityStoreError::NotFound(_))
    ));
}

#[test]
fn due_claims_are_reported_never_resolved_hidden_or_dropped() {
    let fx = fx();
    let early = fx
        .store
        .stage_uncertain_claim(&PendingClaimInput {
            due_at: Some("2026-01-01T00:00:00Z".into()),
            ..claim(&fx, 0, DESKTOP, &[&fx.mobile])
        })
        .unwrap()
        .0;
    let late = fx
        .store
        .stage_uncertain_claim(&PendingClaimInput {
            due_at: Some("2999-01-01T00:00:00Z".into()),
            ..claim(&fx, 1, "Нещо друго.", &[&fx.voice])
        })
        .unwrap()
        .0;
    let never = {
        let c = fx
            .store
            .create(CreateCaptureInput {
                source: "text".into(),
                content: "x y z".into(),
                project_id: None,
            })
            .unwrap();
        fx.store.record_distillation(&c.id, vec![]).unwrap();
        let mut input = claim(&fx, 0, DESKTOP, &[&fx.mobile]);
        input.decision.capture_id = c.id.clone();
        input.source_start = 0;
        input.source_end = 1;
        fx.store.stage_uncertain_claim(&input).unwrap().0
    };
    let due = fx
        .store
        .due_pending_claims("2026-10-08T00:00:00Z", 10)
        .unwrap();
    assert_eq!(
        due.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        [early.id.as_str()]
    );
    assert_eq!(
        fx.store
            .due_pending_claims("2026-10-08T00:00:00Z", 0)
            .unwrap()
            .len(),
        0
    );
    // being due changes nothing: still open, still listed, nothing was created
    assert_eq!(
        fx.store
            .get_pending_claim(&early.id)
            .unwrap()
            .unwrap()
            .state,
        "open"
    );
    assert_eq!(fx.store.list_pending_claims(None, &[]).unwrap().len(), 3);
    assert_eq!(
        count(&fx.store, "SELECT count(*) FROM knowledge_objects"),
        2
    );
    let _ = (late, never);
}

#[test]
fn invalid_state_changes_are_refused_by_the_schema() {
    let fx = fx();
    let pending = staged(&fx);
    let update = |set: &str| {
        sql(
            &fx.store,
            &format!(
                "UPDATE pending_claims SET {set} WHERE id = '{}'",
                pending.id
            ),
        )
    };
    assert!(
        update("state = 'accepted'").is_err(),
        "accepted without a resolution"
    );
    assert!(update("state = 'accepted', resolved_at = 'now', resolved_method = 'user', resolved_object_id = (SELECT id FROM knowledge_objects LIMIT 1), resolved_revision_id = (SELECT current_revision_id FROM knowledge_objects LIMIT 1)").is_err(), "accepted without the revision it produced");
    assert!(update("state = 'separated', resolved_at = 'now', resolved_method = 'user', resolved_object_id = (SELECT id FROM knowledge_objects LIMIT 1)").is_err(), "separated without the object created from the claim");
    assert!(update("state = 'resolved'").is_err());
    assert!(
        update("state = 'deferred'").is_err(),
        "deferred needs deferred_at"
    );
    assert!(
        update("title = 'rewritten'").is_err()
            && update("body = 'rewritten'").is_err()
            && update("source_end = source_end - 1").is_err()
            && update("candidate_ids_json = '[]'").is_err()
            && update("capture_id = 'x'").is_err()
    );
    assert!(update("resolved_method = 'user'").is_err());
    assert!(
        update("updated_at = '2030-01-01T00:00:00Z'").is_ok(),
        "bookkeeping columns may change"
    );
    // inserting an already-terminal or non-open claim
    assert!(sql(&fx.store, &format!("INSERT INTO pending_claims (id, capture_id, ordinal, kind, title, body, source_start, source_end, candidate_ids_json, reasons_json, reframing, state, deferred_at, created_at, updated_at) VALUES ('x', '{}', 1, 'idea', 't', 'b', 0, 3, '[\"{}\"]', '[]', 0, 'deferred', 'now', 'now', 'now')", fx.b.id, fx.mobile.id)).is_err());
    assert_eq!(
        fx.store
            .get_pending_claim(&pending.id)
            .unwrap()
            .unwrap()
            .state,
        "open"
    );
}

#[test]
fn a_resolved_claim_is_final_and_a_second_resolution_is_idempotent_or_a_conflict() {
    let fx = fx();
    let pending = staged(&fx);
    let resolved = fx
        .store
        .accept_pending_claim(&accept_input(
            &pending,
            &fx.mobile,
            &current(&fx.store, &fx.mobile),
        ))
        .unwrap();
    assert!(resolved.applied);
    assert!(sql(
        &fx.store,
        &format!(
            "UPDATE pending_claims SET state = 'open' WHERE id = '{}'",
            pending.id
        )
    )
    .is_err());
    assert!(sql(
        &fx.store,
        &format!(
            "UPDATE pending_claims SET updated_at = 'x' WHERE id = '{}'",
            pending.id
        )
    )
    .is_err());
    assert!(
        fx.store.defer_pending_claim(&pending.id, None).is_err()
            && fx.store.reopen_pending_claim(&pending.id).is_err()
    );
    // the identical accept again: nothing more is written
    let revisions = count(&fx.store, "SELECT count(*) FROM thought_revisions");
    let repeat = fx
        .store
        .accept_pending_claim(&accept_input(&pending, &fx.mobile, "any-stale-base"))
        .unwrap();
    assert!(!repeat.applied);
    assert_eq!(
        (
            repeat.claim.resolved_revision_id.clone(),
            repeat.revision.map(|r| r.id)
        ),
        (
            resolved.claim.resolved_revision_id.clone(),
            resolved.claim.resolved_revision_id.clone()
        )
    );
    assert_eq!(
        count(&fx.store, "SELECT count(*) FROM thought_revisions"),
        revisions
    );
    // the opposite resolution loses
    assert!(matches!(
        fx.store.separate_pending_claim(&pending.id, "user"),
        Err(IdentityStoreError::Conflict(_))
    ));
    assert_eq!(
        count(&fx.store, "SELECT count(*) FROM knowledge_objects"),
        2
    );
}

// --- accept ------------------------------------------------------------------------------------------------------------------

#[test]
fn accepting_commits_the_revision_its_evidence_and_the_terminal_state_together() {
    let fx = fx();
    let pending = staged(&fx);
    let r1 = current(&fx.store, &fx.mobile);

    let done = fx
        .store
        .accept_pending_claim(&accept_input(&pending, &fx.mobile, &r1))
        .unwrap();

    let revision = done.revision.clone().unwrap();
    assert_eq!(
        (
            revision.origin.as_str(),
            revision.parent_revision_ids.clone(),
            revision.provenance.clone()
        ),
        ("system", vec![r1.clone()], None),
        "synthesized: no fake span of its own"
    );
    assert_eq!(
        (
            done.claim.state.as_str(),
            done.claim.resolved_method.as_deref(),
            done.claim.resolved_object_id.as_deref(),
            done.claim.resolved_revision_id.as_deref()
        ),
        (
            "accepted",
            Some("user"),
            Some(fx.mobile.id.as_str()),
            Some(revision.id.as_str())
        )
    );
    assert_eq!(current(&fx.store, &fx.mobile), revision.id);
    let evidence = fx.store.revision_evidence(&revision.id).unwrap();
    assert_eq!(
        (
            evidence.len(),
            evidence[0].capture_id.as_str(),
            evidence[0].role.as_str(),
            (evidence[0].source_start, evidence[0].source_end)
        ),
        (
            1,
            fx.b.id.as_str(),
            "asserts",
            (pending.source_start, pending.source_end)
        )
    );
    // the old revision, the capture and the other object are exactly as they were
    assert_eq!(
        fx.store.get_revision(&r1).unwrap().body,
        "Arthur is a mobile application."
    );
    assert_eq!(
        fx.store.get_capture(&fx.b.id).unwrap().unwrap().content,
        B_TEXT
    );
    // existing integrity: lineage verifies, the lexical index stayed whole
    fx.store.object_lineage(&fx.mobile.id).unwrap();
    fx.store.recall_check_lexical_index().unwrap();
}

#[test]
fn accepting_after_a_user_edit_is_a_conflict_and_nothing_changes() {
    let fx = fx();
    let pending = staged(&fx);
    let r1 = current(&fx.store, &fx.mobile);
    let edit = fx
        .store
        .update_object(
            &fx.mobile.id,
            Changes {
                body: Some("Arthur is a mobile application, said me.".into()),
                ..Changes::default()
            },
        )
        .unwrap();

    let result = fx
        .store
        .accept_pending_claim(&accept_input(&pending, &fx.mobile, &r1));

    assert!(
        matches!(&result, Err(IdentityStoreError::Revise(ReviseConflict::Stale { actual, .. })) if actual == &edit.id),
        "{result:?}"
    );
    assert_eq!(
        current(&fx.store, &fx.mobile),
        edit.id,
        "the user's text is still current"
    );
    assert_eq!(
        (
            count(&fx.store, "SELECT count(*) FROM revision_evidence"),
            fx.store
                .get_pending_claim(&pending.id)
                .unwrap()
                .unwrap()
                .state
        ),
        (0, "open".to_string())
    );
}

#[test]
fn accept_checks_the_target_the_project_and_archive_state() {
    let fx = fx();
    let pending = staged(&fx);
    let r1 = current(&fx.store, &fx.mobile);
    let r_voice = current(&fx.store, &fx.voice);
    assert!(
        matches!(
            fx.store
                .accept_pending_claim(&accept_input(&pending, &fx.voice, &r_voice)),
            Err(IdentityStoreError::Invalid(_))
        ),
        "not one of the candidates"
    );

    let nexus = fx.store.create_project("Nexus").unwrap();
    // the capture moves away from its candidates: the stale assumption is refused, the claim is intact
    fx.store.move_capture(&fx.b.id, &nexus.id).unwrap();
    assert!(matches!(
        fx.store
            .accept_pending_claim(&accept_input(&pending, &fx.mobile, &r1)),
        Err(IdentityStoreError::Conflict(_))
    ));
    let listed = fx.store.list_pending_claims(Some(&nexus.id), &[]).unwrap();
    assert_eq!(
        (
            listed.len(),
            fx.store
                .list_pending_claims(Some(crate::storage::migrations::INBOX_PROJECT_ID), &[])
                .unwrap()
                .len()
        ),
        (1, 0),
        "the claim follows its capture's project"
    );
    fx.store
        .move_capture(&fx.b.id, crate::storage::migrations::INBOX_PROJECT_ID)
        .unwrap();

    // the target moves away instead
    fx.store
        .move_knowledge_object(&fx.mobile.id, &nexus.id)
        .unwrap();
    assert!(matches!(
        fx.store
            .accept_pending_claim(&accept_input(&pending, &fx.mobile, &r1)),
        Err(IdentityStoreError::Conflict(_))
    ));
    assert_eq!(
        count(&fx.store, "SELECT count(*) FROM thought_revisions"),
        2,
        "no revision was created by any refusal"
    );
    assert_eq!(
        fx.store
            .get_pending_claim(&pending.id)
            .unwrap()
            .unwrap()
            .state,
        "open"
    );
}

#[test]
fn a_claim_in_an_archived_project_stays_listed_and_recoverable_but_cannot_be_resolved() {
    let fx = fx();
    let nexus = fx.store.create_project("Nexus").unwrap();
    let a = fx
        .store
        .create(CreateCaptureInput {
            source: "text".into(),
            content: "Nexus mobile app.".into(),
            project_id: Some(nexus.id.clone()),
        })
        .unwrap();
    let target = fx
        .store
        .record_distillation(
            &a.id,
            vec![NewKnowledgeObject {
                kind: "idea".into(),
                title: "N".into(),
                body: "Nexus mobile app.".into(),
                source_start: 0,
                source_end: 17,
            }],
        )
        .unwrap()
        .remove(0);
    let b = fx
        .store
        .create(CreateCaptureInput {
            source: "text".into(),
            content: B_TEXT.into(),
            project_id: Some(nexus.id.clone()),
        })
        .unwrap();
    fx.store.record_distillation(&b.id, vec![]).unwrap();
    let mut input = claim(&fx, 0, DESKTOP, &[&target]);
    input.decision.capture_id = b.id.clone();
    input.due_at = Some("2026-01-01T00:00:00Z".into());
    let pending = fx.store.stage_uncertain_claim(&input).unwrap().0;

    fx.store.archive_project(&nexus.id).unwrap();

    let listed = fx.store.list_pending_claims(Some(&nexus.id), &[]).unwrap();
    assert_eq!(
        (listed.len(), listed[0].project_archived),
        (1, true),
        "recoverable: still listed"
    );
    assert!(
        fx.store
            .due_pending_claims("2026-10-08T00:00:00Z", 10)
            .unwrap()
            .is_empty(),
        "but not offered for resolution"
    );
    let r = current(&fx.store, &target);
    assert!(fx
        .store
        .accept_pending_claim(&accept_input(&pending, &target, &r))
        .is_err());
    assert!(matches!(
        fx.store.separate_pending_claim(&pending.id, "expiry"),
        Err(IdentityStoreError::Conflict(_))
    ));
    assert_eq!(
        fx.store
            .get_pending_claim(&pending.id)
            .unwrap()
            .unwrap()
            .state,
        "open"
    );

    fx.store.restore_project(&nexus.id).unwrap();
    assert_eq!(
        fx.store
            .due_pending_claims("2026-10-08T00:00:00Z", 10)
            .unwrap()
            .len(),
        1,
        "due again once restored"
    );
    assert!(
        fx.store
            .accept_pending_claim(&accept_input(&pending, &target, &r))
            .unwrap()
            .applied
    );
}

// --- separate ----------------------------------------------------------------------------------------------------------------

#[test]
fn keeping_a_claim_separate_creates_its_object_with_the_claim_span_as_its_source() {
    let fx = fx();
    let pending = staged(&fx);
    let objects_before = count(&fx.store, "SELECT count(*) FROM knowledge_objects");

    let done = fx
        .store
        .separate_pending_claim(&pending.id, "user")
        .unwrap();

    assert!(done.applied);
    assert_eq!(
        (
            done.claim.state.as_str(),
            done.claim.resolved_method.as_deref(),
            done.claim.resolved_revision_id.clone()
        ),
        ("separated", Some("user"), None)
    );
    assert_eq!(
        count(&fx.store, "SELECT count(*) FROM knowledge_objects"),
        objects_before + 1
    );
    let object = fx
        .store
        .get_knowledge_object(&done.object_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            object.title.as_str(),
            object.project_id.as_str(),
            object.provenance.capture_id.as_str(),
            (object.provenance.source_start, object.provenance.source_end)
        ),
        (
            "Desktop",
            crate::storage::migrations::INBOX_PROJECT_ID,
            fx.b.id.as_str(),
            (pending.source_start, pending.source_end)
        )
    );
    fx.store.object_lineage(&done.object_id).unwrap();
    assert_eq!(
        fx.store
            .object_lineage(&done.object_id)
            .unwrap()
            .revisions
            .len(),
        1
    );
    // idempotent, and the existing objects were not touched
    let repeat = fx
        .store
        .separate_pending_claim(&pending.id, "user")
        .unwrap();
    assert!(!repeat.applied && repeat.object_id == done.object_id);
    assert_eq!(
        count(&fx.store, "SELECT count(*) FROM knowledge_objects"),
        objects_before + 1
    );
    assert!(fx
        .store
        .accept_pending_claim(&accept_input(
            &pending,
            &fx.mobile,
            &current(&fx.store, &fx.mobile)
        ))
        .is_err());
}

#[test]
fn separating_by_expiry_is_a_real_object_never_a_deletion_and_the_object_lands_in_the_captures_current_project(
) {
    let fx = fx();
    let pending = staged(&fx);
    let nexus = fx.store.create_project("Nexus").unwrap();
    fx.store.move_capture(&fx.b.id, &nexus.id).unwrap();
    let done = fx
        .store
        .separate_pending_claim(&pending.id, "expiry")
        .unwrap();
    assert_eq!(
        (
            done.claim.resolved_method.as_deref(),
            fx.store
                .get_knowledge_object(&done.object_id)
                .unwrap()
                .unwrap()
                .project_id
        ),
        (Some("expiry"), nexus.id)
    );
    assert!(fx
        .store
        .separate_pending_claim(&pending.id, "whenever")
        .is_err());
}

// --- concurrency and rollback ----------------------------------------------------------------------------------------------------

#[test]
fn conflicting_resolutions_racing_have_exactly_one_winner() {
    let fx = fx();
    let pending = staged(&fx);
    let r1 = current(&fx.store, &fx.mobile);
    let store = Arc::new(fx.store);
    let barrier = Arc::new(Barrier::new(8));
    let handles: Vec<_> = (0..8)
        .map(|n| {
            let (store, barrier, pending_id, target, r1) = (
                store.clone(),
                barrier.clone(),
                pending.id.clone(),
                fx.mobile.id.clone(),
                r1.clone(),
            );
            thread::spawn(move || {
                barrier.wait();
                if n % 2 == 0 {
                    store
                        .accept_pending_claim(&AcceptPendingInput {
                            pending_id,
                            target_object_id: target,
                            expected_base_revision_id: r1,
                            content: RevisionContent {
                                kind: "idea".into(),
                                title: "Mobile".into(),
                                body: "Arthur is a mobile and desktop application.".into(),
                            },
                            role: EvidenceRole::Asserts,
                            retracts: None,
                            interpretation_label: None,
                        })
                        .map(|r| ("accepted", r.applied))
                } else {
                    store
                        .separate_pending_claim(&pending_id, "user")
                        .map(|r| ("separated", r.applied))
                }
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let applied: Vec<_> = results
        .iter()
        .filter_map(|r| r.as_ref().ok())
        .filter(|(_, applied)| *applied)
        .collect();
    assert_eq!(applied.len(), 1, "{results:?}");
    let final_state = store.get_pending_claim(&pending.id).unwrap().unwrap();
    assert_eq!(final_state.state, applied[0].0);
    // every success agrees with the winner; every other call is a conflict
    assert!(
        results.iter().all(|r| match r {
            Ok((kind, _)) => *kind == final_state.state,
            Err(IdentityStoreError::Conflict(_)) => true,
            Err(_) => false,
        }),
        "{results:?}"
    );
    // the loser's side effects do not exist
    let revisions = count(
        &store,
        "SELECT count(*) FROM thought_revisions WHERE origin = 'system'",
    );
    let new_objects = count(&store, "SELECT count(*) FROM knowledge_objects") - 2;
    assert_eq!(
        (revisions, new_objects),
        if final_state.state == "accepted" {
            (1, 0)
        } else {
            (0, 1)
        }
    );
    store.object_lineage(&fx.mobile.id).unwrap();
}

#[test]
fn a_failure_while_resolving_rolls_back_the_revision_the_evidence_and_the_object() {
    for poison in [
        "CREATE TRIGGER poison BEFORE UPDATE ON pending_claims BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    ] {
        let fx = fx();
        let pending = staged(&fx);
        let (revisions, evidence, objects) = (count(&fx.store, "SELECT count(*) FROM thought_revisions"), count(&fx.store, "SELECT count(*) FROM revision_evidence"), count(&fx.store, "SELECT count(*) FROM knowledge_objects"));
        let r1 = current(&fx.store, &fx.mobile);
        sql(&fx.store, poison).unwrap();

        assert!(fx.store.accept_pending_claim(&accept_input(&pending, &fx.mobile, &r1)).is_err());
        assert!(fx.store.separate_pending_claim(&pending.id, "user").is_err());

        assert_eq!((count(&fx.store, "SELECT count(*) FROM thought_revisions"), count(&fx.store, "SELECT count(*) FROM revision_evidence"), count(&fx.store, "SELECT count(*) FROM knowledge_objects")), (revisions, evidence, objects));
        assert_eq!(current(&fx.store, &fx.mobile), r1);
        sql(&fx.store, "DROP TRIGGER poison").unwrap();
        assert!(fx.store.accept_pending_claim(&accept_input(&pending, &fx.mobile, &r1)).unwrap().applied, "and the claim can still be resolved afterwards");
    }
}

#[test]
fn the_future_pipeline_can_compose_everything_in_one_commit_and_an_interruption_undoes_all_of_it() {
    use super::evidence_store::{attach_revision_evidence_in, NewEvidence};
    use super::lineage_store::{revise_if_current_in, CasOrigin, ExpectedRevision};
    let fx = fx();
    let r1 = current(&fx.store, &fx.mobile);
    let (start, end) = span_of(B_TEXT, DESKTOP);
    let revise_decision = |revision_id: &str| IdentityDecisionInput {
        capture_id: fx.b.id.clone(),
        ordinal: 0,
        outcome: DecisionOutcome::Revise,
        unchecked_reason: None,
        target_object_id: Some(fx.mobile.id.clone()),
        base_revision_id: Some(r1.clone()),
        result_revision_id: Some(revision_id.to_string()),
        created_object_id: None,
        policy_version: "identity-core-1".into(),
        model_id: Some("fake-1".into()),
        vetoes: vec![],
        audit: audit(&[&fx.mobile.id]),
    };
    let compose = |interrupt: bool| {
        fx.store.in_identity_transaction(|tx| {
            let revision = revise_if_current_in(
                tx,
                &ExpectedRevision {
                    object_id: &fx.mobile.id,
                    project_id: &fx.mobile.project_id,
                    base_revision_id: &r1,
                },
                RevisionContent {
                    kind: "idea".into(),
                    title: "Mobile".into(),
                    body: "Arthur is a mobile and desktop application.".into(),
                },
                CasOrigin::System,
            )?;
            attach_revision_evidence_in(
                tx,
                &revision.id,
                &[NewEvidence {
                    capture_id: fx.b.id.clone(),
                    source_start: start,
                    source_end: end,
                    role: EvidenceRole::Asserts,
                    retracts: None,
                    interpretation_label: None,
                }],
            )?;
            if interrupt {
                return Err(IdentityStoreError::Conflict("interrupted".into()));
            }
            record_identity_decision_in(tx, &revise_decision(&revision.id))?;
            Ok(revision.id)
        })
    };
    assert!(compose(true).is_err());
    assert_eq!(
        (
            count(&fx.store, "SELECT count(*) FROM thought_revisions"),
            count(&fx.store, "SELECT count(*) FROM revision_evidence"),
            count(&fx.store, "SELECT count(*) FROM identity_decisions")
        ),
        (2, 0, 0),
        "nothing of the interrupted attempt survived"
    );
    assert_eq!(current(&fx.store, &fx.mobile), r1);

    let revision_id = compose(false).unwrap();
    let decisions = fx.store.identity_decisions_for(&fx.b.id).unwrap();
    assert_eq!(
        (
            decisions.len(),
            decisions[0].input.result_revision_id.clone()
        ),
        (1, Some(revision_id))
    );
    // a repeated decision is not duplicated
    assert!(
        !fx.store
            .record_identity_decision(&decisions[0].input)
            .unwrap()
            .1
    );
}

#[test]
fn a_revise_decision_cannot_describe_a_revision_that_does_not_exist_or_has_no_evidence() {
    let fx = fx();
    let r1 = current(&fx.store, &fx.mobile);
    let base = |result: &str| IdentityDecisionInput {
        capture_id: fx.b.id.clone(),
        ordinal: 0,
        outcome: DecisionOutcome::Revise,
        unchecked_reason: None,
        target_object_id: Some(fx.mobile.id.clone()),
        base_revision_id: Some(r1.clone()),
        result_revision_id: Some(result.to_string()),
        created_object_id: None,
        policy_version: "identity-core-1".into(),
        model_id: Some("fake-1".into()),
        vetoes: vec![],
        audit: audit(&[&fx.mobile.id]),
    };
    assert!(fx
        .store
        .record_identity_decision(&base("no-such-revision"))
        .is_err());
    assert!(
        fx.store.record_identity_decision(&base(&r1)).is_err(),
        "the base itself is not a result"
    );
    // a real automatic revision, but without evidence from this capture
    let bare = fx
        .store
        .revise_if_current(
            &super::lineage_store::ExpectedRevision {
                object_id: &fx.mobile.id,
                project_id: &fx.mobile.project_id,
                base_revision_id: &r1,
            },
            RevisionContent {
                kind: "idea".into(),
                title: "Mobile".into(),
                body: "changed".into(),
            },
            super::lineage_store::CasOrigin::System,
        )
        .unwrap();
    let wrong_base = IdentityDecisionInput {
        base_revision_id: Some(current(&fx.store, &fx.voice)),
        ..base(&bare.id)
    };
    assert!(
        fx.store.record_identity_decision(&base(&bare.id)).is_err(),
        "no evidence from the capture"
    );
    assert!(fx.store.record_identity_decision(&wrong_base).is_err());
    assert_eq!(
        count(&fx.store, "SELECT count(*) FROM identity_decisions"),
        0
    );
}
