//! Revision evidence (schema v8): what is stored, what is refused, and what the conservative derivation may claim.

use super::capture_store::CaptureStore;
use super::capture_store::CreateCaptureInput;
use super::evidence_store::*;
use super::identity_store::IdentityStoreError;
use super::identity_store_tests::{count, current, fx, span_of, sql, Fx, A_TEXT, B_TEXT};
use super::knowledge_store::NewKnowledgeObject;
use super::lineage_store::{CasOrigin, Changes, ExpectedRevision, Revision, RevisionContent};

const DESKTOP: &str = "Arthur ще работи и на desktop 😀";

fn auto(fx: &Fx, body: &str) -> Revision {
    let base = current(&fx.store, &fx.mobile);
    fx.store
        .revise_if_current(
            &ExpectedRevision {
                object_id: &fx.mobile.id,
                project_id: &fx.mobile.project_id,
                base_revision_id: &base,
            },
            RevisionContent {
                kind: "idea".into(),
                title: "Mobile".into(),
                body: body.into(),
            },
            CasOrigin::System,
        )
        .unwrap()
}

fn ev(
    capture_id: &str,
    content: &str,
    needle: &str,
    role: EvidenceRole,
    retracts: Option<(String, i64)>,
) -> NewEvidence {
    let (source_start, source_end) = span_of(content, needle);
    NewEvidence {
        capture_id: capture_id.into(),
        source_start,
        source_end,
        role,
        retracts,
        interpretation_label: None,
    }
}

/// R1 (initial, from A) -> R2 (automatic, evidence from B).
fn r2(fx: &Fx) -> Revision {
    let r2 = auto(fx, "Arthur is a mobile and desktop application.");
    fx.store
        .attach_revision_evidence(
            &r2.id,
            &[ev(&fx.b.id, B_TEXT, DESKTOP, EvidenceRole::Asserts, None)],
        )
        .unwrap();
    r2
}

fn spans(items: &[EvidenceItem]) -> Vec<(String, i64, i64, String)> {
    items
        .iter()
        .map(|e| {
            (
                e.capture_id.clone(),
                e.source_start,
                e.source_end,
                e.role.clone(),
            )
        })
        .collect()
}

// --- the synthesized example -------------------------------------------------------------------------------------------------

#[test]
fn a_synthesized_revision_is_identified_as_such_and_links_to_the_real_spans_of_both_captures() {
    let fx = fx();
    let r1 = current(&fx.store, &fx.mobile);
    let r2 = r2(&fx);
    let support = fx.store.evidence_support(&r2.id).unwrap();

    assert!(support.synthesized, "Revision 2 is Arthur's own synthesis");
    assert_eq!(r2.provenance, None, "and carries no direct span");
    let (a_start, a_end) = span_of(A_TEXT, "Arthur is a mobile application.");
    let (b_start, b_end) = span_of(B_TEXT, DESKTOP);
    assert_eq!(
        spans(&support.active),
        vec![
            (fx.a.id.clone(), a_start, a_end, "origin".into()),
            (fx.b.id.clone(), b_start, b_end, "asserts".into())
        ]
    );
    assert_eq!(support.active[0].revision_id, r1);
    assert!(support.historical.is_empty() && support.withdrawn.is_empty());
    assert_eq!(
        support.attribution,
        Attribution::ContributingSpans {
            inherited_demoted: false
        },
        "contributing spans, never a sentence-level claim"
    );
    // the spans resolve to the exact words, in code points
    let text: Vec<char> = B_TEXT.chars().collect();
    assert_eq!(
        text[b_start as usize..b_end as usize]
            .iter()
            .collect::<String>(),
        DESKTOP
    );
}

#[test]
fn an_original_revision_is_supported_by_its_own_span_and_is_not_synthesized() {
    let fx = fx();
    let support = fx
        .store
        .evidence_support(&current(&fx.store, &fx.mobile))
        .unwrap();
    assert_eq!(
        (
            support.synthesized,
            support.attribution.clone(),
            support.active.len(),
            support.active[0].role.as_str()
        ),
        (false, Attribution::OriginSpan, 1, "origin")
    );
}

