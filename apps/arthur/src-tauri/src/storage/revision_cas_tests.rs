//! Compare-and-set revisions (M04.7B Phase 1): conflicts, rollback, concurrency, and the lineage invariants they must keep.

use std::sync::{Arc, Barrier};
use std::thread;

use super::capture_store::{Capture, CaptureStore, CreateCaptureInput};
use super::knowledge_store::{KnowledgeObject, NewKnowledgeObject};
use super::lineage_store::{
    CasOrigin, Changes, ExpectedRevision, ReviseConflict, Revision, RevisionContent,
    MAX_REVISIONS_PER_OBJECT,
};
use super::migrations::INBOX_PROJECT_ID;
use super::relation_store::NewRelation;

const TEXT: &str = "Arthur is a mobile app. Arthur needs voice recognition.";

fn setup() -> (CaptureStore, Capture, KnowledgeObject, KnowledgeObject) {
    let store = CaptureStore::open_in_memory().unwrap();
    let capture = store
        .create(CreateCaptureInput {
            source: "text".into(),
            content: TEXT.into(),
            project_id: None,
        })
        .unwrap();
    let mut objects = store
        .record_distillation(
            &capture.id,
            vec![
                NewKnowledgeObject {
                    kind: "idea".into(),
                    title: "Mobile".into(),
                    body: "Arthur is a mobile app.".into(),
                    source_start: 0,
                    source_end: 23,
                },
                NewKnowledgeObject {
                    kind: "idea".into(),
                    title: "Voice".into(),
                    body: "Arthur needs voice recognition.".into(),
                    source_start: 24,
                    source_end: 55,
                },
            ],
        )
        .unwrap();
    let second = objects.remove(1);
    (store, capture, objects.remove(0), second)
}

fn content(text: &str) -> RevisionContent {
    RevisionContent {
        kind: "idea".into(),
        title: "Mobile".into(),
        body: text.into(),
    }
}

fn current(store: &CaptureStore, object: &KnowledgeObject) -> String {
    store
        .object_lineage(&object.id)
        .unwrap()
        .current_revision_id
}

fn expect<'a>(object: &'a KnowledgeObject, base: &'a str) -> ExpectedRevision<'a> {
    ExpectedRevision {
        object_id: &object.id,
        project_id: &object.project_id,
        base_revision_id: base,
    }
}

fn count(store: &CaptureStore, sql: &str) -> i64 {
    store
        .connection
        .lock()
        .unwrap()
        .query_row(sql, [], |row| row.get(0))
        .unwrap()
}

fn user_edit(store: &CaptureStore, object: &KnowledgeObject, text: &str) -> Revision {
    store
        .update_object(
            &object.id,
            Changes {
                body: Some(text.into()),
                ..Changes::default()
            },
        )
        .unwrap()
}

// --- success -------------------------------------------------------------------------------------------------------------

#[test]
fn a_matching_snapshot_creates_an_immutable_child_and_moves_the_projection_atomically() {
    let (store, capture, object, _) = setup();
    let r1 = current(&store, &object);

    let r2 = store
        .revise_if_current(
            &expect(&object, &r1),
            content("Arthur is a mobile and desktop app."),
            CasOrigin::System,
        )
        .unwrap();

    assert_eq!(
        (
            r2.origin.as_str(),
            r2.parent_revision_ids.clone(),
            r2.object_id.as_str()
        ),
        ("system", vec![r1.clone()], object.id.as_str())
    );
    assert_eq!(
        r2.provenance, None,
        "no capture span is invented for synthesized text"
    );
    let lineage = store.object_lineage(&object.id).unwrap();
    assert_eq!(lineage.current_revision_id, r2.id);
    assert_eq!(lineage.revisions.len(), 2);
    let r1_row = store.get_revision(&r1).unwrap();
    assert_eq!(
        (r1_row.origin.as_str(), r1_row.body.as_str()),
        ("initial", "Arthur is a mobile app."),
        "revision 1 is preserved"
    );
    assert!(r1_row.provenance.is_some(), "and keeps its provenance");
    let listed = store
        .list_knowledge_objects()
        .unwrap()
        .into_iter()
        .find(|o| o.id == object.id)
        .unwrap();
    assert_eq!(listed.body, "Arthur is a mobile and desktop app.");
    assert_eq!(
        listed.provenance, object.provenance,
        "the object's original source mapping is untouched"
    );
    assert_eq!(
        store.get_capture(&capture.id).unwrap(),
        Some(capture),
        "the capture is untouched"
    );
}

#[test]
fn a_user_attributed_cas_edit_uses_the_user_origin() {
    let (store, _, object, _) = setup();
    let r2 = store
        .revise_if_current(
            &expect(&object, &current(&store, &object)),
            content("Changed."),
            CasOrigin::UserEdit,
        )
        .unwrap();
    assert_eq!(r2.origin, "user_edit");
}

