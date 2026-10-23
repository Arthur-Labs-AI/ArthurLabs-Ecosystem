use super::storage::JournalKernel;
use super::storage::{Fault, JournalError as J, Stage};
use super::writers::{Result as WResult, WriterError as E, Writers};
use super::{
    codec::{self, EntityKind as K, EventRef, FieldValue, JournalEvent, Operation},
    sql_effects as sql, stream,
};
use crate::storage::{
    capture_store::{CaptureStore, CreateCaptureInput},
    migrations,
};
use crate::storage::{
    integration_store::{IntegrationWrite, ObjectSnapshot},
    knowledge_store::{KnowledgeObject, NewKnowledgeObject},
    lineage_store::{
        CasOrigin, Changes, ExpectedRevision, ReviseConflict, RevisionContent, SourceSpan,
    },
    project_store::ProjectError,
    relation_store::NewRelation,
};
use rusqlite::{params, types::Value};
use std::collections::BTreeMap;

const TEXT: &str = "Идея 🦀 e\u{301} Alpha Beta Gamma";
fn input(project: Option<&str>) -> CreateCaptureInput {
    CreateCaptureInput {
        source: "text".into(),
        content: TEXT.into(),
        project_id: project.map(Into::into),
    }
}
fn candidate(title: &str, start: i64, end: i64) -> NewKnowledgeObject {
    NewKnowledgeObject {
        kind: "idea".into(),
        title: title.into(),
        body: format!("Body {title}"),
        source_start: start,
        source_end: end,
    }
}
fn change(title: &str) -> Changes {
    Changes {
        title: Some(title.into()),
        ..Changes::default()
    }
}
fn content(title: &str) -> RevisionContent {
    RevisionContent {
        kind: "idea".into(),
        title: title.into(),
        body: format!("Body {title}"),
    }
}
fn edge(kind: &str, a: &str, b: &str) -> NewRelation {
    NewRelation {
        kind: kind.into(),
        source_object_id: a.into(),
        target_object_id: b.into(),
    }
}
fn upgrade(s: &CaptureStore) {
    let mut c = s.connection.lock().unwrap();
    let mut steps = migrations::STEPS.to_vec();
    steps.push((10, include_str!("../m05_v10.sql")));
    migrations::migrate_with(&mut c, &steps).unwrap();
}
fn v9_graph(
    n: usize,
) -> (
    CaptureStore,
    crate::storage::capture_store::Capture,
    Vec<KnowledgeObject>,
) {
    let s = CaptureStore::open_in_memory().unwrap();
    let cap = s.create(input(None)).unwrap();
    let objects = s
        .record_distillation(
            &cap.id,
            (0..n)
                .map(|i| candidate(&format!("Object {i}"), 0, 4))
                .collect(),
        )
        .unwrap();
    (s, cap, objects)
}
fn graph(
    n: usize,
) -> (
    CaptureStore,
    crate::storage::capture_store::Capture,
    Vec<KnowledgeObject>,
) {
    let (s, c, o) = v9_graph(n);
    upgrade(&s);
    (s, c, o)
}
fn count(s: &CaptureStore, table: &str) -> i64 {
    s.query_i64_for_test(&format!("SELECT count(*) FROM {table}"))
}
fn snapshot(s: &CaptureStore) -> Vec<(String, Vec<Vec<Value>>)> {
    let c = s.connection.lock().unwrap();
    let names = c
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    names
        .into_iter()
        .map(|name| {
            let n = c
                .prepare(&format!("SELECT * FROM {name}"))
                .unwrap()
                .column_count();
            let order = (1..=n).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
            let mut q = c
                .prepare(&format!("SELECT * FROM {name} ORDER BY {order}"))
                .unwrap();
            let rows = q
                .query_map([], |r| {
                    (0..n)
                        .map(|i| r.get(i))
                        .collect::<rusqlite::Result<Vec<Value>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            (name, rows)
        })
        .collect()
}
fn head(s: &CaptureStore, entity: K, id: &str, facet: &str) -> Option<(String, Vec<u8>)> {
    stream::stored_head(
        &s.connection.lock().unwrap(),
        &(entity, vec![id.into()], facet.into()),
    )
    .unwrap()
}
fn snap(s: &CaptureStore, id: &str) -> ObjectSnapshot {
    ObjectSnapshot {
        object_id: id.into(),
        revision_id: s.current_revision_id_of(id).unwrap().unwrap(),
        project_id: s.project_of_object(id).unwrap().unwrap(),
    }
}

/// Audit every retained core, then compare the latest encoded image/head of
/// each key to actual SQL. Earlier immutable bytes are never rebuilt from today.
fn audit(s: &CaptureStore) -> Vec<JournalEvent> {
    let c = s.connection.lock().unwrap();
    let mut q=c.prepare("SELECT canonical_bytes,canonical_hash,previous_hash,event_id,bundle_id,origin_id,incarnation,origin_seq,raw_effect_count,committed_at FROM sync_bundles ORDER BY rowid").unwrap();
    let mut rows = q.query([]).unwrap();
    let mut cores = Vec::new();
    let mut tips = BTreeMap::new();
    let mut latest = BTreeMap::new();
    let mut heads = BTreeMap::new();
    let mut records = BTreeMap::new();
    while let Some(row) = rows.next().unwrap() {
        let bytes: Vec<u8> = row.get(0).unwrap();
        let core = codec::decode_core_strict(&bytes).unwrap();
        assert_eq!(codec::encode_canonical(&core).unwrap(), bytes);
        let hash = codec::journal_event_hash(&bytes);
        assert_eq!(row.get::<_, Vec<u8>>(1).unwrap(), hash);
        let tip = tips
            .entry((core.origin_id.clone(), core.origin_incarnation.clone()))
            .or_insert((0i64, [0u8; 32]));
        assert_eq!(core.origin_seq, (tip.0 + 1).to_string());
        assert_eq!(core.previous_event_hash, codec::hash_hex(&tip.1));
        assert_eq!(row.get::<_, Vec<u8>>(2).unwrap(), tip.1);
        for (i, expected) in [
            (3, &core.event_id),
            (4, &core.bundle_id),
            (5, &core.origin_id),
            (6, &core.origin_incarnation),
            (9, &core.committed_at),
        ] {
            assert_eq!(&row.get::<_, String>(i).unwrap(), expected);
        }
        assert_eq!(row.get::<_, i64>(7).unwrap().to_string(), core.origin_seq);
        assert_eq!(
            row.get::<_, i64>(8).unwrap().to_string(),
            core.raw_effect_count
        );
        for d in &core.dependencies {
            assert!(sql::reread(&c, d.entity, &d.key).unwrap().is_some());
            if let Some(reference) = &d.event_ref {
                assert_eq!(records.get(&(d.entity, d.key.clone())), Some(reference));
            } else {
                assert!(!records.contains_key(&(d.entity, d.key.clone())));
            }
        }
        let reference = EventRef {
            origin_id: core.origin_id.clone(),
            incarnation: core.origin_incarnation.clone(),
            seq: core.origin_seq.clone(),
            event_id: core.event_id.clone(),
            hash: codec::hash_hex(&hash),
        };
        for op in &core.operations {
            let key = (op.entity(), op.key().to_vec());
            match op {
                Operation::RecordCreate(r) => {
                    assert!(records.insert(key.clone(), reference.clone()).is_none());
                    latest.insert(key, Some(r.after.clone()));
                }
                Operation::FacetUpdate(u) => {
                    for (facet, prior) in &u.expected {
                        assert_eq!(
                            prior.before_hash,
                            codec::hash_hex(
                                &stream::facet_hash(u.entity, &u.key, facet, &u.before).unwrap()
                            )
                        );
                        if let Some(e) = &prior.event_ref {
                            assert_eq!(
                                heads
                                    .get(&(u.entity, u.key.clone(), facet.clone()))
                                    .map(|h: &stream::Head| &h.event),
                                Some(e)
                            );
                        }
                    }
                    latest.insert(key, Some(u.after.clone()));
                }
                Operation::RelationRemove(r) => {
                    assert_eq!(sql::text(&r.before, "origin").unwrap(), "model");
                    if let codec::ObservedCreate::Event(e) = &r.observed_create {
                        assert_eq!(records.get(&key), Some(e));
                    }
                    latest.insert(key, None);
                }
            }
        }
        heads.extend(stream::updates(&core.operations, &reference).unwrap());
        *tip = (tip.0 + 1, hash);
        cores.push(core);
    }
    for ((entity, key), after) in latest {
        assert_eq!(sql::reread(&c, entity, &key).unwrap(), after);
    }
    for (key, expected) in &heads {
        assert_eq!(
            stream::stored_head(&c, key).unwrap(),
            Some((expected.event.event_id.clone(), expected.hash.to_vec()))
        );
    }
    assert_eq!(
        c.query_row("SELECT count(*) FROM sync_entity_heads", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        heads.len() as i64
    );
    assert!(c.is_autocommit());
    assert_eq!(
        c.query_row("SELECT count(*) FROM sync_effects", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM sync_write_context", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(!c
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    assert_eq!(
        c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    cores
}
fn commit<T>(
    s: &CaptureStore,
    k: &JournalKernel<'_>,
    work: impl FnOnce(&mut Writers<'_, '_>) -> WResult<T>,
) -> T {
    let before = count(s, "sync_bundles");
    let (value, observed) = k
        .write(|w| {
            let value = work(w)?;
            Ok((value, w.observed_effect_count()))
        })
        .unwrap();
    let cores = audit(s);
    assert_eq!(cores.len() as i64, before + i64::from(observed > 0));
    if observed > 0 {
        assert_eq!(cores.last().unwrap().raw_effect_count, observed.to_string());
    }
    value
}

fn upgraded() -> CaptureStore {
    let s = CaptureStore::open_in_memory().unwrap();
    {
        let mut c = s.connection.lock().unwrap();
        let mut steps = migrations::STEPS.to_vec();
        steps.push((10, include_str!("../m05_v10.sql")));
        migrations::migrate_with(&mut c, &steps).unwrap();
    }
    s
}

#[test]
fn w02_real_capture_writer_is_available_under_the_dormant_kernel() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let capture = k
        .write(|w| {
            w.create_capture(CreateCaptureInput {
                source: "text".into(),
                content: "Идея 🦀 e\u{301}".into(),
                project_id: None,
            })
        })
        .unwrap();
    assert_eq!(s.get_capture(&capture.id).unwrap(), Some(capture));
    assert_eq!(s.query_i64_for_test("SELECT count(*) FROM sync_bundles"), 1);
}

#[test]
fn w02_capture_preserves_generated_values_validation_projects_and_final_image() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let capture = commit(&s, &k, |w| w.create_capture(input(None)));
    assert_eq!(capture.content, TEXT);
    codec::validate_canonical_uuid(&capture.id).unwrap();
    codec::validate_timestamp(&capture.created_at).unwrap();
    assert_eq!(capture.project_id, migrations::INBOX_PROJECT_ID);
    assert_eq!(s.get_capture(&capture.id).unwrap(), Some(capture.clone()));
    assert!(
        matches!(&audit(&s)[0].operations[0],Operation::RecordCreate(r) if r.key==[capture.id.clone()] && sql::text(&r.after,"content").unwrap()==TEXT)
    );
    for bad in [
        CreateCaptureInput {
            source: "invalid".into(),
            ..input(None)
        },
        CreateCaptureInput {
            content: " \n".into(),
            ..input(None)
        },
        CreateCaptureInput {
            content: "X".repeat(20001),
            ..input(None)
        },
        input(Some("missing")),
    ] {
        let before = snapshot(&s);
        assert!(
            matches!(k.write(|w|w.create_capture(bad)),Err(E::Store(e)) if matches!(e.as_ref(),crate::storage::capture_store::StoreError::Invalid(_)))
        );
        assert_eq!(snapshot(&s), before);
    }
    let p = commit(&s, &k, |w| w.create_project("Capture space"));
    let inherited = commit(&s, &k, |w| w.create_capture(input(Some(&p.id))));
    assert_eq!(inherited.project_id, p.id);
    commit(&s, &k, |w| w.archive_project(&p.id));
    let before = snapshot(&s);
    assert!(
        matches!(k.write(|w|w.create_capture(input(Some(&p.id)))),Err(E::Store(e)) if matches!(e.as_ref(),crate::storage::capture_store::StoreError::Invalid(_)))
    );
    assert_eq!(snapshot(&s), before);
}

#[test]
fn w03_project_lifecycle_has_independent_facets_and_real_idempotence() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let p = commit(&s, &k, |w| w.create_project(" First "));
    assert_eq!(p.name, "First");
    assert_eq!(audit(&s)[0].operations.len(), 1);
    let lifecycle = head(&s, K::Projects, &p.id, "lifecycle");
    commit(&s, &k, |w| w.rename_project(&p.id, "Second"));
    assert_eq!(head(&s, K::Projects, &p.id, "lifecycle"), lifecycle);
    let record = head(&s, K::Projects, &p.id, "record");
    let n = count(&s, "sync_bundles");
    commit(&s, &k, |w| w.rename_project(&p.id, "Second"));
    assert_eq!(count(&s, "sync_bundles"), n);
    commit(&s, &k, |w| w.set_active_project(&p.id));
    assert_eq!(count(&s, "sync_bundles"), n);
    let archived = commit(&s, &k, |w| w.archive_project(&p.id));
    assert!(archived.archived_at.is_some());
    assert_eq!(head(&s, K::Projects, &p.id, "record"), record);
    assert_eq!(s.active_project_id().unwrap(), migrations::INBOX_PROJECT_ID);
    let n = count(&s, "sync_bundles");
    commit(&s, &k, |w| w.archive_project(&p.id));
    assert_eq!(count(&s, "sync_bundles"), n);
    let restored = commit(&s, &k, |w| w.restore_project(&p.id));
    assert!(restored.archived_at.is_none());
    assert_eq!(head(&s, K::Projects, &p.id, "record"), record);
    let n = count(&s, "sync_bundles");
    commit(&s, &k, |w| w.restore_project(&p.id));
    assert_eq!(count(&s, "sync_bundles"), n);
    for result in [
        k.write(|w| w.create_project("second")),
        k.write(|w| w.rename_project(migrations::INBOX_PROJECT_ID, "Changed")),
        k.write(|w| w.archive_project(migrations::INBOX_PROJECT_ID)),
    ] {
        assert!(matches!(
            result,
            Err(E::Project(
                ProjectError::NameTaken | ProjectError::InboxProtected
            ))
        ));
    }
    audit(&s);
}

#[test]
fn w04_membership_changes_preserve_content_provenance_and_unrelated_heads() {
    let (s, cap, o) = graph(1);
    let k = JournalKernel::activate(&s).unwrap();
    let original = s.object_lineage(&o[0].id).unwrap();
    let p = commit(&s, &k, |w| w.create_project("Destination"));
    let moved = commit(&s, &k, |w| w.move_capture(&cap.id, &p.id));
    assert_eq!(
        (&moved.content, &moved.source, &moved.created_at),
        (&cap.content, &cap.source, &cap.created_at)
    );
    assert_eq!(
        s.project_of_object(&o[0].id).unwrap().unwrap(),
        migrations::INBOX_PROJECT_ID
    );
    let before = count(&s, "sync_bundles");
    commit(&s, &k, |w| w.move_capture(&cap.id, &p.id));
    assert_eq!(count(&s, "sync_bundles"), before);
    let old_head = head(&s, K::KnowledgeObjects, &o[0].id, "head");
    let moved = commit(&s, &k, |w| w.move_knowledge_object(&o[0].id, &p.id));
    assert_eq!(moved.provenance, o[0].provenance);
    assert_eq!(s.object_lineage(&o[0].id).unwrap(), original);
    assert_eq!(head(&s, K::KnowledgeObjects, &o[0].id, "head"), old_head);
    let before = count(&s, "sync_bundles");
    commit(&s, &k, |w| w.move_knowledge_object(&o[0].id, &p.id));
    assert_eq!(count(&s, "sync_bundles"), before);
    for result in [
        k.write(|w| w.move_capture(&cap.id, "missing")).map(|_| ()),
        k.write(|w| w.move_knowledge_object("missing", &p.id))
            .map(|_| ()),
    ] {
        assert!(matches!(
            result,
            Err(E::Project(
                ProjectError::ProjectNotFound | ProjectError::ObjectNotFound
            ))
        ));
    }
}

#[test]
fn w05_distillation_one_multiple_zero_repeated_and_full_generated_closure() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    for n in [1, 3, 0] {
        let cap = commit(&s, &k, |w| w.create_capture(input(None)));
        let before = count(&s, "sync_bundles");
        s.record_organization_failure(&cap.id, "storage_failed", "safe")
            .unwrap();
        let mut candidates = (0..n)
            .map(|i| candidate(&format!("Object {i}"), [0, 5, 7][i], [4, 6, 9][i]))
            .collect::<Vec<_>>();
        candidates.reverse();
        let objects = commit(&s, &k, |w| w.record_distillation(&cap.id, candidates));
        assert_eq!(objects.len(), n);
        assert!(objects
            .windows(2)
            .all(|p| p[0].provenance.source_start <= p[1].provenance.source_start));
        assert_eq!(count(&s, "sync_bundles"), before + 1);
        let cores = audit(&s);
        let core = cores.last().unwrap();
        assert_eq!(core.raw_effect_count, (1 + 4 * n).to_string());
        assert_eq!(core.operations.len(), 1 + 3 * n);
        assert!(core
            .operations
            .iter()
            .any(|op| op.entity() == K::DistillationRuns));
        assert!(core.dependencies.iter().any(|d| d.entity == K::Captures
            && d.key == [cap.id.clone()]
            && d.event_ref.is_some()));
        for object in &objects {
            let lineage = s.object_lineage(&object.id).unwrap();
            assert_eq!(lineage.revisions.len(), 1);
            assert_eq!(lineage.revisions[0].created_at, object.created_at);
            assert_eq!(
                lineage.revisions[0].provenance.as_ref(),
                Some(&object.provenance)
            );
            assert_eq!(lineage.current_revision_id, lineage.revisions[0].id);
            assert!(core.operations.iter().any(|op|matches!(op,Operation::RecordCreate(r) if r.entity==K::KnowledgeObjects && sql::text(&r.after,"current_revision_id").unwrap()==lineage.current_revision_id)));
        }
        assert_eq!(count(&s, "organization_failures"), 0);
        let before = snapshot(&s);
        let repeated = commit(&s, &k, |w| w.record_distillation(&cap.id, vec![]));
        assert_eq!(repeated, objects);
        assert_eq!(snapshot(&s), before);
        assert_eq!(s.get_capture(&cap.id).unwrap().unwrap().content, TEXT);
    }
}

#[test]
fn w06_distillation_validation_later_sql_failure_and_finalizer_are_atomic() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let cap = commit(&s, &k, |w| w.create_capture(input(None)));
    for objects in [
        vec![candidate("Invalid", 0, 999)],
        vec![candidate("Valid", 0, 4), candidate("Invalid", -1, 2)],
        vec![candidate("Too many", 0, 4); 13],
    ] {
        let before = snapshot(&s);
        assert!(
            matches!(k.write(|w|w.record_distillation(&cap.id,objects)),Err(E::Store(e)) if matches!(e.as_ref(),crate::storage::capture_store::StoreError::Invalid(_)))
        );
        assert_eq!(snapshot(&s), before);
    }
    s.execute_sql_for_test("CREATE TEMP TRIGGER task11_later_object BEFORE INSERT ON knowledge_objects WHEN NEW.title='Fail second' BEGIN SELECT RAISE(ABORT,'synthetic later insert'); END");
    let before = snapshot(&s);
    assert!(k
        .write(|w| w.record_distillation(
            &cap.id,
            vec![candidate("Valid", 0, 4), candidate("Fail second", 5, 6)]
        ))
        .is_err());
    assert_eq!(snapshot(&s), before);
    s.execute_sql_for_test("DROP TRIGGER task11_later_object");
    let before = snapshot(&s);
    assert!(matches!(
        k.write_fault(Fault::At(Stage::Commit), |w| w
            .record_distillation(&cap.id, vec![candidate("Valid", 0, 4)])),
        Err(E::Journal(J::Injected))
    ));
    assert_eq!(snapshot(&s), before);
    audit(&s);
}

#[test]
fn w07_edit_branches_merge_restore_cas_and_capture_derived_revisions_are_real() {
    let (s, cap, o) = graph(2);
    let k = JournalKernel::activate(&s).unwrap();
    let id = &o[0].id;
    let root = s.object_lineage(id).unwrap().current_revision_id;
    let edit = commit(&s, &k, |w| w.update_object(id, change("Edited")));
    assert_eq!(edit.origin, "user_edit");
    assert_eq!(edit.parent_revision_ids, [root.clone()]);
    assert!(edit.provenance.is_none());
    let current_head = head(&s, K::KnowledgeObjects, id, "head");
    let branch = commit(&s, &k, |w| {
        w.create_revision_from(id, &root, change("Old-base branch"), false)
    });
    assert_eq!(s.current_revision_id_of(id).unwrap().unwrap(), edit.id);
    assert_eq!(head(&s, K::KnowledgeObjects, id, "head"), current_head);
    assert!(branch.provenance.is_none());
    let selected = commit(&s, &k, |w| {
        w.create_revision_from(id, &root, change("Selected branch"), true)
    });
    assert_eq!(s.current_revision_id_of(id).unwrap().unwrap(), selected.id);
    let detached = commit(&s, &k, |w| {
        w.merge_revisions(
            id,
            &[edit.id.clone(), branch.id.clone()],
            content("Detached merge"),
            false,
        )
    });
    assert_eq!(detached.parent_revision_ids.len(), 2);
    assert_eq!(s.current_revision_id_of(id).unwrap().unwrap(), selected.id);
    let merged = commit(&s, &k, |w| {
        w.merge_revisions(
            id,
            &[selected.id.clone(), detached.id.clone()],
            content("Merged"),
            true,
        )
    });
    assert_eq!(merged.origin, "merge");
    assert!(merged.provenance.is_none());
    let restored = commit(&s, &k, |w| w.restore_revision(id, &root, &merged.id));
    assert_ne!(restored.id, root);
    assert_eq!(restored.origin, "merge");
    assert!(restored.parent_revision_ids.contains(&root));
    assert!(restored.parent_revision_ids.contains(&merged.id));
    assert_eq!(restored.title, o[0].title);
    let before = snapshot(&s);
    let stale = ExpectedRevision {
        object_id: id,
        project_id: &o[0].project_id,
        base_revision_id: &merged.id,
    };
    assert!(
        matches!(k.write(|w|w.revise_if_current(&stale,content("Must not write"),CasOrigin::UserEdit)),Err(E::Conflict(e)) if matches!(e.as_ref(),ReviseConflict::Stale{..}))
    );
    assert_eq!(snapshot(&s), before);
    assert!(
        matches!(k.write(|w|w.restore_revision(id,&root,&merged.id)),Err(E::Conflict(e)) if matches!(e.as_ref(),ReviseConflict::Stale{..}))
    );
    assert_eq!(snapshot(&s), before);
    let expected = ExpectedRevision {
        base_revision_id: &restored.id,
        ..stale
    };
    let cas = commit(&s, &k, |w| {
        w.revise_if_current(&expected, content("User CAS"), CasOrigin::UserEdit)
    });
    assert_eq!(cas.parent_revision_ids, [restored.id]);
    let source = commit(&s, &k, |w| w.create_capture(input(None)));
    let derived = commit(&s, &k, |w| {
        w.revise_from_capture(
            id,
            None,
            SourceSpan {
                capture_id: source.id.clone(),
                start: 5,
                end: 6,
            },
            change("Explicit interpretation"),
            true,
        )
    });
    assert_eq!(derived.origin, "distillation");
    let span = derived.provenance.unwrap();
    assert_eq!(
        (span.capture_id, span.source_start, span.source_end),
        (source.id, 5, 6)
    );
    let history = s.object_lineage(id).unwrap();
    assert_eq!(
        history.revisions[0].provenance.as_ref(),
        Some(&o[0].provenance)
    );
    assert_eq!(s.get_capture(&cap.id).unwrap().unwrap(), cap);
    let before = snapshot(&s);
    let other = s.current_revision_id_of(&o[1].id).unwrap().unwrap();
    assert!(k
        .write(|w| w.create_revision_from(id, &other, change("Cross object"), false))
        .is_err());
    assert!(k
        .write(|w| w.merge_revisions(
            id,
            &[root.clone(), root.clone()],
            content("Duplicate parents"),
            true
        ))
        .is_err());
    assert!(k
        .write(|w| w.revise_from_capture(
            id,
            None,
            SourceSpan {
                capture_id: cap.id.clone(),
                start: 0,
                end: 999
            },
            change("Invalid span"),
            true
        ))
        .is_err());
    assert_eq!(snapshot(&s), before);
    audit(&s);
}

#[test]
fn w08_relation_origins_canonicalization_batches_and_actual_noops() {
    let (s, _, o) = graph(3);
    let k = JournalKernel::activate(&s).unwrap();
    let a = &o[0].id;
    let b = &o[1].id;
    for (origin, kind) in [
        ("user", "related_to"),
        ("system", "extends"),
        ("model", "depends_on"),
    ] {
        let r = commit(&s, &k, |w| w.create_relation(edge(kind, b, a), origin));
        assert_eq!(r.origin, origin);
        codec::validate_canonical_uuid(&r.id).unwrap();
        codec::validate_timestamp(&r.created_at).unwrap();
        if kind == "related_to" {
            assert!(r.source_object_id < r.target_object_id);
        } else {
            assert_eq!((&r.source_object_id, &r.target_object_id), (b, a));
        }
        let before = snapshot(&s);
        assert_eq!(
            commit(&s, &k, |w| w.create_relation(edge(kind, b, a), origin)),
            r
        );
        assert_eq!(snapshot(&s), before);
    }
    let rows = commit(&s, &k, |w| {
        w.record_relations(
            vec![edge("extends", a, b), edge("contradicts", a, &o[2].id)],
            "model",
        )
    });
    assert_eq!(rows.len(), 2);
    let before = snapshot(&s);
    assert!(commit(&s, &k, |w| w.record_relations(vec![], "model")).is_empty());
    assert!(commit(&s, &k, |w| w
        .record_relations(vec![edge("extends", a, b)], "model"))
    .is_empty());
    assert_eq!(snapshot(&s), before);
    for bad in [
        vec![edge("duplicates", a, b), edge("duplicates", b, a)],
        vec![edge("invalid", a, b)],
        vec![edge("extends", a, "11111111-1111-4111-8111-111111111111")],
        vec![edge("extends", a, b); 31],
        vec![edge("supersedes", a, a)],
    ] {
        assert!(k.write(|w| w.record_relations(bad, "model")).is_err());
        assert_eq!(snapshot(&s), before);
    }
    assert!(k
        .write(|w| w.create_relation(edge("supersedes", a, b), "invalid"))
        .is_err());
    assert_eq!(snapshot(&s), before);
    audit(&s);
    assert!(k
        .write(|w| {
            let result = w.record_relations(
                vec![edge("supersedes", a, b), edge("invalid", a, b)],
                "user",
            );
            assert!(result.is_err());
            assert_eq!(w.observed_effect_count(), 0);
            result
        })
        .is_err());
    assert_eq!(snapshot(&s), before);
}

#[test]
fn w09_legacy_model_replacement_emits_only_actual_removal_and_nonstale_addition() {
    let (s, _, o) = v9_graph(4);
    let a = &o[0].id;
    let b = &o[1].id;
    let c = &o[2].id;
    let d = &o[3].id;
    let old = s
        .create_relation(edge("related_to", a, b), "model")
        .unwrap();
    let user = s.create_relation(edge("extends", a, b), "user").unwrap();
    let system = s
        .create_relation(edge("contradicts", a, b), "system")
        .unwrap();
    let elsewhere = s
        .create_relation(edge("related_to", c, d), "model")
        .unwrap();
    let stale_edge = s
        .create_relation(edge("related_to", a, c), "model")
        .unwrap();
    let old_image = sql::reread(
        &s.connection.lock().unwrap(),
        K::Relations,
        &[old.id.clone()],
    )
    .unwrap()
    .unwrap();
    let focus = snap(&s, a);
    let context = vec![snap(&s, b), snap(&s, c), snap(&s, d)];
    upgrade(&s);
    let k = JournalKernel::activate(&s).unwrap();
    commit(&s, &k, |w| w.update_object(c, change("Context changed")));
    let write = IntegrationWrite {
        focus: focus.clone(),
        context,
        remove: vec![
            old.id.clone(),
            user.id.clone(),
            system.id.clone(),
            elsewhere.id.clone(),
            stale_edge.id.clone(),
            "11111111-1111-4111-8111-111111111111".into(),
        ],
        add: vec![edge("depends_on", a, b), edge("extends", a, c)],
    };
    let result = commit(&s, &k, |w| w.apply_integration(write.clone()));
    assert_eq!(
        (result.removed, result.added.len(), result.skipped_stale),
        (1, 1, 2)
    );
    let cores = audit(&s);
    let core = cores.last().unwrap();
    assert_eq!(core.raw_effect_count, "2");
    assert_eq!(core.operations.len(), 2);
    assert!(core.operations.iter().any(|op|matches!(op,Operation::RelationRemove(r) if r.before==old_image && matches!(&r.observed_create,codec::ObservedCreate::LegacyHash(h) if h==&codec::hash_hex(&codec::facet_state_hash(K::Relations,"record",&[old.id.clone()],&old_image).unwrap())))));
    for kept in [&user, &system, &elsewhere, &stale_edge] {
        assert!(s.list_relations().unwrap().contains(kept));
    }
    let before = snapshot(&s);
    let repeated = commit(&s, &k, |w| w.apply_integration(write.clone()));
    assert_eq!(
        (
            repeated.removed,
            repeated.added.len(),
            repeated.already_present
        ),
        (0, 0, 1)
    );
    assert_eq!(snapshot(&s), before);
    commit(&s, &k, |w| w.update_object(a, change("Focus changed")));
    let before = snapshot(&s);
    assert!(commit(&s, &k, |w| w.apply_integration(write)).stale);
    assert_eq!(snapshot(&s), before);
}

#[test]
fn w09_modern_removal_uses_immutable_creation_reference_and_retains_tombstone() {
    let (s, _, o) = graph(2);
    let k = JournalKernel::activate(&s).unwrap();
    let a = &o[0].id;
    let b = &o[1].id;
    let old = commit(&s, &k, |w| {
        w.create_relation(edge("related_to", a, b), "model")
    });
    let created = audit(&s)[0].event_id.clone();
    let write = IntegrationWrite {
        focus: snap(&s, a),
        context: vec![snap(&s, b)],
        remove: vec![old.id.clone()],
        add: vec![edge("depends_on", a, b)],
    };
    let result = commit(&s, &k, |w| w.apply_integration(write));
    assert_eq!((result.removed, result.added.len()), (1, 1));
    let cores = audit(&s);
    assert!(cores[1].operations.iter().any(|op|matches!(op,Operation::RelationRemove(r) if matches!(&r.observed_create,codec::ObservedCreate::Event(e) if e.event_id==created))));
    assert!(head(&s, K::Relations, &old.id, "record").is_some());
}

#[test]
fn w09_project_moves_invalidate_focus_or_context_without_intent_only_events() {
    let (s, _, o) = graph(2);
    let k = JournalKernel::activate(&s).unwrap();
    let p = commit(&s, &k, |w| w.create_project("Moved"));
    let write = IntegrationWrite {
        focus: snap(&s, &o[0].id),
        context: vec![snap(&s, &o[1].id)],
        remove: vec![],
        add: vec![edge("extends", &o[0].id, &o[1].id)],
    };
    commit(&s, &k, |w| w.move_knowledge_object(&o[1].id, &p.id));
    let before = snapshot(&s);
    let skipped = commit(&s, &k, |w| w.apply_integration(write.clone()));
    assert_eq!((skipped.added.len(), skipped.skipped_stale), (0, 1));
    assert_eq!(snapshot(&s), before);
    commit(&s, &k, |w| w.move_knowledge_object(&o[0].id, &p.id));
    let before = snapshot(&s);
    assert!(commit(&s, &k, |w| w.apply_integration(write)).stale);
    assert_eq!(snapshot(&s), before);
}

#[test]
fn w10_and_w15_composed_real_writers_have_one_complete_core_and_sequence() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let (p, cap, o, relation) = commit(&s, &k, |w| {
        let p = w.create_project("Composed")?;
        let cap = w.create_capture(input(Some(&p.id)))?;
        let o = w.record_distillation(
            &cap.id,
            vec![candidate("First", 0, 4), candidate("Second", 5, 6)],
        )?;
        let relation = w.create_relation(edge("extends", &o[0].id, &o[1].id), "user")?;
        w.set_active_project(&p.id)?;
        Ok((p, cap, o, relation))
    });
    let cores = audit(&s);
    assert_eq!(cores.len(), 1);
    let core = &cores[0];
    assert_eq!(core.origin_seq, "1");
    assert_eq!(core.raw_effect_count, "12");
    assert_eq!(core.operations.len(), 10);
    assert!(core.dependencies.is_empty());
    assert_eq!(s.active_project_id().unwrap(), p.id);
    assert_eq!(s.get_capture(&cap.id).unwrap(), Some(cap));
    assert!(s.list_relations().unwrap().contains(&relation));
    for object in o {
        assert_eq!(s.get_knowledge_object(&object.id).unwrap(), Some(object));
    }
}