// --- corrections and replacements ------------------------------------------------------------------------------------------------

#[test]
fn a_correction_naming_what_it_withdraws_moves_exactly_that_evidence_out_of_the_active_set() {
    let fx = fx();
    let r2 = r2(&fx);
    let b_row = fx.store.revision_evidence(&r2.id).unwrap().remove(0);
    let c = fx
        .store
        .create(CreateCaptureInput {
            source: "text".into(),
            content: "Correction: no desktop for now, tablets first.".into(),
            project_id: None,
        })
        .unwrap();
    fx.store.record_distillation(&c.id, vec![]).unwrap();
    let r3 = auto(
        &fx,
        "Arthur is a mobile application; tablets come before desktop.",
    );
    fx.store
        .attach_revision_evidence(
            &r3.id,
            &[ev(
                &c.id,
                "Correction: no desktop for now, tablets first.",
                "no desktop for now, tablets first",
                EvidenceRole::Corrects,
                Some((r2.id.clone(), b_row.ordinal.unwrap())),
            )],
        )
        .unwrap();

    let now = fx.store.evidence_support(&r3.id).unwrap();

    assert_eq!(
        now.active
            .iter()
            .map(|e| (e.capture_id.as_str(), e.role.as_str()))
            .collect::<Vec<_>>(),
        vec![(fx.a.id.as_str(), "origin"), (c.id.as_str(), "corrects")]
    );
    assert_eq!(now.withdrawn.len(), 1);
    assert_eq!(
        (
            now.withdrawn[0].0.capture_id.clone(),
            now.withdrawn[0].1 .0.clone()
        ),
        (fx.b.id.clone(), r3.id.clone())
    );
    assert!(
        now.historical.is_empty(),
        "withdrawn evidence is not also reported as history"
    );
    assert_eq!(
        now.attribution,
        Attribution::ContributingSpans {
            inherited_demoted: false
        }
    );
    // History is unchanged: revision 2 still shows B as its own support.
    let before = fx.store.evidence_support(&r2.id).unwrap();
    assert!(before.active.iter().any(|e| e.capture_id == fx.b.id) && before.withdrawn.is_empty());
}

#[test]
fn a_replacement_that_cannot_name_its_target_demotes_everything_inherited_to_history_and_says_so() {
    let fx = fx();
    let r2 = r2(&fx);
    let c = fx
        .store
        .create(CreateCaptureInput {
            source: "text".into(),
            content: "Instead of mobile first we go desktop first.".into(),
            project_id: None,
        })
        .unwrap();
    fx.store.record_distillation(&c.id, vec![]).unwrap();
    let r3 = auto(&fx, "Arthur goes desktop first.");
    fx.store
        .attach_revision_evidence(
            &r3.id,
            &[ev(
                &c.id,
                "Instead of mobile first we go desktop first.",
                "Instead of mobile first we go desktop first",
                EvidenceRole::Replaces,
                None,
            )],
        )
        .unwrap();

    let support = fx.store.evidence_support(&r3.id).unwrap();

    assert_eq!(
        support
            .active
            .iter()
            .map(|e| e.capture_id.as_str())
            .collect::<Vec<_>>(),
        vec![c.id.as_str()],
        "only the replacing evidence supports the current text"
    );
    assert!(
        support.withdrawn.is_empty(),
        "nothing is claimed as provably withdrawn"
    );
    assert_eq!(
        support.historical.len(),
        2,
        "the origin span and B are history, not support"
    );
    assert_eq!(
        support.attribution,
        Attribution::ContributingSpans {
            inherited_demoted: true
        }
    );
    let _ = r2;
}