// --- conflicts -----------------------------------------------------------------------------------------------------------

#[test]
fn a_concurrent_user_edit_makes_the_automatic_revision_a_conflict_not_an_overwrite() {
    let (store, _, object, _) = setup();
    let r1 = current(&store, &object);
    let edited = user_edit(&store, &object, "Arthur is a mobile app, by me.");

    let result = store.revise_if_current(
        &expect(&object, &r1),
        content("Arthur is a mobile and desktop app."),
        CasOrigin::System,
    );

    assert!(
        matches!(&result, Err(ReviseConflict::Stale { expected, actual }) if expected == &r1 && actual == &edited.id),
        "{result:?}"
    );
    assert_eq!(
        current(&store, &object),
        edited.id,
        "the user's revision is still current"
    );
    assert_eq!(
        store.object_lineage(&object.id).unwrap().revisions.len(),
        2,
        "nothing was added"
    );
}

#[test]
fn repeating_the_same_attempt_conflicts_the_second_time() {
    let (store, _, object, _) = setup();
    let r1 = current(&store, &object);
    let first = store
        .revise_if_current(
            &expect(&object, &r1),
            content("Arthur is mobile and desktop."),
            CasOrigin::System,
        )
        .unwrap();
    let again = store.revise_if_current(
        &expect(&object, &r1),
        content("Arthur is mobile and desktop."),
        CasOrigin::System,
    );
    assert!(matches!(again, Err(ReviseConflict::Stale { .. })));
    assert_eq!(store.object_lineage(&object.id).unwrap().revisions.len(), 2);
    assert_eq!(current(&store, &object), first.id);
}

#[test]
fn an_older_branch_head_or_another_objects_revision_is_never_a_valid_base() {
    let (store, _, object, other) = setup();
    let r1 = current(&store, &object);
    let branch = store
        .create_revision_from(
            &object.id,
            &r1,
            Changes {
                body: Some("A side branch.".into()),
                ..Changes::default()
            },
            false,
        )
        .unwrap();
    assert!(
        matches!(
            store.revise_if_current(
                &expect(&object, &branch.id),
                content("x"),
                CasOrigin::System
            ),
            Err(ReviseConflict::Stale { .. })
        ),
        "a non-current branch is stale"
    );
    let foreign = current(&store, &other);
    assert!(matches!(
        store.revise_if_current(&expect(&object, &foreign), content("x"), CasOrigin::System),
        Err(ReviseConflict::Stale { .. })
    ));
    assert!(matches!(
        store.revise_if_current(
            &expect(&object, "no-such-revision"),
            content("x"),
            CasOrigin::System
        ),
        Err(ReviseConflict::Stale { .. })
    ));
    assert_eq!(current(&store, &object), r1);
}

#[test]
fn a_changed_project_a_missing_object_and_an_archived_project_are_refused() {
    let (store, _, object, _) = setup();
    let r1 = current(&store, &object);
    let nexus = store.create_project("Nexus").unwrap();

    let wrong = ExpectedRevision {
        object_id: &object.id,
        project_id: &nexus.id,
        base_revision_id: &r1,
    };
    assert!(
        matches!(store.revise_if_current(&wrong, content("x"), CasOrigin::System), Err(ReviseConflict::ProjectMismatch { actual }) if actual == INBOX_PROJECT_ID)
    );
    let ghost = ExpectedRevision {
        object_id: "ghost",
        project_id: INBOX_PROJECT_ID,
        base_revision_id: &r1,
    };
    assert!(matches!(
        store.revise_if_current(&ghost, content("x"), CasOrigin::System),
        Err(ReviseConflict::ObjectNotFound)
    ));

    // moved while the decision was in flight: the decision was made for Inbox
    store.move_knowledge_object(&object.id, &nexus.id).unwrap();
    assert!(matches!(
        store.revise_if_current(
            &expect(
                &KnowledgeObject {
                    project_id: INBOX_PROJECT_ID.into(),
                    ..object.clone()
                },
                &r1
            ),
            content("x"),
            CasOrigin::System
        ),
        Err(ReviseConflict::ProjectMismatch { .. })
    ));

    // archived
    store.archive_project(&nexus.id).unwrap();
    let in_nexus = ExpectedRevision {
        object_id: &object.id,
        project_id: &nexus.id,
        base_revision_id: &r1,
    };
    assert!(matches!(
        store.revise_if_current(&in_nexus, content("x"), CasOrigin::System),
        Err(ReviseConflict::ProjectArchived)
    ));
    assert_eq!(store.object_lineage(&object.id).unwrap().revisions.len(), 1);
}