#[test]
fn w11_local_preference_false_result_timestamp_and_net_zero_use_actual_effects() {
    let (s, cap, _) = v9_graph(1);
    let p = s.create_project("Before").unwrap();
    s.execute_sql_for_test(&format!(
        "UPDATE projects SET updated_at='1970-01-01T00:00:00Z' WHERE id='{}'",
        p.id
    ));
    upgrade(&s);
    let k = JournalKernel::activate(&s).unwrap();
    assert!(!commit(&s, &k, |w| {
        w.rename_project(&p.id, "After")?;
        Ok(false)
    }));
    let core = audit(&s).pop().unwrap();
    assert!(
        matches!(&core.operations[0],Operation::FacetUpdate(u) if sql::text(&u.before,"updated_at").unwrap()=="1970-01-01T00:00:00Z" && u.before.get("updated_at")!=u.after.get("updated_at"))
    );
    let n = count(&s, "sync_bundles");
    commit(&s, &k, |w| w.set_active_project(&p.id));
    assert_eq!(count(&s, "sync_bundles"), n);
    let before = snapshot(&s);
    assert!(matches!(
        k.write(|w| {
            w.move_capture(&cap.id, &p.id)?;
            w.move_capture(&cap.id, migrations::INBOX_PROJECT_ID)?;
            Ok(())
        }),
        Err(E::Journal(J::UnsupportedEffects))
    ));
    assert_eq!(snapshot(&s), before);
    assert!(matches!(
        k.write(|w| w.set_active_project("missing")),
        Err(E::Project(ProjectError::ProjectNotFound))
    ));
    assert_eq!(snapshot(&s), before);
    commit(&s, &k, |w| w.archive_project(&p.id));
    let before = snapshot(&s);
    assert!(matches!(
        k.write(|w| w.set_active_project(&p.id)),
        Err(E::Project(ProjectError::ProjectArchived))
    ));
    assert_eq!(snapshot(&s), before);
}