#[test]
fn a_correction_may_only_withdraw_provable_earlier_evidence_of_the_same_line() {
    let fx = fx();
    let r2 = r2(&fx);
    let b_row = fx.store.revision_evidence(&r2.id).unwrap().remove(0);
    let ret = |r: &Revision, target: (String, i64)| {
        fx.store.attach_revision_evidence(
            &r.id,
            &[ev(
                &fx.b.id,
                B_TEXT,
                "Нещо друго.",
                EvidenceRole::Corrects,
                Some(target),
            )],
        )
    };

    // evidence of ANOTHER object's revision
    let other = fx
        .store
        .update_object(
            &fx.voice.id,
            Changes {
                body: Some("Arthur needs voice recognition, offline.".into()),
                ..Changes::default()
            },
        )
        .unwrap();
    let other_auto = {
        let base = current(&fx.store, &fx.voice);
        let r = fx
            .store
            .revise_if_current(
                &ExpectedRevision {
                    object_id: &fx.voice.id,
                    project_id: &fx.voice.project_id,
                    base_revision_id: &base,
                },
                RevisionContent {
                    kind: "idea".into(),
                    title: "Voice".into(),
                    body: "Arthur needs offline voice recognition.".into(),
                },
                CasOrigin::System,
            )
            .unwrap();
        fx.store
            .attach_revision_evidence(
                &r.id,
                &[ev(
                    &fx.b.id,
                    B_TEXT,
                    "Arthur ще работи",
                    EvidenceRole::Asserts,
                    None,
                )],
            )
            .unwrap()
    };
    let r3 = auto(
        &fx,
        "Arthur is a mobile and desktop application, plus tablets.",
    );
    assert!(
        ret(&r3, (other.id.clone(), other_auto[0].ordinal.unwrap())).is_err(),
        "another object's evidence"
    );
    assert!(
        ret(&r3, ("no-such-revision".into(), 0)).is_err(),
        "an unknown revision"
    );
    assert!(ret(&r3, (r2.id.clone(), 99)).is_err(), "an unknown ordinal");
    assert!(ret(&r3, (r3.id.clone(), 0)).is_err(), "itself");
    // `asserts` may not name a target, and a correction must be able to name one only if it exists
    assert!(fx
        .store
        .attach_revision_evidence(
            &r3.id,
            &[ev(
                &fx.b.id,
                B_TEXT,
                "Нещо друго.",
                EvidenceRole::Asserts,
                Some((r2.id.clone(), b_row.ordinal.unwrap()))
            )]
        )
        .is_err());
    assert_eq!(count(&fx.store, "SELECT count(*) FROM revision_evidence WHERE revision_id = (SELECT id FROM thought_revisions WHERE body LIKE '%plus tablets%')"), 0);
    assert!(ret(&r3, (r2.id.clone(), b_row.ordinal.unwrap())).is_ok());
}

// --- user ownership ------------------------------------------------------------------------------------------------------------------

#[test]
fn text_written_by_the_user_is_not_claimed_to_rest_on_any_capture() {
    let fx = fx();
    let r2 = r2(&fx);
    let edit = fx
        .store
        .update_object(
            &fx.mobile.id,
            Changes {
                body: Some("Arthur is a mobile app first; desktop later.".into()),
                ..Changes::default()
            },
        )
        .unwrap();
    let support = fx.store.evidence_support(&edit.id).unwrap();
    assert!(!support.synthesized);
    assert!(
        support.active.is_empty(),
        "the person's words are not support-by-capture"
    );
    assert!(matches!(support.attribution, Attribution::Unknown(_)));
    assert_eq!(
        support.historical.len(),
        2,
        "everything stays visible as history"
    );

    // an automatic revision on top of a user edit: only its own evidence is active, and the attribution stays unknown
    let c = fx
        .store
        .create(CreateCaptureInput {
            source: "text".into(),
            content: "Also a web client.".into(),
            project_id: None,
        })
        .unwrap();
    fx.store.record_distillation(&c.id, vec![]).unwrap();
    let base = current(&fx.store, &fx.mobile);
    let r4 = fx
        .store
        .revise_if_current(
            &ExpectedRevision {
                object_id: &fx.mobile.id,
                project_id: &fx.mobile.project_id,
                base_revision_id: &base,
            },
            RevisionContent {
                kind: "idea".into(),
                title: "Mobile".into(),
                body: "Arthur is a mobile app first; desktop and web later.".into(),
            },
            CasOrigin::System,
        )
        .unwrap();
    fx.store
        .attach_revision_evidence(
            &r4.id,
            &[ev(
                &c.id,
                "Also a web client.",
                "a web client",
                EvidenceRole::Asserts,
                None,
            )],
        )
        .unwrap();
    let s4 = fx.store.evidence_support(&r4.id).unwrap();
    assert_eq!(
        s4.active
            .iter()
            .map(|e| e.capture_id.as_str())
            .collect::<Vec<_>>(),
        vec![c.id.as_str()]
    );
    assert!(matches!(s4.attribution, Attribution::Unknown(_)));
    assert!(
        s4.historical.iter().any(|e| e.capture_id == fx.b.id),
        "B is history here"
    );
    let _ = r2;
}