#[test]
fn unchanged_empty_and_oversized_content_is_rejected_by_the_existing_lineage_rules() {
    let (store, _, object, _) = setup();
    let r1 = current(&store, &object);
    let rejected = [
        content("Arthur is a mobile app."),
        content("  "),
        RevisionContent {
            kind: "idea".into(),
            title: "   ".into(),
            body: "x".into(),
        },
        RevisionContent {
            kind: "gizmo".into(),
            title: "t".into(),
            body: "x".into(),
        },
        content(&"x".repeat(2_001)),
    ];
    for bad in rejected {
        assert!(matches!(
            store.revise_if_current(&expect(&object, &r1), bad, CasOrigin::System),
            Err(ReviseConflict::Rejected(_))
        ));
    }
    assert_eq!(store.object_lineage(&object.id).unwrap().revisions.len(), 1);
}

#[test]
fn the_per_object_revision_limit_still_applies() {
    let (store, _, object, _) = setup();
    for n in 1..MAX_REVISIONS_PER_OBJECT {
        let base = current(&store, &object);
        store
            .revise_if_current(
                &expect(&object, &base),
                content(&format!("version {n}")),
                CasOrigin::System,
            )
            .unwrap();
    }
    let base = current(&store, &object);
    assert!(
        matches!(store.revise_if_current(&expect(&object, &base), content("one too many"), CasOrigin::System), Err(ReviseConflict::Rejected(reason)) if reason.contains("at most"))
    );
    assert_eq!(
        store.object_lineage(&object.id).unwrap().revisions.len(),
        MAX_REVISIONS_PER_OBJECT
    );
}

// --- rollback ------------------------------------------------------------------------------------------------------------

#[test]
fn a_failure_at_any_write_step_rolls_everything_back() {
    for poison in [
        "CREATE TRIGGER poison BEFORE INSERT ON revision_parents BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        "CREATE TRIGGER poison BEFORE UPDATE ON knowledge_objects BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        "CREATE TRIGGER poison AFTER INSERT ON thought_revisions BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    ] {
        let (store, _, object, _) = setup();
        let r1 = current(&store, &object);
        let before = (count(&store, "SELECT count(*) FROM thought_revisions"), count(&store, "SELECT count(*) FROM revision_parents"), store.object_lineage(&object.id).unwrap());
        store.execute_sql_for_test(poison);

        let result = store.revise_if_current(&expect(&object, &r1), content("never"), CasOrigin::System);

        assert!(matches!(result, Err(ReviseConflict::Store(_))), "{poison}: {result:?}");
        let after = (count(&store, "SELECT count(*) FROM thought_revisions"), count(&store, "SELECT count(*) FROM revision_parents"), store.object_lineage(&object.id).unwrap());
        assert_eq!(before, after, "{poison}");
        assert_eq!(count(&store, "SELECT count(*) FROM recall_revision_fts WHERE recall_revision_fts MATCH 'never'"), 0, "the lexical index did not see it either");
    }
}

#[test]
fn after_a_rollback_a_retry_with_the_same_base_succeeds() {
    let (store, _, object, _) = setup();
    let r1 = current(&store, &object);
    store.execute_sql_for_test("CREATE TRIGGER poison BEFORE INSERT ON revision_parents BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    assert!(store
        .revise_if_current(&expect(&object, &r1), content("later"), CasOrigin::System)
        .is_err());
    store.execute_sql_for_test("DROP TRIGGER poison");
    assert!(store
        .revise_if_current(&expect(&object, &r1), content("later"), CasOrigin::System)
        .is_ok());
}

// --- concurrency ---------------------------------------------------------------------------------------------------------