#[test]
fn w12_every_admitted_writer_rolls_back_after_successful_domain_sql() {
    for case in 0..18 {
        let (s, cap, o) = v9_graph(3);
        let p = s.create_project("Destination").unwrap();
        let fresh = s.create(input(None)).unwrap();
        let id = &o[0].id;
        let root = s.current_revision_id_of(id).unwrap().unwrap();
        let branch = s
            .create_revision_from(id, &root, change("Branch"), false)
            .unwrap();
        let old = s
            .create_relation(edge("related_to", id, &o[1].id), "model")
            .unwrap();
        if case == 4 {
            s.archive_project(&p.id).unwrap();
        }
        if case == 13 {
            s.update_object(id, change("Before restore")).unwrap();
        }
        let expected = s.current_revision_id_of(id).unwrap().unwrap();
        let write = IntegrationWrite {
            focus: snap(&s, id),
            context: vec![snap(&s, &o[1].id)],
            remove: vec![old.id],
            add: vec![edge("depends_on", id, &o[1].id)],
        };
        upgrade(&s);
        let k = JournalKernel::activate(&s).unwrap();
        let before = snapshot(&s);
        let mut ran = false;
        let result = k.write_fault(Fault::At(Stage::Commit), |w| {
            match case {
                0 => {
                    w.create_capture(input(None))?;
                }
                1 => {
                    w.create_project("New")?;
                }
                2 => {
                    w.rename_project(&p.id, "Renamed")?;
                }
                3 => {
                    w.archive_project(&p.id)?;
                }
                4 => {
                    w.restore_project(&p.id)?;
                }
                5 => {
                    w.move_capture(&cap.id, &p.id)?;
                }
                6 => {
                    w.move_knowledge_object(id, &p.id)?;
                }
                7 => {
                    w.record_distillation(&fresh.id, vec![candidate("New", 0, 4)])?;
                }
                8 => {
                    w.update_object(id, change("Edited"))?;
                }
                9 => {
                    w.create_revision_from(id, &root, change("New branch"), false)?;
                }
                10 => {
                    w.merge_revisions(
                        id,
                        &[root.clone(), branch.id.clone()],
                        content("Merge"),
                        true,
                    )?;
                }
                11 => {
                    w.revise_from_capture(
                        id,
                        None,
                        SourceSpan {
                            capture_id: fresh.id.clone(),
                            start: 0,
                            end: 4,
                        },
                        change("Interpreted"),
                        true,
                    )?;
                }
                12 => {
                    w.revise_if_current(
                        &ExpectedRevision {
                            object_id: id,
                            project_id: &o[0].project_id,
                            base_revision_id: &expected,
                        },
                        content("User CAS"),
                        CasOrigin::UserEdit,
                    )?;
                }
                13 => {
                    w.restore_revision(id, &root, &expected)?;
                }
                14 => {
                    w.create_relation(edge("extends", id, &o[1].id), "user")?;
                }
                15 => {
                    w.record_relations(vec![edge("extends", id, &o[2].id)], "model")?;
                }
                16 => {
                    w.apply_integration(write)?;
                }
                17 => {
                    w.set_active_project(&p.id)?;
                }
                _ => unreachable!(),
            }
            ran = true;
            if case != 17 {
                assert!(w.observed_effect_count() > 0);
            }
            Ok(())
        });
        assert!(ran, "domain writer {case} did not complete");
        assert!(
            matches!(result, Err(E::Journal(J::Injected))),
            "writer {case}: {result:?}"
        );
        assert_eq!(snapshot(&s), before, "writer {case}");
        audit(&s);
    }
}