#[test]
fn an_automatic_revision_without_evidence_claims_no_support() {
    let fx = fx();
    let bare = auto(&fx, "Arthur is a mobile application, bare.");
    let support = fx.store.evidence_support(&bare.id).unwrap();
    assert!(support.synthesized && support.active.is_empty());
    assert!(matches!(support.attribution, Attribution::Unknown(_)));
    assert_eq!(support.historical.len(), 1);
}

#[test]
fn a_branch_does_not_leak_evidence_into_another_revision() {
    let fx = fx();
    let r1 = current(&fx.store, &fx.mobile);
    let _r2 = r2(&fx);
    let branch = fx
        .store
        .create_revision_from(
            &fx.mobile.id,
            &r1,
            Changes {
                body: Some("A side branch.".into()),
                ..Changes::default()
            },
            false,
        )
        .unwrap();
    let support = fx.store.evidence_support(&branch.id).unwrap();
    assert!(
        support.historical.iter().all(|e| e.capture_id != fx.b.id),
        "B belongs to the other line"
    );
}

// --- integrity ------------------------------------------------------------------------------------------------------------------------

#[test]
fn evidence_is_append_only() {
    let fx = fx();
    let _r2 = r2(&fx);
    assert!(sql(&fx.store, "UPDATE revision_evidence SET role = 'replaces'").is_err());
    assert!(sql(
        &fx.store,
        "UPDATE revision_evidence SET source_end = source_end - 1"
    )
    .is_err());
    assert!(sql(&fx.store, "DELETE FROM revision_evidence").is_err());
    assert_eq!(
        count(&fx.store, "SELECT count(*) FROM revision_evidence"),
        1
    );
}