#[test]
fn many_threads_racing_from_the_same_base_produce_exactly_one_revision() {
    let (store, _, object, _) = setup();
    let store = Arc::new(store);
    let r1 = current(&store, &object);
    let threads = 12;
    let barrier = Arc::new(Barrier::new(threads));
    let handles: Vec<_> = (0..threads)
        .map(|n| {
            let (store, barrier, object, r1) =
                (store.clone(), barrier.clone(), object.clone(), r1.clone());
            thread::spawn(move || {
                barrier.wait();
                store.revise_if_current(
                    &expect(&object, &r1),
                    content(&format!("candidate {n}")),
                    CasOrigin::System,
                )
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let winners: Vec<&Revision> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
    assert_eq!(winners.len(), 1);
    assert!(results
        .iter()
        .filter(|r| r.is_err())
        .all(|r| matches!(r, Err(ReviseConflict::Stale { .. }))));
    assert_eq!(current(&store, &object), winners[0].id);
    assert_eq!(store.object_lineage(&object.id).unwrap().revisions.len(), 2);
}

#[test]
fn two_connections_to_one_database_cannot_both_win() {
    let directory = std::env::temp_dir().join(format!("arthur-cas-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("arthur.db");
    let first = CaptureStore::open(&path).unwrap();
    let capture = first
        .create(CreateCaptureInput {
            source: "text".into(),
            content: "Arthur is a mobile app.".into(),
            project_id: None,
        })
        .unwrap();
    let object = first
        .record_distillation(
            &capture.id,
            vec![NewKnowledgeObject {
                kind: "idea".into(),
                title: "Mobile".into(),
                body: "Arthur is a mobile app.".into(),
                source_start: 0,
                source_end: 23,
            }],
        )
        .unwrap()
        .remove(0);
    let r1 = current(&first, &object);
    let second = CaptureStore::open(&path).unwrap();

    let barrier = Arc::new(Barrier::new(2));
    let run = |store: CaptureStore, text: &'static str| {
        let (barrier, object, r1) = (barrier.clone(), object.clone(), r1.clone());
        thread::spawn(move || {
            barrier.wait();
            let result =
                store.revise_if_current(&expect(&object, &r1), content(text), CasOrigin::System);
            (store, result)
        })
    };
    let (a, b) = (
        run(first, "from connection one"),
        run(second, "from connection two"),
    );
    let ((first, ra), (_second, rb)) = (a.join().unwrap(), b.join().unwrap());

    assert_eq!(
        [ra.is_ok(), rb.is_ok()].iter().filter(|ok| **ok).count(),
        1,
        "{ra:?} {rb:?}"
    );
    let lineage = first.object_lineage(&object.id).unwrap();
    assert_eq!(lineage.revisions.len(), 2);
    let _ = std::fs::remove_dir_all(&directory);
}

// --- lineage invariants and neighbours -------------------------------------------------------------------------------------

#[test]
fn a_user_correction_right_after_an_automatic_revision_stacks_on_it_and_history_stays_whole() {
    let (store, _, object, _) = setup();
    let r1 = current(&store, &object);
    let auto = store
        .revise_if_current(
            &expect(&object, &r1),
            content("Arthur is a mobile and desktop app."),
            CasOrigin::System,
        )
        .unwrap();
    let fixed = user_edit(
        &store,
        &object,
        "Arthur is a mobile app first; desktop later.",
    );
    assert_eq!(fixed.parent_revision_ids, vec![auto.id.clone()]);
    assert!(matches!(
        store.revise_if_current(
            &expect(&object, &auto.id),
            content("again"),
            CasOrigin::System
        ),
        Err(ReviseConflict::Stale { .. })
    ));
    let lineage = store.object_lineage(&object.id).unwrap();
    assert_eq!(
        lineage
            .revisions
            .iter()
            .map(|r| r.origin.as_str())
            .collect::<Vec<_>>(),
        ["initial", "system", "user_edit"]
    );
}

#[test]
fn the_writer_touches_no_relations_and_no_other_object() {
    let (store, _, object, other) = setup();
    store
        .create_relation(
            NewRelation {
                kind: "extends".into(),
                source_object_id: other.id.clone(),
                target_object_id: object.id.clone(),
            },
            "user",
        )
        .unwrap();
    store
        .create_relation(
            NewRelation {
                kind: "related_to".into(),
                source_object_id: object.id.clone().min(other.id.clone()),
                target_object_id: object.id.clone().max(other.id.clone()),
            },
            "model",
        )
        .unwrap();
    let relations = |store: &CaptureStore| store.list_relations().unwrap();
    let before = (
        relations(&store),
        current(&store, &other),
        store.get_knowledge_object(&other.id).unwrap(),
    );
    let r1 = current(&store, &object);

    store
        .revise_if_current(
            &expect(&object, &r1),
            content("Arthur is a mobile and desktop app."),
            CasOrigin::System,
        )
        .unwrap();

    assert_eq!(
        before,
        (
            relations(&store),
            current(&store, &other),
            store.get_knowledge_object(&other.id).unwrap()
        ),
        "relations (both owners) and the neighbour are exactly as they were"
    );
}

#[test]
fn automatic_connections_stays_off_and_the_writer_has_no_graph_dependency() {
    // The writer returns a Revision and nothing else: the ChangedKnowledge event is a caller's job after commit, and the caller does
    // not exist yet. With Automatic Connections off, even that event would be dropped before any graph work.
    let settings = crate::graph::integration::IntegrationSettings::in_memory(false);
    assert!(!settings.enabled() && !crate::graph::integration::DEFAULT_ENABLED);
    let source = include_str!("lineage_store.rs");
    let writer = &source[source.find("pub fn revise_if_current").unwrap()
        ..source.find("pub fn diff_revisions").unwrap()];
    for word in ["relations", "graph", "notify", "integration"] {
        assert!(!writer.contains(word), "revise_if_current mentions {word}");
    }
}