#[test]
fn w12_catching_a_partial_domain_failure_cannot_commit_earlier_writes() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    s.execute_sql_for_test("CREATE TEMP TRIGGER task11_partial BEFORE INSERT ON knowledge_objects WHEN NEW.title='Fail' BEGIN SELECT RAISE(ABORT,'private synthetic failure'); END");
    let before = snapshot(&s);
    let result = k.write(|w| {
        let cap = w.create_capture(input(None))?;
        assert!(w
            .record_distillation(
                &cap.id,
                vec![candidate("Good", 0, 4), candidate("Fail", 5, 6)]
            )
            .is_err());
        assert!(w.create_project("Must not run").is_err());
        Ok(())
    });
    assert!(
        matches!(result,Err(E::Store(e)) if matches!(e.as_ref(),crate::storage::capture_store::StoreError::Database(_)))
    );
    assert_eq!(snapshot(&s), before);
    audit(&s);
}

#[test]
fn w13_production_v9_still_operates_without_any_journal_initialization() {
    let s = CaptureStore::open_in_memory().unwrap();
    assert_eq!(migrations::SCHEMA_VERSION, 9);
    assert_eq!(
        migrations::STEPS.iter().map(|s| s.0).collect::<Vec<_>>(),
        (1..=9).collect::<Vec<_>>()
    );
    let p = s.create_project("Production").unwrap();
    let cap = s.create(input(Some(&p.id))).unwrap();
    let o = s
        .record_distillation(&cap.id, vec![candidate("Production", 0, 4)])
        .unwrap();
    s.update_object(&o[0].id, change("User edit")).unwrap();
    assert_eq!(s.query_i64_for_test("PRAGMA user_version"), 9);
    assert_eq!(
        s.query_i64_for_test("SELECT count(*) FROM sqlite_schema WHERE name LIKE 'sync_%'"),
        0
    );
    assert!(matches!(JournalKernel::activate(&s), Err(J::WrongSchema)));
}

#[test]
fn w14_identity_evidence_and_claim_effects_commit_while_unguarded_paths_fail_closed() {
    use crate::storage::{
        evidence_store::{attach_revision_evidence_in, EvidenceRole, NewEvidence},
        identity_store::{
            self, DecisionAudit, DecisionOutcome, IdentityDecisionInput, PendingClaimInput,
        },
    };
    let (s, cap, o) = v9_graph(1);
    let id = &o[0].id;
    let root = s.current_revision_id_of(id).unwrap().unwrap();
    let automatic = s
        .revise_if_current(
            &ExpectedRevision {
                object_id: id,
                project_id: &o[0].project_id,
                base_revision_id: &root,
            },
            content("Historical automatic"),
            CasOrigin::System,
        )
        .unwrap();
    upgrade(&s);
    let k = JournalKernel::activate(&s).unwrap();
    let before = snapshot(&s);
    assert!(matches!(
        k.write(|w| w.revise_if_current(
            &ExpectedRevision {
                object_id: id,
                project_id: &o[0].project_id,
                base_revision_id: &automatic.id
            },
            content("Excluded automatic"),
            CasOrigin::System
        )),
        Err(E::Journal(J::IncompleteClosure))
    ));
    assert_eq!(snapshot(&s), before);
    k.run(|tx| {
        attach_revision_evidence_in(
            tx.sql(),
            &automatic.id,
            &[NewEvidence {
                capture_id: cap.id.clone(),
                source_start: 0,
                source_end: 4,
                role: EvidenceRole::Asserts,
                retracts: None,
                interpretation_label: None,
            }],
        )
        .expect("valid system-only native evidence fixture");
        Ok(())
    })
    .unwrap();
    let core = audit(&s).pop().expect("evidence bundle commits");
    assert_eq!(core.operations.len(), 1);
    let decision = IdentityDecisionInput {
        capture_id: cap.id.clone(),
        ordinal: 0,
        outcome: DecisionOutcome::Uncertain,
        unchecked_reason: None,
        target_object_id: None,
        base_revision_id: None,
        result_revision_id: None,
        created_object_id: None,
        policy_version: "test".into(),
        model_id: Some("synthetic".into()),
        vetoes: vec![],
        audit: DecisionAudit {
            candidates_sent: vec![id.clone()],
            runs: 1,
            ..DecisionAudit::default()
        },
    };
    let pending = PendingClaimInput {
        decision,
        kind: "idea".into(),
        title: "Pending".into(),
        body: "Body".into(),
        source_start: 0,
        source_end: 4,
        candidate_ids: vec![id.clone()],
        due_at: None,
    };
    k.run(|tx| {
        assert!(
            identity_store::stage_uncertain_claim_in(tx.sql(), &pending)
                .expect("valid paired native decision/claim")
                .1
        );
        Ok(())
    })
    .unwrap();
    let core = audit(&s).pop().expect("decision and claim bundle commits");
    assert_eq!(core.operations.len(), 2);
    let review_store = CaptureStore::open_in_memory().unwrap();
    crate::storage::m05_v10_tests::populated(&review_store.connection.lock().unwrap());
    upgrade(&review_store);
    let review_kernel = JournalKernel::activate(&review_store).unwrap();
    let before = snapshot(&review_store);
    assert_eq!(
        review_kernel.run(|tx| {
            identity_store::defer_pending_claim_in(
                tx.sql(),
                "00000014-0000-4000-8000-000000000000",
                None,
            )
            .expect("valid native defer SQL");
            Ok(())
        }),
        Err(J::ReviewContext)
    );
    assert_eq!(snapshot(&review_store), before);
    // This real helper still enforces system attribution; the Task 11 adapter
    // never relabels it as user_edit to obtain admission.
    audit(&s);
}