#[test]
fn evidence_cannot_reference_unrelated_incompatible_or_missing_things() {
    let fx = fx();
    let r2 = r2(&fx);
    let attach = |revision: &str, evidence: NewEvidence| {
        fx.store.attach_revision_evidence(revision, &[evidence])
    };
    let good = ev(&fx.b.id, B_TEXT, "Нещо друго.", EvidenceRole::Asserts, None);
    assert!(attach(&r2.id, good.clone()).is_ok());
    assert!(
        matches!(
            attach("ghost", good.clone()),
            Err(IdentityStoreError::Store(_))
        ),
        "a revision that was never committed"
    );
    assert!(matches!(
        attach(
            &r2.id,
            NewEvidence {
                capture_id: "ghost".into(),
                ..good.clone()
            }
        ),
        Err(IdentityStoreError::Invalid(_))
    ));
    let length = B_TEXT.chars().count() as i64;
    assert!(
        attach(
            &r2.id,
            NewEvidence {
                source_start: length - 3,
                source_end: length + 1,
                ..good.clone()
            }
        )
        .is_err(),
        "past the end, counted in code points"
    );
    assert!(
        attach(
            &r2.id,
            NewEvidence {
                source_start: 4,
                source_end: 4,
                ..good.clone()
            }
        )
        .is_err(),
        "empty"
    );
    assert!(
        attach(
            &r2.id,
            NewEvidence {
                source_start: -1,
                source_end: 3,
                ..good.clone()
            }
        )
        .is_err(),
        "negative"
    );
    assert!(fx.store.attach_revision_evidence(&r2.id, &[]).is_err());

    // only automatic revisions take evidence
    let initial = current(&fx.store, &fx.voice);
    assert!(
        attach(&initial, good.clone()).is_err(),
        "an initial revision keeps its own span"
    );
    let user = fx
        .store
        .update_object(
            &fx.voice.id,
            Changes {
                body: Some("Voice, by me.".into()),
                ..Changes::default()
            },
        )
        .unwrap();
    assert!(
        attach(&user.id, good.clone()).is_err(),
        "a user edit claims no capture"
    );

    // a revision that history has moved on from is closed
    let _next = fx
        .store
        .update_object(
            &fx.mobile.id,
            Changes {
                body: Some("moved on".into()),
                ..Changes::default()
            },
        )
        .unwrap();
    assert!(
        attach(
            &r2.id,
            ev(
                &fx.b.id,
                B_TEXT,
                "Arthur ще работи",
                EvidenceRole::Asserts,
                None
            )
        )
        .is_err(),
        "a revision with descendants cannot gain evidence"
    );

    // a capture of another project is not evidence for this object
    let nexus = fx.store.create_project("Nexus").unwrap();
    let foreign = fx
        .store
        .create(CreateCaptureInput {
            source: "text".into(),
            content: "Foreign words here.".into(),
            project_id: Some(nexus.id),
        })
        .unwrap();
    let r_voice = {
        let base = current(&fx.store, &fx.voice);
        fx.store
            .revise_if_current(
                &ExpectedRevision {
                    object_id: &fx.voice.id,
                    project_id: &fx.voice.project_id,
                    base_revision_id: &base,
                },
                RevisionContent {
                    kind: "idea".into(),
                    title: "Voice".into(),
                    body: "Voice, automatic.".into(),
                },
                CasOrigin::System,
            )
            .unwrap()
    };
    assert!(matches!(
        attach(
            &r_voice.id,
            ev(
                &foreign.id,
                "Foreign words here.",
                "Foreign",
                EvidenceRole::Asserts,
                None
            )
        ),
        Err(IdentityStoreError::Conflict(_))
    ));
}

#[test]
fn the_schema_enforces_the_same_rules_without_the_rust_api() {
    let fx = fx();
    let r2 = r2(&fx);
    let insert = |extra_cols: &str,
                  extra_vals: &str,
                  ordinal: i64,
                  end: i64,
                  role: &str,
                  object: &str| {
        sql(&fx.store, &format!("INSERT INTO revision_evidence (revision_id, ordinal, object_id, capture_id, source_start, source_end, role, created_at{extra_cols}) VALUES ('{}', {ordinal}, '{object}', '{}', 0, {end}, '{role}', 'now'{extra_vals})", r2.id, fx.b.id))
    };
    assert!(
        insert("", "", 5, 3, "supports", &fx.mobile.id).is_err(),
        "an unknown role"
    );
    assert!(
        insert("", "", 5, 3, "asserts", &fx.voice.id).is_err(),
        "the wrong object for the revision"
    );
    assert!(
        insert(
            "",
            "",
            5,
            B_TEXT.chars().count() as i64 + 1,
            "asserts",
            &fx.mobile.id
        )
        .is_err(),
        "a span past the capture (SQLite length() counts characters)"
    );
    assert!(
        insert(
            ", retracts_revision_id",
            ", 'x'",
            5,
            3,
            "corrects",
            &fx.mobile.id
        )
        .is_err(),
        "a half-specified target"
    );
    assert!(
        insert(
            "",
            "",
            5,
            B_TEXT.chars().count() as i64,
            "asserts",
            &fx.mobile.id
        )
        .is_ok(),
        "ending exactly at the last code point is fine"
    );
}