/// Compare independently generated fixtures by table insertion roles. Only ID
/// references and timestamps are normalized; domain text and nulls stay exact.
fn normalized_domain(s: &CaptureStore) -> Vec<(String, Vec<codec::RowImage>)> {
    let c = s.connection.lock().unwrap();
    let mut all = Vec::new();
    let mut identities = BTreeMap::new();
    for entity in sql::ENTITIES {
        let order = if entity.all_fields().contains(&"id") {
            "seq".into()
        } else {
            entity.key_fields().join(",")
        };
        let mut q = c
            .prepare(&format!(
                "SELECT {} FROM {} ORDER BY {order}",
                entity.key_fields().join(","),
                entity.as_str()
            ))
            .unwrap();
        let keys = q
            .query_map([], |r| {
                (0..entity.key_fields().len())
                    .map(|i| {
                        if entity.key_element_is_decimal(i) {
                            r.get::<_, i64>(i).map(|n| n.to_string())
                        } else {
                            r.get(i)
                        }
                    })
                    .collect::<rusqlite::Result<Vec<String>>>()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let rows = keys
            .into_iter()
            .map(|key| sql::reread(&c, entity, &key).unwrap().unwrap())
            .collect::<Vec<_>>();
        for (i, row) in rows.iter().enumerate() {
            if let Some(FieldValue::Text(id)) = row.get("id") {
                identities.insert(id.clone(), format!("{}:{i}", entity.as_str()));
            }
        }
        all.push((entity.as_str().to_string(), rows));
    }
    for (_, rows) in &mut all {
        for row in rows.iter_mut() {
            for (field, value) in row {
                if let FieldValue::Text(text) = value {
                    if field.ends_with("_at") {
                        codec::validate_timestamp(text).unwrap();
                        *text = "@generated-time".into();
                    } else if field == "id" || field.ends_with("_id") {
                        if let Some(role) = identities.get(text) {
                            *text = role.clone();
                        }
                    }
                }
            }
        }
        rows.sort_by_key(|row| format!("{row:?}"));
    }
    let active = c
        .prepare("SELECT project_id FROM active_project")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    all.push((
        "active_project".into(),
        active
            .into_iter()
            .map(|id| {
                codec::RowImage::from([(
                    "project_id".into(),
                    FieldValue::Text(identities[&id].clone()),
                )])
            })
            .collect(),
    ));
    all
}

fn parity_scenario(s: &CaptureStore, k: Option<&JournalKernel<'_>>) -> Vec<String> {
    macro_rules! call {($public:ident,$private:ident $(,$arg:expr)*)=>{match k {Some(k)=>k.write(|w|w.$private($($arg),*)),None=>s.$public($($arg),*).map_err(E::from)}};}
    let p = call!(create_project, create_project, "Parity").unwrap();
    call!(rename_project, rename_project, &p.id, "Renamed").unwrap();
    call!(set_active_project, set_active_project, &p.id).unwrap();
    let cap = call!(create, create_capture, input(Some(&p.id))).unwrap();
    let o = call!(
        record_distillation,
        record_distillation,
        &cap.id,
        vec![candidate("First", 0, 4), candidate("Second", 5, 6)]
    )
    .unwrap();
    let id = &o[0].id;
    let root = s.current_revision_id_of(id).unwrap().unwrap();
    let edit = call!(update_object, update_object, id, change("Edited")).unwrap();
    let branch = call!(
        create_revision_from,
        create_revision_from,
        id,
        &root,
        change("Branch"),
        false
    )
    .unwrap();
    let selected = call!(
        create_revision_from,
        create_revision_from,
        id,
        &root,
        change("Selected"),
        true
    )
    .unwrap();
    let merged = call!(
        merge_revisions,
        merge_revisions,
        id,
        &[edit.id, branch.id, selected.id],
        content("Merge"),
        true
    )
    .unwrap();
    let source = call!(create, create_capture, input(Some(&p.id))).unwrap();
    let derived = call!(
        revise_from_capture,
        revise_from_capture,
        id,
        None,
        SourceSpan {
            capture_id: source.id,
            start: 5,
            end: 6
        },
        change("Capture-derived"),
        true
    )
    .unwrap();
    let cas = call!(
        revise_if_current,
        revise_if_current,
        &ExpectedRevision {
            object_id: id,
            project_id: &p.id,
            base_revision_id: &derived.id
        },
        content("CAS"),
        CasOrigin::UserEdit
    )
    .unwrap();
    call!(restore_revision, restore_revision, id, &root, &cas.id).unwrap();
    call!(
        create_relation,
        create_relation,
        edge("extends", id, &o[1].id),
        "user"
    )
    .unwrap();
    let model = call!(
        record_relations,
        record_relations,
        vec![edge("depends_on", id, &o[1].id)],
        "model"
    )
    .unwrap()
    .remove(0);
    let write = IntegrationWrite {
        focus: snap(s, id),
        context: vec![snap(s, &o[1].id)],
        remove: vec![model.id],
        add: vec![edge("derived_from", id, &o[1].id)],
    };
    let written = call!(apply_integration, apply_integration, write).unwrap();
    assert_eq!((written.removed, written.added.len()), (1, 1));
    call!(
        move_capture,
        move_capture,
        &cap.id,
        migrations::INBOX_PROJECT_ID
    )
    .unwrap();
    call!(
        move_knowledge_object,
        move_knowledge_object,
        id,
        migrations::INBOX_PROJECT_ID
    )
    .unwrap();
    call!(archive_project, archive_project, &p.id).unwrap();
    call!(restore_project, restore_project, &p.id).unwrap();
    call!(
        set_active_project,
        set_active_project,
        migrations::INBOX_PROJECT_ID
    )
    .unwrap();
    let errors = [
        call!(create_project, create_project, "Renamed").map(|_| ()),
        call!(
            rename_project,
            rename_project,
            migrations::INBOX_PROJECT_ID,
            "No"
        )
        .map(|_| ()),
        call!(
            create,
            create_capture,
            CreateCaptureInput {
                source: "invalid".into(),
                ..input(None)
            }
        )
        .map(|_| ()),
        call!(
            move_capture,
            move_capture,
            "missing",
            migrations::INBOX_PROJECT_ID
        )
        .map(|_| ()),
        call!(
            revise_if_current,
            revise_if_current,
            &ExpectedRevision {
                object_id: id,
                project_id: migrations::INBOX_PROJECT_ID,
                base_revision_id: &merged.id
            },
            content("Stale"),
            CasOrigin::UserEdit
        )
        .map(|_| ()),
    ];
    let noops = [
        call!(record_distillation, record_distillation, &cap.id, vec![])
            .unwrap()
            .len(),
        call!(
            record_relations,
            record_relations,
            vec![edge("extends", id, &o[1].id)],
            "model"
        )
        .unwrap()
        .len(),
    ];
    assert_eq!(noops, [2, 0]);
    errors
        .into_iter()
        .map(|r| format!("{:?}", r.unwrap_err()))
        .collect()
}

fn decision_for(capture_id: &str, ordinal: i64, candidates: Vec<String>) -> crate::storage::identity_store::IdentityDecisionInput {
    use crate::storage::identity_store::{DecisionAudit, DecisionOutcome, IdentityDecisionInput};
    IdentityDecisionInput {
        capture_id: capture_id.into(),
        ordinal,
        outcome: DecisionOutcome::Uncertain,
        unchecked_reason: None,
        target_object_id: None,
        base_revision_id: None,
        result_revision_id: None,
        created_object_id: None,
        policy_version: "test".into(),
        model_id: Some("synthetic".into()),
        vetoes: vec![],
        audit: DecisionAudit { candidates_sent: candidates, runs: 1, ..DecisionAudit::default() },
    }
}
fn pending_for(decision: crate::storage::identity_store::IdentityDecisionInput, candidates: Vec<String>) -> crate::storage::identity_store::PendingClaimInput {
    use crate::storage::identity_store::PendingClaimInput;
    PendingClaimInput {
        decision,
        kind: "idea".into(),
        title: "Pending".into(),
        body: "Body".into(),
        source_start: 0,
        source_end: 4,
        candidate_ids: candidates,
        due_at: None,
    }
}
#[test]
fn w15_identity_decision_and_claim_adapters_commit_with_idempotence() {
    use crate::storage::identity_store::DecisionOutcome;
    let (s, cap, o) = graph(2);
    let k = JournalKernel::activate(&s).unwrap();
    let prop = commit(&s, &k, |w| {
        w.stage_uncertain_claim(pending_for(decision_for(&cap.id, 0, vec![o[0].id.clone()]), vec![o[0].id.clone()]))
    });
    assert!(prop.1);
    let core = audit(&s).pop().expect("decision and claim bundle commits");
    assert_eq!(core.operations.len(), 2);
    let n = count(&s, "sync_bundles");
    let repeat = commit(&s, &k, |w| {
        w.stage_uncertain_claim(pending_for(decision_for(&cap.id, 0, vec![o[0].id.clone()]), vec![o[0].id.clone()]))
    });
    assert!(!repeat.1);
    assert_eq!(count(&s, "sync_bundles"), n);
    let mut solo = decision_for(&cap.id, 1, vec![o[0].id.clone()]);
    solo.outcome = DecisionOutcome::New;
    solo.created_object_id = Some(o[0].id.clone());
    solo.audit = Default::default();
    let (stored, created) = commit(&s, &k, |w| w.record_identity_decision(solo.clone()));
    assert!(created);
    assert_eq!(stored.input.ordinal, 1);
    let before = snapshot(&s);
    assert!(matches!(
        k.write(|w| w.stage_uncertain_claim(pending_for(decision_for(&cap.id, 0, vec![o[1].id.clone()]), vec![o[1].id.clone()]))),
        Err(E::Identity(_))
    ));
    assert_eq!(snapshot(&s), before);
}
#[test]
fn w01_public_v9_and_dormant_v10_share_domain_rows_results_errors_and_side_effects() {
    let v9 = CaptureStore::open_in_memory().unwrap();
    let v10 = upgraded();
    let k = JournalKernel::activate(&v10).unwrap();
    let errors9 = parity_scenario(&v9, None);
    let errors10 = parity_scenario(&v10, Some(&k));
    assert_eq!(errors9, errors10);
    assert_eq!(normalized_domain(&v9), normalized_domain(&v10));
    assert_eq!(
        count(&v9, "recall_revision_fts"),
        count(&v10, "recall_revision_fts")
    );
    assert_eq!(
        count(&v9, "organization_failures"),
        count(&v10, "organization_failures")
    );
    audit(&v10);
}

fn proposal_for(claim_id: &str, object_id: &str, base: &str, body: &str, capture_id: &str) -> crate::storage::proposal_store::NewProposal {
    use crate::storage::proposal_store::{EvidenceRef, NewProposal};
    NewProposal {
        pending_claim_id: claim_id.into(),
        object_id: object_id.into(),
        base_revision_id: base.into(),
        change: "additive".into(),
        kind: "idea".into(),
        title: "Draft".into(),
        proposed_body: body.into(),
        evidence: vec![EvidenceRef { role: "claim".into(), capture_id: capture_id.into(), start: 0, end: 4 }],
        retracts: None,
        synthesis_model: "synthetic".into(),
        verifier_model: "synthetic".into(),
        verification_mode: "independent".into(),
        policy_version: "test".into(),
    }
}
fn staged_claim(s: &CaptureStore, k: &JournalKernel<'_>, cap_id: &str, object_id: &str) -> crate::storage::identity_store::PendingClaim {
    staged_claim_ordinal(s, k, cap_id, object_id, 0)
}
fn staged_claim_ordinal(s: &CaptureStore, k: &JournalKernel<'_>, cap_id: &str, object_id: &str, ordinal: i64) -> crate::storage::identity_store::PendingClaim {
    commit(s, k, |w| {
        Ok(w.stage_uncertain_claim(pending_for(decision_for(cap_id, ordinal, vec![object_id.into()]), vec![object_id.into()]))?.0)
    })
}
#[test]
fn w16_proposal_creation_is_idempotent_and_rejects_stale_base() {
    let (s, cap, o) = graph(1);
    let k = JournalKernel::activate(&s).unwrap();
    let claim = staged_claim(&s, &k, &cap.id, &o[0].id);
    let base = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
    commit(&s, &k, |w| w.update_object(&o[0].id, change("Moved")));
    let head = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
    assert_ne!(head, base);
    assert!(matches!(
        k.write(|w| w.insert_proposal(proposal_for(&claim.id, &o[0].id, &base, "Stale draft", &cap.id))),
        Err(E::Identity(_)) | Err(E::Journal(_))
    ));
    let first = commit(&s, &k, |w| w.insert_proposal(proposal_for(&claim.id, &o[0].id, &head, "Draft body", &cap.id)));
    assert!(first.1);
    let n = count(&s, "sync_bundles");
    let repeat = commit(&s, &k, |w| w.insert_proposal(proposal_for(&claim.id, &o[0].id, &head, "Draft body", &cap.id)));
    assert!(!repeat.1);
    assert_eq!(count(&s, "sync_bundles"), n);
    assert_eq!(repeat.0.id, first.0.id);
}

#[test]
fn w17_review_approve_closes_full_revision_and_evidence_closure() {
    use crate::storage::proposal_store::{ReviewAction, ReviewRequest};
    let (s, cap, o) = graph(1);
    let k = JournalKernel::activate(&s).unwrap();
    let claim = staged_claim(&s, &k, &cap.id, &o[0].id);
    let base = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
    let proposal = commit(&s, &k, |w| w.insert_proposal(proposal_for(&claim.id, &o[0].id, &base, "Approved text", &cap.id))).0;
    let out = commit(&s, &k, |w| {
        w.review_proposal(ReviewRequest { proposal_id: proposal.id.clone(), action: ReviewAction::Approve, reviewed_revision_id: Some(base.clone()) })
    });
    assert!(out.applied);
    assert_eq!(out.proposal.state, "approved");
    let core = audit(&s).pop().expect("approval bundle commits");
    let mut kinds: Vec<(codec::EntityKind, &str)> = core.operations.iter().map(|op| match op {
        Operation::RecordCreate(r) => (r.entity, "create"),
        Operation::FacetUpdate(u) => (u.entity, if u.review_proof.is_some() { "proved" } else { "bare" }),
        Operation::RelationRemove(_) => (K::Relations, "remove"),
    }).collect();
    assert!(kinds.iter().any(|(e, k)| *e == K::RevisionProposals && *k == "proved"));
    let fresh = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
    assert_ne!(fresh, base);
}


#[test]
fn w19_claim_accept_separate_expiry_and_terminal_idempotence() {
    use crate::storage::identity_store::AcceptPendingInput;
    use crate::storage::lineage_store::RevisionContent;
    use crate::storage::evidence_store::EvidenceRole;
    use crate::storage::lineage_store::ExpectedRevision;
    let (s, cap, o) = graph(1);
    let k = JournalKernel::activate(&s).unwrap();
    let claim = staged_claim(&s, &k, &cap.id, &o[0].id);
    let base = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
    let out = commit(&s, &k, |w| {
        w.accept_pending_claim(AcceptPendingInput {
            pending_id: claim.id.clone(),
            target_object_id: o[0].id.clone(),
            expected_base_revision_id: base.clone(),
            content: RevisionContent { kind: "idea".into(), title: "Accepted".into(), body: "Accepted body".into() },
            role: EvidenceRole::Asserts,
            retracts: None,
            interpretation_label: None,
        })
    });
    assert!(out.applied);
    assert_eq!(out.claim.state, "accepted");
    let core = audit(&s).pop().expect("accept bundle commits");
    assert!(core.operations.iter().any(|op| matches!(op, Operation::RecordCreate(r) if r.entity == K::ThoughtRevisions)));
    assert!(core.operations.iter().any(|op| matches!(op, Operation::RecordCreate(r) if r.entity == K::RevisionEvidence)));
    let n = count(&s, "sync_bundles");
    let current = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
    let repeat = commit(&s, &k, |w| {
        w.accept_pending_claim(AcceptPendingInput {
            pending_id: claim.id.clone(),
            target_object_id: o[0].id.clone(),
            expected_base_revision_id: current.clone(),
            content: RevisionContent { kind: "idea".into(), title: "Accepted".into(), body: "Accepted body".into() },
            role: EvidenceRole::Asserts,
            retracts: None,
            interpretation_label: None,
        })
    });
    let claim2 = staged_claim_ordinal(&s, &k, &cap.id, &o[0].id, 1);
    let sep = commit(&s, &k, |w| w.separate_pending_claim(&claim2.id, "expiry"));
    assert!(sep.applied);
    assert_eq!(sep.claim.state, "separated");
    let core = audit(&s).pop().expect("separate bundle commits");
    let proof = core.operations.iter().find_map(|op| match op { Operation::FacetUpdate(u) if u.entity == K::PendingClaims => u.review_proof.clone(), _ => None }).expect("separate proof");
}

#[test]
fn w20_trigger_supersession_captured_with_derived_proof() {
    use crate::storage::evidence_store::EvidenceRole;
    use crate::storage::identity_store::AcceptPendingInput;
    use crate::storage::lineage_store::RevisionContent;
    let (s, cap, o) = graph(1);
    let k = JournalKernel::activate(&s).unwrap();
    let claim = staged_claim(&s, &k, &cap.id, &o[0].id);
    let base = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
    let proposal = commit(&s, &k, |w| w.insert_proposal(proposal_for(&claim.id, &o[0].id, &base, "Draft text", &cap.id))).0;
    let out = commit(&s, &k, |w| {
        w.accept_pending_claim(AcceptPendingInput {
            pending_id: claim.id.clone(),
            target_object_id: o[0].id.clone(),
            expected_base_revision_id: base.clone(),
            content: RevisionContent { kind: "idea".into(), title: "Accepted".into(), body: "Accepted body".into() },
            role: EvidenceRole::Asserts,
            retracts: None,
            interpretation_label: None,
        })
    });
    assert!(out.applied);
    let core = audit(&s).pop().expect("accept with trigger bundle commits");
    let superseded: Vec<_> = core.operations.iter().filter_map(|op| match op {
        Operation::FacetUpdate(u) if u.entity == K::RevisionProposals => Some(u),
        _ => None,
    }).collect();
    assert_eq!(superseded.len(), 1);
    let proof = superseded[0].review_proof.as_ref().expect("supersede carries derived proof");
    assert_eq!(proof.action, codec::ReviewAction::Supersede);
    assert_eq!(proof.proposal_id, Some(proposal.id.clone()));
    assert_eq!(proof.claim_id, Some(claim.id.clone()));
    assert_eq!(proof.method, Some(codec::ReviewMethod::DerivedClaimResolution));
    let fresh = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
}

#[test]
fn w21_review_action_must_match_the_observed_transition() {
    let (s, cap, o) = graph(1);
    let k = JournalKernel::activate(&s).unwrap();
    let claim = staged_claim(&s, &k, &cap.id, &o[0].id);
    let before = snapshot(&s);
    assert_eq!(
        k.run(|t| {
            t.sql().execute("UPDATE pending_claims SET state='deferred',deferred_at=?1,updated_at=?1 WHERE id=?2", params!["2026-10-22T00:00:00Z", claim.id])?;
            t.register_review(
                K::PendingClaims,
                vec![claim.id.clone()],
                super::reducer::ReviewContext {
                    action: codec::ReviewAction::Approve,
                    proposal_id: None,
                    claim_id: Some(claim.id.clone()),
                    object_id: None,
                    reviewed_revision_id: None,
                    final_body: None,
                    user_edited: None,
                    result_revision_id: None,
                    method: Some(codec::ReviewMethod::User),
                },
            )?;
            Ok(())
        }),
        Err(J::ReviewContext)
    );
    assert_eq!(snapshot(&s), before);
}

#[test]
fn w22_automatic_revision_requires_same_event_evidence() {
    let (s, cap, o) = graph(1);
    let k = JournalKernel::activate(&s).unwrap();
    let root = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
    let before = snapshot(&s);
    assert_eq!(
        k.run(|tx| {
            tx.sql().execute("INSERT INTO thought_revisions(id,object_id,kind,title,body,origin,created_at) VALUES(?1,?2,'idea','No evidence','Body','system',?3)", params!["00012cc8-1234-4abc-8def-000000012cc8", o[0].id, "2026-10-22T00:00:00Z"])?;
            tx.sql().execute("INSERT INTO revision_parents(child_revision_id,parent_revision_id) VALUES(?1,?2)", params!["00012cc8-1234-4abc-8def-000000012cc8", root.clone()])?;
            Ok(())
        }),
        Err(J::IncompleteClosure)
    );
    assert_eq!(snapshot(&s), before);
}

#[test]
fn w23_repeated_metadata_writes_emit_proof_free_bundles() {
    let (s, cap, o) = graph(1);
    let k = JournalKernel::activate(&s).unwrap();
    let claim = staged_claim(&s, &k, &cap.id, &o[0].id);
    let deferred = commit(&s, &k, |w| w.defer_claim(&claim.id, None));
    assert_eq!(deferred.state, "deferred");
    let n = count(&s, "sync_bundles");
    let again = commit(&s, &k, |w| w.defer_claim(&claim.id, Some("2030-01-01T00:00:00Z")));
    assert_eq!(count(&s, "sync_bundles"), n + 1);
    let core = audit(&s).pop().expect("repeat defer bundle commits");
    assert_eq!(core.operations.len(), 1);
    let Operation::FacetUpdate(update) = &core.operations[0] else { panic!("expected update"); };
    assert_eq!(update.entity, K::PendingClaims);
    assert!(update.review_proof.is_none());
}

fn evolution_parts(policy: &str, candidates: Vec<String>) -> crate::distillation::evolution::Parts {
    use crate::storage::identity_store::DecisionAudit;
    crate::distillation::evolution::Parts::synthetic(
        policy.into(),
        Some("synthetic".into()),
        vec![],
        DecisionAudit { candidates_sent: candidates, runs: 1, ..DecisionAudit::default() },
    )
}
#[test]
fn w24_identity_aware_evolution_commits_multi_claim_bundle() {
    use crate::distillation::evolution::{Committed, Plan, Planned};
    use crate::identity::TargetSnapshot;
    use crate::storage::evidence_store::EvidenceRole;
    use crate::storage::knowledge_store::NewKnowledgeObject;
    use crate::storage::lineage_store::RevisionContent;
    let (s, _cap, o) = graph(2);
    let k = JournalKernel::activate(&s).unwrap();
    let cap = commit(&s, &k, |w| w.create_capture(input(None)));
    let head = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
    let claims = vec![
        NewKnowledgeObject { kind: "idea".into(), title: "Fresh Angle".into(), body: "Fresh body text".into(), source_start: 0, source_end: 4 },
        NewKnowledgeObject { kind: "idea".into(), title: "Refined".into(), body: "Refined body text".into(), source_start: 0, source_end: 4 },
        NewKnowledgeObject { kind: "idea".into(), title: "Maybe".into(), body: "Maybe body text".into(), source_start: 0, source_end: 4 },
    ];
    let planned = vec![
        Planned { plan: Plan::New(None), parts: evolution_parts("test", vec![]) },
        Planned {
            plan: Plan::Revise {
                target: TargetSnapshot { object_id: o[0].id.clone(), project_id: o[0].project_id.clone(), base_revision_id: head.clone() },
                draft: crate::distillation::evolution::RevisionDraft {
                    content: RevisionContent { kind: "idea".into(), title: o[0].title.clone(), body: "Revised body text".into() },
                    role: EvidenceRole::Asserts,
                    retracts: None,
                    interpretation_label: None,
                },
            },
            parts: evolution_parts("test", vec![o[0].id.clone()]),
        },
        Planned { plan: Plan::Uncertain(vec![o[1].id.clone()]), parts: evolution_parts("test", vec![o[1].id.clone()]) },
    ];
    let out = commit(&s, &k, |w| {
        let granted = || true;
        w.evolve_capture(&cap.id, claims, planned, &crate::distillation::evolution::EvolutionLimits::default(), &granted, false)
    });
    let Committed::Fresh { objects, revised, pending, proposals } = out else { panic!("expected fresh"); };
    assert_eq!(objects.len(), 1);
    assert_eq!(revised.len(), 1);
    assert_eq!(pending.len(), 1);
    assert!(proposals.is_empty());
    let core = audit(&s).pop().expect("evolution bundle commits");
    let kinds: Vec<(codec::EntityKind, &str)> = core.operations.iter().map(|op| match op {
        Operation::RecordCreate(r) => (r.entity, "create"),
        Operation::FacetUpdate(u) => (u.entity, if u.review_proof.is_some() { "proved" } else { "bare" }),
        Operation::RelationRemove(_) => (K::Relations, "remove"),
    }).collect();
    assert!(kinds.iter().any(|(e, k)| *e == K::KnowledgeObjects && *k == "create"));
    assert!(kinds.iter().any(|(e, k)| *e == K::ThoughtRevisions && *k == "create"));
    assert!(kinds.iter().any(|(e, k)| *e == K::RevisionEvidence && *k == "create"));
    assert!(kinds.iter().any(|(e, k)| *e == K::IdentityDecisions && *k == "create"));
    assert!(kinds.iter().any(|(e, k)| *e == K::PendingClaims && *k == "create"));
}
#[test]
fn w18_review_reject_defer_reopen_and_keep_separate_paths() {
    use crate::storage::proposal_store::{ClaimAction, ClaimResolution, ReviewAction, ReviewRequest};
    let (s, cap, o) = graph(1);
    let k = JournalKernel::activate(&s).unwrap();
    let claim = staged_claim(&s, &k, &cap.id, &o[0].id);
    let base = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
    let proposal = commit(&s, &k, |w| w.insert_proposal(proposal_for(&claim.id, &o[0].id, &base, "Draft text", &cap.id))).0;
    let rejected = commit(&s, &k, |w| {
        w.review_proposal(ReviewRequest { proposal_id: proposal.id.clone(), action: ReviewAction::Reject, reviewed_revision_id: None })
    });
    assert!(rejected.applied);
    assert_eq!(rejected.proposal.state, "rejected");
    let core = audit(&s).pop().expect("reject bundle commits");
    assert_eq!(core.operations.len(), 1);
    let deferred: ClaimResolution = commit(&s, &k, |w| w.resolve_claim(&claim.id, ClaimAction::Defer { due_at: None }));
    assert!(deferred.applied);
    assert_eq!(deferred.claim_state, "deferred");
    let reopened: ClaimResolution = commit(&s, &k, |w| w.resolve_claim(&claim.id, ClaimAction::Reopen));
    assert!(reopened.applied);
    assert_eq!(reopened.claim_state, "open");
    let separated: ClaimResolution = commit(&s, &k, |w| w.resolve_claim(&claim.id, ClaimAction::KeepSeparate));
    assert!(separated.applied);
    assert_eq!(separated.claim_state, "separated");
    assert!(separated.created_object_id.is_some());
}

#[test]
fn w25_stale_evolution_target_falls_back_inside_savepoint() {
    use crate::distillation::evolution::{Committed, Plan, Planned};
    use crate::identity::TargetSnapshot;
    use crate::storage::evidence_store::EvidenceRole;
    use crate::storage::knowledge_store::NewKnowledgeObject;
    use crate::storage::lineage_store::RevisionContent;
    let (s, _cap, o) = graph(1);
    let k = JournalKernel::activate(&s).unwrap();
    let cap = commit(&s, &k, |w| w.create_capture(input(None)));
    let stale_base = "00000000-0000-4000-8000-000000000000".to_string();
    let claims = vec![
        NewKnowledgeObject { kind: "idea".into(), title: "Stale".into(), body: "Stale body".into(), source_start: 0, source_end: 4 },
    ];
    let planned = vec![Planned {
        plan: Plan::Revise {
            target: TargetSnapshot { object_id: o[0].id.clone(), project_id: o[0].project_id.clone(), base_revision_id: stale_base },
            draft: crate::distillation::evolution::RevisionDraft {
                content: RevisionContent { kind: "idea".into(), title: o[0].title.clone(), body: "Stale attempt body".into() },
                role: EvidenceRole::Asserts,
                retracts: None,
                interpretation_label: None,
            },
        },
        parts: evolution_parts("test", vec![o[0].id.clone()]),
    }];
    let granted = || true; // tests simulate granted permission for the fallback-path fixture
    let out = commit(&s, &k, |w| w.evolve_capture(&cap.id, claims, planned, &crate::distillation::evolution::EvolutionLimits::default(), &granted, false));
    let Committed::Fresh { objects, revised, pending, proposals } = out else { panic!("expected fresh"); };
    assert!(objects.is_empty());
    assert!(revised.is_empty());
    assert_eq!(pending.len(), 1);
    assert!(proposals.is_empty());
    let core = audit(&s).pop().expect("fallback bundle commits");
    assert!(core.operations.iter().any(|op| matches!(op, Operation::RecordCreate(r) if r.entity == K::PendingClaims)));
    assert!(!core.operations.iter().any(|op| matches!(op, Operation::RecordCreate(r) if r.entity == K::ThoughtRevisions && sql::text(&r.after, "origin").unwrap() == "system")));
    assert!(core.operations.iter().all(|op| !matches!(op, Operation::FacetUpdate(u) if u.review_proof.is_some())));
}

#[test]
fn w26_journal_failure_after_complete_review_sql_rolls_back() {
    use crate::storage::proposal_store::{ReviewAction, ReviewRequest};
    let (s, cap, o) = graph(1);
    let k = JournalKernel::activate(&s).unwrap();
    let claim = staged_claim(&s, &k, &cap.id, &o[0].id);
    let base = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
    let proposal = commit(&s, &k, |w| w.insert_proposal(proposal_for(&claim.id, &o[0].id, &base, "Draft text", &cap.id))).0;
    let before = snapshot(&s);
    assert!(matches!(
        k.write_fault(Fault::At(Stage::Commit), |w| {
            w.review_proposal(ReviewRequest { proposal_id: proposal.id.clone(), action: ReviewAction::Approve, reviewed_revision_id: Some(base.clone()) })
        }),
        Err(E::Journal(J::Injected))
    ));
    assert_eq!(snapshot(&s), before);
}

#[test]
fn w27_multi_entity_transaction_finalizes_exactly_one_bundle() {
    let (s, cap, o) = graph(1);
    let k = JournalKernel::activate(&s).unwrap();
    let n = count(&s, "sync_bundles");
    let out = commit(&s, &k, |w| {
        let project = w.create_project("Joint space")?;
        let capture = w.create_capture(CreateCaptureInput { source: "text".into(), content: "Joint capture".into(), project_id: Some(project.id.clone()) })?;
        let objects = w.record_distillation(&capture.id, vec![NewKnowledgeObject { kind: "idea".into(), title: "Joint".into(), body: "Joint body".into(), source_start: 0, source_end: 4 }])?;
        let edge = w.create_relation(NewRelation { kind: "depends_on".into(), source_object_id: o[0].id.clone(), target_object_id: objects[0].id.clone() }, "model")?;
        Ok((project, capture, objects, edge))
    });
    assert_eq!(count(&s, "sync_bundles"), n + 1);
    let core = audit(&s).pop().expect("joint bundle commits");
    let mut entities: Vec<codec::EntityKind> = core.operations.iter().map(|op| match op {
        Operation::RecordCreate(r) => r.entity,
        Operation::FacetUpdate(u) => u.entity,
        Operation::RelationRemove(_) => K::Relations,
    }).collect();
    entities.sort();
    entities.dedup();
    for expected in [K::Projects, K::Captures, K::DistillationRuns, K::KnowledgeObjects, K::Relations] {
        assert!(entities.contains(&expected), "joint bundle covers {expected:?}");
    }
    assert!(out.1.id != cap.id);
}

#[test]
fn w28_withdrawn_revise_permission_falls_back_without_revision() {
    use crate::distillation::evolution::{Committed, EvolutionLimits, Plan, Planned};
    use crate::identity::TargetSnapshot;
    use crate::storage::knowledge_store::NewKnowledgeObject;
    use crate::storage::lineage_store::RevisionContent;
    use std::cell::Cell;
    let (s, _cap, o) = graph(1);
    let k = JournalKernel::activate(&s).unwrap();
    let cap = commit(&s, &k, |w| w.create_capture(input(None)));
    let head = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
    let permitted = Cell::new(true);
    let claims = vec![NewKnowledgeObject { kind: "idea".into(), title: "Revise".into(), body: "Revise body".into(), source_start: 0, source_end: 4 }];
    let planned = vec![Planned {
        plan: Plan::Revise {
            target: TargetSnapshot { object_id: o[0].id.clone(), project_id: o[0].project_id.clone(), base_revision_id: head.clone() },
            draft: crate::distillation::evolution::RevisionDraft {
                content: RevisionContent { kind: "idea".into(), title: o[0].title.clone(), body: "Permitted-then-revoked body".into() },
                role: crate::storage::evidence_store::EvidenceRole::Asserts,
                retracts: None,
                interpretation_label: None,
            },
        },
        parts: evolution_parts("test", vec![o[0].id.clone()]),
    }];
    permitted.set(false);
    let out = commit(&s, &k, |w| w.evolve_capture(&cap.id, claims, planned, &EvolutionLimits::default(), &|| permitted.get(), false));
    let Committed::Fresh { objects, revised, pending, proposals } = out else { panic!("expected fresh"); };
    assert!(objects.is_empty());
    assert!(revised.is_empty(), "revoked permission must not revise");
    assert_eq!(pending.len(), 1);
    assert!(proposals.is_empty());
    assert_eq!(s.current_revision_id_of(&o[0].id).unwrap().unwrap(), head);
    let core = audit(&s).pop().expect("fallback bundle commits");
    assert!(!core.operations.iter().any(|op| matches!(op, Operation::RecordCreate(r) if r.entity == K::ThoughtRevisions)));
    assert!(!core.operations.iter().any(|op| matches!(op, Operation::RecordCreate(r) if r.entity == K::RevisionEvidence)));
    assert!(core.operations.iter().any(|op| matches!(op, Operation::RecordCreate(r) if r.entity == K::PendingClaims)));
    assert!(core.operations.iter().all(|op| !matches!(op, Operation::FacetUpdate(u) if u.review_proof.is_some())));
}

#[test]
fn w29_withdrawn_propose_permission_stores_no_proposal() {
    use crate::distillation::evolution::{Committed, EvolutionLimits, Plan, Planned, ProposalDraft};
    use crate::identity::TargetSnapshot;
    use crate::storage::evidence_store::EvidenceRole;
    use crate::storage::knowledge_store::NewKnowledgeObject;
    use crate::storage::lineage_store::RevisionContent;
    use crate::storage::proposal_store::EvidenceRef;
    use std::cell::Cell;
    let (s, _cap, o) = graph(1);
    let k = JournalKernel::activate(&s).unwrap();
    let cap = commit(&s, &k, |w| w.create_capture(input(None)));
    let head = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
    let permitted = Cell::new(true);
    let claims = vec![NewKnowledgeObject { kind: "idea".into(), title: "Propose".into(), body: "Propose body".into(), source_start: 0, source_end: 4 }];
    let planned = vec![Planned {
        plan: Plan::Propose {
            target: TargetSnapshot { object_id: o[0].id.clone(), project_id: o[0].project_id.clone(), base_revision_id: head },
            draft: ProposalDraft {
                change: "additive",
                kind: "idea".into(),
                title: "Draft".into(),
                body: "Proposed text".into(),
                retracts: None,
                evidence: vec![EvidenceRef { role: "claim".into(), capture_id: cap.id.clone(), start: 0, end: 4 }],
                synthesis_model: "synthetic".into(),
                verifier_model: "synthetic".into(),
                mode: "same_family_review",
            },
        },
        parts: evolution_parts("test", vec![o[0].id.clone()]),
    }];
    permitted.set(false);
    let out = commit(&s, &k, |w| w.evolve_capture(&cap.id, claims, planned, &EvolutionLimits::default(), &|| permitted.get(), false));
    let Committed::Fresh { objects, revised, pending, proposals } = out else { panic!("expected fresh"); };
    assert!(objects.is_empty());
    assert!(revised.is_empty());
    assert_eq!(pending.len(), 1);
    assert!(proposals.is_empty(), "withdrawn permission must not store a proposal");
    let core = audit(&s).pop().expect("fallback bundle commits");
    assert!(!core.operations.iter().any(|op| matches!(op, Operation::RecordCreate(r) if r.entity == K::RevisionProposals)));
    assert!(core.operations.iter().any(|op| matches!(op, Operation::RecordCreate(r) if r.entity == K::PendingClaims)));
}

#[test]
fn w30_granted_permission_admits_planned_automatic_revision() {
    use crate::distillation::evolution::{Committed, EvolutionLimits, Plan, Planned};
    use crate::identity::TargetSnapshot;
    use crate::storage::knowledge_store::NewKnowledgeObject;
    use crate::storage::lineage_store::RevisionContent;
    use std::cell::Cell;
    let (s, _cap, o) = graph(1);
    let k = JournalKernel::activate(&s).unwrap();
    let cap = commit(&s, &k, |w| w.create_capture(input(None)));
    let head = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
    let permitted = Cell::new(true);
    let claims = vec![NewKnowledgeObject { kind: "idea".into(), title: "Revise".into(), body: "Revise body".into(), source_start: 0, source_end: 4 }];
    let planned = vec![Planned {
        plan: Plan::Revise {
            target: TargetSnapshot { object_id: o[0].id.clone(), project_id: o[0].project_id.clone(), base_revision_id: head.clone() },
            draft: crate::distillation::evolution::RevisionDraft {
                content: RevisionContent { kind: "idea".into(), title: o[0].title.clone(), body: "Granted revision body".into() },
                role: crate::storage::evidence_store::EvidenceRole::Asserts,
                retracts: None,
                interpretation_label: None,
            },
        },
        parts: evolution_parts("test", vec![o[0].id.clone()]),
    }];
    let out = commit(&s, &k, |w| w.evolve_capture(&cap.id, claims, planned, &EvolutionLimits::default(), &|| permitted.get(), false));
    let Committed::Fresh { objects, revised, pending, proposals } = out else { panic!("expected fresh"); };
    assert!(objects.is_empty());
    assert_eq!(revised.len(), 1);
    assert!(pending.is_empty());
    assert!(proposals.is_empty());
    assert_ne!(s.current_revision_id_of(&o[0].id).unwrap().unwrap(), head);
}

#[test]
fn w31_non_default_limits_shape_evolution_outcomes() {
    use crate::distillation::evolution::{Committed, EvolutionLimits, Plan, Planned};
    use crate::identity::TargetSnapshot;
    use crate::storage::evidence_store::EvidenceRole;
    use crate::storage::knowledge_store::NewKnowledgeObject;
    use crate::storage::lineage_store::RevisionContent;
    let (s, _cap, o) = graph(1);
    let k = JournalKernel::activate(&s).unwrap();
    let cap = commit(&s, &k, |w| w.create_capture(input(None)));
    let head = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
    let claims = || vec![NewKnowledgeObject { kind: "idea".into(), title: "Maybe".into(), body: "Maybe body".into(), source_start: 0, source_end: 4 }];
    let uncertain = |candidates: Vec<String>| Planned { plan: Plan::Uncertain(candidates.clone()), parts: evolution_parts("test", candidates) };
    let strict = EvolutionLimits { max_unresolved_pending: 0, ..EvolutionLimits::default() };
    let out = commit(&s, &k, |w| w.evolve_capture(&cap.id, claims(), vec![uncertain(vec![o[0].id.clone()])], &strict, &|| true, false));
    let Committed::Fresh { objects, revised, pending, proposals } = out else { panic!("expected fresh"); };
    assert_eq!(objects.len(), 1);
    assert!(revised.is_empty());
    assert!(pending.is_empty());
    assert!(proposals.is_empty());
    let decision: (String, Option<String>) = s.connection.lock().unwrap().query_row("SELECT outcome,unchecked_reason FROM identity_decisions WHERE capture_id=?1 AND ordinal=0", [&cap.id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(decision, ("unchecked".to_string(), Some("review_quota".to_string())));
    let cap2 = commit(&s, &k, |w| w.create_capture(input(None)));
    let relaxed = EvolutionLimits { pending_due_days: 1, ..EvolutionLimits::default() };
    let out = commit(&s, &k, |w| w.evolve_capture(&cap2.id, claims(), vec![uncertain(vec![o[0].id.clone()])], &relaxed, &|| true, false));
    let Committed::Fresh { pending, .. } = out else { panic!("expected fresh"); };
    assert_eq!(pending.len(), 1);
    let due: String = s.connection.lock().unwrap().query_row("SELECT due_at FROM pending_claims WHERE id=?1", [&pending[0].id], |r| r.get(0)).unwrap();
    let now_secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let due_secs = time::OffsetDateTime::parse(&due, &time::format_description::well_known::Rfc3339).unwrap().unix_timestamp();
    let day = 24 * 3600;
    assert!((due_secs - now_secs - day).abs() < 3600, "due date honors the supplied 1-day policy");
}