#[test]
fn re_attaching_the_same_evidence_is_idempotent_and_a_different_claim_for_a_span_is_not() {
    let fx = fx();
    let r2 = r2(&fx);
    let again = fx
        .store
        .attach_revision_evidence(
            &r2.id,
            &[ev(&fx.b.id, B_TEXT, DESKTOP, EvidenceRole::Asserts, None)],
        )
        .unwrap();
    assert_eq!(
        (
            again.len(),
            count(&fx.store, "SELECT count(*) FROM revision_evidence")
        ),
        (1, 1)
    );
    assert!(matches!(
        fx.store.attach_revision_evidence(
            &r2.id,
            &[ev(&fx.b.id, B_TEXT, DESKTOP, EvidenceRole::Replaces, None)]
        ),
        Err(IdentityStoreError::Conflict(_))
    ));
}

#[test]
fn spans_are_counted_in_code_points_for_bulgarian_english_and_emoji_text() {
    let fx = fx();
    let mixed = "Здравей 😀 свят, Arthur работи offline. Ще го сменим вместо Postgres.";
    let c = fx
        .store
        .create(CreateCaptureInput {
            source: "voice".into(),
            content: mixed.into(),
            project_id: None,
        })
        .unwrap();
    fx.store.record_distillation(&c.id, vec![]).unwrap();
    let r = auto(&fx, "Arthur is a mobile application that works offline.");
    for needle in [
        "Здравей 😀 свят",
        "Arthur работи offline",
        "вместо Postgres.",
    ] {
        let item = ev(&c.id, mixed, needle, EvidenceRole::Asserts, None);
        let stored = fx
            .store
            .attach_revision_evidence(&r.id, &[item.clone()])
            .unwrap();
        let chars: Vec<char> = mixed.chars().collect();
        assert_eq!(
            chars[stored[0].source_start as usize..stored[0].source_end as usize]
                .iter()
                .collect::<String>(),
            needle
        );
        assert!(
            mixed.len() as i64 > mixed.chars().count() as i64,
            "bytes differ from code points in this text"
        );
    }
    assert_eq!(
        count(&fx.store, "SELECT count(*) FROM revision_evidence"),
        3
    );
    // the very last code point is allowed, one more is not (a byte-counting implementation would get this wrong)
    let last = mixed.chars().count() as i64;
    assert!(sql(&fx.store, &format!("INSERT INTO revision_evidence (revision_id, ordinal, object_id, capture_id, source_start, source_end, role, created_at) VALUES ('{}', 9, '{}', '{}', {}, {}, 'asserts', 'now')", r.id, fx.mobile.id, c.id, last - 1, last + 1)).is_err());
}

#[test]
fn existing_graph_lineage_and_search_are_unaffected_by_evidence() {
    use super::relation_store::NewRelation;
    let fx = fx();
    fx.store
        .create_relation(
            NewRelation {
                kind: "extends".into(),
                source_object_id: fx.voice.id.clone(),
                target_object_id: fx.mobile.id.clone(),
            },
            "user",
        )
        .unwrap();
    fx.store
        .create_relation(
            NewRelation {
                kind: "related_to".into(),
                source_object_id: fx.mobile.id.clone().min(fx.voice.id.clone()),
                target_object_id: fx.mobile.id.clone().max(fx.voice.id.clone()),
            },
            "model",
        )
        .unwrap();
    let relations = fx.store.list_relations().unwrap();
    let r2 = r2(&fx);
    assert_eq!(
        fx.store.list_relations().unwrap(),
        relations,
        "relations and their owners are untouched"
    );
    let lineage = fx.store.object_lineage(&fx.mobile.id).unwrap();
    assert_eq!(
        (lineage.current_revision_id, lineage.revisions.len()),
        (r2.id, 2)
    );
    fx.store.recall_check_lexical_index().unwrap();
    assert_eq!(
        fx.store.recall_indexed_revision_count().unwrap(),
        count(&fx.store, "SELECT count(*) FROM thought_revisions")
    );
    let _ = (
        NewKnowledgeObject {
            kind: String::new(),
            title: String::new(),
            body: String::new(),
            source_start: 0,
            source_end: 1,
        },
        CaptureStore::open_in_memory().is_ok(),
    );
}
